/**
 * Master-key rotation engine (architecture §9.2, plan T14; wave-4 worker E).
 *
 * Rotating APP_MASTER_KEY re-seals every D1-resident credential envelope in
 * place. The mechanics deliberately reuse the existing vault primitives:
 *
 * - Both keys coexist for the duration of a run: APP_MASTER_KEY opens the
 *   current envelopes, the optional APP_MASTER_KEY_NEXT secret reseals them.
 *   The HKDF key id stays `v1` — the salt is domain separation, not the
 *   secret being rotated — so no call site outside this module changes.
 * - While a run is active the `maintenance_state` singleton holds
 *   mode='key-rotation'; the ProjectCoordinator admission gate reads that
 *   row on every /admit and refuses new token issuance (fail-closed on
 *   read errors), so no credential can be mutated mid-rotation by an
 *   upstream refresh CAS.
 * - Progress is checkpointed per envelope table (`checkpoint` JSON holds a
 *   per-source row cursor + processed count). A crashed step resumes from
 *   the cursor; rows already resealed are detected by decrypting under the
 *   NEW key first, so restart is idempotent without per-row flags.
 * - Rewrites are CAS-guarded on the old ciphertext
 *   (`UPDATE ... WHERE id=? AND <col>=?`), so a racing writer can never be
 *   clobbered — a missed CAS leaves the row for the next step.
 * - The old key is kept until `verifyRotation` has opened EVERY envelope
 *   under the new key; `completeRotation` then revokes all app sessions
 *   (media tickets die with the key change itself) and clears maintenance.
 *   Pinned upload writer identity is never touched.
 *
 * UploadSession DO envelopes (`session_uri_envelope`, purpose
 * 'upload-session') are re-keyed through the UploadSessionRekeyPort defined
 * here. Since wave 5 the engine drives `/rekey` across non-terminal upload
 * operations as a checkpointed pseudo-source inside `stepRotation`, and
 * `verifyRotation`/`completeRotation` refuse only while a session still
 * reports unavailable/unrekeyable (count-only) — active uploads no longer
 * block a rotation outright, they get re-keyed in place.
 */

import {
  createSecretKeyring,
  decodeEnvelope,
  masterKeyLabel,
  type KeyringBox,
  type SecretContext,
} from './vault';
import {
  oauthClientSecretContext,
  oauthPkceVerifierContext,
  oauthRefreshTokenContext,
  serviceAccountKeyContext,
} from '../drive/tokens';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// 'drain' blocks new token admissions without re-encrypting (e.g. during a
// restore); 'key-rotation' additionally drives the envelope reseal phases.
export const MAINTENANCE_MODES = ['off', 'drain', 'key-rotation'] as const;
export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

export const ROTATION_PHASES = [
  'idle',
  'reencrypting',
  'verifying',
  'verified',
  'done',
  'failed',
] as const;
export type RotationPhase = (typeof ROTATION_PHASES)[number];

interface SourceCheckpoint {
  /** Last processed primary key; rows are scanned in `id` order. */
  readonly cursor: string;
  readonly done: boolean;
  readonly processed: number;
  /**
   * Upload-sessions source only: ops whose DO reported
   * unavailable/unrekeyable during this run. They are scanned past but
   * still gate verify/complete — the live re-scan there recounts them.
   */
  readonly blocked?: number;
}

interface RotationCheckpoint {
  /** Per-envelope-source progress, keyed by source name. */
  readonly sources: Record<string, SourceCheckpoint>;
}

