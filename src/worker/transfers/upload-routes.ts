/**
 * Upload API routes (spec §6, §10.2; plan T07/T08):
 *
 *   POST   /api/v1/uploads                  idempotent init (Idempotency-Key)
 *   GET    /api/v1/uploads/:u               canonical view / tombstone
 *   PUT    /api/v1/uploads/:u/chunks        one chunk at generation+offset
 *   POST   /api/v1/uploads/:u/reconcile     probe/renewal recovery
 *   POST   /api/v1/uploads/:u/pause|resume|cancel
 *
 * The ordinary Worker owns every remote call: it claims attempts from the
 * UploadSession DO, executes the returned directive through the pinned
 * OAuth provider, streams request bytes straight into upstream
 * FixedLengthStream transport, and commits attempt+generation fenced
 * results. Upstream 308 never leaks — every answer is JSON 200 UploadView
 * or a shared error envelope. Dependency injection mirrors
 * createOAuthRouter so fixtures stay deterministic.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  decimalBytesToBigInt,
  type ApiErrorCode,
  type DecimalBytes,
} from '../../shared/contracts/common';
import {
  CreateUploadRequestSchema,
  type UploadView,
} from '../../shared/contracts/uploads';
import { AuthError } from '../auth/session';
import { authorizeMount } from '../auth/grants';
import {
  ApiRequestError,
  requireMountAccess,
  resolveActor,
  statusForApiCode,
  type MountRecord,
} from '../drive/mounts';
import { invalidateFolder } from '../drive/containment';
import { createFileMetadataCache } from '../drive/metadata-cache';
import { isDriveError } from '../drive/errors';
import { isMaintenanceActive } from '../security/rotation';
import {
  recordReaderBlocked,
  recordUploadReauth,
} from '../admin/metrics';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { createGoogleOAuthProvider } from '../drive/providers/google-oauth';
import { createServiceAccountReadProvider } from '../drive/providers/service-account-read';
import type {
  DriveFileMeta,
  OAuthCatalogWriteProvider,
  ResolvedWriter,
  ServiceAccountContentReadProvider,
} from '../drive/types';
import { streamChunk, remoteInitOutcomeForError } from './upload-stream';
import {
  proveDriveAccess,
  proveWritableDestination,
  runLookup,
  runProbe,
  runRenew,
} from './reconcile';
import { checkReaderAccess, runVerify } from './verify';
import { runTrash } from './cancel';
import { defer } from '../timing';
import {
  assertNodeAcceptsOperation,
  claimOperation,
  findOperationByIdempotency,
  inputHashFor,
  linkBatchNode,
  mountForOperation,
  pinnedFromRow,
  readOperation,
  refreshPinnedWriter,
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
  DEFAULT_ATTEMPT_LEASE_MS,
  DO_ORIGIN,
  type DoErrorCode,
  type DoResponse,
  type RemoteInitOutcome,
  type UploadDirective,
  type UploadSessionEvent,
  type UploadSessionSnapshot,
} from './upload-internal';
import type { PinnedUploadWriter } from './upload-internal';

export interface UploadRouterDeps {
  /** Provider factory; tests inject a fixture provider. */
  providerFor?: (env: Env) => OAuthCatalogWriteProvider;
  /** SA read provider factory for the post-complete readiness probe. */
  readProviderFor?: (env: Env) => ServiceAccountContentReadProvider;
  /** Actor resolution seam (A's contract; production uses resolveActor). */
  resolveActorFn?: (
    request: Request,
    env: { DB: D1Database; APP_MASTER_KEY?: string },
  ) => ReturnType<typeof resolveActor>;
  /** DO namespace seam; defaults to env.UPLOAD_SESSION. */
  sessionNamespace?: (env: Env) => DurableObjectNamespace;
  /** Deterministic clock for tests; drives leases and projections. */
  now?: () => number;
  /** 4/8/16 MiB policy list only (spec §6.1). Default 8 MiB. */
  chunkSizeBytes?: number;
  /** Attempt lease for claimed remote steps. */
  leaseMs?: number;
}

