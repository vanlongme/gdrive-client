/**
 * Internal UploadSession protocol (spec §6.2–6.5, plan T07/T08).
 *
 * Server-only types shared between the canonical UploadSession Durable
 * Object and the ordinary-Worker upload drivers. None of these shapes ever
 * appear in a public DTO: they carry pinned OAuth writer identity, resumable
 * session URIs, attempt IDs and lease internals.
 *
 * The DO is a synchronous fencing authority: every mutation is a command or
 * an attempt-fenced event, and every response pairs the canonical snapshot
 * with the next directive the caller must execute. Remote calls always run
 * in the ordinary Worker — the DO never receives file bytes and never
 * issues network I/O itself.
 *
 * Fencing (coordinator R2): every remote-result event must carry the exact
 * attemptId and generation the DO claimed for that step. Directives that
 * trigger remote work always mint a fresh attempt; stale results can never
 * complete, trash or renew against a newer canonical state.
 */

import type { DriveFileMeta, ResolvedWriter } from '../drive/types';
import type { UploadState } from '../../shared/contracts/uploads';
import type {
  DecimalBytes,
  ReaderAccessState,
} from '../../shared/contracts/common';

// ---------------------------------------------------------------------------
// Pinned identity
// ---------------------------------------------------------------------------

/**
 * The writer identity an upload operation is bound to for its whole life
 * (spec §5.3, §6.2). `driveId` is pinned alongside the credential tuple so
 * renewal lookups can re-prove access on the exact destination drive. The
 * credential versions are snapshots taken at pin time; the route re-resolves
 * CURRENT row versions (same immutable identity — a same-principal
 * reconnect bumps versions, never substitutes identity) before every
 * remote call.
 */
export interface PinnedUploadWriter extends ResolvedWriter {
  readonly driveId: string;
}

// ---------------------------------------------------------------------------
// Attempts and snapshots
// ---------------------------------------------------------------------------

export const ATTEMPT_KINDS = [
  'init',
  'chunk',
  'probe',
  'renew',
  'verify',
  'trash',
] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export interface AttemptView {
  readonly attemptId: string;
  readonly kind: AttemptKind;
  readonly generation: number;
  /** Chunk attempts only: the confirmed position they claimed. */
  readonly offset?: DecimalBytes;
  readonly length?: number;
  readonly leaseUntilMs: number;
}

/** Init sub-phases; persisted so a crashed initialize resumes exactly. */
export type InitPhase = 'pin' | 'generate-id' | 'start' | 'done';

/**
 * Canonical state as the DO persists it. `sessionUri` is deliberately
 * absent: it is sealed at rest and only released inside claim directives.
 */
export interface UploadSessionSnapshot {
  readonly uploadId: string;
  readonly ownerId: string;
  readonly mountId: string;
  readonly kind: 'file' | 'folder';
  readonly inputHash: string;
  readonly parentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly totalBytes: DecimalBytes;
  readonly sha256: string;
  readonly md5: string;
  readonly batchId?: string;
  readonly nodeId?: string;
  readonly state: UploadState;
  readonly initPhase: InitPhase;
  readonly pinned: PinnedUploadWriter;
  readonly generatedFileId?: string;
  readonly sessionGeneration: number;
  readonly confirmedOffset: DecimalBytes;
  readonly chunkSize: number;
  readonly hasSessionUri: boolean;
  /** True once a remote create/session call was attempted (crash marker). */
  readonly remoteInitAttempted: boolean;
  /** True after Google confirmed this session is gone (404/410). */
  readonly sessionExpired: boolean;
  readonly pauseRequested: boolean;
  readonly cancelRequested: boolean;
  readonly activeAttempt?: AttemptView;
  readonly blockReason?: string;
  /** File metadata parked while state === 'verifying' or pending trash. */
  readonly pendingFile?: DriveFileMeta;
  /** Final result JSON (terminal states). */
  readonly result?: string;
  readonly readerAccessState: ReaderAccessState;
  readonly readerCheckedMs?: number;
  readonly readerPoolVersion?: number;
  readonly readerPolicyVersion?: number;
  readonly readerReason?: string;
  readonly createdMs: number;
  readonly updatedMs: number;
  readonly completedMs?: number;
  /**
   * Canonical monotonic version: incremented on every durable mutation.
   * The D1 projection writes are conditional on this — a delayed older
   * projection can never overwrite a newer tombstone (R7).
   */
  readonly stateVersion: number;
}

