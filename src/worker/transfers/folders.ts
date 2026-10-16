/**
 * Folder create route (spec §6.6, §10.2; plan T10; wave-4 contract B):
 *
 *   POST /   metadata-only folder create by generated ID + idempotency
 *
 * A folder operation is the same UploadSession state machine as a file
 * upload with kind='folder': files.generateIds pins the generated ID, the
 * pinned OAuth writer creates it with the folder MIME type, and a lost
 * response reconciles by that generated ID — never by a name lookup. There
 * is no resumable session, no chunks and no checksum axis; the
 * metadata-only create completes once the pinned ID is confirmed. Idem:
 * the Idempotency-Key header or the durable (batchId, nodeId) pair pins
 * one operation per node.
 */

import { Hono } from 'hono';
import type { DecimalBytes } from '../../shared/contracts/common';
import {
  CreateFolderRequestSchema,
  type FolderView,
} from '../../shared/contracts/uploads';
import {
  ApiRequestError,
  requireMountAccess,
  type ResolveActorFn,
} from '../drive/mounts';
import { FOLDER_MIME_TYPE } from '../drive/providers/common';
import type { OAuthCatalogWriteProvider } from '../drive/types';
import {
  assertNodeAcceptsOperation,
  claimOperation,
  findOperationByIdempotency,
  inputHashFor,
  linkBatchNode,
  pinnedFromRow,
  requireBatchBinding,
  resolveMountWriter,
  sha256Hex,
  syncBatchNodeFromRow,
  viewFromSnapshot,
  viewFromTombstone,
  writeProjection,
  type UploadOperationRow,
} from './operations';
import {
  apiError,
  doCommand,
  doErrorToApi,
  driveDirectives,
  errorToResponse,
  maintenanceCreationGate,
  TERMINAL_OP_STATES,
  type DriveCtx,
  type RouterContext,
} from './upload-routes';
import {
  DEFAULT_ATTEMPT_LEASE_MS,
  type DoResponse,
} from './upload-internal';

export interface FolderRouterDeps {
  /** Provider factory; tests inject a fixture provider. */
  providerFor?: (env: Env) => OAuthCatalogWriteProvider;
  /** Actor resolution seam; production uses resolveActor. */
  resolveActorFn?: ResolveActorFn;
  /** DO namespace seam; defaults to env.UPLOAD_SESSION. */
  sessionNamespace?: (env: Env) => DurableObjectNamespace;
  /** Deterministic clock for tests. */
  now?: () => number;
  /** Attempt lease for claimed remote steps. */
  leaseMs?: number;
}

