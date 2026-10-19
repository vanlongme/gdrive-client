/**
 * Completion verification and the independent reader-access axis
 * (spec §6.5, plan T08). Before an upload may complete, the pinned OAuth
 * writer re-reads the file and every comparable fact is checked: exact
 * generated ID, parent/drive, declared size and whichever checksum Google
 * exposes — SHA-256 first, MD5 as the content-diff fallback, and an
 * explicit 'none' when upstream carries no checksum at all. A failed
 * comparison is a conflict, never a silent pass; an unreadable upstream
 * is retried, not failed. Missing metadata (no driveId on a Shared Drive
 * mount, a driveId on a My Drive mount, empty/absent parents, absent size)
 * fails closed — it is never treated as success.
 *
 * readerAccessState is a separate axis: after the write completes the SA
 * read pool is probed within its current versions; a 403/404 or
 * canDownload=false keeps uploadState=completed and marks the reader
 * blocked — the write is never retried because of it.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { isDriveError } from '../drive/errors';
import type { DriveFailureReason } from '../drive/errors';
import {
  listReadPool,
  type MountRecord,
} from '../drive/mounts';
import { mountScopeOf } from '../drive/containment';
import type {
  DriveFileMeta,
  OAuthCatalogWriteProvider,
  ServiceAccountContentReadProvider,
} from '../drive/types';
import { decimalBytesToBigInt } from '../../shared/contracts/common';
import type { ReaderAccessState } from '../../shared/contracts/common';
import { driveMatchesScope } from './upload-internal';
import type { UploadDirective, UploadSessionEvent } from './upload-internal';

export type VerifyDirective = Extract<UploadDirective, { kind: 'verify' }>;

export interface VerificationDetail {
  readonly method: 'sha256' | 'md5' | 'none';
}

/**
 * Compare fresh upstream metadata against the operation's declared facts.
 * Returns the verify-result event; 'retry' asks the DO to re-issue the
 * verify directive on the next reconcile instead of declaring conflict.
 */