export interface MaintenanceStateRow {
  readonly id: number;
  readonly mode: MaintenanceMode;
  readonly phase: RotationPhase;
  readonly fromKeyLabel: string | null;
  readonly toKeyLabel: string | null;
  readonly checkpoint: RotationCheckpoint;
  readonly processedCount: number;
  readonly verifiedCount: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export type RotationErrorCode =
  | 'NEXT_KEY_MISSING'
  | 'NEXT_KEY_INVALID'
  | 'ROTATION_IN_WRONG_PHASE'
  | 'ROTATION_NOT_ABORTABLE'
  | 'ROTATION_BLOCKED_BY_ACTIVE_UPLOADS'
  | 'STORAGE_ERROR';

export interface RotationError {
  readonly ok: false;
  readonly code: RotationErrorCode;
  readonly message: string;
  /** Count only — never row ids or remote URIs. */
  readonly blockedUploads?: number;
}

export interface RotationStatus {
  readonly mode: MaintenanceMode;
  readonly phase: RotationPhase;
  readonly fromKeyLabel: string | null;
  readonly toKeyLabel: string | null;
  readonly processedCount: number;
  readonly verifiedCount: number;
  readonly envelopeTotals: Record<string, number>;
  /**
   * Progress of the UploadSession rekey pseudo-source, once the run has
   * scanned any non-terminal upload operation.
   */
  readonly uploadSessions: {
    readonly processed: number;
    readonly blocked: number;
    readonly done: boolean;
  } | null;
  readonly lastError: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly completedAt: string | null;
}

export interface RotationStepResult {
  readonly phase: RotationPhase;
  /** Source the batch was consumed from (null when nothing remained). */
  readonly source: string | null;
  readonly processed: number;
  readonly remaining: boolean;
  /**
   * Ops whose UploadSession DO reported unavailable/unrekeyable so far
   * this run — present once the upload-session scan has been reached.
   * Verify/complete still refuse while any remain.
   */
  readonly blockedUploads?: number;
}

export interface RotationVerifyResult {
  readonly ok: boolean;
  readonly verified: number;
  /** Live upload sessions proven openable under the new key. */
  readonly sessionsProved: number;
  readonly failed: number;
  /** Failing row ids by source (ids are safe — never secret material). */
  readonly failures: Record<string, string[]>;
}

export interface RotationCompleteResult {
  readonly sessionsRevoked: number;
  readonly completedAt: number;
}

/** Environment slice the rotation needs; APP_MASTER_KEY_NEXT is optional. */
export interface RotationEnv {
  readonly DB: D1Database;
  readonly APP_MASTER_KEY?: string;
  readonly APP_MASTER_KEY_NEXT?: string;
  /**
   * UploadSession DO namespace — used to build the default rekey port for
   * step/verify/complete. An explicit `rekey` option always wins.
   */
  readonly UPLOAD_SESSION?: UploadSessionNamespace;
}

// ---------------------------------------------------------------------------
// Envelope sources — every D1 column holding a 'vault'-purpose envelope.
// ---------------------------------------------------------------------------

interface EnvelopeSourceRow {
  readonly id: string;
  readonly envelope: string | null;
  readonly projectId: string;
}

interface EnvelopeSource {
  readonly name: string;
  /** Ordered keyset pagination over rows still holding an envelope. */
  readonly select: string;
  readonly count: string;
  /** Column the resealed envelope is written back to, with CAS on the old. */
  readonly update: string;
  readonly context: (row: EnvelopeSourceRow) => SecretContext<string>;
}

const ENVELOPE_SOURCES: readonly EnvelopeSource[] = [
  {
    name: 'service_accounts',
    select:
      'SELECT id, project_id AS projectId, envelope FROM service_accounts ' +
      'WHERE id > ? ORDER BY id LIMIT ?',
    count: 'SELECT COUNT(*) AS n FROM service_accounts',
    update:
      'UPDATE service_accounts SET envelope = ?, updated_at = ? ' +
      'WHERE id = ? AND envelope = ?',
    context: (row) => serviceAccountKeyContext(row.id, row.projectId),
  },
  {
    name: 'google_oauth_clients',
    select:
      'SELECT id, project_id AS projectId, secret_envelope AS envelope ' +
      'FROM google_oauth_clients WHERE id > ? ORDER BY id LIMIT ?',
    count: 'SELECT COUNT(*) AS n FROM google_oauth_clients',
    update:
      'UPDATE google_oauth_clients SET secret_envelope = ?, updated_at = ? ' +
      'WHERE id = ? AND secret_envelope = ?',
    context: (row) => oauthClientSecretContext(row.id, row.projectId),
  },
  {
    name: 'google_connections',
    select:
      'SELECT gc.id, c.project_id AS projectId, gc.refresh_envelope AS envelope ' +
      'FROM google_connections gc ' +
      'JOIN google_oauth_clients c ON c.id = gc.oauth_client_id ' +
      'WHERE gc.refresh_envelope IS NOT NULL AND gc.id > ? ' +
      'ORDER BY gc.id LIMIT ?',
    count:
      'SELECT COUNT(*) AS n FROM google_connections ' +
      'WHERE refresh_envelope IS NOT NULL',
    update:
      'UPDATE google_connections SET refresh_envelope = ?, updated_at = ? ' +
      'WHERE id = ? AND refresh_envelope = ?',
    context: (row) => oauthRefreshTokenContext(row.id, row.projectId),
  },
  {
    name: 'oauth_transactions',
    select:
      'SELECT t.id, c.project_id AS projectId, t.pkce_envelope AS envelope ' +
      'FROM oauth_transactions t ' +
      'JOIN google_oauth_clients c ON c.id = t.oauth_client_id ' +
      'WHERE t.pkce_envelope IS NOT NULL AND t.id > ? ' +
      'ORDER BY t.id LIMIT ?',
    count:
      'SELECT COUNT(*) AS n FROM oauth_transactions ' +
      'WHERE pkce_envelope IS NOT NULL',
    update:
      'UPDATE oauth_transactions SET pkce_envelope = ? ' +
      'WHERE id = ? AND pkce_envelope = ?',
    context: (row) => oauthPkceVerifierContext(row.id, row.projectId),
  },
];

export const DEFAULT_ROTATION_BATCH = 100;
export const MAX_ROTATION_BATCH = 500;

// ---------------------------------------------------------------------------
// UploadSession envelope re-keying — interface frozen for Wave 5.
// ---------------------------------------------------------------------------

/**
 * Wave-5 contract: the UploadSession DO owns `session_uri_envelope` in its
 * own SQLite storage, sealed under HKDF purpose 'upload-session'. The
 * ordinary Worker cannot reach that storage, so re-keying is a DO command:
 *
 *   POST https://upload-session.internal/rekey
 *   body: {now: number}   (the DO derives the write label from its env)
 *   → 200 {ok:true, resealed:boolean}   (false when no envelope is stored)
 *   → 404 {code:'NOT_INITIALIZED'}      (no session row — nothing to do)
 *   → 409 {code:'STATE_CONFLICT'}       (DO refuses outside maintenance)
 *
 * The DO opens the stored envelope through the keyring and reseals it
 * under the current write key (APP_MASTER_KEY_NEXT when staged) under the
 * SAME AAD context (provider 'google-oauth', recordId upload_id,
 * projectId pinned project, kind 'resumable-session'). The command is
 * idempotent: an envelope that already opens under the write label is
 * reported resealed without rewriting — opening comes first, so
 * 'resealed' is always a proof, never just a label match. The DO's
 * envelope write is guarded on the exact value it opened, so a racing
 * session write can never be clobbered.
 *
 * The rotation engine drives it through this port — one call per upload
 * operation id, bounded by the caller. Pinned writer identity, the state
 * machine and attempt leases are never touched by re-keying.
 */
export interface UploadSessionRekeyPort {
  rekey(uploadId: string): Promise<'resealed' | 'none' | 'unavailable'>;
}

/** Minimal structural shape the rekey port needs — avoids pinning a DO
 * class generic that would couple this module to objects/upload-session. */
export interface UploadSessionNamespace {
  get(id: DurableObjectId): DurableObjectStub;
  idFromName(name: string): DurableObjectId;
}

/** Build the Wave-5 port: one `/rekey` POST per operation's DO stub. */
export function createUploadSessionRekeyPort(env: {
  UPLOAD_SESSION: UploadSessionNamespace;
}): UploadSessionRekeyPort {
  return {
    async rekey(uploadId) {
      const stub = env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName(uploadId));
      const res = await stub.fetch('https://upload-session.internal/rekey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ now: Date.now() }),
      });
      if (res.status === 404) return 'none';
      if (!res.ok) return 'unavailable';
      const body = (await res.json()) as { resealed?: boolean };
      return body.resealed === true ? 'resealed' : 'none';
    },
  };
}