const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_DRIVE_STEPS = 10;
/** Strict decimal validation — no parseInt prefixes (R9). */
const GENERATION_PATTERN = /^[1-9][0-9]*$/;
const OFFSET_PATTERN = /^(0|[1-9][0-9]*)$/;
export const TERMINAL_OP_STATES = new Set([
  'completed',
  'cancelled',
  'expired',
  'conflict',
  'cleanup_pending',
]);

export type RouterContext = Context<{ Bindings: Env }>;

export function requestId(c: RouterContext): string {
  const existing = (c as unknown as { get?: (k: string) => unknown }).get?.(
    'requestId',
  );
  return typeof existing === 'string' ? existing : crypto.randomUUID();
}

export function apiError(
  c: RouterContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): Response {
  return c.json(buildApiError(code, message, requestId(c)), status);
}

export function errorToResponse(c: RouterContext, err: unknown): Response {
  if (err instanceof ApiRequestError) {
    return apiError(
      c,
      err.status as ContentfulStatusCode,
      err.code,
      err.message,
    );
  }
  if (err instanceof AuthError) {
    return apiError(
      c,
      err.status as ContentfulStatusCode,
      err.code,
      err.message,
    );
  }
  if (isDriveError(err)) {
    const code: ApiErrorCode =
      err.reason === 'unauthorized'
        ? 'GOOGLE_REAUTH_REQUIRED'
        : err.reason === 'permission-denied' || err.reason === 'not-found'
          ? 'FILE_NOT_ACCESSIBLE'
          : 'DRIVE_UNAVAILABLE';
    return apiError(
      c,
      statusForApiCode(code) as ContentfulStatusCode,
      code,
      `Drive operation failed (${err.reason}).`,
    );
  }
  return apiError(c, 500, 'INTERNAL_ERROR', 'Internal error.');
}

/**
 * Maintenance creation gate (W4-R1 #1): while the maintenance_state
 * singleton holds an active mode ('drain' or 'key-rotation'), NO new
 * upload/folder/batch operation may be created — a rotation re-seals the
 * very envelopes new work would mint, and `requireNoActiveUploads` could
 * never drain if fresh ops keep arriving. Only creation is gated:
 * idempotent replays and the finish/cancel/expire surfaces keep working.
 *
 * Same fail-closed posture as the ProjectCoordinator admission gate: a
 * D1 read error is treated as maintenance-active. The answer is the
 * shared error envelope with a retry hint and no internal detail.
 */
export async function maintenanceCreationGate(
  c: RouterContext,
): Promise<Response | null> {
  try {
    if (!(await isMaintenanceActive(c.env.DB))) return null;
  } catch {
    // Fail closed: an unreadable maintenance flag is treated as active.
  }
  return c.json(
    buildApiError(
      'DRIVE_UNAVAILABLE',
      'The service is temporarily unavailable; retry later.',
      requestId(c),
      60,
    ),
    503,
  );
}

