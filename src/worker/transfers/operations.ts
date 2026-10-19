/**
 * Upload operation index (D1) and tombstone handling (spec §6.2, §10.1;
 * plan T07). `upload_operations` is the idempotency index and durable
 * tombstone — the canonical upload state machine lives in UploadSession.
 *
 * Invariants kept here:
 *  - INSERT ... UNIQUE(owner_id, idempotency_hash): two concurrent inits
 *    land on the same uploadId; a replay with a different input digest is a
 *    409 IDEMPOTENCY_CONFLICT, never a second operation.
 *  - Pinned writer columns are immutable identity snapshots written once at
 *    claim time; replay reuses the stored pin and never re-resolves the
 *    mount's current default.
 *  - Rows are never deleted: terminal results and pinned identity stay for
 *    the installation lifetime, so a replayed key after detail cleanup or
 *    an out-of-band file delete still answers the original outcome.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { UploadView } from '../../shared/contracts/uploads';
import type { DecimalBytes } from '../../shared/contracts/common';
import {
  ApiRequestError,
  getMount,
  requireUsableOAuthWriter,
  resolveWriterState,
  type MountRecord,
  type ResolvedWriterState,
} from '../drive/mounts';
import { mountScopeOf } from '../drive/containment';
import type { ResolvedWriter } from '../drive/types';
import type { PinnedUploadWriter, UploadSessionSnapshot } from './upload-internal';

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Stable JSON for hashing: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(',')}}`;
}

export interface UploadOperationRow {
  id: string;
  owner_id: string;
  mount_id: string;
  batch_id: string | null;
  node_id: string | null;
  kind: 'file' | 'folder';
  idempotency_hash: string;
  input_hash: string;
  generated_file_id: string | null;
  pinned_oauth_connection_id: string;
  pinned_principal_id: string;
  pinned_oauth_client_id: string;
  pinned_project_id: string;
  state: string;
  result: string | null;
  summary: string | null;
  detail_purged_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface OperationInput {
  readonly mountId: string;
  readonly parentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly totalBytes: DecimalBytes;
  readonly sha256: string;
  readonly md5: string;
  readonly batchId?: string;
  readonly nodeId?: string;
}

export type ClaimOperationResult =
  | { readonly ok: true; readonly operation: UploadOperationRow; readonly created: boolean }
  | { readonly ok: false; readonly code: 'IDEMPOTENCY_CONFLICT' };

export function inputHashFor(input: OperationInput, kind: 'file' | 'folder'): Promise<string> {
  return sha256Hex(
    stableStringify({
      kind,
      mountId: input.mountId,
      parentId: input.parentId,
      name: input.name,
      mimeType: input.mimeType,
      totalBytes: input.totalBytes,
      sha256: input.sha256,
      md5: input.md5,
      batchId: input.batchId ?? null,
      nodeId: input.nodeId ?? null,
    }),
  );
}

function idempotencyHashFor(key: string): Promise<string> {
  return sha256Hex(`upload-operation:${key}`);
}

const OPERATION_COLUMNS =
  'id, owner_id, mount_id, batch_id, node_id, kind, idempotency_hash, input_hash, ' +
  'generated_file_id, pinned_oauth_connection_id, pinned_principal_id, ' +
  'pinned_oauth_client_id, pinned_project_id, state, result, summary, ' +
  'detail_purged_at, created_at, updated_at, completed_at';

export async function readOperation(
  db: D1Database,
  uploadId: string,
): Promise<UploadOperationRow | null> {
  const row = await db
    .prepare(`SELECT ${OPERATION_COLUMNS} FROM upload_operations WHERE id = ?`)
    .bind(uploadId)
    .first<UploadOperationRow>();
  return row ?? null;
}

/**
 * Resolve the mount's CURRENT write connection into the pinned tuple used
 * at claim time. Unusable connections (disabled / needs_reauth / missing)
 * fail closed via ApiRequestError from requireUsableOAuthWriter — the
 * caller never uploads under a different identity.
 */