// ---------------------------------------------------------------------------
// State row access
// ---------------------------------------------------------------------------

interface MaintenanceRecord {
  id: number;
  mode: string;
  phase: string;
  from_key_label: string | null;
  to_key_label: string | null;
  checkpoint: string;
  processed_count: number;
  verified_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function parseCheckpoint(raw: string): RotationCheckpoint {
  try {
    const parsed = JSON.parse(raw) as RotationCheckpoint;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.sources === 'object' &&
      parsed.sources !== null
    ) {
      return parsed;
    }
  } catch {
    // fall through to the empty checkpoint
  }
  return { sources: {} };
}

function isMode(value: string): value is MaintenanceMode {
  return (MAINTENANCE_MODES as readonly string[]).includes(value);
}

function isPhase(value: string): value is RotationPhase {
  return (ROTATION_PHASES as readonly string[]).includes(value);
}

function toStateRow(r: MaintenanceRecord): MaintenanceStateRow {
  return {
    id: r.id,
    mode: isMode(r.mode) ? r.mode : 'off',
    phase: isPhase(r.phase) ? r.phase : 'idle',
    fromKeyLabel: r.from_key_label,
    toKeyLabel: r.to_key_label,
    checkpoint: parseCheckpoint(r.checkpoint),
    processedCount: r.processed_count,
    verifiedCount: r.verified_count,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

const STATE_COLUMNS =
  'id, mode, phase, from_key_label, to_key_label, checkpoint, ' +
  'processed_count, verified_count, last_error, created_at, updated_at, completed_at';

const EMPTY_STATE: MaintenanceStateRow = {
  id: 1,
  mode: 'off',
  phase: 'idle',
  fromKeyLabel: null,
  toKeyLabel: null,
  checkpoint: { sources: {} },
  processedCount: 0,
  verifiedCount: 0,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
  completedAt: null,
};

/**
 * Read the maintenance singleton. A missing row means mode 'off'. A read
 * ERROR propagates — the admission gate in project-coordinator.ts relies
 * on that to fail closed instead of silently serving during a suspected
 * rotation.
 */
export async function readMaintenanceState(
  db: D1Database,
): Promise<MaintenanceStateRow> {
  const row = await db
    .prepare(`SELECT ${STATE_COLUMNS} FROM maintenance_state WHERE id = 1`)
    .first<MaintenanceRecord>();
  return row === null ? EMPTY_STATE : toStateRow(row);
}

/** True while any maintenance mode is active — the admission gate's check. */
export async function isMaintenanceActive(db: D1Database): Promise<boolean> {
  const state = await readMaintenanceState(db);
  return state.mode !== 'off';
}

/** Rekey pseudo-source progress for status/diagnostics DTOs. */
export function uploadSessionProgress(
  state: MaintenanceStateRow,
): { processed: number; blocked: number; done: boolean } | null {
  const rekey = state.checkpoint.sources['upload_sessions'];
  return rekey === undefined
    ? null
    : {
        processed: rekey.processed,
        blocked: rekey.blocked ?? 0,
        done: rekey.done,
      };
}

// ---------------------------------------------------------------------------
// Keyring: opens select the key by the envelope's own keyId ('v1' →
// APP_MASTER_KEY; k_<fingerprint> labels map to whichever binding holds those
// bytes), and seals land on APP_MASTER_KEY_NEXT whenever it is staged — see
// the keyring contract in ./vault.ts.
// ---------------------------------------------------------------------------

function keyring(env: RotationEnv): KeyringBox<string> {
  return createSecretKeyring<string>(env, 'vault');
}

/** Fingerprint label that new envelopes carry during this rotation. */
async function nextKeyLabel(env: RotationEnv): Promise<string> {
  return masterKeyLabel(env.APP_MASTER_KEY_NEXT as string);
}

// ---------------------------------------------------------------------------
// UploadSession rekey phase (wave-5 frozen decision 6)
// ---------------------------------------------------------------------------

/**
 * Upload states whose UploadSession DO can no longer hold a live resumable
 * session URI envelope: completed/cancelled/expired mean no further remote
 * session work; conflict terminates without a usable session. Everything
 * else — including cleanup_pending, whose DO still fences unresolved remote
 * writes — may keep a 'upload-session'-purpose envelope that the run must
 * re-key through the DO `/rekey` command.
 */
const ENVELOPE_FREE_STATES = ['completed', 'cancelled', 'expired', 'conflict'] as const;

/**
 * Checkpoint key of the rekey pseudo-source inside
 * `maintenance_state.checkpoint.sources`. The non-terminal upload set is
 * closed for the run — maintenance mode gates NEW operation creation and
 * states only move toward terminal — so a single keyset scan covers every
 * envelope that can still exist under the old key; envelopes minted inside
 * the window are sealed under NEXT by the keyring itself.
 */
const REKEY_SOURCE = 'upload_sessions';

interface RekeyableUploadRow {
  readonly id: string;
}

/** Non-terminal upload operation ids, keyset-paginated in `id` order. */
async function listRekeyableUploads(
  db: D1Database,
  cursor: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .prepare(
      'SELECT id FROM upload_operations ' +
        `WHERE state NOT IN (${ENVELOPE_FREE_STATES.map(() => '?').join(',')}) ` +
        'AND id > ? ORDER BY id LIMIT ?',
    )
    .bind(...ENVELOPE_FREE_STATES, cursor, limit)
    .all<RekeyableUploadRow>();
  return (rows.results ?? []).map((r) => r.id);
}

/**
 * Resolve the rekey port: an injected port wins (tests), otherwise the
 * env's UPLOAD_SESSION binding builds the default `/rekey` driver. No port
 * at all means sessions can never be proven — every op counts unavailable.
 */
function rekeyPortFor(
  env: RotationEnv,
  options: { rekey?: UploadSessionRekeyPort },
): UploadSessionRekeyPort | undefined {
  if (options.rekey !== undefined) return options.rekey;
  if (env.UPLOAD_SESSION !== undefined) {
    return createUploadSessionRekeyPort({
      UPLOAD_SESSION: env.UPLOAD_SESSION,
    });
  }
  return undefined;
}

/** A port throw is infrastructure-unavailable, never a crash of the run. */
async function rekeyOutcome(
  port: UploadSessionRekeyPort | undefined,
  uploadId: string,
): Promise<'resealed' | 'none' | 'unavailable'> {
  if (port === undefined) return 'unavailable';
  try {
    return await port.rekey(uploadId);
  } catch {
    return 'unavailable';
  }
}

function blockedUploadsError(count: number): RotationError {
  return {
    ok: false,
    code: 'ROTATION_BLOCKED_BY_ACTIVE_UPLOADS',
    message:
      `${count} upload session(s) could not be re-keyed; finish or cancel ` +
      'them, or let the session renew so its envelope can be re-sealed, then retry.',
    blockedUploads: count,
  };
}

/**
 * Prove every live session envelope opens under the new key: `/rekey` is
 * idempotent — it opens the stored envelope first, so a 'resealed' verdict
 * is proof, and an 'unavailable' verdict gates the run. Returns the count
 * of sessions proven re-sealed and the count still unavailable.
 */
async function proveUploadSessions(
  db: D1Database,
  port: UploadSessionRekeyPort | undefined,
): Promise<{ proved: number; unavailable: number }> {
  let proved = 0;
  let unavailable = 0;
  let cursor = '';
  for (;;) {
    const ids = await listRekeyableUploads(db, cursor, DEFAULT_ROTATION_BATCH);
    if (ids.length === 0) break;
    for (const id of ids) {
      cursor = id;
      const outcome = await rekeyOutcome(port, id);
      if (outcome === 'unavailable') {
        unavailable += 1;
      } else if (outcome === 'resealed') {
        proved += 1;
      }
    }
    if (ids.length < DEFAULT_ROTATION_BATCH) break;
  }
  return { proved, unavailable };
}

// ---------------------------------------------------------------------------
// Rotation lifecycle
// ---------------------------------------------------------------------------

function fail<T extends RotationErrorCode>(
  code: T,
  message: string,
): RotationError {
  return { ok: false, code, message };
}

async function envelopeTotals(
  db: D1Database,
): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const source of ENVELOPE_SOURCES) {
    const row = await db.prepare(source.count).first<{ n: number }>();
    totals[source.name] = row?.n ?? 0;
  }
  return totals;
}

