import { DurableObject } from 'cloudflare:workers';
import type { DriveFileMeta } from '../drive/types';
import { FOLDER_MIME_TYPE } from '../drive/providers/common';
import type { UploadState } from '../../shared/contracts/uploads';
import {
  decimalBytesFromBigInt,
  decimalBytesToBigInt,
  type DecimalBytes,
  type ReaderAccessState,
} from '../../shared/contracts/common';
import {
  createSecretKeyring,
  decodeEnvelope,
  encodeEnvelope,
  masterKeyLabel,
  type KeyringBox,
} from '../security/vault';
import { isMaintenanceActive } from '../security/rotation';
import type {
  AttemptView,
  ClaimChunkCommand,
  ClaimProbeCommand,
  DoErrorCode,
  EventCommand,
  InitializeCommand,
  IntentCommand,
  PinnedUploadWriter,
  UploadDirective,
  UploadSessionSnapshot,
} from '../transfers/upload-internal';
import { DEFAULT_ATTEMPT_LEASE_MS, DO_ORIGIN } from '../transfers/upload-internal';

/**
 * UploadSession — one SQLite Durable Object per upload operation.
 *
 * This is the canonical upload state machine (spec §6.2–6.5): it owns the
 * pinned OAuth writer tuple, the generated Drive file ID, the sealed
 * resumable-session URI, the session generation, the confirmed offset and
 * every attempt lease. D1 holds only a projection/idempotency index and
 * never decides the next byte.
 *
 * The DO never receives file bytes and never performs network I/O. Every
 * mutating request is a command or an attempt-fenced event; each response
 * returns the canonical snapshot plus the next directive for the ordinary
 * Worker to execute (generate ID, remote init, probe, lookup, renew, verify,
 * trash, check-writer). Every remote-result event must name the exact
 * attempt and generation claimed for it — late results from fenced or older
 * generations are rejected and can never move canonical state.
 *
 * All durable transitions happen inside synchronous SQLite blocks, so
 * concurrent requests cannot interleave between a claim check and its
 * write — the single-threaded isolate makes each block atomic.
 */

const TERMINAL_STATES = new Set<UploadState>([
  'completed',
  'cancelled',
  'expired',
  'conflict',
  'cleanup_pending',
]);

/** Which event types each attempt kind may commit (R2: every remote result
 * is fenced to the attempt and generation that claimed it). */
const EVENT_KINDS_BY_ATTEMPT: Record<string, ReadonlySet<string>> = {
  init: new Set(['generated-id', 'remote-init-intent', 'remote-init-result']),
  chunk: new Set([
    'chunk-incomplete',
    'chunk-completed',
    'chunk-outcome-unknown',
    'chunk-session-expired',
    'chunk-blocked',
  ]),
  probe: new Set([
    'probe-incomplete',
    'probe-completed',
    'probe-session-expired',
    'probe-unknown',
    'probe-blocked',
    'lookup-found',
    'lookup-absent',
    'lookup-blocked',
    'writer-status',
  ]),
  renew: new Set(['renew-result', 'lookup-found', 'lookup-absent', 'lookup-blocked']),
  verify: new Set(['verify-result']),
  trash: new Set(['trash-result']),
};

const NON_ATTEMPT_EVENTS = new Set(['reader-access']);

/**
 * Uncertain-write tracking (R4). A dropped response never proves the
 * remote request died — a held PUT can still create the file — so a
 * fenced/unknown write attempt is marked uncertain and stays marked until
 * POSITIVE remote evidence settles it: a probe whose Range covers the
 * attempt's byte range, the pinned file found, a dead session, or a
 * definitive remote verdict arriving late for that exact attempt. There
 * is deliberately NO wall-clock settlement: while uncertain, no competing
 * PUT claim is granted and cancel cannot go terminal on a mere 404 —
 * the operation holds recoverable cleanup_pending instead.
 */
export const UNRESOLVED_WRITES_REASON = 'unresolved-writes';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface SessionRow {
  upload_id: string;
  owner_id: string;
  mount_id: string;
  kind: string;
  input_hash: string;
  parent_id: string;
  name: string;
  mime_type: string;
  total_bytes: string;
  sha256: string;
  md5: string;
  batch_id: string | null;
  node_id: string | null;
  chunk_size: number;
  state: string;
  init_phase: string;
  pinned_json: string;
  generated_file_id: string | null;
  session_uri_envelope: string | null;
  session_generation: number;
  confirmed_offset: string;
  remote_init_attempted: number;
  session_expired: number;
  probe_done: number;
  lookup_done: number;
  file_trashed: number;
  pause_requested: number;
  cancel_requested: number;
  uncertain_attempt_id: string | null;
  uncertain_kind: string | null;
  uncertain_end: string | null;
  active_attempt_id: string | null;
  block_reason: string | null;
  pending_file_json: string | null;
  result: string | null;
  reader_access_state: string;
  reader_checked_ms: number | null;
  reader_pool_version: number | null;
  reader_policy_version: number | null;
  reader_reason: string | null;
  attempt_seq: number;
  state_version: number;
  created_ms: number;
  updated_ms: number;
  completed_ms: number | null;
}

interface AttemptRow {
  attempt_id: string;
  kind: string;
  generation: number;
  offset: string | null;
  length: number | null;
  status: string;
  lease_until_ms: number;
  created_ms: number;
  finished_ms: number | null;
}