export function doErrorToApi(code: DoErrorCode): {
  status: ContentfulStatusCode;
  code: ApiErrorCode;
} {
  switch (code) {
    case 'UPLOAD_NEEDS_RECONCILIATION':
      return { status: 409, code: 'UPLOAD_NEEDS_RECONCILIATION' };
    case 'NOT_INITIALIZED':
      return { status: 404, code: 'NOT_FOUND' };
    case 'INPUT_MISMATCH':
      return { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
    case 'ATTEMPT_IN_FLIGHT':
    case 'STATE_CONFLICT':
    case 'TERMINAL':
    case 'STALE_GENERATION':
    case 'OFFSET_MISMATCH':
    case 'LENGTH_MISMATCH':
      return { status: 409, code: 'VALIDATION_FAILED' };
    default:
      return { status: 500, code: 'INTERNAL_ERROR' };
  }
}

// ---------------------------------------------------------------------------
// Driver context
// ---------------------------------------------------------------------------

export interface DriveCtx {
  env: Env;
  deps: UploadRouterDeps & { now: () => number; leaseMs: number };
  stub: DurableObjectStub;
  /** Immutable pinned identity (from the op row / DO snapshot). */
  pinned: PinnedUploadWriter;
  snapshot: UploadSessionSnapshot;
  /** Chunk route only: the incoming byte stream and its declared length. */
  body?: ReadableStream<Uint8Array> | null;
  declaredLength?: number;
  signal?: AbortSignal;
  /** Off-critical-path work hook (route-level defer/waitUntil). */
  runLater?: (work: Promise<unknown>) => void;
}

export function providerFor(ctx: DriveCtx): OAuthCatalogWriteProvider {
  return (
    ctx.deps.providerFor?.(ctx.env) ??
    createGoogleOAuthProvider({
      tokenSource: createCoordinatorTokenSource(ctx.env),
    })
  );
}

export async function doFetch(
  stub: DurableObjectStub,
  path: string,
  init: RequestInit,
): Promise<DoResponse> {
  const res = await stub.fetch(`${DO_ORIGIN}${path}`, init);
  return (await res.json()) as DoResponse;
}

export async function doCommand(
  stub: DurableObjectStub,
  path: string,
  body: unknown,
): Promise<DoResponse> {
  return doFetch(stub, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function sendEvent(
  ctx: DriveCtx,
  fences: { attemptId?: string; generation?: number },
  event: UploadSessionEvent,
): Promise<DoResponse> {
  return doCommand(ctx.stub, '/event', {
    attemptId: fences.attemptId,
    generation: fences.generation,
    event,
    now: ctx.deps.now(),
  });
}

/**
 * Run the directive chain: execute each directive's remote call, commit the
 * fenced event, take the next derived directive — bounded so a flapping
 * upstream cannot spin a single request forever. Whatever the DO reports
 * after the last applied step is the canonical answer.
 */
export async function driveDirectives(
  ctx: DriveCtx,
  directive: UploadDirective,
): Promise<UploadSessionSnapshot> {
  let current = directive;
  for (
    let step = 0;
    step < MAX_DRIVE_STEPS && current.kind !== 'none';
    step++
  ) {
    const event = await executeDirective(ctx, current);
    const res = await sendEvent(ctx, current, event);
    if (!res.ok) break;
    ctx.snapshot = res.snapshot;
    current = res.directive;
    if (res.applied === false) break;
  }
  return ctx.snapshot;
}

/** Pinned identity, current row versions — or the blocked reason (R2). */
async function currentWriter(
  ctx: DriveCtx,
): Promise<{ ok: true; writer: ResolvedWriter } | { ok: false; reason: string }> {
  return refreshPinnedWriter(ctx.env.DB, ctx.pinned);
}

async function executeDirective(
  ctx: DriveCtx,
  directive: UploadDirective,
): Promise<UploadSessionEvent> {
  const provider = providerFor(ctx);
  const writer = await currentWriter(ctx);
  // Metric: a directive blocked because the pinned connection needs
  // re-authentication — no remote call happened, so it never reaches
  // the chunk outcome counters in upload-stream.
  if (!writer.ok && writer.reason.includes('re-authentication')) {
    recordUploadReauth();
  }
  switch (directive.kind) {
    case 'put-chunk': {
      if (!writer.ok) {
        return { type: 'chunk-blocked', reason: writer.reason };
      }
      return streamChunk({
        provider,
        directive: { ...directive, writer: writer.writer },
        body: ctx.body ?? null,
        declaredLength: ctx.declaredLength,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    }
    case 'generate-id': {
      if (!writer.ok) {
        return {
          type: 'remote-init-result',
          outcome: { kind: 'blocked', reason: writer.reason },
        };
      }
      try {
        const fileId = await provider.generateId({ writer: writer.writer });
        return { type: 'generated-id', fileId };
      } catch (err) {
        return {
          type: 'remote-init-result',
          outcome: outcomeForThrown(err),
        };
      }
    }
    case 'remote-init': {
      if (!writer.ok) {
        return {
          type: 'remote-init-result',
          outcome: { kind: 'blocked', reason: writer.reason },
        };
      }
      return runRemoteInit(ctx, provider, writer.writer, directive);
    }
    case 'probe': {
      if (!writer.ok) {
        return { type: 'probe-blocked', reason: writer.reason };
      }
      return runProbe({
        provider,
        directive: { ...directive, writer: writer.writer },
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    }
    case 'lookup-file': {
      if (!writer.ok) {
        return { type: 'lookup-blocked', reason: writer.reason };
      }
      return runLookup({
        provider,
        directive: { ...directive, writer: writer.writer },
        parentId: ctx.snapshot.parentId,
        requireParentScope: !ctx.snapshot.cancelRequested,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    }
    case 'renew': {
      if (!writer.ok) {
        return {
          type: 'renew-result',
          outcome: { kind: 'blocked', reason: writer.reason },
        };
      }
      return runRenew({
        provider,
        directive: { ...directive, writer: writer.writer },
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    }
    case 'trash': {
      if (!writer.ok) {
        return {
          type: 'trash-result',
          outcome: 'failed',
          reason: writer.reason,
        };
      }
      return runTrash({
        provider,
        directive: { ...directive, writer: writer.writer },
        db: ctx.env.DB,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    }
    case 'verify': {
      if (!writer.ok) {
        return {
          type: 'verify-result',
          outcome: 'retry',
          reason: writer.reason,
        };
      }
      return runVerify({
        provider,
        directive: { ...directive, writer: writer.writer },
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
    }
    case 'check-writer': {
      const status = await refreshPinnedWriter(ctx.env.DB, directive.pinned);
      return status.ok
        ? { type: 'writer-status', ok: true }
        : { type: 'writer-status', ok: false, reason: status.reason };
    }
    default:
      return { type: 'probe-unknown', reason: 'unhandled-directive' };
  }
}

function outcomeForThrown(err: unknown): RemoteInitOutcome {
  if (isDriveError(err)) return remoteInitOutcomeForError(err);
  return { kind: 'retry-later', reason: 'transport-error' };
}

/**
 * Remote init (create folder or resumable session). lookupFirst → adopt a
 * found file after proving access; then the remote-init-intent crash
 * marker is committed BEFORE the remote call so a mid-call crash resumes
 * through lookup instead of blindly re-creating (spec §6.2).
 */
async function runRemoteInit(
  ctx: DriveCtx,
  provider: OAuthCatalogWriteProvider,
  writer: ResolvedWriter,
  directive: Extract<UploadDirective, { kind: 'remote-init' }>,
): Promise<UploadSessionEvent> {
  // R9: prove the destination is inside the pinned mount and writable
  // BEFORE any remote create — never write outside the mount.
  const dest = await proveWritableDestination({
    provider,
    writer,
    parentId: directive.upload.parentId,
    mountScope: ctx.pinned.mountScope,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!dest.ok) {
    return {
      type: 'remote-init-result',
      outcome: {
        kind: 'retry' in dest && dest.retry ? 'retry-later' : 'blocked',
        reason: dest.reason,
      },
    };
  }
  if (directive.lookupFirst) {
    const found = await lookupGenerated(
      ctx,
      provider,
      writer,
      directive.generatedFileId,
    );
    if (found.kind === 'found') {
      return {
        type: 'remote-init-result',
        outcome: { kind: 'created', file: found.file },
      };
    }
    if (found.kind === 'blocked') {
      return {
        type: 'remote-init-result',
        outcome: { kind: 'blocked', reason: found.reason },
      };
    }
    if (found.kind === 'unknown') {
      return {
        type: 'remote-init-result',
        outcome: { kind: 'retry-later', reason: found.reason },
      };
    }
  }
  // Durable marker: any crash after this point resumes through lookup-first.
  const intent = await sendEvent(ctx, directive, {
    type: 'remote-init-intent',
  });
  if (!intent.ok || intent.applied === false) {
    // The attempt was superseded — do not call remote on a dead fence.
    return {
      type: 'remote-init-result',
      outcome: { kind: 'retry-later', reason: 'init attempt superseded' },
    };
  }
  ctx.snapshot = intent.snapshot;
  try {
    if (directive.upload.kind === 'folder') {
      const file = await provider.createFolder({
        writer,
        parentFolderId: directive.upload.parentId,
        name: directive.upload.name,
        generatedId: directive.generatedFileId,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      // The generated id may carry a cached "outside" verdict in this
      // isolate from an earlier 404 lookup; the new folder must be
      // re-walked. The shared store needs no delete: it holds positive
      // verdicts only, and a fresh generated id can have none (review L5).
      invalidateFolder(ctx.pinned.mountScope, file.id);
      return {
        type: 'remote-init-result',
        outcome: { kind: 'created', file },
      };
    }
    const start = await provider.startUpload({
      writer,
      parentFolderId: directive.upload.parentId,
      name: directive.upload.name,
      mimeType: directive.upload.mimeType,
      totalBytes: decimalBytesToBigInt(directive.upload.totalBytes),
      generatedFileId: directive.generatedFileId,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (start.kind === 'resumable') {
      return {
        type: 'remote-init-result',
        outcome: { kind: 'resumable', sessionUri: start.sessionUri },
      };
    }
    return {
      type: 'remote-init-result',
      outcome: { kind: 'created', file: start.file },
    };
  } catch (err) {
    if (isDriveError(err) && err.reason === 'conflict') {
      // Generated-ID collision: never assume success — look the ID up and
      // let verify decide match vs conflict (spec §6.4).
      const found = await lookupGenerated(
        ctx,
        provider,
        writer,
        directive.generatedFileId,
      );
      if (found.kind === 'found') {
        return {
          type: 'remote-init-result',
          outcome: { kind: 'created', file: found.file },
        };
      }
      return {
        type: 'remote-init-result',
        outcome: { kind: 'blocked', reason: 'conflict-lookup-failed' },
      };
    }
    return {
      type: 'remote-init-result',
      outcome: outcomeForThrown(err),
    };
  }
}

type LookupOutcome =
  | { kind: 'found'; file: DriveFileMeta }
  | { kind: 'absent' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unknown'; reason: string };

/**
 * files.get the generated ID; a 404 is only "absent" after the pinned
 * writer re-proves Drive-root identity+write scope AND the destination
 * parent remains a writable folder on the pinned drive (R8/R9). Anything
 * ambiguous is blocked or retry — never mistaken for absence.
 */
async function lookupGenerated(
  ctx: DriveCtx,
  provider: OAuthCatalogWriteProvider,
  writer: ResolvedWriter,
  fileId: string,
): Promise<LookupOutcome> {
  try {
    const file = await provider.getMetadata({
      writer,
      ref: { id: fileId },
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    return file.trashed === true ? { kind: 'absent' } : { kind: 'found', file };
  } catch (err) {
    if (!isDriveError(err)) {
      return { kind: 'unknown', reason: 'transport-error' };
    }
    if (err.reason !== 'not-found') {
      if (
        err.reason === 'unauthorized' ||
        err.reason === 'permission-denied' ||
        err.reason === 'credential-disabled'
      ) {
        return { kind: 'blocked', reason: err.reason };
      }
      return { kind: 'unknown', reason: err.reason };
    }
  }
  const drive = await proveDriveAccess({
    provider,
    writer,
    mountScope: ctx.pinned.mountScope,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!drive.ok) {
    return 'retry' in drive && drive.retry
      ? { kind: 'unknown', reason: drive.reason }
      : { kind: 'blocked', reason: `drive-check:${drive.reason}` };
  }
  const parent = await proveWritableDestination({
    provider,
    writer,
    parentId: ctx.snapshot.parentId,
    mountScope: ctx.pinned.mountScope,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!parent.ok) {
    return 'retry' in parent && parent.retry
      ? { kind: 'unknown', reason: parent.reason }
      : { kind: 'blocked', reason: `parent-check:${parent.reason}` };
  }
  return { kind: 'absent' };
}

// ---------------------------------------------------------------------------
// Reader-access finalize (independent axis, spec §6.5)
// ---------------------------------------------------------------------------

async function finalizeReaderAccess(
  ctx: DriveCtx,
  mount: MountRecord | null,
): Promise<void> {
  const snap = ctx.snapshot;
  if (snap.state === 'completed' && snap.generatedFileId !== undefined) {
    // Wave-10 invalidation: the finalize created/replaced remote content,
    // so any cached metadata row for the generated file id is stale. The
    // delete is required but not latency-critical — waitUntil is enough
    // (review M4); without a hook it still runs fire-and-forget.
    const work = createFileMetadataCache(ctx.env.DB).invalidateFile(
      snap.generatedFileId,
    );
    if (ctx.runLater === undefined) {
      work.catch(() => undefined);
    } else {
      ctx.runLater(work);
    }
  }
  if (
    snap.state !== 'completed' ||
    snap.generatedFileId === undefined ||
    snap.readerAccessState !== 'unchecked' ||
    mount === null
  ) {
    return;
  }
  const readProvider =
    ctx.deps.readProviderFor?.(ctx.env) ??
    createServiceAccountReadProvider({
      tokenSource: createCoordinatorTokenSource(ctx.env),
    });
  const check = await checkReaderAccess({
    db: ctx.env.DB,
    mount,
    fileId: snap.generatedFileId,
    readProvider,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (check.state === 'blocked') recordReaderBlocked();
  const res = await sendEvent(
    ctx,
    {},
    {
      type: 'reader-access',
      state: check.state,
      ...(check.reason === undefined ? {} : { reason: check.reason }),
      readPoolVersion: check.readPoolVersion,
      policyVersion: check.policyVersion,
      checkedMs: ctx.deps.now(),
    },
  );
  if (res.ok) ctx.snapshot = res.snapshot;
  // Projection table for the content surface (independent of upload state).
  await ctx.env.DB.prepare(
    'INSERT INTO file_readiness (mount_id, file_id, reader_access_state, ' +
      'read_pool_version, policy_version, checked_at, reason, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(mount_id, file_id) DO UPDATE SET reader_access_state = excluded.reader_access_state, ' +
      'read_pool_version = excluded.read_pool_version, policy_version = excluded.policy_version, ' +
      'checked_at = excluded.checked_at, reason = excluded.reason, updated_at = excluded.updated_at',
  )
    .bind(
      mount.id,
      snap.generatedFileId,
      check.state,
      check.readPoolVersion,
      check.policyVersion,
      ctx.deps.now(),
      check.reason ?? null,
      ctx.deps.now(),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createUploadRouter(deps: UploadRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const now = deps.now ?? (() => Date.now());
  const leaseMs = deps.leaseMs ?? DEFAULT_ATTEMPT_LEASE_MS;
  const mergedDeps: DriveCtx['deps'] = { ...deps, now, leaseMs };

  function stubFor(env: Env, uploadId: string): DurableObjectStub {
    const ns = deps.sessionNamespace?.(env) ?? env.UPLOAD_SESSION;
    return ns.get(ns.idFromName(uploadId));
  }

  function makeCtx(
    env: Env,
    uploadId: string,
    snapshot: UploadSessionSnapshot,
    extra: Partial<DriveCtx> = {},
  ): DriveCtx {
    return {
      env,
      deps: mergedDeps,
      stub: stubFor(env, uploadId),
      pinned: snapshot.pinned,
      snapshot,
      ...extra,
    };
  }

  async function doErrorResponse(
    c: RouterContext,
    res: Extract<DoResponse, { ok: false }>,
  ): Promise<Response> {
    const mapped = doErrorToApi(res.code);
    return apiError(c, mapped.status, mapped.code, res.message);
  }

  /** Owner or admin only — non-owners never learn an upload exists. */
  async function loadOwnedOperation(
    c: RouterContext,
    uploadId: string,
    /** R9: write-driving routes must still hold the mount upload grant —
     * a revoked uploader grant means zero remote write calls. */
    writeScope?: boolean,
  ): Promise<{ row: UploadOperationRow; mount: MountRecord | null } | Response> {
    const row = await readOperation(c.env.DB, uploadId);
    if (row === null) {
      return apiError(c, 404, 'NOT_FOUND', 'Upload not found.');
    }
    const actor = await (deps.resolveActorFn ?? resolveActor)(c.req.raw, c.env);
    if (actor.kind !== 'user') {
      return apiError(c, 404, 'NOT_FOUND', 'Upload not found.');
    }
    if (actor.user.id !== row.owner_id && actor.user.role !== 'admin') {
      return apiError(c, 404, 'NOT_FOUND', 'Upload not found.');
    }
    if (writeScope === true) {
      const access = await authorizeMount(c.env.DB, actor, row.mount_id);
      if (access === null || !access.operations.has('upload')) {
        return apiError(
          c,
          403,
          'FORBIDDEN',
          'The mount no longer grants upload access.',
        );
      }
    }
    const mount = await mountForOperation(c.env.DB, row);
    return { row, mount };
  }

  // ---------------------------------------------------------------------
  // POST / — idempotent init
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
      const parsed = CreateUploadRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Upload request is invalid.',
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
      // Batch-scoped nodes may omit the header: the durable (batchId,
      // nodeId) pair is itself the idempotency basis so a reload can
      // re-derive the exact operation (spec §6.6).
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
          'Uploads require an app session.',
        );
      }
      const ownerId = actor.user.id;
      const inputHash = await inputHashFor(input, 'file');
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
            'Idempotency-Key was used with a different upload.',
          );
        }
        // R7: a terminal operation answers its permanent compact result —
        // the replay never re-initializes or touches remote work. The node
        // sync still repairs a mapping lost to a crash after the write.
        if (TERMINAL_OP_STATES.has(existing.state)) {
          if (existing.batch_id !== null && existing.node_id !== null) {
            await syncBatchNodeFromRow(c.env.DB, existing, now());
          }
          return c.json(viewFromTombstone(existing), 200);
        }
        operation = existing;
      } else {
        // New operation creation pauses while maintenance is active; the
        // replay path above is never gated (W4-R1 #1).
        const gate = await maintenanceCreationGate(c);
        if (gate !== null) return gate;
        // Batch linkage (spec §6.6): a new operation for a batch node binds
        // to the sealed plan — the durable parent mapping is the only legal
        // destination and must already be confirmed before any child op.
        const binding =
          input.batchId === undefined
            ? null
            : await requireBatchBinding(c.env.DB, {
                batchId: input.batchId,
                nodeId: input.nodeId as string,
                ownerId,
                mountId: input.mountId,
                kind: 'file',
                parentId: input.parentId,
              });
        if (binding !== null) assertNodeAcceptsOperation(binding.node);
        const pinned = await resolveMountWriter(c.env.DB, mount);
        const claim = await claimOperation(c.env.DB, {
          ownerId,
          kind: 'file',
          idempotencyKey,
          input,
          pinned,
          now: now(),
        });
        if (!claim.ok) {
          return apiError(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key was used with a different upload.',
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
      const pinned = pinnedFromRow(operation, mount);
      const res = await doCommand(stub, '/initialize', {
        uploadId: operation.id,
        ownerId: operation.owner_id,
        mountId: operation.mount_id,
        kind: operation.kind,
        inputHash: operation.input_hash,
        parentId: input.parentId,
        name: input.name,
        mimeType: input.mimeType,
        totalBytes: input.totalBytes,
        sha256: input.sha256,
        md5: input.md5,
        ...(operation.batch_id === null
          ? {}
          : { batchId: operation.batch_id }),
        ...(operation.node_id === null ? {} : { nodeId: operation.node_id }),
        chunkSize: deps.chunkSizeBytes ?? 8 * 1024 * 1024,
        pinned,
        now: now(),
        leaseMs,
      });
      if (!res.ok) return doErrorResponse(c, res);
      const ctx = makeCtx(c.env, operation.id, res.snapshot, {
        signal: c.req.raw.signal,
        runLater: (work) => defer(c, work),
      });
      await driveDirectives(ctx, res.directive);
      await finalizeReaderAccess(ctx, mount);
      await writeProjection(c.env.DB, operation.id, ctx.snapshot, now());
      return c.json(viewFromSnapshot(ctx.snapshot) satisfies UploadView, 200);
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // GET /:u — live snapshot or tombstone. Strictly read-only (R9): a GET
  // never claims attempts, drives remote calls, writes projections or
  // runs reader checks.
  // ---------------------------------------------------------------------
  app.get('/:u', async (c) => {
    try {
      const loaded = await loadOwnedOperation(c, c.req.param('u'));
      if (loaded instanceof Response) return loaded;
      const { row } = loaded;
      const stub = stubFor(c.env, row.id);
      const res = await doFetch(stub, '/snapshot', { method: 'GET' });
      if (!res.ok) {
        // DO evicted before init or tombstone-only record: answer from D1.
        return c.json(viewFromTombstone(row), 200);
      }
      return c.json(viewFromSnapshot(res.snapshot), 200);
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // PUT /:u/chunks?generation=N&offset=D — one streamed chunk
  // ---------------------------------------------------------------------
  app.put('/:u/chunks', async (c) => {
    try {
      const loaded = await loadOwnedOperation(c, c.req.param('u'), true);
      if (loaded instanceof Response) return loaded;
      const { row, mount } = loaded;
      // Strict decimal validation — no partial parseInt prefixes (R9).
      const generationRaw = c.req.query('generation') ?? '';
      const offset = c.req.query('offset') ?? '';
      if (
        !GENERATION_PATTERN.test(generationRaw) ||
        !OFFSET_PATTERN.test(offset)
      ) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Chunk address requires generation and offset.',
        );
      }
      const generation = Number.parseInt(generationRaw, 10);
      const declared = c.req.header('content-length');
      if (declared === undefined) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'A Content-Length header is required for chunk uploads.',
        );
      }
      if (!OFFSET_PATTERN.test(declared)) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Content-Length must be an integer.',
        );
      }
      const declaredLength = Number.parseInt(declared, 10);
      if (declaredLength <= 0 || declaredLength > MAX_CHUNK_BYTES) {
        return apiError(
          c,
          400,
          'VALIDATION_FAILED',
          'Chunk length is outside the upload policy.',
        );
      }

      const stub = stubFor(c.env, row.id);
      const res = await doCommand(stub, '/claim', {
        generation,
        offset: offset as DecimalBytes,
        length: declaredLength,
        now: now(),
        leaseMs,
      });
      if (!res.ok) return doErrorResponse(c, res);
      if (res.directive.kind !== 'put-chunk') {
        return apiError(
          c,
          409,
          'VALIDATION_FAILED',
          'No chunk claim was granted.',
        );
      }
      const ctx = makeCtx(c.env, row.id, res.snapshot, {
        body: c.req.raw.body,
        declaredLength,
        signal: c.req.raw.signal,
        runLater: (work) => defer(c, work),
      });
      await driveDirectives(ctx, res.directive);
      await finalizeReaderAccess(ctx, mount);
      await writeProjection(c.env.DB, row.id, ctx.snapshot, now());
      return c.json(viewFromSnapshot(ctx.snapshot), 200);
    } catch (err) {
      return errorToResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // POST /:u/reconcile|pause|resume|cancel
  // ---------------------------------------------------------------------
  for (const action of ['reconcile', 'pause', 'resume', 'cancel'] as const) {
    app.post(`/:u/${action}`, async (c) => {
      try {
        // R9: reconcile may drive a renewal write and resume re-enables
        // writes — both revalidate the current upload grant. Pause/cancel
        // never authorize new writes; owner cleanup stays allowed.
        const loaded = await loadOwnedOperation(
          c,
          c.req.param('u'),
          action === 'reconcile' || action === 'resume',
        );
        if (loaded instanceof Response) return loaded;
        const { row, mount } = loaded;
        const path = action === 'reconcile' ? '/probe' : `/${action}`;
        const stub = stubFor(c.env, row.id);
        const res = await doCommand(stub, path, {
          now: now(),
          leaseMs,
        });
        if (!res.ok) return doErrorResponse(c, res);
        const ctx = makeCtx(c.env, row.id, res.snapshot, {
          signal: c.req.raw.signal,
          runLater: (work) => defer(c, work),
        });
        await driveDirectives(ctx, res.directive);
        await finalizeReaderAccess(ctx, mount);
        await writeProjection(c.env.DB, row.id, ctx.snapshot, now());
        return c.json(viewFromSnapshot(ctx.snapshot), 200);
      } catch (err) {
        return errorToResponse(c, err);
      }
    });
  }

  return app;
}