export async function runVerify(args: {
  provider: OAuthCatalogWriteProvider;
  directive: VerifyDirective;
  signal?: AbortSignal;
}): Promise<UploadSessionEvent> {
  const { directive } = args;
  let file: DriveFileMeta;
  try {
    file = await args.provider.verifyFile({
      writer: directive.writer,
      ref: { id: directive.fileId },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch (err) {
    // Lost access cannot prove the file — park as retryable; the
    // writer-status path decides blocked vs resumed. Any DriveError or
    // transport fault stays non-terminal here.
    return {
      type: 'verify-result',
      outcome: 'retry',
      reason: `verify-read:${isDriveError(err) ? err.reason : 'transport-error'}`,
    };
  }

  const expected = directive.expected;
  const failed = (reason: string): UploadSessionEvent => ({
    type: 'verify-result',
    outcome: 'failed',
    file,
    reason,
  });
  if (file.id !== directive.fileId) {
    return failed('file id mismatch');
  }
  if (file.trashed === true) {
    return failed('file is trashed');
  }
  if (!driveMatchesScope(file.driveId, expected.mountScope)) {
    return failed('file is on a different drive');
  }
  if (
    file.parents === undefined ||
    file.parents.length === 0 ||
    !file.parents.includes(expected.parentId)
  ) {
    return failed('file is under a different parent');
  }
  if (
    file.size === undefined ||
    decimalBytesToBigInt(file.size) !==
      decimalBytesToBigInt(expected.totalBytes)
  ) {
    return failed('file size does not match the uploaded total');
  }
  let verification = 'none';
  if (file.sha256Checksum !== undefined) {
    if (file.sha256Checksum !== expected.sha256) {
      return failed('sha256 checksum mismatch');
    }
    verification = 'sha256';
  } else if (file.md5Checksum !== undefined) {
    if (file.md5Checksum !== expected.md5) {
      return failed('md5 checksum mismatch');
    }
    verification = 'md5';
  }
  return { type: 'verify-result', outcome: 'ok', file, verification };
}

// ---------------------------------------------------------------------------
// Reader access axis (SA read pool)
// ---------------------------------------------------------------------------

export interface ReaderAccessCheck {
  readonly state: ReaderAccessState;
  readonly reason?: string;
  readonly readPoolVersion: number;
  readonly policyVersion: number;
}

/** Bounded probe count — mirrors the content path's failover budget. */
const MAX_READ_PROBES = 3;

/**
 * Reasons that never trigger a different-identity retry (mirrors
 * content-access.ts NON_FAILOVER_REASONS): file-level download limits must
 * cooldown the file and rate/quota failures stay with the reported
 * identity — rotating SAs on them would be a cooldown-evasion channel
 * (spec §5.4, coordinator R5). Caller aborts and local
 * input/destination refusals are not SA faults either.
 */
const NON_FAILOVER_REASONS = new Set<DriveFailureReason>([
  'download-restricted',
  'rate-limited',
  'quota-exceeded',
  'aborted',
  'invalid-input',
  'operation-not-allowed',
  'destination-refused',
]);

/**
 * SA-side verdicts that prove the identity cannot serve this file. If every
 * enabled candidate ends in one of these, the pool verdict is 'blocked';
 * any other failure class leaves the axis 'pending' for a later re-check.
 * Credential faults (unauthorized, disabled, version-changed) are pending,
 * not blocked — they say nothing definitive about the file.
 */
const SA_DENIAL_REASONS = new Set<DriveFailureReason>([
  'permission-denied',
  'not-found',
  'gone',
]);

/**
 * Probe the mount's SA read pool for the completed file. Only ENABLED pool
 * entries are probed (bounded failover on identity/access faults only —
 * file/project rate limits and quotas never rotate). 'readable' requires
 * the SA's own metadata read to affirm the exact file id, the mount's
 * drive, non-trashed state and an explicit canDownload=true; anything less
 * is not success. Definitive denials mark 'blocked', inconclusive results
 * 'pending', an empty pool 'unchecked' — none of which ever change the
 * completed write, and OAuth is never used as a fallback.
 */
export async function checkReaderAccess(args: {
  db: D1Database;
  mount: MountRecord;
  fileId: string;
  readProvider?: ServiceAccountContentReadProvider;
  signal?: AbortSignal;
}): Promise<ReaderAccessCheck> {
  const { db, mount, fileId } = args;
  const pool = await listReadPool(db, mount.id);
  const versions = {
    readPoolVersion: mount.readPoolVersion,
    policyVersion: mount.policyVersion,
  };
  if (pool.length === 0) {
    return { ...versions, state: 'unchecked', reason: 'no read pool configured' };
  }
  const candidates = pool
    .filter((entry) => entry.enabled)
    .slice(0, MAX_READ_PROBES);
  if (candidates.length === 0) {
    return {
      ...versions,
      state: 'pending',
      reason: 'read pool has no enabled service account',
    };
  }
  const provider = args.readProvider;
  if (provider === undefined) {
    return {
      ...versions,
      state: 'pending',
      reason: 'read provider not configured',
    };
  }
  let denial: string | undefined;
  let uncertain: string | undefined;
  for (const entry of candidates) {
    let meta: DriveFileMeta;
    try {
      meta = await provider.getReadMetadata({
        identity: entry.identity,
        ref: { id: fileId },
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
    } catch (err) {
      if (!isDriveError(err)) {
        uncertain = 'transport-error';
        continue;
      }
      if (NON_FAILOVER_REASONS.has(err.reason)) {
        // Never rotate the pool on file limits, rate/project quotas,
        // caller aborts or local refusals — decide from this signal.
        return {
          ...versions,
          state: err.reason === 'download-restricted' ? 'blocked' : 'pending',
          reason: err.reason,
        };
      }
      if (SA_DENIAL_REASONS.has(err.reason)) {
        denial = err.reason;
      } else {
        uncertain = err.reason;
      }
      continue;
    }
    if (meta.id !== fileId) {
      // Upstream answered for a different object — inconclusive, try the
      // next identity; never proof of readability or of denial.
      uncertain = 'id-mismatch';
      continue;
    }
    if (meta.trashed === true) {
      return { ...versions, state: 'blocked', reason: 'file is trashed' };
    }
    if (!driveMatchesScope(meta.driveId, mountScopeOf(mount))) {
      return {
        ...versions,
        state: 'blocked',
        reason: 'file is outside the mount drive',
      };
    }
    if (meta.capabilities?.canDownload === false) {
      // Per-identity denial: another enabled SA may still read the file.
      denial = 'canDownload-false';
      continue;
    }
    if (meta.capabilities?.canDownload !== true) {
      // Readability needs an affirmative capability, not a missing flag.
      uncertain = 'canDownload-unproven';
      continue;
    }
    return { ...versions, state: 'readable' };
  }
  if (denial !== undefined && uncertain === undefined) {
    return { ...versions, state: 'blocked', reason: denial };
  }
  return {
    ...versions,
    state: 'pending',
    reason: uncertain ?? denial ?? 'no enabled service account answered',
  };
}