// ---------------------------------------------------------------------------
// Directives — work the DO asks the ordinary Worker to perform
// ---------------------------------------------------------------------------

/**
 * Every directive that triggers remote work carries the exact
 * `attemptId`/`generation` fence the DO claimed for it; the route echoes
 * both back on the result event.
 */
export type UploadDirective =
  | { readonly kind: 'none' }
  /**
   * A granted chunk PUT lease (response to /claim): the route streams the
   * request body through the provider for exactly chunkBytes at offset.
   */
  | {
      readonly kind: 'put-chunk';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
      readonly sessionUri: string;
      readonly offset: DecimalBytes;
      readonly chunkBytes: number;
      readonly totalBytes: DecimalBytes;
    }
  /** generateIds via the pinned writer, then event 'generated-id'. */
  | {
      readonly kind: 'generate-id';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
    }
  /**
   * Init or re-init the remote object. `lookupFirst` is set when a previous
   * attempt may have created the file already (crash between remote create
   * and persistence): the route must files.get the generated ID first and
   * adopt a found file instead of blindly re-creating (spec §6.2).
   */
  | {
      readonly kind: 'remote-init';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
      readonly generatedFileId: string;
      readonly lookupFirst: boolean;
      readonly upload: {
        readonly kind: 'file' | 'folder';
        readonly parentId: string;
        readonly name: string;
        readonly mimeType: string;
        readonly totalBytes: DecimalBytes;
      };
    }
  /** Probe the pinned session URI, then a probe-* event. */
  | {
      readonly kind: 'probe';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
      readonly sessionUri: string;
      readonly totalBytes: DecimalBytes;
    }
  /**
   * Session is known-expired or a file may exist: prove the pinned writer
   * still has Drive access, then look the generated file ID up. Route emits
   * lookup-found / lookup-absent / lookup-blocked.
   */
  | {
      readonly kind: 'lookup-file';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
      readonly fileId: string;
      readonly driveId: string;
    }
  /** Open a fresh resumable session for the same generated ID. */
  | {
      readonly kind: 'renew';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
      readonly generatedFileId: string;
      /** Pinned destination drive for the writable-destination proof. */
      readonly driveId: string;
      readonly upload: {
        readonly parentId: string;
        readonly name: string;
        readonly mimeType: string;
        readonly totalBytes: DecimalBytes;
      };
    }
  /** Re-check the pinned connection row after blocked; then 'writer-status'. */
  | {
      readonly kind: 'check-writer';
      readonly attemptId: string;
      readonly generation: number;
      readonly pinned: PinnedUploadWriter;
    }
  /** Trash the pinned generated file (cancel cleanup), then 'trash-result'. */
  | {
      readonly kind: 'trash';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
      /** Pinned destination drive — the only scope trash may act under. */
      readonly driveId: string;
      readonly file: DriveFileMeta;
    }
  /** Verify identity/parent/size/checksum, then 'verify-result'. */
  | {
      readonly kind: 'verify';
      readonly attemptId: string;
      readonly generation: number;
      readonly writer: ResolvedWriter;
      readonly fileId: string;
      readonly expected: {
        readonly parentId: string;
        readonly driveId: string;
        readonly totalBytes: DecimalBytes;
        readonly sha256: string;
        readonly md5: string;
      };
      /** Parked metadata; the route still calls verifyFile for a fresh read. */
      readonly hint?: DriveFileMeta;
    };

// ---------------------------------------------------------------------------
// Events — attempt+generation fenced remote results plus readiness facts
// ---------------------------------------------------------------------------

/** Remote init/renew outcomes reported back to the DO. */
export type RemoteInitOutcome =
  | { readonly kind: 'resumable'; readonly sessionUri: string }
  | { readonly kind: 'created'; readonly file: DriveFileMeta }
  /** Credential/permission class: park on blocked with the reason. */
  | { readonly kind: 'blocked'; readonly reason: string }
  /** Retryable upstream failure: stay in the current phase for a retry. */
  | { readonly kind: 'retry-later'; readonly reason: string }
  /** Google refused session creation for the pinned ID: terminal. */
  | { readonly kind: 'expired'; readonly reason: string };

/**
 * All events except 'reader-access' are remote results: they are only valid
 * when sent with the attemptId and generation of a live claimed attempt
 * (R2). 'reader-access' is independent readiness metadata and never drives
 * canonical upload state.
 */