export async function getRotationStatus(
  env: RotationEnv,
): Promise<RotationStatus> {
  const state = await readMaintenanceState(env.DB);
  let totals: Record<string, number> = {};
  try {
    totals = await envelopeTotals(env.DB);
  } catch {
    totals = {};
  }
  const iso = (ms: number | null): string | null =>
    ms === null || ms === 0 ? null : new Date(ms).toISOString();
  return {
    mode: state.mode,
    phase: state.phase,
    fromKeyLabel: state.fromKeyLabel,
    toKeyLabel: state.toKeyLabel,
    processedCount: state.processedCount,
    verifiedCount: state.verifiedCount,
    envelopeTotals: totals,
    uploadSessions: uploadSessionProgress(state),
    lastError: state.lastError,
    startedAt: iso(state.createdAt),
    updatedAt: state.updatedAt === 0 ? null : new Date(state.updatedAt).toISOString(),
    completedAt: iso(state.completedAt),
  };
}

/**
 * Enter maintenance mode and begin (or idempotently report) a rotation.
 * Requires APP_MASTER_KEY (still opens 'v1' envelopes) and
 * APP_MASTER_KEY_NEXT (the key envelopes are resealed under). The recorded
 * to-key label is the non-secret fingerprint of NEXT — envelopes sealed
 * during the run carry it as their keyId.
 */