export function createFolderRouter(deps: FolderRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const now = deps.now ?? (() => Date.now());
  const leaseMs = deps.leaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;
  const mergedDeps: DriveCtx['deps'] = { ...deps, now, leaseMs };

  function stubFor(env: Env, uploadId: string): DurableObjectStub {
    const ns = deps.sessionNamespace?.(env) ?? env.UPLOAD_SESSION;
    return ns.get(ns.idFromName(uploadId));
  }

  function doErrorResponse(
    c: RouterContext,
    res: Extract<DoResponse, { ok: false }>,
  ): Response {
    const mapped = doErrorToApi(res.code);
    return apiError(c, mapped.status, mapped.code, res.message);
  }

  // ---------------------------------------------------------------------
  // POST / — idempotent metadata-only folder create
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
      const parsed = CreateFolderRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Folder request is invalid.',
        );
      }
      const input = parsed.data;
      if ((input.batchId === undefined) !== (input.nodeId === undefined)) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'batchId and nodeId must be provided together.',
        );
      }
      const headerKey = c.req.header('idempotency-key');
      const idempotencyKey =
        headerKey !== undefined && headerKey.length > 0
          ? headerKey
          : input.batchId !== undefined
            ? `batch-node:${input.batchId}:${input.nodeId ?? ''}`
            : undefined;
      if (idempotencyKey === undefined || idempotencyKey.length > 256) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'An Idempotency-Key header is required.',
        );
      }
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
          'Folder creates require an app session.',
        );
      }
      const ownerId = actor.user.id;
      const operationInput = {
        mountId: input.mountId,
        parentId: input.parentId,
        name: input.name,
        mimeType: FOLDER_MIME_TYPE,
        totalBytes: '0' as DecimalBytes,
        sha256: '',
        md5: '',
        ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
        ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      };
      const inputHash = await inputHashFor(operationInput, 'folder');
      const idemHash = await sha256Hex(`upload-operation:${idempotencyKey}`);

      let operation: UploadOperationRow;
      const existing = await findOperationByIdempotency(
        c.env.DB,
        ownerId,
        idemHash,
      );
      if (existing !== null) {
        if (existing.input_hash !== inputHash) {
          return apiError(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key was used with a different folder create.',
          );
        }
        if (TERMINAL_OP_STATES.has(existing.state)) {
          // A replay still repairs a node mapping lost to a crash after
          // the remote create confirmed.
          if (existing.batch_id !== null && existing.node_id !== null) {
            await syncBatchNodeFromRow(c.env.DB, existing, now());
          }
          const tombstone = viewFromTombstone(existing);
          return c.json(
            {
              ...tombstone,
              ...(existing.generated_file_id === null
                ? {}
                : { driveFileId: existing.generated_file_id }),
            } satisfies FolderView,
            200,
          );
        }
        operation = existing;
      } else {
        // New operation creation pauses while maintenance is active; the
        // replay path above is never gated (W4-R1 #1).
        const gate = await maintenanceCreationGate(c);
        if (gate !== null) return gate;
        // Sealed-plan binding: the node's durable parent mapping is the
        // only legal destination and must be confirmed before a child op
        // may run (spec §6.6 step 4).
        const binding =
          input.batchId === undefined
            ? null
            : await requireBatchBinding(c.env.DB, {
                batchId: input.batchId,
                nodeId: input.nodeId as string,
                ownerId,
                mountId: input.mountId,
                kind: 'folder',
                parentId: input.parentId,
              });
        if (binding !== null) assertNodeAcceptsOperation(binding.node);
        const pinned = await resolveMountWriter(c.env.DB, mount);
        const claim = await claimOperation(c.env.DB, {
          ownerId,
          kind: 'folder',
          idempotencyKey,
          input: operationInput,
          pinned,
          now: now(),
        });
        if (!claim.ok) {
          return apiError(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key was used with a different folder create.',
          );
        }
        operation = claim.operation;
        if (binding !== null) {
          await linkBatchNode(c.env.DB, {
            batchId: binding.batch.id,
            nodeId: binding.node.node_id,
            operationId: operation.id,
            now: now(),
          });
        }
      }

      const stub = stubFor(c.env, operation.id);
      const pinned = pinnedFromRow(operation, mount.driveId);
      const res = await doCommand(stub, '/initialize', {
        uploadId: operation.id,
        ownerId: operation.owner_id,
        mountId: operation.mount_id,
        kind: 'folder',
        inputHash: operation.input_hash,
        parentId: input.parentId,
        name: input.name,
        mimeType: FOLDER_MIME_TYPE,
        totalBytes: '0',
        sha256: '',
        md5: '',
        ...(operation.batch_id === null
          ? {}
          : { batchId: operation.batch_id }),
        ...(operation.node_id === null ? {} : { nodeId: operation.node_id }),
        // No chunks exist for folders; the value only satisfies the
        // command contract and is never used.
        chunkSize: 8 * 1024 * 1024,
        pinned,
        now: now(),
        leaseMs,
      });
      if (!res.ok) return doErrorResponse(c, res);
      const ctx: DriveCtx = {
        env: c.env,
        deps: mergedDeps,
        stub,
        pinned,
        snapshot: res.snapshot,
        signal: c.req.raw.signal,
      };
      await driveDirectives(ctx, res.directive);
      await writeProjection(c.env.DB, operation.id, ctx.snapshot, now());
      const view = viewFromSnapshot(ctx.snapshot);
      return c.json(
        {
          ...view,
          ...(ctx.snapshot.generatedFileId === undefined
            ? {}
            : { driveFileId: ctx.snapshot.generatedFileId }),
        } satisfies FolderView,
        200,
      );
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  return app;
}