export async function resolveMountWriter(
  db: D1Database,
  mount: MountRecord,
): Promise<PinnedUploadWriter> {
  const state = await requireUsableOAuthWriter(
    db,
    mount.writeConnectionId,
    'upload',
  );
  return { ...state.writer, mountScope: mountScopeOf(mount) };
}

export type PinnedWriterStatus =
  | { readonly ok: true; readonly writer: ResolvedWriter }
  | { readonly ok: false; readonly reason: string };

/**
 * Re-resolve the pinned writer NOW (R2): the connection row's current
 * versions are used so coordinator admission succeeds after a
 * same-principal reconnect, while every identity field must still match
 * the immutable pin exactly. Any mismatch, missing row, disabled or
 * needs_reauth state is reported as blocked — never a different writer.
 */
export async function refreshPinnedWriter(
  db: D1Database,
  pinned: PinnedUploadWriter,
): Promise<PinnedWriterStatus> {
  const state: ResolvedWriterState | null = await resolveWriterState(
    db,
    pinned.connectionId,
  );
  if (state === null) {
    return { ok: false, reason: 'pinned OAuth connection no longer exists' };
  }
  const w = state.writer;
  if (
    w.connectionId !== pinned.connectionId ||
    w.principalId !== pinned.principalId ||
    w.oauthClientId !== pinned.oauthClientId ||
    w.projectId !== pinned.projectId
  ) {
    return {
      ok: false,
      reason: 'pinned writer identity changed; refusing substitute',
    };
  }
  if (!state.connection.enabled || state.connection.state === 'disabled') {
    return { ok: false, reason: 'pinned OAuth connection is disabled' };
  }
  if (state.connection.state === 'needs_reauth') {
    return {
      ok: false,
      reason: 'pinned OAuth connection requires re-authentication',
    };
  }
  if (!state.client.enabled) {
    return { ok: false, reason: 'pinned OAuth client is disabled' };
  }
  return { ok: true, writer: w };
}

/**
 * Claim the operation row. Inserts pinned identity + input hash under
 * UNIQUE(owner_id, idempotency_hash); on conflict re-reads the winner and
 * compares input digests (same digest → idempotent replay, different →
 * IDEMPOTENCY_CONFLICT).
 */
export async function claimOperation(
  db: D1Database,
  args: {
    ownerId: string;
    kind: 'file' | 'folder';
    idempotencyKey: string;
    input: OperationInput;
    pinned: PinnedUploadWriter;
    now: number;
  },
): Promise<ClaimOperationResult> {
  const idempotencyHash = await idempotencyHashFor(args.idempotencyKey);
  const inputHash = await inputHashFor(args.input, args.kind);
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        'INSERT INTO upload_operations (id, owner_id, mount_id, batch_id, node_id, kind, ' +
          'idempotency_hash, input_hash, pinned_oauth_connection_id, pinned_principal_id, ' +
          "pinned_oauth_client_id, pinned_project_id, state, summary, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', '{}', ?, ?)",
      )
      .bind(
        id,
        args.ownerId,
        args.input.mountId,
        args.input.batchId ?? null,
        args.input.nodeId ?? null,
        args.kind,
        idempotencyHash,
        inputHash,
        args.pinned.connectionId,
        args.pinned.principalId,
        args.pinned.oauthClientId,
        args.pinned.projectId,
        args.now,
        args.now,
      )
      .run();
    const row = await readOperation(db, id);
    if (row === null) {
      throw new Error('operation insert vanished');
    }
    return { ok: true, operation: row, created: true };
  } catch (err) {
    // UNIQUE(owner_id, idempotency_hash) → the winner's row decides.
    if (!isUniqueViolation(err)) throw err;
    const winner = await db
      .prepare(
        `SELECT ${OPERATION_COLUMNS} FROM upload_operations ` +
          'WHERE owner_id = ? AND idempotency_hash = ?',
      )
      .bind(args.ownerId, idempotencyHash)
      .first<UploadOperationRow>();
    if (winner === null) throw err;
    if (winner.input_hash !== inputHash) {
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    }
    return { ok: true, operation: winner, created: false };
  }
}