export async function startRotation(
  env: RotationEnv,
  options: { now?: () => number } = {},
): Promise<MaintenanceStateRow | RotationError> {
  const now = options.now ?? Date.now;
  if (env.APP_MASTER_KEY === undefined || env.APP_MASTER_KEY === '') {
    return fail('STORAGE_ERROR', 'APP_MASTER_KEY is missing.');
  }
  let toKeyLabel: string;
  try {
    if (env.APP_MASTER_KEY_NEXT === undefined || env.APP_MASTER_KEY_NEXT === '') {
      return fail(
        'NEXT_KEY_MISSING',
        'APP_MASTER_KEY_NEXT must be set before a rotation can start.',
      );
    }
    toKeyLabel = await masterKeyLabel(env.APP_MASTER_KEY_NEXT);
  } catch {
    return fail(
      'NEXT_KEY_INVALID',
      'APP_MASTER_KEY_NEXT must be canonical base64 decoding to 32 bytes.',
    );
  }
  // Active uploads no longer refuse the start: the run re-keys their
  // session envelopes in place via the checkpointed upload_sessions
  // pseudo-source, and verify/complete refuse only while a session
  // reports unavailable/unrekeyable (wave-5 frozen decision 6).

  const nowMs = now();
  // Guarded claim: only an 'off' singleton may enter rotation. A repeated
  // start while a run is active is reported, never restarted — restarting
  // means resuming `step`/`verify` from the recorded checkpoint.
  const claimed = await env.DB
    .prepare(
      'INSERT INTO maintenance_state ' +
        '(id, mode, phase, from_key_label, to_key_label, checkpoint, ' +
        'processed_count, verified_count, created_at, updated_at) ' +
        "SELECT 1, 'key-rotation', 'reencrypting', 'v1', ?, '{}', 0, 0, ?, ? " +
        'WHERE NOT EXISTS (SELECT 1 FROM maintenance_state WHERE id = 1)',
    )
    .bind(toKeyLabel, nowMs, nowMs)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) {
    const reclaimed = await env.DB
      .prepare(
        "UPDATE maintenance_state SET mode = 'key-rotation', phase = 'reencrypting', " +
          "from_key_label = 'v1', to_key_label = ?, checkpoint = '{}', " +
          'processed_count = 0, verified_count = 0, last_error = NULL, ' +
          'created_at = ?, updated_at = ?, completed_at = NULL ' +
          "WHERE id = 1 AND mode = 'off'",
      )
      .bind(toKeyLabel, nowMs, nowMs)
      .run();
    if ((reclaimed.meta.changes ?? 0) === 0) {
      const state = await readMaintenanceState(env.DB);
      if (state.mode === 'key-rotation') {
        // Idempotent start: report the in-flight run so callers resume it.
        return state;
      }
      return fail(
        'ROTATION_IN_WRONG_PHASE',
        'Cannot start a rotation while another maintenance mode is active.',
      );
    }
  }
  return readMaintenanceState(env.DB);
}

/**
 * Advance re-encryption by at most `batchSize` rows across the envelope
 * sources, checkpointing progress after each source. Idempotent: a row
 * that already opens under the new key counts as processed without being
 * rewritten, so a step retried after a crash continues cleanly. A row
 * that opens under NEITHER key halts the run in 'failed' — it is corrupt
 * for every key this deployment knows; investigate before re-stepping.
 */
