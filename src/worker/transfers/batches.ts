/**
 * Upload-batch routes (spec §6.6, §10.2; plan T10; wave-4 contract B):
 *
 *   POST /            create a draft batch in a granted mount/parent
 *   GET  /:b          batch view + bounded node page (?cursor=&limit=)
 *   POST /:b/nodes    append a bounded plan page (planVersion CAS, per-node
 *                     idempotent merge, parents must precede children)
 *   POST /:b/seal     validate the whole graph and seal it before any
 *                     execution; nodes accept operations only afterwards
 *
 * nodeId is the only identity — display names are never keys, so two
 * siblings may share a name legitimately. The canonical plan digest shared
 * with the client planner is recomputed at seal and stored as plan_hash.
 * Batch/nodes are D1 plan state only: remote work happens exclusively in
 * UploadSession-driven folder/file operations.
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorCode, DecimalBytes } from '../../shared/contracts/common';
import {
  AppendBatchNodesRequestSchema,
  canonicalPlanDigest,
  CreateUploadBatchRequestSchema,
  findPlanGraphIssue,
  SealUploadBatchRequestSchema,
  type BatchNodeInput,
  type BatchNodeView,
  type UploadBatchState,
  type UploadBatchView,
  type UploadNodeState,
} from '../../shared/contracts/uploads';
import type { Actor } from '../auth/grants';
import {
  ApiRequestError,
  requireMountAccess,
  resolveActor,
  type ResolveActorFn,
} from '../drive/mounts';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { createGoogleOAuthProvider } from '../drive/providers/google-oauth';
import type { OAuthCatalogWriteProvider } from '../drive/types';
import { proveWritableDestination } from './reconcile';
import {
  readBatch,
  readBatchNode,
  resolveMountWriter,
  sha256Hex,
  stableStringify,
  type UploadBatchNodeRow,
  type UploadBatchRow,
} from './operations';
import {
  apiError,
  errorToResponse,
  maintenanceCreationGate,
  type RouterContext,
} from './upload-routes';

export interface BatchRouterDeps {
  /** Provider factory for the batch-create destination proof. */
  providerFor?: (env: Env) => OAuthCatalogWriteProvider;
  /** Actor resolution seam; production uses resolveActor. */
  resolveActorFn?: ResolveActorFn;
  /** Deterministic clock for tests. */
  now?: () => number;
}

const DEFAULT_NODE_PAGE = 200;
const MAX_NODE_PAGE = 500;
const MAX_BATCH_NODES = 10_000;
const CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/;

function nodeView(row: UploadBatchNodeRow): BatchNodeView {
  return {
    nodeId: row.node_id,
    parentNodeId: row.parent_node_id,
    kind: row.kind,
    displayName: row.display_name,
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    ...(row.total_bytes === null
      ? {}
      : { totalBytes: row.total_bytes as DecimalBytes }),
    state: row.state as UploadNodeState,
    ...(row.drive_file_id === null ? {} : { driveFileId: row.drive_file_id }),
    ...(row.operation_id === null ? {} : { uploadId: row.operation_id }),
  };
}

function nodeMatches(row: UploadBatchNodeRow, n: BatchNodeInput): boolean {
  return (
    row.parent_node_id === n.parentNodeId &&
    row.kind === n.kind &&
    row.display_name === n.displayName &&
    row.mime_type === (n.mimeType ?? null) &&
    row.total_bytes === (n.totalBytes ?? null)
  );
}