function errorResponse(
  status: number,
  code: DoErrorCode,
  message: string,
): Response {
  return Response.json({ ok: false, code, message, status }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export class UploadSession extends DurableObject<Env> {
  private storageInitialized = false;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== DO_ORIGIN) {
      return errorResponse(400, 'INVALID_COMMAND', 'unexpected origin');
    }
    try {
      if (request.method === 'GET' && url.pathname === '/snapshot') {
        const rec = this.readRecord();
        if (rec === undefined) {
          return errorResponse(
            404,
            'NOT_INITIALIZED',
            'upload session is not initialized',
          );
        }
        return this.reply(rec, { kind: 'none' });
      }
      if (request.method !== 'POST') {
        return errorResponse(404, 'INVALID_COMMAND', 'not found');
      }
      const body = await request.json().catch(() => undefined);
      if (!isRecord(body)) {
        return errorResponse(
          400,
          'INVALID_COMMAND',
          'command body must be a JSON object',
        );
      }
      switch (url.pathname) {
        case '/initialize':
          return await this.initialize(body);
        case '/claim':
          return await this.claimChunk(body);
        case '/probe':
          return await this.reconcile(body);
        case '/pause':
          return this.pause(body);
        case '/resume':
          return this.resume(body);
        case '/cancel':
          return await this.cancel(body);
        case '/event':
          return await this.event(body);
        case '/rekey':
          return await this.rekey(body);
        default:
          return errorResponse(404, 'INVALID_COMMAND', 'not found');
      }
    } catch {
      return errorResponse(500, 'STORAGE_ERROR', 'durable operation failed');
    }
  }

  private reply(
    rec: SessionRow,
    directive: UploadDirective,
    applied?: boolean,
  ): Response {
    return Response.json({
      ok: true,
      snapshot: this.snapshot(rec),
      directive,
      ...(applied === undefined ? {} : { applied }),
    });
  }

  // -----------------------------------------------------------------------
  // Durable storage
  // -----------------------------------------------------------------------

  private ensureStorage(): void {
    if (this.storageInitialized) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS session (' +
        'id INTEGER PRIMARY KEY CHECK (id = 1), ' +
        'upload_id TEXT NOT NULL, owner_id TEXT NOT NULL, mount_id TEXT NOT NULL, ' +
        'kind TEXT NOT NULL, input_hash TEXT NOT NULL, parent_id TEXT NOT NULL, ' +
        'name TEXT NOT NULL, mime_type TEXT NOT NULL, total_bytes TEXT NOT NULL, ' +
        'sha256 TEXT NOT NULL, md5 TEXT NOT NULL, ' +
        'batch_id TEXT, node_id TEXT, chunk_size INTEGER NOT NULL, ' +
        'state TEXT NOT NULL, init_phase TEXT NOT NULL, pinned_json TEXT NOT NULL, ' +
        'generated_file_id TEXT, session_uri_envelope TEXT, ' +
        'session_generation INTEGER NOT NULL, confirmed_offset TEXT NOT NULL, ' +
        'remote_init_attempted INTEGER NOT NULL, session_expired INTEGER NOT NULL, ' +
        'probe_done INTEGER NOT NULL, lookup_done INTEGER NOT NULL, ' +
        'file_trashed INTEGER NOT NULL, ' +
        'pause_requested INTEGER NOT NULL, cancel_requested INTEGER NOT NULL, ' +
        'uncertain_attempt_id TEXT, uncertain_kind TEXT, ' +
        'uncertain_end TEXT, ' +
        'active_attempt_id TEXT, block_reason TEXT, pending_file_json TEXT, ' +
        'result TEXT, ' +
        'reader_access_state TEXT NOT NULL, reader_checked_ms INTEGER, ' +
        'reader_pool_version INTEGER, reader_policy_version INTEGER, ' +
        'reader_reason TEXT, attempt_seq INTEGER NOT NULL, ' +
        'state_version INTEGER NOT NULL DEFAULT 0, ' +
        'created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, ' +
        'completed_ms INTEGER)',
    );
    // Older storages get missing columns added once.
    const cols = this.ctx.storage.sql
      .exec('PRAGMA table_info(session)')
      .toArray() as unknown as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('state_version')) {
      this.ctx.storage.sql.exec(
        'ALTER TABLE session ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0',
      );
    }
    if (!have.has('uncertain_attempt_id')) {
      this.ctx.storage.sql.exec(
        'ALTER TABLE session ADD COLUMN uncertain_attempt_id TEXT',
      );
    }
    if (!have.has('uncertain_kind')) {
      this.ctx.storage.sql.exec(
        'ALTER TABLE session ADD COLUMN uncertain_kind TEXT',
      );
    }
    if (!have.has('uncertain_end')) {
      this.ctx.storage.sql.exec(
        'ALTER TABLE session ADD COLUMN uncertain_end TEXT',
      );
    }
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS attempts (' +
        'attempt_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ' +
        'generation INTEGER NOT NULL, offset TEXT, length INTEGER, ' +
        'status TEXT NOT NULL, lease_until_ms INTEGER NOT NULL, ' +
        'created_ms INTEGER NOT NULL, finished_ms INTEGER)',
    );
    this.storageInitialized = true;
  }

  private readRecord(): SessionRow | undefined {
    this.ensureStorage();
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM session WHERE id = 1')
      .toArray() as unknown as SessionRow[];
    return rows[0];
  }

  /**
   * Synchronous single-statement record update. Every canonical mutation
   * bumps state_version — the D1 projection is ordered by it, never by
   * wall-clock (R7).
   */
  private updateRecord(fields: Record<string, unknown>, now: number): void {
    const assignments = Object.keys(fields)
      .map((key) => `${key} = ?`)
      .join(', ');
    this.ctx.storage.sql.exec(
      `UPDATE session SET ${assignments}, updated_ms = ?, ` +
        'state_version = state_version + 1 WHERE id = 1',
      ...Object.values(fields).map((v) => (v === undefined ? null : v)),
      now,
    );
  }

  private readAttempt(attemptId: string): AttemptRow | undefined {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM attempts WHERE attempt_id = ?', attemptId)
      .toArray() as unknown as AttemptRow[];
    return rows[0];
  }

  /** Claim a fresh attempt; the caller already proved none is active. */
  private claimAttempt(
    rec: SessionRow,
    kind: string,
    generation: number,
    now: number,
    leaseMs: number,
    offset?: string,
    length?: number,
  ): AttemptRow {
    const seq = rec.attempt_seq + 1;
    const attemptId = `${kind}-${seq}`;
    this.ctx.storage.sql.exec(
      'INSERT INTO attempts (attempt_id, kind, generation, offset, length, status, lease_until_ms, created_ms) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      attemptId,
      kind,
      generation,
      offset ?? null,
      length ?? null,
      'active',
      now + leaseMs,
      now,
    );
    this.updateRecord(
      { active_attempt_id: attemptId, attempt_seq: seq },
      now,
    );
    return {
      attempt_id: attemptId,
      kind,
      generation,
      offset: offset ?? null,
      length: length ?? null,
      status: 'active',
      lease_until_ms: now + leaseMs,
      created_ms: now,
      finished_ms: null,
    };
  }

  private finishAttempt(
    attempt: AttemptRow,
    status: 'committed' | 'unknown' | 'fenced' | 'failed',
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      'UPDATE attempts SET status = ?, finished_ms = ? WHERE attempt_id = ?',
      status,
      now,
      attempt.attempt_id,
    );
  }

  /**
   * Fence the active attempt when its lease elapsed. Returns true when an
   * attempt was fenced. Lease expiry alone proves nothing about the remote
   * side: the request may still be running, so write attempts are marked
   * uncertain — it never authorizes a competing PUT (spec §6.4, R4).
   */
  private fenceExpiredAttempt(rec: SessionRow, now: number): boolean {
    if (rec.active_attempt_id === null) return false;
    const attempt = this.readAttempt(rec.active_attempt_id);
    if (attempt === undefined) {
      this.updateRecord({ active_attempt_id: null }, now);
      return false;
    }
    if (attempt.lease_until_ms > now) return false;
    this.finishAttempt(attempt, 'fenced', now);
    this.updateRecord({ active_attempt_id: null }, now);
    this.markUncertain(rec, attempt, now);
    return true;
  }

  /** Byte position an uncertain write may cover (chunk end / file end). */
  private attemptEnd(rec: SessionRow, attempt: AttemptRow): string {
    if (attempt.kind === 'chunk' && attempt.offset !== null && attempt.length !== null) {
      return decimalBytesFromBigInt(
        decimalBytesToBigInt(attempt.offset as DecimalBytes) +
          BigInt(attempt.length),
      );
    }
    return rec.total_bytes;
  }

  /**
   * Mark a write attempt uncertain: its remote request may still land. At
   * most one write attempt is ever live/uncertain because no new claim is
   * granted while one is unresolved.
   */
  private markUncertain(
    rec: SessionRow,
    attempt: AttemptRow,
    now: number,
  ): void {
    if (
      attempt.kind !== 'chunk' &&
      attempt.kind !== 'init' &&
      attempt.kind !== 'renew'
    ) {
      return;
    }
    if (
      (attempt.kind === 'init' || attempt.kind === 'renew') &&
      rec.remote_init_attempted === 0
    ) {
      return;
    }
    this.updateRecord(
      {
        uncertain_attempt_id: attempt.attempt_id,
        uncertain_kind: attempt.kind,
        uncertain_end: this.attemptEnd(rec, attempt),
      },
      now,
    );
  }

  /**
   * An uncertain write stays marked until positive remote evidence clears
   * it — never on a timer. `uncertain_end` is the byte position the write
   * may cover; a probe reporting a Range at or past it settles the write.
   */
  private uncertainPending(rec: SessionRow): boolean {
    return rec.uncertain_attempt_id !== null;
  }

  /** Positive remote evidence settles the write (clears the marker). */
  private clearUncertain(now: number): void {
    this.updateRecord(
      {
        uncertain_attempt_id: null,
        uncertain_kind: null,
        uncertain_end: null,
      },
      now,
    );
  }

  // -----------------------------------------------------------------------
  // Snapshot
  // -----------------------------------------------------------------------

  private snapshot(rec: SessionRow): UploadSessionSnapshot {
    const pinned = JSON.parse(rec.pinned_json) as PinnedUploadWriter;
    const active = rec.active_attempt_id
      ? this.readAttempt(rec.active_attempt_id)
      : undefined;
    return {
      uploadId: rec.upload_id,
      ownerId: rec.owner_id,
      mountId: rec.mount_id,
      kind: rec.kind as 'file' | 'folder',
      inputHash: rec.input_hash,
      parentId: rec.parent_id,
      name: rec.name,
      mimeType: rec.mime_type,
      totalBytes: rec.total_bytes as DecimalBytes,
      sha256: rec.sha256,
      md5: rec.md5,
      ...(rec.batch_id === null ? {} : { batchId: rec.batch_id }),
      ...(rec.node_id === null ? {} : { nodeId: rec.node_id }),
      state: rec.state as UploadState,
      initPhase: rec.init_phase as UploadSessionSnapshot['initPhase'],
      pinned,
      ...(rec.generated_file_id === null
        ? {}
        : { generatedFileId: rec.generated_file_id }),
      sessionGeneration: rec.session_generation,
      confirmedOffset: rec.confirmed_offset as DecimalBytes,
      chunkSize: rec.chunk_size,
      hasSessionUri: rec.session_uri_envelope !== null,
      remoteInitAttempted: rec.remote_init_attempted === 1,
      sessionExpired: rec.session_expired === 1,
      pauseRequested: rec.pause_requested === 1,
      cancelRequested: rec.cancel_requested === 1,
      ...(active === undefined
        ? {}
        : {
            activeAttempt: {
              attemptId: active.attempt_id,
              kind: active.kind as AttemptView['kind'],
              generation: active.generation,
              ...(active.offset === null
                ? {}
                : { offset: active.offset as DecimalBytes }),
              ...(active.length === null ? {} : { length: active.length }),
              leaseUntilMs: active.lease_until_ms,
            } satisfies AttemptView,
          }),
      ...(rec.block_reason === null ? {} : { blockReason: rec.block_reason }),
      ...(rec.pending_file_json === null
        ? {}
        : { pendingFile: JSON.parse(rec.pending_file_json) as DriveFileMeta }),
      ...(rec.result === null ? {} : { result: rec.result }),
      readerAccessState: rec.reader_access_state as ReaderAccessState,
      ...(rec.reader_checked_ms === null
        ? {}
        : { readerCheckedMs: rec.reader_checked_ms }),
      ...(rec.reader_pool_version === null
        ? {}
        : { readerPoolVersion: rec.reader_pool_version }),
      ...(rec.reader_policy_version === null
        ? {}
        : { readerPolicyVersion: rec.reader_policy_version }),
      ...(rec.reader_reason === null ? {} : { readerReason: rec.reader_reason }),
      createdMs: rec.created_ms,
      updatedMs: rec.updated_ms,
      ...(rec.completed_ms === null ? {} : { completedMs: rec.completed_ms }),
      stateVersion: rec.state_version,
    };
  }

  // -----------------------------------------------------------------------
  // Session-URI sealing (spec §6.2: validated and encrypted before storage)
  // -----------------------------------------------------------------------

  /**
   * Session-URI envelopes ride the vault keyring (W4-R1 #3): opens select
   * the key by the envelope's own keyId, and seals land on
   * APP_MASTER_KEY_NEXT whenever a next key is staged, else
   * APP_MASTER_KEY — so envelopes minted inside a rotation window carry
   * the fingerprint label and still open after promotion. The keyring is
   * rebuilt per call so a staged/unstaged NEXT is always honored.
   */
  private box(): KeyringBox<string> {
    return createSecretKeyring<string>(this.env, 'upload-session');
  }

  private sealContext(rec: SessionRow): {
    provider: string;
    recordId: string;
    projectId: string;
    kind: string;
  } {
    const pinned = JSON.parse(rec.pinned_json) as PinnedUploadWriter;
    return {
      provider: 'google-oauth',
      recordId: rec.upload_id,
      projectId: pinned.projectId,
      kind: 'resumable-session',
    };
  }

  private async sealSessionUri(
    rec: SessionRow,
    uri: string,
  ): Promise<string> {
    const envelope = await this.box().sealSecret(
      textEncoder.encode(uri),
      this.sealContext(rec),
    );
    return encodeEnvelope(envelope);
  }

  private async openSessionUri(
    rec: SessionRow,
  ): Promise<
    | { kind: 'absent' }
    | { kind: 'unopenable' }
    | { kind: 'uri'; uri: string }
  > {
    if (rec.session_uri_envelope === null) return { kind: 'absent' };
    try {
      const plain = await this.box().openSecret(
        decodeEnvelope(rec.session_uri_envelope),
        this.sealContext(rec),
      );
      return { kind: 'uri', uri: textDecoder.decode(plain) };
    } catch {
      // The envelope opens under no key this deployment knows (wrong key,
      // corruption, or a keyId outside the keyring). This is a DEAD
      // session from the DO's perspective — callers must route it through
      // the renew path, never silently drop the directive (W4-R1 #3).
      return { kind: 'unopenable' };
    }
  }

  private pinned(rec: SessionRow): PinnedUploadWriter {
    return JSON.parse(rec.pinned_json) as PinnedUploadWriter;
  }

  private pendingFile(rec: SessionRow): DriveFileMeta | undefined {
    if (rec.pending_file_json === null) return undefined;
    return JSON.parse(rec.pending_file_json) as DriveFileMeta;
  }

  // -----------------------------------------------------------------------
  // Directive derivation
  // -----------------------------------------------------------------------

  /**
   * Compute the next remote step from durable state and claim its attempt
   * inside the same synchronous block. Chain markers (session_expired,
   * probe_done, lookup_done, pending file, file_trashed) encode where the
   * chain stands, so a crashed step resumes correctly under a new attempt.
   *
   * Cancel chain (R4): a probe 308 does NOT prove a fenced PUT stopped —
   * the generated file may still be created late — so cancellation always
   * performs a generated-ID lookup before going terminal, and stays
   * recoverable through reconcile afterwards.
   */
  private deriveDirective(
    rec: SessionRow,
    now: number,
    leaseMs: number,
  ): UploadDirective {
    if (rec.active_attempt_id !== null) return { kind: 'none' };
    const writer = this.pinned(rec);
    const cancel = rec.cancel_requested === 1;
    const gen = rec.session_generation;

    if (rec.state === 'preparing') {
      if (rec.init_phase === 'generate-id') {
        const a = this.claimAttempt(rec, 'init', 0, now, leaseMs);
        return { kind: 'generate-id', attemptId: a.attempt_id, generation: 0, writer };
      }
      if (rec.init_phase === 'start' && rec.generated_file_id !== null) {
        const a = this.claimAttempt(rec, 'init', 0, now, leaseMs);
        return {
          kind: 'remote-init',
          attemptId: a.attempt_id,
          generation: 0,
          writer,
          generatedFileId: rec.generated_file_id,
          lookupFirst: rec.remote_init_attempted === 1,
          upload: {
            kind: rec.kind as 'file' | 'folder',
            parentId: rec.parent_id,
            name: rec.name,
            mimeType: rec.mime_type,
            totalBytes: rec.total_bytes as DecimalBytes,
          },
        };
      }
      return { kind: 'none' };
    }

    if (rec.state === 'verifying') {
      const fileId = rec.generated_file_id;
      if (fileId === null) return { kind: 'none' };
      const pending = this.pendingFile(rec);
      const a = this.claimAttempt(rec, 'verify', gen, now, leaseMs);
      return {
        kind: 'verify',
        attemptId: a.attempt_id,
        generation: gen,
        writer,
        fileId,
        expected: {
          parentId: rec.parent_id,
          driveId: writer.driveId,
          totalBytes: rec.total_bytes as DecimalBytes,
          sha256: rec.sha256,
          md5: rec.md5,
        },
        ...(pending === undefined ? {} : { hint: pending }),
      };
    }

    if (
      rec.state === 'reconciling' ||
      rec.state === 'cancel_requested' ||
      (cancel && rec.state === 'cancelled')
    ) {
      const pending = this.pendingFile(rec);
      if (cancel && pending !== undefined) {
        // Trash only ever targets the exact pinned generated ID — a file
        // reported under a different identity is never touched (R8).
        if (pending.id !== rec.generated_file_id) {
          const fields = {
            state: 'cleanup_pending',
            completed_ms: now,
            block_reason: 'pinned file identity mismatch',
          };
          this.updateRecord(
            {
              ...fields,
              result: JSON.stringify({
                outcome: 'cleanup_pending',
                reason: 'pinned file identity mismatch',
                view: {
                  state: 'cleanup_pending',
                  sessionGeneration: rec.session_generation,
                  confirmedOffset: rec.confirmed_offset,
                  totalBytes: rec.total_bytes,
                  chunkSize: rec.chunk_size,
                  readerAccessState: rec.reader_access_state,
                },
              }),
            },
            now,
          );
          return { kind: 'none' };
        }
        const a = this.claimAttempt(rec, 'trash', gen, now, leaseMs);
        return {
          kind: 'trash',
          attemptId: a.attempt_id,
          generation: gen,
          writer,
          driveId: writer.driveId,
          file: pending,
        };
      }
      const uncertain = this.uncertainPending(rec);
      if (
        rec.session_uri_envelope !== null &&
        rec.session_expired === 0 &&
        !(cancel && rec.probe_done === 1) &&
        !(uncertain && rec.probe_done === 1)
      ) {
        const a = this.claimAttempt(rec, 'probe', gen, now, leaseMs);
        return {
          kind: 'probe',
          attemptId: a.attempt_id,
          generation: gen,
          writer,
          sessionUri: '',
          totalBytes: rec.total_bytes as DecimalBytes,
        };
      }
      if (
        rec.generated_file_id !== null &&
        rec.remote_init_attempted === 1 &&
        rec.lookup_done === 0 &&
        (cancel ||
          rec.session_expired === 1 ||
          (uncertain && rec.probe_done === 1))
      ) {
        const a = this.claimAttempt(rec, 'probe', gen, now, leaseMs);
        return {
          kind: 'lookup-file',
          attemptId: a.attempt_id,
          generation: gen,
          writer,
          fileId: rec.generated_file_id,
          driveId: writer.driveId,
        };
      }
      if (
        !cancel &&
        rec.generated_file_id !== null &&
        rec.remote_init_attempted === 1 &&
        rec.session_expired === 1 &&
        rec.lookup_done === 1
      ) {
        const a = this.claimAttempt(rec, 'renew', gen, now, leaseMs);
        return {
          kind: 'renew',
          attemptId: a.attempt_id,
          generation: gen,
          writer,
          generatedFileId: rec.generated_file_id,
          driveId: writer.driveId,
          upload: {
            parentId: rec.parent_id,
            name: rec.name,
            mimeType: rec.mime_type,
            totalBytes: rec.total_bytes as DecimalBytes,
          },
        };
      }
      if (cancel && rec.state === 'cancel_requested') {
        if (uncertain) {
          // R4: an unresolved write may still create the pinned file —
          // the operation stays recoverable (cleanup_pending), never a
          // false terminal 'cancelled' on a mere 308+404 pair.
          this.updateRecord(
            {
              state: 'cleanup_pending',
              completed_ms: now,
              block_reason: UNRESOLVED_WRITES_REASON,
              result: JSON.stringify({
                outcome: 'cleanup_pending',
                reason: UNRESOLVED_WRITES_REASON,
                view: {
                  state: 'cleanup_pending',
                  sessionGeneration: rec.session_generation,
                  confirmedOffset: rec.confirmed_offset,
                  totalBytes: rec.total_bytes,
                  chunkSize: rec.chunk_size,
                  readerAccessState: rec.reader_access_state,
                },
              }),
            },
            now,
          );
          return { kind: 'none' };
        }
        // Nothing remote could exist or everything was cleaned: terminal.
        this.updateRecord(
          {
            state: 'cancelled',
            completed_ms: now,
            result: JSON.stringify({
              outcome: 'cancelled',
              view: {
                state: 'cancelled',
                sessionGeneration: rec.session_generation,
                confirmedOffset: rec.confirmed_offset,
                totalBytes: rec.total_bytes,
                chunkSize: rec.chunk_size,
                readerAccessState: rec.reader_access_state,
              },
            }),
          },
          now,
        );
      }
      return { kind: 'none' };
    }

    return { kind: 'none' };
  }

  /**
   * Attach the unsealed session URI to probe/put-chunk directives. An
   * envelope that opens under NO key in the keyring is treated exactly
   * like a remote session-expired verdict: the just-claimed attempt is
   * retired, `session_expired` is flagged, and the next directive is
   * re-derived so probe → lookup → renew recovers (W4-R1 #3). Without
   * this the claim/probe silently answered {kind:'none'} forever while
   * the upload stalled without error.
   */
  private async hydrateDirective(
    rec: SessionRow,
    directive: UploadDirective,
    now: number,
    leaseMs: number,
  ): Promise<UploadDirective> {
    if (directive.kind !== 'probe' && directive.kind !== 'put-chunk') {
      return directive;
    }
    const opened = await this.openSessionUri(rec);
    if (opened.kind === 'uri') {
      return { ...directive, sessionUri: opened.uri };
    }
    if (opened.kind === 'absent') return { kind: 'none' };
    // 'unopenable': the stored envelope is dead to us. Retire the attempt
    // this directive claimed — it can never run without a usable URI —
    // flag expiry and enter reconciling so the standard recovery chain
    // (generated-ID lookup → renew) produces a fresh session.
    const attempt = this.readAttempt(directive.attemptId);
    if (attempt !== undefined && attempt.status === 'active') {
      this.finishAttempt(attempt, 'failed', now);
    }
    const fields: Record<string, unknown> = {
      session_expired: 1,
      active_attempt_id: null,
    };
    if (rec.state === 'uploading' || rec.state === 'paused') {
      fields.state = 'reconciling';
    }
    this.updateRecord(fields, now);
    const fresh = this.readRecord() as SessionRow;
    return this.deriveDirective(fresh, now, leaseMs);
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  /**
   * Idempotent init (spec §6.2). The first call persists input, pinned
   * writer and phase atomically with the first attempt claim; replay with
   * the same inputHash resumes exactly at the durable phase, fencing a
   * crashed attempt only after its lease expired.
   */
  private async initialize(body: Record<string, unknown>): Promise<Response> {
    const cmd = body as unknown as InitializeCommand;
    const now = asNonNegativeInt(cmd.now);
    const leaseMs = asNonNegativeInt(cmd.leaseMs);
    const pinned = cmd.pinned;
    if (
      now === undefined ||
      leaseMs === undefined ||
      !isRecord(pinned) ||
      asString(cmd.uploadId) === undefined ||
      asString(cmd.ownerId) === undefined ||
      asString(cmd.inputHash) === undefined ||
      asString(cmd.parentId) === undefined ||
      asString(cmd.name) === undefined ||
      asString(cmd.totalBytes) === undefined ||
      asString(pinned.connectionId) === undefined ||
      asString(pinned.principalId) === undefined ||
      asString(pinned.oauthClientId) === undefined ||
      asString(pinned.projectId) === undefined ||
      asString(pinned.driveId) === undefined ||
      asNonNegativeInt(pinned.connectionVersion) === undefined ||
      asNonNegativeInt(pinned.oauthClientVersion) === undefined ||
      asNonNegativeInt(cmd.chunkSize) === undefined ||
      (cmd.kind !== 'file' && cmd.kind !== 'folder')
    ) {
      return errorResponse(
        400,
        'INVALID_COMMAND',
        'initialize payload is malformed',
      );
    }

    // Single synchronous block: read + validate + all writes are atomic.
    this.ensureStorage();
    let rec = this.readRecord();
    if (rec !== undefined) {
      if (rec.input_hash !== cmd.inputHash || rec.owner_id !== cmd.ownerId) {
        return errorResponse(
          409,
          'INPUT_MISMATCH',
          'upload input does not match the stored operation',
        );
      }
      if (TERMINAL_STATES.has(rec.state as UploadState)) {
        return this.reply(rec, { kind: 'none' });
      }
      // Resume: an unexpired attempt means another init is still in
      // flight; otherwise re-derive so a pending cleanup/reconcile chain
      // (cancel_requested, reconciling, verifying) keeps moving (R4).
      this.fenceExpiredAttempt(rec, now);
      rec = this.readRecord() as SessionRow;
      const directive = await this.hydrateDirective(
        rec,
        this.deriveDirective(rec, now, leaseMs),
        now,
        leaseMs,
      );
      return this.reply(this.readRecord() as SessionRow, directive);
    }

    this.ctx.storage.sql.exec(
      'INSERT INTO session (id, upload_id, owner_id, mount_id, kind, input_hash, ' +
        'parent_id, name, mime_type, total_bytes, sha256, md5, batch_id, node_id, ' +
        'chunk_size, state, init_phase, pinned_json, generated_file_id, ' +
        'session_uri_envelope, session_generation, confirmed_offset, ' +
        'remote_init_attempted, session_expired, probe_done, lookup_done, ' +
        'file_trashed, pause_requested, cancel_requested, ' +
        'uncertain_attempt_id, uncertain_kind, uncertain_end, ' +
        'active_attempt_id, block_reason, pending_file_json, result, ' +
        'reader_access_state, reader_checked_ms, reader_pool_version, ' +
        'reader_policy_version, reader_reason, attempt_seq, created_ms, updated_ms, ' +
        'completed_ms) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ' +
        "'preparing', 'generate-id', ?, NULL, NULL, 1, '0', 0, 0, 0, 0, 0, 0, 0, " +
        "NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'unchecked', NULL, NULL, NULL, NULL, 0, ?, ?, NULL)",
      cmd.uploadId,
      cmd.ownerId,
      cmd.mountId,
      cmd.kind,
      cmd.inputHash,
      cmd.parentId,
      cmd.name,
      cmd.mimeType,
      cmd.totalBytes,
      cmd.sha256,
      cmd.md5,
      cmd.batchId ?? null,
      cmd.nodeId ?? null,
      cmd.chunkSize,
      JSON.stringify(pinned),
      now,
      now,
    );
    rec = this.readRecord() as SessionRow;
    const directive = this.deriveDirective(rec, now, leaseMs);
    return this.reply(this.readRecord() as SessionRow, directive);
  }

  /**
   * Chunk claim (spec §6.3): validates generation, confirmed offset and the
   * declared length before any byte is delivered, then issues the only live
   * PUT lease. An expired prior lease moves the upload to reconciling
   * instead of granting a competing PUT.
   */
  private async claimChunk(body: Record<string, unknown>): Promise<Response> {
    const cmd = body as unknown as ClaimChunkCommand;
    const now = asNonNegativeInt(cmd.now);
    const leaseMs = asNonNegativeInt(cmd.leaseMs);
    const generation = asNonNegativeInt(cmd.generation);
    const length = asNonNegativeInt(cmd.length);
    if (
      now === undefined ||
      leaseMs === undefined ||
      generation === undefined ||
      length === undefined ||
      asString(cmd.offset) === undefined
    ) {
      return errorResponse(400, 'INVALID_COMMAND', 'claim payload is malformed');
    }
    this.ensureStorage();
    const outcome = this.claimChunkSync(cmd, now, leaseMs, generation, length);
    if (outcome instanceof Response) return outcome;
    const directive = await this.hydrateDirective(
      outcome.rec,
      outcome.directive,
      now,
      leaseMs,
    );
    return this.reply(this.readRecord() as SessionRow, directive);
  }

  private claimChunkSync(
    cmd: ClaimChunkCommand,
    now: number,
    leaseMs: number,
    generation: number,
    length: number,
  ): { rec: SessionRow; directive: UploadDirective } | Response {
    const rec = this.readRecord();
    if (rec === undefined) {
      return errorResponse(
        404,
        'NOT_INITIALIZED',
        'upload session is not initialized',
      );
    }
    if (rec.cancel_requested === 1) {
      return errorResponse(409, 'STATE_CONFLICT', 'upload is cancel-requested');
    }
    if (rec.pause_requested === 1 || rec.state === 'paused') {
      return errorResponse(409, 'STATE_CONFLICT', 'upload is paused');
    }
    if (rec.state === 'reconciling' || rec.state === 'blocked') {
      return errorResponse(
        409,
        'UPLOAD_NEEDS_RECONCILIATION',
        'upload requires reconciliation first',
      );
    }
    if (
      rec.uncertain_attempt_id !== null &&
      rec.uncertain_kind === 'chunk'
    ) {
      // R4: an unresolved byte write may still be in flight — never grant
      // a competing PUT for the same range until positive remote evidence
      // settles it. 'init'/'renew' uncertainty is a create-existence
      // question and does not race byte writes.
      return errorResponse(
        409,
        'UPLOAD_NEEDS_RECONCILIATION',
        'an unresolved write attempt must settle before the next chunk',
      );
    }
    if (rec.state !== 'uploading') {
      return errorResponse(409, 'STATE_CONFLICT', `upload is ${rec.state}`);
    }
    if (generation !== rec.session_generation) {
      return errorResponse(
        409,
        'STALE_GENERATION',
        'chunk generation does not match the session generation',
      );
    }
    if (cmd.offset !== rec.confirmed_offset) {
      return errorResponse(
        409,
        'OFFSET_MISMATCH',
        'chunk offset does not match the confirmed offset',
      );
    }
    if (rec.active_attempt_id !== null) {
      if (!this.fenceExpiredAttempt(rec, now)) {
        return errorResponse(
          409,
          'ATTEMPT_IN_FLIGHT',
          'an attempt is already in flight',
        );
      }
      this.updateRecord({ state: 'reconciling' }, now);
      return errorResponse(
        409,
        'UPLOAD_NEEDS_RECONCILIATION',
        'the previous attempt lease expired; reconcile first',
      );
    }
    const total = decimalBytesToBigInt(rec.total_bytes as DecimalBytes);
    const confirmed = decimalBytesToBigInt(
      rec.confirmed_offset as DecimalBytes,
    );
    const remaining = total - confirmed;
    const expected =
      remaining > BigInt(rec.chunk_size) ? BigInt(rec.chunk_size) : remaining;
    if (BigInt(length) !== expected || expected <= 0n) {
      return errorResponse(
        409,
        'LENGTH_MISMATCH',
        'chunk length does not match the expected remaining chunk',
      );
    }
    const attempt = this.claimAttempt(
      rec,
      'chunk',
      generation,
      now,
      leaseMs,
      rec.confirmed_offset,
      length,
    );
    const fresh = this.readRecord() as SessionRow;
    return {
      rec: fresh,
      directive: {
        kind: 'put-chunk',
        attemptId: attempt.attempt_id,
        generation,
        writer: this.pinned(fresh),
        sessionUri: '',
        offset: rec.confirmed_offset as DecimalBytes,
        chunkBytes: length,
        totalBytes: rec.total_bytes as DecimalBytes,
      },
    };
  }

  /**
   * Client-driven reconcile: derives the next recovery step. On 'blocked'
   * the pinned connection must first be re-proven (check-writer under a
   * fresh attempt). On 'verifying' the verify directive is re-issued so a
   * crashed finalize can be re-driven. On a terminal 'cancelled' the
   * generated ID is looked up once more when a late create could still be
   * in flight — a cancelled upload with an untrashed remote file must stay
   * recoverable (R4).
   */
  private async reconcile(body: Record<string, unknown>): Promise<Response> {
    const cmd = body as unknown as ClaimProbeCommand;
    const now = asNonNegativeInt(cmd.now);
    const leaseMs = asNonNegativeInt(cmd.leaseMs);
    if (now === undefined || leaseMs === undefined) {
      return errorResponse(
        400,
        'INVALID_COMMAND',
        'reconcile payload is malformed',
      );
    }
    this.ensureStorage();
    let rec = this.readRecord();
    if (rec === undefined) {
      return errorResponse(
        404,
        'NOT_INITIALIZED',
        'upload session is not initialized',
      );
    }
    if (rec.state === 'blocked') {
      this.fenceExpiredAttempt(rec, now);
      rec = this.readRecord() as SessionRow;
      if (rec.active_attempt_id !== null) {
        return this.reply(rec, { kind: 'none' });
      }
      const a = this.claimAttempt(
        rec,
        'probe',
        rec.session_generation,
        now,
        leaseMs,
      );
      return this.reply(this.readRecord() as SessionRow, {
        kind: 'check-writer',
        attemptId: a.attempt_id,
        generation: rec.session_generation,
        pinned: this.pinned(rec),
      });
    }
    if (rec.state === 'cancelled') {
      // R4: a dropped late create may land AFTER the cancel chain already
      // proved absence — one lookup never makes that permanent. While the
      // generated file is not trashed-or-proven-impossible, a reconcile
      // re-checks the exact pinned generated ID. Once the file was trashed
      // (or a create could never have happened), cancelled stays put.
      const mayStillCreate =
        rec.cancel_requested === 1 &&
        rec.file_trashed === 0 &&
        rec.generated_file_id !== null &&
        rec.remote_init_attempted === 1 &&
        this.pendingFile(rec) === undefined;
      if (!mayStillCreate) return this.reply(rec, { kind: 'none' });
      this.fenceExpiredAttempt(rec, now);
      rec = this.readRecord() as SessionRow;
      if (rec.active_attempt_id !== null) {
        return this.reply(rec, { kind: 'none' });
      }
      const a = this.claimAttempt(
        rec,
        'probe',
        rec.session_generation,
        now,
        leaseMs,
      );
      return this.reply(this.readRecord() as SessionRow, {
        kind: 'lookup-file',
        attemptId: a.attempt_id,
        generation: rec.session_generation,
        writer: this.pinned(rec),
        fileId: rec.generated_file_id as string,
        driveId: this.pinned(rec).driveId,
      });
    }
    if (
      rec.state === 'cleanup_pending' &&
      rec.block_reason === UNRESOLVED_WRITES_REASON &&
      rec.cancel_requested === 1
    ) {
      // R4: recoverable uncertainty — every reconcile re-runs one remote
      // round (probe + pinned lookup) until positive evidence settles the
      // held write: file found → trash, dead session → provably gone,
      // range covered → landed. Absence alone keeps cleanup_pending.
      this.fenceExpiredAttempt(rec, now);
      rec = this.readRecord() as SessionRow;
      if (rec.active_attempt_id !== null) {
        return this.reply(rec, { kind: 'none' });
      }
      this.updateRecord(
        { state: 'cancel_requested', probe_done: 0, lookup_done: 0 },
        now,
      );
      rec = this.readRecord() as SessionRow;
      const directive = await this.hydrateDirective(
        rec,
        this.deriveDirective(rec, now, leaseMs),
        now,
        leaseMs,
      );
      return this.reply(this.readRecord() as SessionRow, directive);
    }
    if (TERMINAL_STATES.has(rec.state as UploadState)) {
      return this.reply(rec, { kind: 'none' });
    }
    if (rec.state === 'reconciling' || rec.state === 'cancel_requested') {
      // While a write is uncertain and the last remote round produced no
      // positive evidence, let the next reconcile take one fresh round —
      // progress can only be observed remotely (R4).
      if (
        rec.uncertain_attempt_id !== null &&
        rec.probe_done === 1 &&
        rec.lookup_done === 1
      ) {
        this.updateRecord({ probe_done: 0, lookup_done: 0 }, now);
        rec = this.readRecord() as SessionRow;
      }
    }
    if (rec.state === 'paused' || rec.state === 'uploading') {
      // Reconcile only matters when an attempt's outcome is unknown.
      if (rec.active_attempt_id === null) {
        return this.reply(rec, { kind: 'none' });
      }
      this.fenceExpiredAttempt(rec, now);
      rec = this.readRecord() as SessionRow;
      if (rec.active_attempt_id !== null) {
        return this.reply(rec, { kind: 'none' });
      }
      this.updateRecord({ state: 'reconciling' }, now);
      rec = this.readRecord() as SessionRow;
    }
    if (rec.state === 'verifying') {
      this.fenceExpiredAttempt(rec, now);
      rec = this.readRecord() as SessionRow;
      if (rec.active_attempt_id !== null) {
        return this.reply(rec, { kind: 'none' });
      }
      const directive = this.deriveDirective(rec, now, leaseMs);
      return this.reply(
        this.readRecord() as SessionRow,
        await this.hydrateDirective(rec, directive, now, leaseMs),
      );
    }
    this.fenceExpiredAttempt(rec, now);
    rec = this.readRecord() as SessionRow;
    const directive = this.deriveDirective(rec, now, leaseMs);
    return this.reply(
      this.readRecord() as SessionRow,
      await this.hydrateDirective(rec, directive, now, leaseMs),
    );
  }

  private pause(body: Record<string, unknown>): Response {
    const cmd = body as unknown as IntentCommand;
    const now = asNonNegativeInt(cmd.now);
    if (now === undefined) {
      return errorResponse(400, 'INVALID_COMMAND', 'pause payload is malformed');
    }
    this.ensureStorage();
    const rec = this.readRecord();
    if (rec === undefined) {
      return errorResponse(
        404,
        'NOT_INITIALIZED',
        'upload session is not initialized',
      );
    }
    if (TERMINAL_STATES.has(rec.state as UploadState)) {
      return this.reply(rec, { kind: 'none' });
    }
    const fields: Record<string, unknown> = { pause_requested: 1 };
    if (rec.state === 'uploading') fields.state = 'paused';
    this.updateRecord(fields, now);
    return this.reply(this.readRecord() as SessionRow, { kind: 'none' });
  }

  private resume(body: Record<string, unknown>): Response {
    const cmd = body as unknown as IntentCommand;
    const now = asNonNegativeInt(cmd.now);
    if (now === undefined) {
      return errorResponse(
        400,
        'INVALID_COMMAND',
        'resume payload is malformed',
      );
    }
    this.ensureStorage();
    const rec = this.readRecord();
    if (rec === undefined) {
      return errorResponse(
        404,
        'NOT_INITIALIZED',
        'upload session is not initialized',
      );
    }
    if (rec.state === 'paused') {
      this.updateRecord({ pause_requested: 0, state: 'uploading' }, now);
    } else if (rec.pause_requested === 1 && rec.state === 'reconciling') {
      // Pause was recorded while an outcome was unknown; resume just clears
      // the flag — the reconcile result then lands on 'uploading'.
      this.updateRecord({ pause_requested: 0 }, now);
    }
    return this.reply(this.readRecord() as SessionRow, { kind: 'none' });
  }

  /**
   * Maintenance re-key (the UploadSessionRekeyPort contract frozen in
   * security/rotation.ts): while any maintenance mode is active, the
   * stored session-URI envelope is opened through the keyring — which
   * selects the key by the envelope's own keyId — and re-sealed under the
   * current write key (APP_MASTER_KEY_NEXT when staged, else
   * APP_MASTER_KEY). The pinned writer, state machine and attempt leases
   * are never touched.
   *
   * Refused outside maintenance (a rekey command is only ever driven by
   * a rotation run); a D1 maintenance-read error fails closed into the
   * same refusal. Idempotent: an envelope already carrying the write
   * label reports resealed without a rewrite; no envelope reports
   * resealed:false.
   */
  private async rekey(body: Record<string, unknown>): Promise<Response> {
    const now = asNonNegativeInt((body as { now?: unknown }).now);
    if (now === undefined) {
      return errorResponse(400, 'INVALID_COMMAND', 'rekey payload is malformed');
    }
    this.ensureStorage();
    let rec = this.readRecord();
    if (rec === undefined) {
      return errorResponse(
        404,
        'NOT_INITIALIZED',
        'upload session is not initialized',
      );
    }
    let maintenance: boolean;
    try {
      maintenance = await isMaintenanceActive(this.env.DB);
    } catch {
      // Fail closed: an unreadable gate is treated as no maintenance.
      maintenance = false;
    }
    if (!maintenance) {
      return errorResponse(
        409,
        'STATE_CONFLICT',
        'rekey is only admitted while maintenance is active',
      );
    }
    if (rec.session_uri_envelope === null) {
      return Response.json({ ok: true, resealed: false });
    }
    const writeLabel = await this.writeKeyLabel();
    // Proof-before-report (W4-R1 #2 pattern): an envelope already at the
    // write label still has to OPEN under it — label equality alone would
    // let a corrupt resealed envelope sail through rotation verify.
    // Concurrent-session CAS: a renew racing this command can replace the
    // envelope between our read and our write, so the UPDATE is guarded on
    // the exact value opened; a miss re-reads and retries (bounded).
    for (let attempt = 0; attempt < 3; attempt++) {
      const opened = await this.openSessionUri(rec);
      if (opened.kind !== 'uri') {
        // The stored envelope opens under no key we hold — nothing can be
        // re-sealed. The caller treats this as unavailable and lets the
        // session expiry path handle it.
        return errorResponse(
          409,
          'STATE_CONFLICT',
          'stored session envelope cannot be opened',
        );
      }
      const envelope = decodeEnvelope(rec.session_uri_envelope as string);
      if (envelope.keyId === writeLabel) {
        return Response.json({ ok: true, resealed: true });
      }
      const resealed = await this.box().sealSecret(
        textEncoder.encode(opened.uri),
        this.sealContext(rec),
      );
      const written = this.ctx.storage.sql.exec(
        'UPDATE session SET session_uri_envelope = ?, updated_ms = ?, ' +
          'state_version = state_version + 1 ' +
          'WHERE id = 1 AND session_uri_envelope IS ?',
        encodeEnvelope(resealed),
        now,
        rec.session_uri_envelope,
      );
      if (written.rowsWritten === 1) {
        return Response.json({ ok: true, resealed: true });
      }
      const fresh = this.readRecord();
      if (fresh === undefined) {
        return errorResponse(
          404,
          'NOT_INITIALIZED',
          'upload session is not initialized',
        );
      }
      rec = fresh;
      if (rec.session_uri_envelope === null) {
        return Response.json({ ok: true, resealed: false });
      }
    }
    return errorResponse(
      409,
      'STATE_CONFLICT',
      'session envelope changed during rekey',
    );
  }

  /** The keyId the keyring seals under right now (NEXT staged → its label). */
  private async writeKeyLabel(): Promise<string> {
    const next = this.env.APP_MASTER_KEY_NEXT;
    if (next !== undefined && next !== '') return masterKeyLabel(next);
    return 'v1';
  }

  /**
   * Cancel intent (spec §6.5): records the intent, fences any live attempt
   * so a late commit can never move canonical state, resets the cleanup
   * chain markers and derives the first cleanup step — probe an open
   * session, look the generated ID up when a create may have landed, trash
   * a known file, or go straight to cancelled when nothing remote exists.
   */
  private async cancel(body: Record<string, unknown>): Promise<Response> {
    const cmd = body as unknown as IntentCommand;
    const now = asNonNegativeInt(cmd.now);
    if (now === undefined) {
      return errorResponse(
        400,
        'INVALID_COMMAND',
        'cancel payload is malformed',
      );
    }
    const leaseMs =
      asNonNegativeInt(cmd.leaseMs) ?? DEFAULT_ATTEMPT_LEASE_MS;
    this.ensureStorage();
    let rec = this.readRecord();
    if (rec === undefined) {
      return errorResponse(
        404,
        'NOT_INITIALIZED',
        'upload session is not initialized',
      );
    }
    if (TERMINAL_STATES.has(rec.state as UploadState)) {
      return this.reply(rec, { kind: 'none' });
    }
    this.fenceExpiredAttempt(rec, now);
    rec = this.readRecord() as SessionRow;
    if (rec.active_attempt_id !== null) {
      const attempt = this.readAttempt(rec.active_attempt_id);
      if (attempt !== undefined) {
        this.finishAttempt(attempt, 'fenced', now);
        // A live in-flight write stays uncertain after fencing (R4).
        this.markUncertain(rec, attempt, now);
      }
    }
    this.updateRecord(
      {
        cancel_requested: 1,
        pause_requested: 0,
        probe_done: 0,
        lookup_done: 0,
        state: 'cancel_requested',
        active_attempt_id: null,
      },
      now,
    );
    rec = this.readRecord() as SessionRow;
    const directive = this.deriveDirective(rec, now, leaseMs);
    return this.reply(
      this.readRecord() as SessionRow,
      await this.hydrateDirective(rec, directive, now, leaseMs),
    );
  }

  // -----------------------------------------------------------------------
  // Events — attempt+generation fenced remote results and readiness facts
  // -----------------------------------------------------------------------

  private async event(body: Record<string, unknown>): Promise<Response> {
    const cmd = body as unknown as EventCommand;
    const now = asNonNegativeInt(cmd.now);
    if (
      now === undefined ||
      !isRecord(cmd.event) ||
      asString(cmd.event.type) === undefined
    ) {
      return errorResponse(400, 'INVALID_COMMAND', 'event payload is malformed');
    }
    this.ensureStorage();

    // A new session URI is sealed BEFORE the synchronous commit so the
    // check-attempt-then-write block stays atomic (spec §6.2).
    let sealedUri: string | undefined;
    const preRec = this.readRecord();
    if (preRec === undefined) {
      return errorResponse(
        404,
        'NOT_INITIALIZED',
        'upload session is not initialized',
      );
    }
    if (
      (cmd.event.type === 'remote-init-result' ||
        cmd.event.type === 'renew-result') &&
      isRecord(cmd.event.outcome) &&
      cmd.event.outcome.kind === 'resumable' &&
      asString(cmd.event.outcome.sessionUri) !== undefined
    ) {
      sealedUri = await this.sealSessionUri(
        preRec,
        cmd.event.outcome.sessionUri,
      );
    }

    const outcome = this.eventSync(cmd, now, sealedUri);
    if (outcome instanceof Response) return outcome;
    const directive = await this.hydrateDirective(
      outcome.rec,
      outcome.directive,
      now,
      DEFAULT_ATTEMPT_LEASE_MS,
    );
    return this.reply(
      this.readRecord() as SessionRow,
      directive,
      outcome.applied,
    );
  }

  private eventSync(
    cmd: EventCommand,
    now: number,
    sealedUri: string | undefined,
  ): { rec: SessionRow; directive: UploadDirective; applied: boolean } | Response {
    const rec = this.readRecord() as SessionRow;
    const event = cmd.event;

    if (NON_ATTEMPT_EVENTS.has(event.type)) {
      return this.applyLifecycleEvent(rec, cmd, now);
    }

    // R2: every remote result names the attempt and generation claimed for
    // it. Missing or mismatched fences are stale and never mutate state.
    const attemptId = asString(cmd.attemptId);
    const generation = asNonNegativeInt(cmd.generation);
    if (attemptId === undefined || generation === undefined) {
      return errorResponse(
        400,
        'INVALID_COMMAND',
        'remote result events require attemptId and generation',
      );
    }
    if (
      rec.active_attempt_id === null ||
      attemptId !== rec.active_attempt_id
    ) {
      return this.staleEvent(rec, cmd, now);
    }
    const attempt = this.readAttempt(attemptId);
    if (attempt === undefined || attempt.status !== 'active') {
      return this.staleEvent(rec, cmd, now);
    }
    if (generation !== attempt.generation) {
      return this.staleEvent(rec, cmd, now);
    }
    const allowed = EVENT_KINDS_BY_ATTEMPT[attempt.kind];
    if (allowed === undefined || !allowed.has(event.type)) {
      return this.staleEvent(rec, cmd, now);
    }
    return this.applyAttemptEvent(rec, attempt, cmd, now, sealedUri);
  }

  /**
   * A stale event never mutates canonical state — but it may carry two
   * honest facts (R4):
   *  - a DEFINITIVE remote verdict arriving late for the uncertain attempt
   *    proves that remote call ended (a response existed, even if stale),
   *    so the uncertainty marker is settled;
   *  - proof that THE pinned generated file was created while cancellation
   *    is pending issues the trash directive — but only when the reported
   *    file ID equals the pinned generatedFileId; an arbitrary event file
   *    is never trashed.
   */
  private staleEvent(
    rec: SessionRow,
    cmd: EventCommand,
    now: number,
  ): { rec: SessionRow; directive: UploadDirective; applied: boolean } {
    const event = cmd.event;
    // R13: before ANY bookkeeping (uncertainty settle or late-file trash),
    // the stale event must name a stored attempt whose generation matches
    // and whose kind accepts the event type — the same fencing the live
    // path enforces (R2). Anything else is fully inert.
    const staleAttemptId = asString(cmd.attemptId);
    const staleGeneration = asNonNegativeInt(cmd.generation);
    const staleAttempt =
      staleAttemptId === undefined
        ? undefined
        : this.readAttempt(staleAttemptId);
    const fencesValid =
      staleAttempt !== undefined &&
      staleGeneration !== undefined &&
      staleGeneration === staleAttempt.generation &&
      (EVENT_KINDS_BY_ATTEMPT[staleAttempt.kind]?.has(event.type) ?? false);

    // Settle: a definitive verdict for the uncertain attempt ended it —
    // a verdict for a DIFFERENT or mismatched attempt never settles
    // another write's uncertainty.
    if (
      fencesValid &&
      staleAttemptId === rec.uncertain_attempt_id &&
      (event.type === 'chunk-incomplete' ||
        event.type === 'chunk-completed' ||
        event.type === 'chunk-session-expired' ||
        event.type === 'chunk-blocked' ||
        (event.type === 'remote-init-result' &&
          isRecord(event.outcome) &&
          event.outcome.kind !== 'retry-later') ||
        (event.type === 'renew-result' &&
          isRecord(event.outcome) &&
          event.outcome.kind !== 'retry-later'))
    ) {
      this.clearUncertain(now);
      rec = this.readRecord() as SessionRow;
    }
    let file: DriveFileMeta | undefined;
    if (
      event.type === 'chunk-completed' ||
      event.type === 'probe-completed' ||
      event.type === 'lookup-found'
    ) {
      file = event.file;
    } else if (
      event.type === 'remote-init-result' &&
      isRecord(event.outcome) &&
      event.outcome.kind === 'created' &&
      isRecord(event.outcome.file)
    ) {
      file = event.outcome.file;
    }
    if (
      fencesValid &&
      file !== undefined &&
      file.id === rec.generated_file_id &&
      rec.cancel_requested === 1 &&
      rec.active_attempt_id === null &&
      rec.file_trashed === 0
    ) {
      const pinned = this.pinned(rec);
      const attempt = this.claimAttempt(
        rec,
        'trash',
        rec.session_generation,
        now,
        DEFAULT_ATTEMPT_LEASE_MS,
      );
      return {
        rec: this.readRecord() as SessionRow,
        directive: {
          kind: 'trash',
          attemptId: attempt.attempt_id,
          generation: rec.session_generation,
          writer: pinned,
          driveId: pinned.driveId,
          file,
        },
        applied: false,
      };
    }
    return { rec, directive: { kind: 'none' }, applied: false };
  }

  private applyAttemptEvent(
    rec: SessionRow,
    attempt: AttemptRow,
    cmd: EventCommand,
    now: number,
    sealedUri: string | undefined,
  ): { rec: SessionRow; directive: UploadDirective; applied: boolean } | Response {
    const event = cmd.event;
    const settle = (
      fields: Record<string, unknown>,
      status: 'committed' | 'unknown' | 'failed' = 'committed',
    ): { rec: SessionRow; directive: UploadDirective; applied: boolean } => {
      this.finishAttempt(attempt, status, now);
      this.updateRecord({ ...fields, active_attempt_id: null }, now);
      const fresh = this.readRecord() as SessionRow;
      return {
        rec: fresh,
        directive: this.deriveDirective(
          fresh,
          now,
          DEFAULT_ATTEMPT_LEASE_MS,
        ),
        applied: true,
      };
    };
    /**
     * Terminal results embed the compact public view — a purged summary can
     * always be recovered into an honest tombstone answer (R7).
     */
    const finalView = (fields: Record<string, unknown>) => {
      const merged = { ...rec, ...fields };
      return {
        state: merged.state,
        sessionGeneration: merged.session_generation,
        confirmedOffset: merged.confirmed_offset,
        totalBytes: merged.total_bytes,
        chunkSize: merged.chunk_size,
        readerAccessState: merged.reader_access_state,
      };
    };
    const cancelledOrCleanup = (reason: string) => {
      const fields = {
        state: 'cleanup_pending',
        completed_ms: now,
        block_reason: reason,
      };
      return {
        ...fields,
        result: JSON.stringify({
          outcome: 'cleanup_pending',
          reason,
          view: finalView(fields),
        }),
      };
    };
    const cancelledFinal = (extra: Record<string, unknown> = {}) => {
      const fields = { state: 'cancelled', completed_ms: now, ...extra };
      return {
        ...fields,
        result: JSON.stringify({
          outcome: 'cancelled',
          ...extra,
          view: finalView(fields),
        }),
      };
    };

    switch (event.type) {
      case 'generated-id': {
        const fileId = asString(event.fileId);
        if (fileId === undefined || rec.init_phase !== 'generate-id') {
          return errorResponse(
            409,
            'STATE_CONFLICT',
            'generated-id is not expected in this phase',
          );
        }
        return settle({ generated_file_id: fileId, init_phase: 'start' });
      }
      case 'remote-init-intent': {
        // Crash marker for the remote create/session call. The attempt
        // stays ACTIVE: this is a sub-step, not its completion.
        this.updateRecord({ remote_init_attempted: 1 }, now);
        return {
          rec: this.readRecord() as SessionRow,
          directive: { kind: 'none' },
          applied: true,
        };
      }
      case 'remote-init-result': {
        if (
          !isRecord(event.outcome) ||
          asString(event.outcome.kind) === undefined
        ) {
          return errorResponse(
            400,
            'INVALID_COMMAND',
            'remote-init-result outcome is malformed',
          );
        }
        switch (event.outcome.kind) {
          case 'resumable':
            if (sealedUri === undefined) {
              return errorResponse(
                400,
                'INVALID_COMMAND',
                'resumable result needs a session URI',
              );
            }
            if (rec.uncertain_attempt_id !== null) this.clearUncertain(now);
            return settle({
              session_uri_envelope: sealedUri,
              session_expired: 0,
              state:
                rec.cancel_requested === 1 ? 'cancel_requested' : 'uploading',
              init_phase: 'done',
              confirmed_offset: '0',
            });
          case 'created': {
            if (!isRecord(event.outcome.file)) {
              return errorResponse(
                400,
                'INVALID_COMMAND',
                'created result needs file metadata',
              );
            }
            if (rec.uncertain_attempt_id !== null) this.clearUncertain(now);
            const created = event.outcome.file as DriveFileMeta;
            // A create must adopt the exact pinned generated ID — a
            // different identity is conflict, never a file to trust (R8).
            if (
              rec.generated_file_id !== null &&
              created.id !== rec.generated_file_id
            ) {
              if (rec.cancel_requested === 1) {
                return settle(
                  cancelledOrCleanup('pinned file identity mismatch'),
                  'failed',
                );
              }
              const fields = {
                state: 'conflict',
                completed_ms: now,
                block_reason: 'pinned file identity mismatch',
              };
              return settle(
                {
                  ...fields,
                  result: JSON.stringify({
                    outcome: 'conflict',
                    reason: 'pinned file identity mismatch',
                    view: finalView(fields),
                  }),
                },
                'failed',
              );
            }
            if (rec.cancel_requested === 1) {
              return settle({
                init_phase: 'done',
                pending_file_json: JSON.stringify(created),
              });
            }
            if (rec.kind === 'folder') {
              // Metadata-only create (spec §6.6): there is no byte stream,
              // resumable session or checksum to verify — the create
              // response already carries the comparable facts. Identity
              // was pinned by the generated-ID adoption check above; fail
              // closed only when reported metadata contradicts the create.
              const createdMime = asString(created.mimeType);
              const createdParents = Array.isArray(created.parents)
                ? created.parents
                : undefined;
              if (
                (createdMime !== undefined &&
                  createdMime !== FOLDER_MIME_TYPE) ||
                (createdParents !== undefined &&
                  createdParents.length > 0 &&
                  !createdParents.includes(rec.parent_id))
              ) {
                const fields = {
                  state: 'conflict',
                  completed_ms: now,
                  block_reason: 'created folder metadata mismatch',
                };
                return settle(
                  {
                    ...fields,
                    result: JSON.stringify({
                      outcome: 'conflict',
                      reason: 'created folder metadata mismatch',
                      view: finalView(fields),
                    }),
                  },
                  'failed',
                );
              }
              const fields = {
                state: 'completed',
                completed_ms: now,
                init_phase: 'done',
                confirmed_offset: rec.total_bytes,
                pending_file_json: null,
              };
              return settle({
                ...fields,
                result: JSON.stringify({
                  outcome: 'completed',
                  file: created,
                  verification: 'identity',
                  view: finalView(fields),
                }),
              });
            }
            return settle({
              init_phase: 'done',
              pending_file_json: JSON.stringify(created),
              state: 'verifying',
            });
          }
          case 'blocked':
            if (rec.cancel_requested === 1) {
              return settle(
                cancelledOrCleanup(
                  asString(event.outcome.reason) ?? 'blocked',
                ),
                'failed',
              );
            }
            return settle(
              {
                state: 'blocked',
                block_reason: asString(event.outcome.reason) ?? 'blocked',
              },
              'failed',
            );
          case 'retry-later':
            // The driver settled (response lost) — the lookup-first
            // re-init protocol covers a possibly-landed create; no live
            // request remains, so no uncertainty marker is set (R4
            // distinction: uncertainty is only a still-live fenced
            // request).
            return settle({}, 'failed');
          case 'expired': {
            const fields = {
              state: 'expired',
              completed_ms: now,
            };
            return settle({
              ...fields,
              result: JSON.stringify({
                outcome: 'expired',
                view: finalView(fields),
              }),
            }, 'failed');
          }
          default:
            return errorResponse(400, 'INVALID_COMMAND', 'unknown remote init outcome');
        }
      }
      case 'chunk-incomplete': {
        const offset = asString(event.confirmedOffset);
        if (offset === undefined) {
          return errorResponse(
            400,
            'INVALID_COMMAND',
            'chunk-incomplete needs confirmedOffset',
          );
        }
        const reported = decimalBytesToBigInt(offset as DecimalBytes);
        const current = decimalBytesToBigInt(
          rec.confirmed_offset as DecimalBytes,
        );
        const total = decimalBytesToBigInt(rec.total_bytes as DecimalBytes);
        if (reported < current || reported > total) {
          return errorResponse(
            409,
            'STATE_CONFLICT',
            'reported offset regresses or exceeds the total',
          );
        }
        return settle({
          confirmed_offset: offset,
          probe_done: 0,
          state:
            rec.cancel_requested === 1
              ? 'cancel_requested'
              : rec.pause_requested === 1
                ? 'paused'
                : 'uploading',
        });
      }
      case 'chunk-completed': {
        if (!isRecord(event.file)) {
          return errorResponse(
            400,
            'INVALID_COMMAND',
            'chunk-completed needs file metadata',
          );
        }
        const doneFile = event.file as DriveFileMeta;
        if (
          rec.generated_file_id !== null &&
          doneFile.id !== rec.generated_file_id
        ) {
          if (rec.cancel_requested === 1) {
            return settle(
              cancelledOrCleanup('pinned file identity mismatch'),
              'failed',
            );
          }
          const fields = {
            state: 'conflict',
            completed_ms: now,
            block_reason: 'pinned file identity mismatch',
          };
          return settle(
            {
              ...fields,
              result: JSON.stringify({
                outcome: 'conflict',
                reason: 'pinned file identity mismatch',
                view: finalView(fields),
              }),
            },
            'failed',
          );
        }
        if (rec.uncertain_attempt_id !== null) this.clearUncertain(now);
        if (rec.cancel_requested === 1) {
          return settle({
            confirmed_offset: rec.total_bytes,
            pending_file_json: JSON.stringify(doneFile),
          });
        }
        return settle({
          confirmed_offset: rec.total_bytes,
          pending_file_json: JSON.stringify(doneFile),
          state: 'verifying',
        });
      }
      case 'chunk-outcome-unknown':
        // The driver settled (response lost) — the remote request died
        // with it, so the normal probe protocol is authoritative here.
        // Uncertainty is only for a still-live FENCED request (R4).
        return settle({ state: 'reconciling' }, 'unknown');
      case 'chunk-session-expired':
        // A dead session cannot accept the PUT — that write is settled.
        if (rec.uncertain_kind === 'chunk') this.clearUncertain(now);
        return settle({ state: 'reconciling', session_expired: 1 }, 'failed');
      case 'chunk-blocked':
        if (rec.cancel_requested === 1) {
          return settle(
            cancelledOrCleanup(asString(event.reason) ?? 'blocked'),
            'failed',
          );
        }
        return settle(
          {
            state: 'blocked',
            block_reason: asString(event.reason) ?? 'blocked',
          },
          'failed',
        );
      case 'probe-incomplete': {
        const offset = asString(event.confirmedOffset);
        if (offset === undefined) {
          return errorResponse(
            400,
            'INVALID_COMMAND',
            'probe-incomplete needs confirmedOffset',
          );
        }
        const reported = decimalBytesToBigInt(offset as DecimalBytes);
        const current = decimalBytesToBigInt(
          rec.confirmed_offset as DecimalBytes,
        );
        const total = decimalBytesToBigInt(rec.total_bytes as DecimalBytes);
        if (reported < current || reported > total) {
          return errorResponse(
            409,
            'STATE_CONFLICT',
            'reported offset regresses or exceeds the total',
          );
        }
        if (rec.cancel_requested === 1) {
          // R4: a 308 does NOT prove a fenced PUT stopped — the generated
          // file may still be created late. Never finalize on probe alone;
          // the chain continues with a generated-ID lookup. A Range that
          // covers the uncertain write's end DOES settle it.
          if (
            rec.uncertain_kind === 'chunk' &&
            rec.uncertain_end !== null &&
            reported >=
              decimalBytesToBigInt(rec.uncertain_end as DecimalBytes)
          ) {
            this.clearUncertain(now);
          }
          return settle({ confirmed_offset: offset, probe_done: 1 });
        }
        if (
          rec.uncertain_attempt_id !== null &&
          rec.uncertain_kind === 'chunk'
        ) {
          if (
            rec.uncertain_end !== null &&
            reported >=
              decimalBytesToBigInt(rec.uncertain_end as DecimalBytes)
          ) {
            // The probe Range covers the uncertain write's end — the held
            // PUT landed and can never race a fresh claim.
            this.clearUncertain(now);
            return settle({
              confirmed_offset: offset,
              probe_done: 1,
              session_expired: 0,
              state: rec.pause_requested === 1 ? 'paused' : 'uploading',
            });
          }
          // Still uncertain: stay reconciling — no competing PUT may be
          // granted while the held write could still be in flight (R4).
          return settle({
            confirmed_offset: offset,
            probe_done: 1,
            state: 'reconciling',
          });
        }
        return settle({
          confirmed_offset: offset,
          probe_done: 1,
          session_expired: 0,
          state: rec.pause_requested === 1 ? 'paused' : 'uploading',
        });
      }
      case 'probe-completed': {
        if (!isRecord(event.file)) {
          return errorResponse(
            400,
            'INVALID_COMMAND',
            'probe-completed needs file metadata',
          );
        }
        const probeFile = event.file as DriveFileMeta;
        if (
          rec.generated_file_id !== null &&
          probeFile.id !== rec.generated_file_id
        ) {
          if (rec.cancel_requested === 1) {
            return settle(
              cancelledOrCleanup('pinned file identity mismatch'),
              'failed',
            );
          }
          const fields = {
            state: 'conflict',
            completed_ms: now,
            block_reason: 'pinned file identity mismatch',
          };
          return settle(
            {
              ...fields,
              result: JSON.stringify({
                outcome: 'conflict',
                reason: 'pinned file identity mismatch',
                view: finalView(fields),
              }),
            },
            'failed',
          );
        }
        if (rec.uncertain_attempt_id !== null) this.clearUncertain(now);
        if (rec.cancel_requested === 1) {
          return settle({
            confirmed_offset: rec.total_bytes,
            probe_done: 1,
            pending_file_json: JSON.stringify(probeFile),
          });
        }
        return settle({
          confirmed_offset: rec.total_bytes,
          pending_file_json: JSON.stringify(probeFile),
          state: 'verifying',
        });
      }
      case 'probe-session-expired':
        // A dead session cannot accept an in-flight PUT — that write is
        // settled (only 'chunk' writes upload to this session URI).
        if (rec.uncertain_kind === 'chunk') this.clearUncertain(now);
        return settle({ session_expired: 1, probe_done: 1 });
      case 'probe-unknown':
        return settle({}, 'unknown');
      case 'probe-blocked':
        if (rec.cancel_requested === 1) {
          return settle(
            cancelledOrCleanup(asString(event.reason) ?? 'blocked'),
            'failed',
          );
        }
        return settle(
          {
            state: 'blocked',
            block_reason: asString(event.reason) ?? 'blocked',
          },
          'failed',
        );
      case 'lookup-found': {
        if (!isRecord(event.file)) {
          return errorResponse(
            400,
            'INVALID_COMMAND',
            'lookup-found needs file metadata',
          );
        }
        const found = event.file as DriveFileMeta;
        // The pinned file IS the only identity that counts — a different
        // ID is conflict, never a file to trust or trash (R8).
        if (
          rec.generated_file_id !== null &&
          found.id !== rec.generated_file_id
        ) {
          if (rec.cancel_requested === 1) {
            return settle(
              cancelledOrCleanup('pinned file identity mismatch'),
              'failed',
            );
          }
          const fields = {
            state: 'conflict',
            completed_ms: now,
            block_reason: 'pinned file identity mismatch',
          };
          return settle(
            {
              ...fields,
              result: JSON.stringify({
                outcome: 'conflict',
                reason: 'pinned file identity mismatch',
                view: finalView(fields),
              }),
            },
            'failed',
          );
        }
        // The pinned file exists — any uncertain write has landed.
        if (rec.uncertain_attempt_id !== null) this.clearUncertain(now);
        if (rec.cancel_requested === 1) {
          return settle({
            lookup_done: 1,
            pending_file_json: JSON.stringify(found),
          });
        }
        return settle({
          lookup_done: 1,
          confirmed_offset: rec.total_bytes,
          pending_file_json: JSON.stringify(found),
          state: 'verifying',
        });
      }
      case 'lookup-absent':
        if (rec.cancel_requested === 1) {
          // R4: absence alone never settles a still-uncertain write — a
          // dropped late create can land after this read. Hold recoverable
          // cleanup_pending until positive evidence or trash settles it.
          if (rec.uncertain_attempt_id !== null) {
            return settle(
              {
                lookup_done: 1,
                ...cancelledOrCleanup(UNRESOLVED_WRITES_REASON),
              },
              'failed',
            );
          }
          return settle({ lookup_done: 1, ...cancelledFinal() });
        }
        return settle({ lookup_done: 1, state: 'reconciling' });
      case 'lookup-blocked':
        if (rec.cancel_requested === 1) {
          return settle(
            { lookup_done: 1, ...cancelledOrCleanup(asString(event.reason) ?? 'blocked') },
            'failed',
          );
        }
        return settle(
          {
            lookup_done: 1,
            state: 'blocked',
            block_reason: asString(event.reason) ?? 'blocked',
          },
          'failed',
        );
      case 'renew-result': {
        if (
          !isRecord(event.outcome) ||
          asString(event.outcome.kind) === undefined
        ) {
          return errorResponse(
            400,
            'INVALID_COMMAND',
            'renew outcome is malformed',
          );
        }
        switch (event.outcome.kind) {
          case 'resumable': {
            if (sealedUri === undefined) {
              return errorResponse(
                400,
                'INVALID_COMMAND',
                'renew resumable needs a session URI',
              );
            }
            return settle({
              session_uri_envelope: sealedUri,
              session_generation: rec.session_generation + 1,
              confirmed_offset: '0',
              session_expired: 0,
              probe_done: 0,
              lookup_done: 0,
              state:
                rec.cancel_requested === 1
                  ? 'cancel_requested'
                  : rec.pause_requested === 1
                    ? 'paused'
                    : 'uploading',
            });
          }
          case 'created': {
            if (!isRecord(event.outcome.file)) {
              return errorResponse(
                400,
                'INVALID_COMMAND',
                'created result needs file metadata',
              );
            }
            const renewed = event.outcome.file as DriveFileMeta;
            if (
              rec.generated_file_id !== null &&
              renewed.id !== rec.generated_file_id
            ) {
              if (rec.cancel_requested === 1) {
                return settle(
                  cancelledOrCleanup('pinned file identity mismatch'),
                  'failed',
                );
              }
              const fields = {
                state: 'conflict',
                completed_ms: now,
                block_reason: 'pinned file identity mismatch',
              };
              return settle(
                {
                  ...fields,
                  result: JSON.stringify({
                    outcome: 'conflict',
                    reason: 'pinned file identity mismatch',
                    view: finalView(fields),
                  }),
                },
                'failed',
              );
            }
            if (rec.uncertain_attempt_id !== null) this.clearUncertain(now);
            if (rec.cancel_requested === 1) {
              return settle({
                lookup_done: 1,
                pending_file_json: JSON.stringify(renewed),
              });
            }
            return settle({
              lookup_done: 1,
              confirmed_offset: rec.total_bytes,
              pending_file_json: JSON.stringify(renewed),
              state: 'verifying',
            });
          }
          case 'blocked':
            if (rec.cancel_requested === 1) {
              return settle(
                cancelledOrCleanup(
                  asString(event.outcome.reason) ?? 'blocked',
                ),
                'failed',
              );
            }
            return settle(
              {
                state: 'blocked',
                block_reason: asString(event.outcome.reason) ?? 'blocked',
              },
              'failed',
            );
          case 'retry-later':
            // Driver settled — a possibly-landed create is covered by the
            // generated-ID lookup, not an uncertainty marker (R4).
            return settle({}, 'failed');
          case 'expired': {
            const fields = {
              state: 'expired',
              completed_ms: now,
            };
            return settle(
              {
                ...fields,
                result: JSON.stringify({
                  outcome: 'expired',
                  reason:
                    asString(event.outcome.reason) ??
                    'session renewal refused',
                  view: finalView(fields),
                }),
              },
              'failed',
            );
          }
          default:
            return errorResponse(
              400,
              'INVALID_COMMAND',
              'unknown renew outcome',
            );
        }
      }
      case 'verify-result': {
        if (rec.state !== 'verifying') {
          return { rec, directive: { kind: 'none' }, applied: false };
        }
        if (event.outcome === 'ok') {
          const file = isRecord(event.file)
            ? event.file
            : this.pendingFile(rec);
          const verification = asString(event.verification) ?? 'none';
          const fields = {
            state: 'completed',
            completed_ms: now,
            confirmed_offset: rec.total_bytes,
            pending_file_json: null,
          };
          return settle({
            ...fields,
            result: JSON.stringify({
              outcome: 'completed',
              file,
              verification,
              view: finalView(fields),
            }),
          });
        }
        if (event.outcome === 'retry') {
          // Unreadable upstream: stay 'verifying'; the derived directive
          // re-claims a fresh verify attempt for the next drive.
          return settle({});
        }
        {
          const fields = {
            state: 'conflict',
            completed_ms: now,
            pending_file_json: null,
            block_reason: asString(event.reason) ?? 'verification failed',
          };
          return settle(
            {
              ...fields,
              result: JSON.stringify({
                outcome: 'conflict',
                reason: asString(event.reason) ?? 'verification failed',
                view: finalView(fields),
              }),
            },
            'failed',
          );
        }
      }
      case 'writer-status': {
        if (rec.state !== 'blocked') {
          return { rec, directive: { kind: 'none' }, applied: false };
        }
        if (event.ok === true) {
          const next =
            rec.init_phase === 'done' ? 'reconciling' : 'preparing';
          return settle({ state: next, block_reason: null });
        }
        return settle(
          {
            state: 'blocked',
            block_reason: asString(event.reason) ?? 'writer still blocked',
          },
          'failed',
        );
      }
      case 'trash-result':
        if (event.outcome === 'done') {
          const fields = {
            file_trashed: 1,
            pending_file_json: null,
            state: 'cancelled',
            completed_ms: now,
          };
          return settle({
            ...fields,
            result: JSON.stringify({
              outcome: 'cancelled',
              trashed: true,
              view: finalView(fields),
            }),
          });
        }
        return settle(
          {
            file_trashed: 0,
            ...cancelledOrCleanup(asString(event.reason) ?? 'trash failed'),
          },
          'failed',
        );
      default:
        return errorResponse(400, 'INVALID_COMMAND', 'unknown attempt event');
    }
  }

  /**
   * Non-attempt facts: the reader-access axis is readiness metadata only —
   * it never drives canonical upload state, so it needs no fence (R2).
   */
  private applyLifecycleEvent(
    rec: SessionRow,
    cmd: EventCommand,
    now: number,
  ): { rec: SessionRow; directive: UploadDirective; applied: boolean } | Response {
    const event = cmd.event;
    switch (event.type) {
      case 'reader-access': {
        const readerAccessState =
          asString(event.state) ?? 'unchecked';
        this.updateRecord(
          {
            reader_access_state: readerAccessState,
            reader_checked_ms: asNonNegativeInt(event.checkedMs) ?? now,
            reader_pool_version:
              asNonNegativeInt(event.readPoolVersion) ??
              rec.reader_pool_version,
            reader_policy_version:
              asNonNegativeInt(event.policyVersion) ??
              rec.reader_policy_version,
            reader_reason: asString(event.reason) ?? null,
          },
          now,
        );
        // Keep the permanent compact view honest: tombstone replays must
        // surface the finalized reader state, not a stale 'unchecked'
        // frozen at completion time (R12/R7).
        const rec2 = this.readRecord() as SessionRow;
        if (rec2.result !== null) {
          try {
            const result = JSON.parse(rec2.result) as Record<
              string,
              unknown
            >;
            const view = isRecord(result.view)
              ? (result.view as Record<string, unknown>)
              : undefined;
            if (view !== undefined) {
              this.updateRecord(
                {
                  result: JSON.stringify({
                    ...result,
                    view: { ...view, readerAccessState },
                  }),
                },
                now,
              );
            }
          } catch {
            // Malformed result JSON is left untouched.
          }
        }
        return {
          rec: this.readRecord() as SessionRow,
          directive: { kind: 'none' },
          applied: true,
        };
      }
      default:
        return errorResponse(400, 'INVALID_COMMAND', 'unknown lifecycle event');
    }
  }
}