export type UploadSessionEvent =
  | { readonly type: 'generated-id'; readonly fileId: string }
  /** Route marks "about to call remote create/session" — the crash marker. */
  | { readonly type: 'remote-init-intent' }
  | { readonly type: 'remote-init-result'; readonly outcome: RemoteInitOutcome }
  | { readonly type: 'chunk-incomplete'; readonly confirmedOffset: DecimalBytes }
  | { readonly type: 'chunk-completed'; readonly file: DriveFileMeta }
  /** PUT outcome undetermined: bytes may have landed. Probe before replay. */
  | { readonly type: 'chunk-outcome-unknown' }
  /** Definitive 404/410 on the session URI during a PUT. */
  | { readonly type: 'chunk-session-expired' }
  | { readonly type: 'chunk-blocked'; readonly reason: string }
  | { readonly type: 'probe-incomplete'; readonly confirmedOffset: DecimalBytes }
  | { readonly type: 'probe-completed'; readonly file: DriveFileMeta }
  | { readonly type: 'probe-session-expired' }
  | { readonly type: 'probe-unknown'; readonly reason?: string }
  | { readonly type: 'probe-blocked'; readonly reason: string }
  | { readonly type: 'lookup-found'; readonly file: DriveFileMeta }
  | { readonly type: 'lookup-absent' }
  | { readonly type: 'lookup-blocked'; readonly reason: string }
  | { readonly type: 'renew-result'; readonly outcome: RemoteInitOutcome }
  | {
      readonly type: 'trash-result';
      readonly outcome: 'done' | 'failed';
      readonly reason?: string;
    }
  | {
      readonly type: 'verify-result';
      /** 'retry': upstream unreadable — re-issue verify on next reconcile. */
      readonly outcome: 'ok' | 'failed' | 'retry';
      readonly file?: DriveFileMeta;
      /** 'sha256' | 'md5' | 'none' — the assurance actually established. */
      readonly verification?: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'writer-status';
      readonly ok: boolean;
      readonly reason?: string;
    }
  | {
      readonly type: 'reader-access';
      readonly state: ReaderAccessState;
      readonly reason?: string;
      readonly readPoolVersion?: number;
      readonly policyVersion?: number;
      readonly checkedMs: number;
    };

// ---------------------------------------------------------------------------
// Commands — request/response envelope over the DO fetch boundary
// ---------------------------------------------------------------------------

export interface InitializeCommand {
  readonly uploadId: string;
  readonly ownerId: string;
  readonly mountId: string;
  readonly kind: 'file' | 'folder';
  readonly inputHash: string;
  readonly parentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly totalBytes: DecimalBytes;
  readonly sha256: string;
  readonly md5: string;
  readonly batchId?: string;
  readonly nodeId?: string;
  readonly chunkSize: number;
  readonly pinned: PinnedUploadWriter;
  readonly now: number;
  readonly leaseMs: number;
}

export interface ClaimChunkCommand {
  readonly generation: number;
  readonly offset: DecimalBytes;
  /** Declared Content-Length, already validated by the route. */
  readonly length: number;
  readonly now: number;
  readonly leaseMs: number;
}

export interface ClaimProbeCommand {
  readonly now: number;
  readonly leaseMs: number;
}

export interface IntentCommand {
  readonly now: number;
  readonly leaseMs?: number;
}

/**
 * attemptId/generation are required for every remote-result event (all
 * types except 'reader-access'); they stay optional in the wire shape so a
 * malformed caller gets a clean 400 instead of a type error.
 */
export interface EventCommand {
  readonly attemptId?: string;
  readonly generation?: number;
  readonly event: UploadSessionEvent;
  readonly now: number;
}

export type DoErrorCode =
  | 'NOT_INITIALIZED'
  | 'INPUT_MISMATCH'
  | 'INVALID_COMMAND'
  | 'STATE_CONFLICT'
  | 'ATTEMPT_IN_FLIGHT'
  | 'UPLOAD_NEEDS_RECONCILIATION'
  | 'STALE_GENERATION'
  | 'OFFSET_MISMATCH'
  | 'LENGTH_MISMATCH'
  | 'TERMINAL'
  | 'STORAGE_ERROR';

export type DoResponse =
  | {
      readonly ok: true;
      readonly snapshot: UploadSessionSnapshot;
      readonly directive: UploadDirective;
      /** False when the event was fenced (stale attempt/generation). */
      readonly applied?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: DoErrorCode;
      readonly message: string;
      readonly status: number;
    };

export const DO_ORIGIN = 'https://upload-session.internal';

/** Default lease for a claimed remote operation (init/chunk/probe/trash). */
export const DEFAULT_ATTEMPT_LEASE_MS = 120_000;