export function createBatchRouter(deps: BatchRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const now = deps.now ?? (() => Date.now());
  const resolve = deps.resolveActorFn ?? resolveActor;

  function provider(env: Env): OAuthCatalogWriteProvider {
    return (
      deps.providerFor?.(env) ??
      createGoogleOAuthProvider({
        tokenSource: createCoordinatorTokenSource(env),
      })
    );
  }

  /** Owner or admin may read; only the owner may mutate the plan. */
  async function loadOwnedBatch(
    c: RouterContext,
    batchId: string,
    write: boolean,
  ): Promise<{ batch: UploadBatchRow; actor: Actor } | Response> {
    const batch = await readBatch(c.env.DB, batchId);
    if (batch === null) {
      return apiError(c, 404, 'NOT_FOUND', 'Upload batch not found.');
    }
    const actor = await resolve(c.req.raw, c.env);
    if (actor.kind !== 'user') {
      return apiError(c, 404, 'NOT_FOUND', 'Upload batch not found.');
    }
    const isOwner = actor.user.id === batch.owner_id;
    if (!isOwner && actor.user.role !== 'admin') {
      return apiError(c, 404, 'NOT_FOUND', 'Upload batch not found.');
    }
    if (write && !isOwner) {
      return apiError(c, 404, 'NOT_FOUND', 'Upload batch not found.');
    }
    return { batch, actor };
  }

  async function nodesPage(
    db: D1Database,
    batchId: string,
    cursor: number,
    limit: number,
  ): Promise<{ nodes: BatchNodeView[]; nextCursor?: string }> {
    const rows = await db
      .prepare(
        'SELECT rowid AS rid, * FROM upload_batch_nodes ' +
          'WHERE batch_id = ? AND rowid > ? ORDER BY rowid LIMIT ?',
      )
      .bind(batchId, cursor, limit + 1)
      .all<UploadBatchNodeRow & { rid: number }>();
    const list = rows.results ?? [];
    const page = list.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      list.length > limit && last !== undefined ? String(last.rid) : undefined;
    return {
      nodes: page.map(nodeView),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async function batchView(
    db: D1Database,
    batch: UploadBatchRow,
    cursor = 0,
    limit = DEFAULT_NODE_PAGE,
  ): Promise<UploadBatchView> {
    const page = await nodesPage(db, batch.id, cursor, limit);
    return {
      batchId: batch.id,
      state: batch.state as UploadBatchState,
      planVersion: batch.plan_version,
      ...(batch.sealed_at === null
        ? {}
        : { sealedAt: new Date(batch.sealed_at).toISOString() }),
      ...(batch.plan_hash === null ? {} : { planHash: batch.plan_hash }),
      nodes: page.nodes,
      ...(page.nextCursor === undefined
        ? {}
        : { nextCursor: page.nextCursor }),
    };
  }

  function destinationError(dest: {
    ok: boolean;
    reason?: string;
  }): { status: ContentfulStatusCode; code: ApiErrorCode } {
    if ('retry' in dest) {
      return { status: 502, code: 'DRIVE_UNAVAILABLE' };
    }
    const reason = dest.reason ?? '';
    if (
      reason.includes('not-found') ||
      reason.includes('gone') ||
      reason.includes('permission-denied')
    ) {
      return { status: 404, code: 'FILE_NOT_ACCESSIBLE' };
    }
    if (reason.includes('add children')) {
      return { status: 403, code: 'FORBIDDEN' };
    }
    return { status: 400, code: 'VALIDATION_FAILED' };
  }

  // ---------------------------------------------------------------------
  // POST / — idempotent draft create (Idempotency-Key)
  // ---------------------------------------------------------------------
  app.post('/', async (c) => {
    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Request body must be JSON.',
        );
      }
      const parsed = CreateUploadBatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Batch request is invalid.',
        );
      }
      const idempotencyKey = c.req.header('idempotency-key');
      if (
        idempotencyKey === undefined ||
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 256
      ) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'An Idempotency-Key header is required.',
        );
      }
      const input = parsed.data;
      const { actor, mount } = await requireMountAccess(
        c.env,
        c.req.raw,
        input.mountId,
        'upload',
        deps.resolveActorFn,
      );
      if (actor.kind !== 'user') {
        throw new ApiRequestError(
          403,
          'FORBIDDEN',
          'Upload batches require an app session.',
        );
      }
      const ownerId = actor.user.id;
      const idemHash = await sha256Hex(`upload-batch:${idempotencyKey}`);
      const inputHash = await sha256Hex(
        stableStringify({
          mountId: input.mountId,
          rootParentId: input.rootParentId,
        }),
      );
      const existing = await c.env.DB.prepare(
        'SELECT * FROM upload_batches ' +
          'WHERE owner_id = ? AND idempotency_hash = ?',
      )
        .bind(ownerId, idemHash)
        .first<UploadBatchRow>();
      if (existing !== null && existing !== undefined) {
        if (existing.input_hash !== inputHash) {
          return apiError(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key was used with a different batch.',
          );
        }
        return c.json(await batchView(c.env.DB, existing), 200);
      }

      // New batch creation pauses while maintenance is active; the replay
      // path above is never gated (W4-R1 #1).
      const gate = await maintenanceCreationGate(c);
      if (gate !== null) return gate;

      // New batch: prove the destination is a writable folder inside the
      // mount before the plan container is admitted (spec §6.6 — the batch
      // lives on a granted mount/parent).
      const pinned = await resolveMountWriter(c.env.DB, mount);
      const dest = await proveWritableDestination({
        provider: provider(c.env),
        writer: pinned,
        parentId: input.rootParentId,
        driveId: mount.driveId,
        signal: c.req.raw.signal,
      });
      if (!dest.ok) {
        const mapped = destinationError(dest);
        return apiError(
          c,
          mapped.status,
          mapped.code,
          'The batch destination is not writable.',
        );
      }

      const id = crypto.randomUUID();
      let batch: UploadBatchRow;
      try {
        await c.env.DB.prepare(
          'INSERT INTO upload_batches (id, owner_id, mount_id, root_parent_id, ' +
            "idempotency_hash, input_hash, state, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
        )
          .bind(
            id,
            ownerId,
            input.mountId,
            input.rootParentId,
            idemHash,
            inputHash,
            now(),
            now(),
          )
          .run();
        batch = (await readBatch(c.env.DB, id)) as UploadBatchRow;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err ?? '');
        if (
          !message.includes('UNIQUE constraint failed') &&
          !message.includes('SQLITE_CONSTRAINT')
        ) {
          throw err;
        }
        const winner = await c.env.DB.prepare(
          'SELECT * FROM upload_batches ' +
            'WHERE owner_id = ? AND idempotency_hash = ?',
        )
          .bind(ownerId, idemHash)
          .first<UploadBatchRow>();
        if (winner === null || winner === undefined) throw err;
        if (winner.input_hash !== inputHash) {
          return apiError(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key was used with a different batch.',
          );
        }
        batch = winner;
      }
      return c.json(await batchView(c.env.DB, batch), 200);
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // GET /:b — batch view + bounded node page
  // ---------------------------------------------------------------------
  app.get('/:b', async (c) => {
    try {
      const loaded = await loadOwnedBatch(c, c.req.param('b'), false);
      if (loaded instanceof Response) return loaded;
      const limitRaw = c.req.query('limit');
      const cursorRaw = c.req.query('cursor') ?? '0';
      if (!CURSOR_PATTERN.test(cursorRaw)) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'The cursor is not valid.',
        );
      }
      let limit = DEFAULT_NODE_PAGE;
      if (limitRaw !== undefined) {
        if (!CURSOR_PATTERN.test(limitRaw)) {
          return apiError(
            c,
            400,
            'VALIDATION_FAILED',
            'The limit is not valid.',
          );
        }
        limit = Number.parseInt(limitRaw, 10);
        if (limit < 1 || limit > MAX_NODE_PAGE) {
          return apiError(
            c,
            400,
            'VALIDATION_FAILED',
            `The limit must be between 1 and ${MAX_NODE_PAGE}.`,
          );
        }
      }
      return c.json(
        await batchView(
          c.env.DB,
          loaded.batch,
          Number.parseInt(cursorRaw, 10),
          limit,
        ),
        200,
      );
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // POST /:b/nodes — bounded plan page append (planVersion CAS)
  // ---------------------------------------------------------------------
  app.post('/:b/nodes', async (c) => {
    try {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Request body must be JSON.',
        );
      }
      const parsed = AppendBatchNodesRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'The node page is invalid.',
        );
      }
      const loaded = await loadOwnedBatch(c, c.req.param('b'), true);
      if (loaded instanceof Response) return loaded;
      const { batch } = loaded;
      const nodes = parsed.data.nodes;
      if (batch.state !== 'draft') {
        return apiError(
          c,
          409,
          'FILE_CONFLICT',
          'The batch plan is already sealed.',
        );
      }

      if (batch.plan_version !== parsed.data.planVersion) {
        // Replay of an already-committed page answers the current view;
        // a genuinely stale version is a conflict, never a merge.
        let identical = nodes.length > 0;
        for (const n of nodes) {
          const row = await readBatchNode(c.env.DB, batch.id, n.nodeId);
          if (row === null || !nodeMatches(row, n)) {
            identical = false;
            break;
          }
        }
        if (identical) {
          const fresh = (await readBatch(
            c.env.DB,
            batch.id,
          )) as UploadBatchRow;
          return c.json(await batchView(c.env.DB, fresh), 200);
        }
        return apiError(
          c,
          409,
          'IDEMPOTENCY_CONFLICT',
          'The plan version does not match the batch.',
        );
      }

      const count = await c.env.DB.prepare(
        'SELECT COUNT(*) AS c FROM upload_batch_nodes WHERE batch_id = ?',
      )
        .bind(batch.id)
        .first<{ c: number }>();
      if ((count?.c ?? 0) + nodes.length > MAX_BATCH_NODES) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          `The batch plan exceeds ${MAX_BATCH_NODES} nodes.`,
        );
      }

      // Two passes over the page: validate the whole page first so a bad
      // node never leaves a partial append behind, then insert atomically.
      const pageInputs = new Map<string, BatchNodeInput>();
      const toInsert: BatchNodeInput[] = [];
      for (const n of nodes) {
        const seen = pageInputs.get(n.nodeId);
        if (seen !== undefined) {
          if (nodeInputEquals(seen, n)) continue;
          return apiError(
            c,
            400,
            'VALIDATION_FAILED',
            'A nodeId appears twice in one page.',
          );
        }
        const existing = await readBatchNode(c.env.DB, batch.id, n.nodeId);
        if (existing !== null) {
          if (nodeMatches(existing, n)) continue;
          return apiError(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'A nodeId already exists with different content.',
          );
        }
        if (
          n.kind === 'file' &&
          (n.mimeType === undefined || n.totalBytes === undefined)
        ) {
          return apiError(
            c,
            400,
            'VALIDATION_FAILED',
            'File nodes require mimeType and totalBytes.',
          );
        }
        if (n.parentNodeId !== null) {
          // Parents must precede children: the parent resolves only from
          // nodes already validated in this page or already durable — so a
          // self-reference or forward reference is a missing parent.
          const inPage = pageInputs.get(n.parentNodeId);
          const parent =
            inPage !== undefined
              ? inPage
              : await readBatchNode(c.env.DB, batch.id, n.parentNodeId);
          if (parent === undefined || parent === null) {
            return apiError(
              c,
              400,
              'VALIDATION_FAILED',
              'A parentNodeId does not reference an earlier node in this batch.',
            );
          }
          if (parent.kind !== 'folder') {
            return apiError(
              c,
              400,
              'VALIDATION_FAILED',
              'A parentNodeId must reference a folder node.',
            );
          }
        }
        pageInputs.set(n.nodeId, n);
        toInsert.push(n);
      }

      const stamp = now();
      const statements = toInsert.map((n) =>
        c.env.DB.prepare(
          'INSERT INTO upload_batch_nodes (batch_id, node_id, parent_node_id, ' +
            'kind, display_name, mime_type, total_bytes, state, created_at, updated_at) ' +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        ).bind(
          batch.id,
          n.nodeId,
          n.parentNodeId,
          n.kind,
          n.displayName,
          n.mimeType ?? null,
          n.totalBytes ?? null,
          stamp,
          stamp,
        ),
      );
      statements.push(
        c.env.DB.prepare(
          'UPDATE upload_batches SET plan_version = plan_version + 1, ' +
            'updated_at = ? WHERE id = ? AND plan_version = ?',
        ).bind(stamp, batch.id, parsed.data.planVersion),
      );
      await c.env.DB.batch(statements);
      const fresh = (await readBatch(c.env.DB, batch.id)) as UploadBatchRow;
      return c.json(await batchView(c.env.DB, fresh), 200);
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // POST /:b/seal — validate + seal (idempotent)
  // ---------------------------------------------------------------------
  app.post('/:b/seal', async (c) => {
    try {
      let body: unknown = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const parsed = SealUploadBatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'The seal request is invalid.',
        );
      }
      const loaded = await loadOwnedBatch(c, c.req.param('b'), true);
      if (loaded instanceof Response) return loaded;
      const { batch } = loaded;
      const request = parsed.data;

      if (batch.state !== 'draft') {
        // Seal replay: answer the sealed batch unless the caller asserts a
        // different plan digest.
        if (
          request.planHash !== undefined &&
          batch.plan_hash !== request.planHash
        ) {
          return apiError(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'The plan hash does not match the sealed batch.',
          );
        }
        return c.json(await batchView(c.env.DB, batch), 200);
      }
      if (
        request.planVersion !== undefined &&
        request.planVersion !== batch.plan_version
      ) {
        return apiError(
          c,
          409,
          'IDEMPOTENCY_CONFLICT',
          'The plan version does not match the batch.',
        );
      }

      const rows = await c.env.DB.prepare(
        'SELECT * FROM upload_batch_nodes WHERE batch_id = ? ORDER BY rowid',
      )
        .bind(batch.id)
        .all<UploadBatchNodeRow>();
      const nodeRows = rows.results ?? [];
      if (nodeRows.length === 0) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'The batch plan is empty.',
        );
      }
      const issue = findPlanGraphIssue(
        nodeRows.map((r) => ({
          nodeId: r.node_id,
          parentNodeId: r.parent_node_id,
          kind: r.kind,
        })),
      );
      if (issue !== null) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          `The batch plan is not a valid tree (${issue.reason}).`,
        );
      }
      const planHash = await canonicalPlanDigest(
        nodeRows.map((r) => ({
          nodeId: r.node_id,
          parentNodeId: r.parent_node_id,
          kind: r.kind,
          displayName: r.display_name,
          ...(r.mime_type === null ? {} : { mimeType: r.mime_type }),
          ...(r.total_bytes === null
            ? {}
            : { totalBytes: r.total_bytes as DecimalBytes }),
        })),
      );
      if (request.planHash !== undefined && request.planHash !== planHash) {
        return apiError(
          c,
          409,
          'IDEMPOTENCY_CONFLICT',
          'The plan hash does not match the batch plan.',
        );
      }
      const stamp = now();
      await c.env.DB.prepare(
        "UPDATE upload_batches SET state = 'sealed', plan_hash = ?, " +
          'sealed_at = ?, updated_at = ? WHERE id = ? AND state = ?',
      )
        .bind(planHash, stamp, stamp, batch.id, 'draft')
        .run();
      const fresh = (await readBatch(c.env.DB, batch.id)) as UploadBatchRow;
      return c.json(await batchView(c.env.DB, fresh), 200);
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  return app;
}

function nodeInputEquals(a: BatchNodeInput, b: BatchNodeInput): boolean {
  return (
    a.nodeId === b.nodeId &&
    a.parentNodeId === b.parentNodeId &&
    a.kind === b.kind &&
    a.displayName === b.displayName &&
    a.mimeType === b.mimeType &&
    a.totalBytes === b.totalBytes
  );
}