export async function stepRotation(
  env: RotationEnv,
  options: {
    batchSize?: number;
    now?: () => number;
    rekey?: UploadSessionRekeyPort;
  } = {},
): Promise<RotationStepResult | RotationError> {
  const now = options.now ?? Date.now;
  const batchSize = Math.min(
    Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_ROTATION_BATCH)),
    MAX_ROTATION_BATCH,
  );
  const state = await readMaintenanceState(env.DB);
  if (state.mode !== 'key-rotation' || (state.phase !== 'reencrypting' && state.phase !== 'failed')) {
    return fail(
      'ROTATION_IN_WRONG_PHASE',
      'Rotation is not in the re-encryption phase.',
    );
  }
  let toLabel: string;
  try {
    if (env.APP_MASTER_KEY_NEXT === undefined || env.APP_MASTER_KEY_NEXT === '') {
      return fail(
        'NEXT_KEY_MISSING',
        'APP_MASTER_KEY_NEXT was removed before the rotation completed.',
      );
    }
    toLabel = await nextKeyLabel(env);
  } catch {
    return fail(
      'NEXT_KEY_INVALID',
      'APP_MASTER_KEY_NEXT is not a valid 32-byte base64 key.',
    );
  }
  const ring = keyring(env);
  if (state.phase === 'failed') {
    // Resume after inspection: drop back into re-encryption and continue
    // from the recorded checkpoint.
    await env.DB
      .prepare(
        "UPDATE maintenance_state SET phase = 'reencrypting', last_error = NULL, " +
          'updated_at = ? WHERE id = 1',
      )
      .bind(now())
      .run();
  }

  const sources = { ...state.checkpoint.sources };
  let processed = 0;
  let processedTotal = state.processedCount;
  let activeSource: string | null = null;
  let blockedUploads: number | undefined;
  const nowMs = now();

  for (const source of ENVELOPE_SOURCES) {
    if (processed >= batchSize) break;
    const progress = sources[source.name] ?? {
      cursor: '',
      done: false,
      processed: 0,
    };
    if (progress.done) continue;
    activeSource = source.name;

    const requested = batchSize - processed;
    const rows = await env.DB
      .prepare(source.select)
      .bind(progress.cursor, requested)
      .all<EnvelopeSourceRow>();
    const batch = rows.results ?? [];

    let cursor = progress.cursor;
    let count = progress.processed;
    let consumedAll = true;
    for (const row of batch) {
      if (row.envelope !== null) {
        const context = source.context(row);
        let envelope;
        try {
          envelope = decodeEnvelope(row.envelope);
        } catch {
          await failRotation(env.DB, source.name, row.id, 'malformed envelope', now());
          return { phase: 'failed', source: source.name, processed, remaining: true };
        }
        if (envelope.keyId === toLabel) {
          // W4-R1 #2: a toLabel row must still PROVE it opens. Skipping it
          // by label alone let a corrupt resealed envelope live forever —
          // verify flagged it, reset the cursor, step skipped it again →
          // infinite verify↔step loop. Open it here instead; a failure is
          // a hard run failure, not another retry.
          try {
            await ring.openSecret(envelope, context);
          } catch {
            await failRotation(
              env.DB,
              source.name,
              row.id,
              'resealed envelope fails to open',
              now(),
            );
            return { phase: 'failed', source: source.name, processed, remaining: true };
          }
        } else {
          let plaintext: Uint8Array;
          try {
            plaintext = await ring.openSecret(envelope, context);
          } catch {
            await failRotation(env.DB, source.name, row.id, 'opens under no known key', now());
            return { phase: 'failed', source: source.name, processed, remaining: true };
          }
          const resealedEnvelope = await ring.sealSecret(plaintext, context);
          const resealed = JSON.stringify({
            version: resealedEnvelope.version,
            keyId: resealedEnvelope.keyId,
            nonce: resealedEnvelope.nonce,
            ciphertext: resealedEnvelope.ciphertext,
          });
          // CAS on the old ciphertext: a concurrent writer that changed the
          // envelope (e.g. a refresh-token rotation CAS) wins — the row is
          // retried on the next step instead of being clobbered.
          const updated = await env.DB
            .prepare(source.update)
            .bind(resealed, nowMs, row.id, row.envelope)
            .run();
          if ((updated.meta.changes ?? 0) !== 1) {
            // W4-R1 #4: break WITHOUT advancing the cursor — the missed
            // row must be re-read and retried by the next step, not
            // rescued only by the verify full-rescan.
            consumedAll = false;
            break;
          }
        }
        count += 1;
        processed += 1;
        processedTotal += 1;
      }
      // The cursor only ever lands on a fully processed row.
      cursor = row.id;
    }

    // Done when we scanned to the end of the table (a short page) without
    // leaving an unprocessed row behind.
    const sourceDone = consumedAll && batch.length < requested;
    sources[source.name] = { cursor, done: sourceDone, processed: count };
    await persistCheckpoint(env.DB, sources, processedTotal, now());
    if (!sourceDone) break;
  }

  // UploadSession session envelopes (wave-5): once every D1 source is
  // done, re-key each non-terminal upload operation's DO envelope in the
  // same bounded, checkpointed way. An 'unavailable' verdict does NOT stop
  // the scan — the op is recorded blocked and the cursor moves past it so
  // the rest still get re-keyed; verify/complete re-scan live and refuse
  // while any op remains unrekeyable. The DO writes the envelope itself
  // with a guard on the value it opened, so a concurrent session write
  // racing this rekey can never be clobbered (CAS).
  const d1Done = ENVELOPE_SOURCES.every((s) => sources[s.name]?.done === true);
  if (d1Done && processed < batchSize) {
    const progress = sources[REKEY_SOURCE] ?? {
      cursor: '',
      done: false,
      processed: 0,
    };
    if (!progress.done) {
      activeSource = REKEY_SOURCE;
      const requested = batchSize - processed;
      const ids = await listRekeyableUploads(
        env.DB,
        progress.cursor,
        requested,
      );
      const port = rekeyPortFor(env, options);
      let cursor = progress.cursor;
      let count = progress.processed;
      let blocked = progress.blocked ?? 0;
      for (const id of ids) {
        const outcome = await rekeyOutcome(port, id);
        if (outcome === 'unavailable') {
          blocked += 1;
        } else {
          count += 1;
          processed += 1;
          processedTotal += 1;
        }
        // The cursor advances past blocked ops too — verify's live
        // re-scan recounts them, so a scan past is never a skipped proof.
        cursor = id;
      }
      const sourceDone = ids.length < requested;
      sources[REKEY_SOURCE] = {
        cursor,
        done: sourceDone,
        processed: count,
        blocked,
      };
      await persistCheckpoint(env.DB, sources, processedTotal, now());
    }
    blockedUploads = sources[REKEY_SOURCE]?.blocked ?? 0;
  }

  const allDone =
    d1Done && sources[REKEY_SOURCE]?.done === true;
  if (allDone) {
    await env.DB
      .prepare(
        "UPDATE maintenance_state SET phase = 'verifying', checkpoint = ?, " +
          'processed_count = ?, updated_at = ? WHERE id = 1',
      )
      .bind(JSON.stringify({ sources }), processedTotal, now())
      .run();
    return {
      phase: 'verifying',
      source: activeSource,
      processed,
      remaining: false,
      ...(blockedUploads === undefined ? {} : { blockedUploads }),
    };
  }
  return {
    phase: 'reencrypting',
    source: activeSource,
    processed,
    remaining: true,
    ...(blockedUploads === undefined ? {} : { blockedUploads }),
  };
}