/** Read the idempotency-index row for (owner, key) — the replay check. */
export async function findOperationByIdempotency(
  db: D1Database,
  ownerId: string,
  idempotencyHash: string,
): Promise<UploadOperationRow | null> {
  const row = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS} FROM upload_operations ` +
        'WHERE owner_id = ? AND idempotency_hash = ?',
    )
    .bind(ownerId, idempotencyHash)
    .first<UploadOperationRow>();
  return row ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return (
    message.includes('UNIQUE constraint failed') ||
    message.includes('SQLITE_CONSTRAINT')
  );
}

/**
 * Rebuild the pin from the D1 row. The mount scope always comes from the
 * mount row (rows created before 0007 carry no scope of their own).
 */
export function pinnedFromRow(
  row: UploadOperationRow,
  mount: Pick<MountRecord, 'id' | 'rootFolderId' | 'driveId'>,
): PinnedUploadWriter {
  return {
    connectionId: row.pinned_oauth_connection_id,
    principalId: row.pinned_principal_id,
    oauthClientId: row.pinned_oauth_client_id,
    projectId: row.pinned_project_id,
    // Version snapshots are re-resolved per remote call; the stored pin is
    // identity, not admission authority.
    connectionVersion: 1,
    oauthClientVersion: 1,
    mountScope: mountScopeOf(mount),
  };
}

/**
 * Write the D1 projection after a state-changing step. The DO snapshot is
 * canonical; this row only feeds listing/tombstone reads and NEVER decides
 * progress. generated_file_id is persisted as soon as known so late
 * reconcile-by-file lookups and crash audits can find the operation.
 *
 * Ordering is the canonical monotonic stateVersion, never wall-clock:
 * a delayed write from an older in-flight request cannot overwrite a
 * newer projection or tombstone (R7).
 */
export async function writeProjection(
  db: D1Database,
  uploadId: string,
  snapshot: UploadSessionSnapshot,
  now: number,
): Promise<void> {
  const terminal = snapshot.completedMs !== undefined;
  const summary = JSON.stringify({
    confirmedOffset: snapshot.confirmedOffset,
    totalBytes: snapshot.totalBytes,
    chunkSize: snapshot.chunkSize,
    sessionGeneration: snapshot.sessionGeneration,
    readerAccessState: snapshot.readerAccessState,
    readerCheckedMs: snapshot.readerCheckedMs ?? null,
    readerReason: snapshot.readerReason ?? null,
    blockReason: snapshot.blockReason ?? null,
  });
  await db
    .prepare(
      'UPDATE upload_operations SET state = ?, summary = ?, ' +
        'generated_file_id = COALESCE(?, generated_file_id), ' +
        'result = COALESCE(?, result), completed_at = COALESCE(?, completed_at), ' +
        'updated_at = ?, projection_version = ? ' +
        'WHERE id = ? AND projection_version < ?',
    )
    .bind(
      snapshot.state,
      summary,
      snapshot.generatedFileId ?? null,
      snapshot.result ?? null,
      terminal ? snapshot.completedMs ?? now : null,
      now,
      snapshot.stateVersion,
      uploadId,
      snapshot.stateVersion,
    )
    .run();
  // Batch linkage (spec §6.6): mirror the node row from the CURRENT
  // projected operation state — not this call's possibly-stale snapshot —
  // so the node view never regresses behind the monotonic projection.
  const row = await readOperation(db, uploadId);
  if (row !== null) await syncBatchNodeFromRow(db, row, now);
}

/**
 * Project an operation row onto its batch node (spec §6.6). Only the op
 * that owns the node (operation_id set at claim or NULL on a crash before
 * linkage) may write state, so a replayed superseded op never clobbers a
 * retried node's progress. The drive_file_id mapping is confirmed only on
 * a completed write — a generated-but-unproven ID must not admit children.
 * Idempotent: replays after a crash between the remote create and the
 * original mapping write repair the durable nodeId → Drive ID mapping.
 */
export async function syncBatchNodeFromRow(
  db: D1Database,
  row: UploadOperationRow,
  now: number,
): Promise<void> {
  if (row.batch_id === null || row.node_id === null) return;
  await db
    .prepare(
      'UPDATE upload_batch_nodes SET operation_id = ?, ' +
        "drive_file_id = CASE WHEN ? = 'completed' THEN COALESCE(?, drive_file_id) ELSE drive_file_id END, " +
        'state = ?, updated_at = ? WHERE batch_id = ? AND node_id = ? ' +
        'AND (operation_id IS NULL OR operation_id = ?)',
    )
    .bind(
      row.id,
      row.state,
      row.generated_file_id,
      nodeStateForOperation(row.state),
      now,
      row.batch_id,
      row.node_id,
      row.id,
    )
    .run();
  await refreshBatchState(db, row.batch_id, now);
}

/** Public UploadView from a canonical DO snapshot (internal fields stripped). */
export function viewFromSnapshot(snapshot: UploadSessionSnapshot): UploadView {
  return {
    uploadId: snapshot.uploadId,
    state: snapshot.state,
    sessionGeneration: snapshot.sessionGeneration,
    confirmedOffset: snapshot.confirmedOffset,
    totalBytes: snapshot.totalBytes,
    chunkSize: snapshot.chunkSize,
    readerAccessState: snapshot.readerAccessState,
    ...(snapshot.blockReason === undefined
      ? {}
      : { blockReason: snapshot.blockReason }),
  };
}

/**
 * Tombstone view for an ended operation: the D1 row is the source — the DO
 * may have been evicted or its detail purged. The permanent result JSON
 * embeds the compact public view (R7), so a replay after detail cleanup
 * still answers the original total/generation/outcome verbatim; the
 * summary is the second source while it lasts.
 */
export function viewFromTombstone(row: UploadOperationRow): UploadView {
  const result = parseResult(row.result);
  const view = result?.view;
  const summary = parseSummary(row.summary);
  return {
    uploadId: row.id,
    state: row.state as UploadView['state'],
    sessionGeneration:
      view?.sessionGeneration ?? summary?.sessionGeneration ?? 1,
    confirmedOffset: (view?.confirmedOffset ??
      summary?.confirmedOffset ??
      '0') as DecimalBytes,
    totalBytes: (view?.totalBytes ?? summary?.totalBytes ?? '0') as DecimalBytes,
    chunkSize: view?.chunkSize ?? summary?.chunkSize ?? 8 * 1024 * 1024,
    readerAccessState:
      view?.readerAccessState ?? summary?.readerAccessState ?? 'unchecked',
    ...(view?.blockReason ?? summary?.blockReason ?? undefined) === undefined
      ? {}
      : { blockReason: (view?.blockReason ?? summary?.blockReason) as string },
  };
}

interface OperationResult {
  outcome?: string;
  reason?: string;
  verification?: string;
  trashed?: boolean;
  /** Compact final UploadView written at terminal commit (R7). */
  view?: {
    state?: string;
    sessionGeneration?: number;
    confirmedOffset?: string;
    totalBytes?: string;
    chunkSize?: number;
    readerAccessState?: UploadView['readerAccessState'];
    blockReason?: string;
  };
}

export function parseResult(raw: string | null): OperationResult | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as OperationResult;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

interface OperationSummary {
  confirmedOffset?: string;
  totalBytes?: string;
  chunkSize?: number;
  sessionGeneration?: number;
  readerAccessState?: UploadView['readerAccessState'];
  readerCheckedMs?: number | null;
  readerReason?: string | null;
  blockReason?: string | null;
}

export function parseSummary(raw: string | null): OperationSummary | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as OperationSummary;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** Resolve the mount row for an existing operation (mount scope for the pin). */
export async function mountForOperation(
  db: D1Database,
  row: UploadOperationRow,
): Promise<MountRecord | null> {
  return getMount(db, row.mount_id);
}

// ---------------------------------------------------------------------------
// Folder-upload batch linkage (spec §6.6, plan T10). `upload_batch_nodes`
// rows are the durable nodeId → Drive ID mapping; this module validates
// node ownership before an operation claims a node and keeps the mapping
// in step with canonical UploadSession projections.
// ---------------------------------------------------------------------------

export interface UploadBatchRow {
  id: string;
  owner_id: string;
  mount_id: string;
  root_parent_id: string;
  idempotency_hash: string | null;
  input_hash: string | null;
  plan_hash: string | null;
  plan_version: number;
  state: string;
  sealed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface UploadBatchNodeRow {
  batch_id: string;
  node_id: string;
  parent_node_id: string | null;
  kind: 'file' | 'folder';
  display_name: string;
  mime_type: string | null;
  total_bytes: string | null;
  operation_id: string | null;
  drive_file_id: string | null;
  state: string;
  created_at: number;
  updated_at: number;
}

export async function readBatch(
  db: D1Database,
  batchId: string,
): Promise<UploadBatchRow | null> {
  const row = await db
    .prepare('SELECT * FROM upload_batches WHERE id = ?')
    .bind(batchId)
    .first<UploadBatchRow>();
  return row ?? null;
}

export async function readBatchNode(
  db: D1Database,
  batchId: string,
  nodeId: string,
): Promise<UploadBatchNodeRow | null> {
  const row = await db
    .prepare(
      'SELECT * FROM upload_batch_nodes WHERE batch_id = ? AND node_id = ?',
    )
    .bind(batchId, nodeId)
    .first<UploadBatchNodeRow>();
  return row ?? null;
}

export interface BatchBinding {
  readonly batch: UploadBatchRow;
  readonly node: UploadBatchNodeRow;
  /** The only parent ID the sealed plan permits for this node. */
  readonly requiredParentId: string;
}

/** Batch states that still admit child operations. 'failed' is included so
 * a retry of a failed node can re-activate the batch (linkBatchNode moves
 * it back to executing). */
const EXECUTABLE_BATCH_STATES = new Set(['sealed', 'executing', 'failed']);

/**
 * Resolve and validate a (batchId, nodeId) operation binding (spec §6.6
 * step 4): the batch must belong to the caller and mount, be sealed and
 * executable, the node must exist with the expected kind, and the durable
 * parent mapping must already be confirmed — a root node binds to the
 * batch root, any other node binds to its parent folder node's confirmed
 * drive_file_id. The caller's parentId must equal that mapping exactly;
 * children are never scheduled under an unconfirmed or guessed parent.
 */
export async function requireBatchBinding(
  db: D1Database,
  args: {
    batchId: string;
    nodeId: string;
    ownerId: string;
    mountId: string;
    kind: 'file' | 'folder';
    parentId: string;
  },
): Promise<BatchBinding> {
  const batch = await readBatch(db, args.batchId);
  if (
    batch === null ||
    batch.owner_id !== args.ownerId ||
    batch.mount_id !== args.mountId
  ) {
    throw new ApiRequestError(404, 'NOT_FOUND', 'Upload batch not found.');
  }
  if (!EXECUTABLE_BATCH_STATES.has(batch.state)) {
    throw new ApiRequestError(
      409,
      'FILE_CONFLICT',
      'The upload batch is not open for operations.',
    );
  }
  const node = await readBatchNode(db, args.batchId, args.nodeId);
  if (node === null || node.kind !== args.kind) {
    throw new ApiRequestError(404, 'NOT_FOUND', 'Batch node not found.');
  }
  let requiredParentId = batch.root_parent_id;
  if (node.parent_node_id !== null) {
    const parent = await readBatchNode(db, args.batchId, node.parent_node_id);
    if (
      parent === null ||
      parent.kind !== 'folder' ||
      parent.drive_file_id === null
    ) {
      throw new ApiRequestError(
        409,
        'FILE_CONFLICT',
        'The parent folder has no confirmed Drive mapping yet.',
      );
    }
    requiredParentId = parent.drive_file_id;
  }
  if (args.parentId !== requiredParentId) {
    throw new ApiRequestError(
      400,
      'VALIDATION_FAILED',
      'The parent does not match the confirmed plan mapping.',
    );
  }
  return { batch, node, requiredParentId };
}

/**
 * A node accepts a new operation only while it has no live/completed one:
 * pending (never started), failed or cancelled (explicit retry). The
 * idempotent replay path answers earlier, so reaching here means a NEW
 * operation would be created for the node.
 */
export function assertNodeAcceptsOperation(node: UploadBatchNodeRow): void {
  if (node.state === 'pending' || node.state === 'failed' || node.state === 'cancelled') {
    return;
  }
  throw new ApiRequestError(
    409,
    'FILE_CONFLICT',
    'The batch node already has an operation.',
  );
}

/** Attach the claimed operation to its node; a sealed/failed batch resumes
 * executing. The UPDATE guard keeps a racing second claim from stealing a
 * node that is already in progress. */
export async function linkBatchNode(
  db: D1Database,
  args: { batchId: string; nodeId: string; operationId: string; now: number },
): Promise<void> {
  await db
    .prepare(
      "UPDATE upload_batch_nodes SET operation_id = ?, state = 'in_progress', " +
        'updated_at = ? WHERE batch_id = ? AND node_id = ? ' +
        "AND state IN ('pending', 'failed', 'cancelled')",
    )
    .bind(args.operationId, args.now, args.batchId, args.nodeId)
    .run();
  await db
    .prepare(
      "UPDATE upload_batches SET state = 'executing', updated_at = ? " +
        "WHERE id = ? AND state IN ('sealed', 'failed')",
    )
    .bind(args.now, args.batchId)
    .run();
}

/** Coarse node view of an operation state (projection axis only — the DO
 * remains canonical for the operation itself). */
export function nodeStateForOperation(state: string): string {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
    case 'conflict':
    case 'cleanup_pending':
      return 'failed';
    default:
      return 'in_progress';
  }
}

/** Recompute the batch rollup after a node transition: executing while any
 * node is unfinished, then completed only when every node completed; any
 * failed/cancelled residue makes the batch failed (completed siblings are
 * never deleted — spec §6.6). */
export async function refreshBatchState(
  db: D1Database,
  batchId: string,
  now: number,
): Promise<void> {
  const rows = await db
    .prepare(
      'SELECT state, COUNT(*) AS c FROM upload_batch_nodes ' +
        'WHERE batch_id = ? GROUP BY state',
    )
    .bind(batchId)
    .all<{ state: string; c: number }>();
  const counts = new Map<string, number>();
  for (const r of rows.results ?? []) counts.set(r.state, r.c);
  const unfinished =
    (counts.get('pending') ?? 0) + (counts.get('in_progress') ?? 0);
  let next = 'executing';
  if (unfinished === 0) {
    const completed = counts.get('completed') ?? 0;
    const failed = (counts.get('failed') ?? 0) + (counts.get('cancelled') ?? 0);
    next = failed === 0 && completed > 0 ? 'completed' : 'failed';
  }
  await db
    .prepare(
      'UPDATE upload_batches SET state = ?, updated_at = ? WHERE id = ? ' +
        "AND state IN ('sealed', 'executing', 'failed')",
    )
    .bind(next, now, batchId)
    .run();
}