/**
 * Verify that EVERY envelope in every source opens under the new key.
 * Verification re-scans all rows regardless of checkpoint, because a row
 * could have been rewritten by a concurrent writer after its step. On any
 * failure the run returns to 'reencrypting' with the failed sources'
 * cursors reset so the next step pass re-covers them.
 */
export async function verifyRotation(
  env: RotationEnv,
  options: { now?: () => number; rekey?: UploadSessionRekeyPort } = {},
): Promise<RotationVerifyResult | RotationError> {
  const now = options.now ?? Date.now;
  const state = await readMaintenanceState(env.DB);
  if (state.mode !== 'key-rotation') {
    return fail('ROTATION_IN_WRONG_PHASE', 'No key rotation is active.');
  }
  if (state.phase !== 'verifying' && state.phase !== 'verified') {
    return fail(
      'ROTATION_IN_WRONG_PHASE',
      'Rotation must finish re-encryption before verification.',
    );
  }
  let toLabel: string;
  try {
    if (env.APP_MASTER_KEY_NEXT === undefined || env.APP_MASTER_KEY_NEXT === '') {
      return fail(
        'NEXT_KEY_MISSING',
        'APP_MASTER_KEY_NEXT was removed before verification completed.',
      );
    }
    toLabel = await nextKeyLabel(env);
  } catch {
    return fail('NEXT_KEY_INVALID', 'APP_MASTER_KEY_NEXT is invalid.');
  }
  const ring = keyring(env);

  const failures: Record<string, string[]> = {};
  let verified = 0;
  let failed = 0;
  for (const source of ENVELOPE_SOURCES) {
    let cursor = '';
    for (;;) {
      const rows = await env.DB
        .prepare(source.select)
        .bind(cursor, DEFAULT_ROTATION_BATCH)
        .all<EnvelopeSourceRow>();
      const batch = rows.results ?? [];
      if (batch.length === 0) break;
      for (const row of batch) {
        cursor = row.id;
        if (row.envelope === null) continue;
        // Zero envelopes may remain under the old label: the row counts as
        // verified only when it carries the new key label AND opens.
        let ok = false;
        try {
          const envelope = decodeEnvelope(row.envelope);
          ok =
            envelope.keyId === toLabel &&
            (await tryOpen(ring, envelope, source.context(row)));
        } catch {
          ok = false;
        }
        if (ok) {
          verified += 1;
        } else {
          failed += 1;
          (failures[source.name] ??= []).push(row.id);
        }
      }
      if (batch.length < DEFAULT_ROTATION_BATCH) break;
    }
  }

  const nowMs = now();
  if (failed > 0) {
    // Reset cursors on failed sources so the next step re-covers them.
    const sources = { ...state.checkpoint.sources };
    for (const name of Object.keys(failures)) {
      sources[name] = { cursor: '', done: false, processed: 0 };
    }
    await env.DB
      .prepare(
        "UPDATE maintenance_state SET phase = 'reencrypting', checkpoint = ?, " +
          'last_error = ?, updated_at = ? WHERE id = 1',
      )
      .bind(
        JSON.stringify({ sources }),
        `verify failed for ${failed} envelope(s)`,
        nowMs,
      )
      .run();
    return { ok: false, verified, sessionsProved: 0, failed, failures };
  }

  // Prove every live session envelope now opens under the new key: the
  // idempotent `/rekey` opens before it reports 'resealed', so a re-scan
  // here is both proof and repair. Sessions that still report
  // unavailable/unrekeyable gate the run — count only, never op ids.
  const sessionProof = await proveUploadSessions(
    env.DB,
    rekeyPortFor(env, options),
  );
  if (sessionProof.unavailable > 0) {
    return blockedUploadsError(sessionProof.unavailable);
  }

  await env.DB
    .prepare(
      "UPDATE maintenance_state SET phase = 'verified', verified_count = ?, " +
        'last_error = NULL, updated_at = ? WHERE id = 1',
    )
    .bind(verified, nowMs)
    .run();
  return {
    ok: true,
    verified,
    sessionsProved: sessionProof.proved,
    failed: 0,
    failures: {},
  };
}

/**
 * Complete a verified rotation: revoke every app session (spec §9.2 — a
 * master-key change invalidates all sessions and media tickets; tickets
 * die with the key itself, sessions are deleted here) and clear
 * maintenance mode so admissions resume. Pinned upload writers and every
 * credential identity row are never touched.
 */
export async function completeRotation(
  env: RotationEnv,
  options: { now?: () => number; rekey?: UploadSessionRekeyPort } = {},
): Promise<RotationCompleteResult | RotationError> {
  const now = options.now ?? Date.now;
  const state = await readMaintenanceState(env.DB);
  if (state.mode !== 'key-rotation' || state.phase !== 'verified') {
    return fail(
      'ROTATION_IN_WRONG_PHASE',
      'Rotation must be verified before completion.',
    );
  }
  // Re-prove sessions at completion: a session that turned unrekeyable
  // since verify must not be orphaned by promotion.
  const sessionProof = await proveUploadSessions(
    env.DB,
    rekeyPortFor(env, options),
  );
  if (sessionProof.unavailable > 0) {
    return blockedUploadsError(sessionProof.unavailable);
  }
  const nowMs = now();
  const deleted = await env.DB.prepare('DELETE FROM session').run();
  await env.DB
    .prepare(
      "UPDATE maintenance_state SET mode = 'off', phase = 'done', " +
        'completed_at = ?, updated_at = ? WHERE id = 1',
    )
    .bind(nowMs, nowMs)
    .run();
  return {
    sessionsRevoked: deleted.meta.changes ?? 0,
    completedAt: nowMs,
  };
}

/**
 * Abort a rotation that has not rewritten any envelope yet. Once a single
 * row has been resealed the old key alone can no longer serve every
 * envelope, so abort is refused — the run must complete (or the database
 * restored from backup) before maintenance mode lifts.
 */
export async function abortRotation(
  env: RotationEnv,
  options: { now?: () => number } = {},
): Promise<{ ok: true } | RotationError> {
  const now = options.now ?? Date.now;
  const state = await readMaintenanceState(env.DB);
  if (state.mode !== 'key-rotation') {
    return fail('ROTATION_IN_WRONG_PHASE', 'No key rotation is active.');
  }
  if (
    state.processedCount > 0 ||
    state.phase === 'verifying' ||
    state.phase === 'verified'
  ) {
    return fail(
      'ROTATION_NOT_ABORTABLE',
      'Envelopes have already been re-sealed; abort is unsafe. Complete the rotation or restore a backup.',
    );
  }
  await env.DB
    .prepare(
      "UPDATE maintenance_state SET mode = 'off', phase = 'idle', " +
        'from_key_label = NULL, to_key_label = NULL, last_error = NULL, ' +
        'updated_at = ? WHERE id = 1',
    )
    .bind(now())
    .run();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function tryOpen(
  box: KeyringBox<string>,
  envelope: Parameters<KeyringBox<string>['openSecret']>[0],
  context: SecretContext<string>,
): Promise<boolean> {
  try {
    await box.openSecret(envelope, context);
    return true;
  } catch {
    return false;
  }
}

async function persistCheckpoint(
  db: D1Database,
  sources: Record<string, SourceCheckpoint>,
  processedCount: number,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      'UPDATE maintenance_state SET checkpoint = ?, processed_count = ?, ' +
        'updated_at = ? WHERE id = 1',
    )
    .bind(JSON.stringify({ sources }), processedCount, nowMs)
    .run();
}

async function failRotation(
  db: D1Database,
  source: string,
  rowId: string,
  reason: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE maintenance_state SET phase = 'failed', last_error = ?, " +
        'updated_at = ? WHERE id = 1',
    )
    .bind(`${source}/${rowId}: ${reason}`, nowMs)
    .run();
}
