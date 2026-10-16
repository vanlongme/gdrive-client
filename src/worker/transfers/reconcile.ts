/**
 * Reconcile drivers (spec §6.4, plan T08): probe the pinned session URI,
 * look the pinned generated file ID up after session expiry or uncertain
 * outcomes, and open a replacement session for the same ID when the old
 * one is provably dead. Unknown outcomes always probe before any replay;
 * a lookup 404 is never treated as "file absent" until the pinned writer's
 * Drive access is re-proven — missing permission is blocked, not absence
 * (R8), and a renewal destination is only writable when the parent is a
 * proven folder on the pinned Drive with canAddChildren (R9).
 */

import { isDriveError } from '../drive/errors';
import type { OAuthCatalogWriteProvider } from '../drive/types';
import { FOLDER_MIME_TYPE } from '../drive/providers/common';
import {
  decimalBytesFromBigInt,
  decimalBytesToBigInt,
} from '../../shared/contracts/common';
import { remoteInitOutcomeForError } from './upload-stream';
import type { UploadDirective, UploadSessionEvent } from './upload-internal';

export type ProbeDirective = Extract<UploadDirective, { kind: 'probe' }>;
export type LookupDirective = Extract<UploadDirective, { kind: 'lookup-file' }>;
export type RenewDirective = Extract<UploadDirective, { kind: 'renew' }>;

/** Probe the pinned resumable session for ground truth. */
export async function runProbe(args: {
  provider: OAuthCatalogWriteProvider;
  directive: ProbeDirective;
  signal?: AbortSignal;
}): Promise<UploadSessionEvent> {
  const { directive } = args;
  try {
    const result = await args.provider.probeUpload({
      writer: directive.writer,
      sessionUri: directive.sessionUri,
      totalBytes: decimalBytesToBigInt(directive.totalBytes),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (result.kind === 'incomplete') {
      return {
        type: 'probe-incomplete',
        confirmedOffset: decimalBytesFromBigInt(result.confirmedOffset),
      };
    }
    return { type: 'probe-completed', file: result.file };
  } catch (err) {
    if (!isDriveError(err)) return { type: 'probe-unknown' };
    switch (err.reason) {
      case 'not-found':
      case 'gone':
      case 'conflict':
        return { type: 'probe-session-expired' };
      case 'unauthorized':
      case 'permission-denied':
      case 'credential-disabled':
        return { type: 'probe-blocked', reason: err.reason };
      default:
        return { type: 'probe-unknown', reason: err.reason };
    }
  }
}

// ---------------------------------------------------------------------------
// Writable-destination proof (R8/R9): never write outside the pinned mount
// ---------------------------------------------------------------------------

export type DestinationProof =
  | { readonly ok: true }
  /** Destination is unusable or unproven — not retryable by itself. */
  | { readonly ok: false; readonly reason: string }
  /** Upstream unreadable — retry the check, never assume. */
  | { readonly ok: false; readonly retry: true; readonly reason: string };

/**
 * Prove the pinned writer may create under `parentId` on the pinned Drive:
 * the parent must exist, be a folder, sit on the exact pinned driveId, not
 * be trashed, and expose canAddChildren. Missing evidence is unproven —
 * never silently accepted (R9: the writer must never create a file outside
 * the mount it was pinned to).
 */
export async function proveWritableDestination(args: {
  provider: OAuthCatalogWriteProvider;
  writer: Parameters<OAuthCatalogWriteProvider['getMetadata']>[0]['writer'];
  parentId: string;
  driveId: string;
  signal?: AbortSignal;
}): Promise<DestinationProof> {
  try {
    const parent = await args.provider.getMetadata({
      writer: args.writer,
      ref: { id: args.parentId },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (parent.trashed === true) {
      return { ok: false, reason: 'destination parent is trashed' };
    }
    if (parent.mimeType !== FOLDER_MIME_TYPE) {
      return { ok: false, reason: 'destination parent is not a folder' };
    }
    if (parent.driveId === undefined || parent.driveId !== args.driveId) {
      return {
        ok: false,
        reason: 'destination parent is outside the pinned drive',
      };
    }
    if (parent.capabilities?.canAddChildren !== true) {
      return {
        ok: false,
        reason: 'writer cannot add children to the destination parent',
      };
    }
    return { ok: true };
  } catch (err) {
    if (!isDriveError(err)) {
      return { ok: false, retry: true, reason: 'transport-error' };
    }
    switch (err.reason) {
      case 'unauthorized':
      case 'permission-denied':
      case 'credential-disabled':
      case 'not-found':
      case 'gone':
        return { ok: false, reason: `destination:${err.reason}` };
      default:
        return { ok: false, retry: true, reason: `destination:${err.reason}` };
    }
  }
}

/**
 * Prove the pinned writer still has write-class access to the pinned Drive
 * root: the returned identity must be the pinned drive, not trashed, and
 * canAddChildren must hold. A readable-but-nonwriter root means a file 404
 * cannot be trusted as "absent" (R8).
 */
export async function proveDriveAccess(args: {
  provider: OAuthCatalogWriteProvider;
  writer: Parameters<OAuthCatalogWriteProvider['getMetadata']>[0]['writer'];
  driveId: string;
  signal?: AbortSignal;
}): Promise<DestinationProof> {
  try {
    const drive = await args.provider.getMetadata({
      writer: args.writer,
      ref: { id: args.driveId },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (drive.trashed === true) {
      return { ok: false, reason: 'pinned drive is trashed' };
    }
    if (drive.id !== args.driveId) {
      return { ok: false, reason: 'drive identity mismatch' };
    }
    if (
      drive.driveId !== undefined &&
      drive.driveId !== args.driveId
    ) {
      return { ok: false, reason: 'drive identity mismatch' };
    }
    if (drive.capabilities?.canAddChildren !== true) {
      return {
        ok: false,
        reason: 'writer lacks add-children on the pinned drive',
      };
    }
    return { ok: true };
  } catch (err) {
    if (!isDriveError(err)) {
      return { ok: false, retry: true, reason: 'transport-error' };
    }
    switch (err.reason) {
      case 'unauthorized':
      case 'permission-denied':
      case 'credential-disabled':
      case 'not-found':
      case 'gone':
        return { ok: false, reason: `drive-check:${err.reason}` };
      default:
        return { ok: false, retry: true, reason: `drive-check:${err.reason}` };
    }
  }
}

/**
 * Generated-ID lookup (R8). A file 404 is "absent" only after BOTH proofs:
 * the pinned writer still sees the pinned Drive (root identity + write
 * capability), and — for the renewal path — the destination parent is
 * still a writable folder on that drive. `requireParentScope` distinguishes
 * the cleanup lookup (cancel only needs access proof) from the
 * renewal-eligible lookup (recreate only under a writable destination).
 */
export async function runLookup(args: {
  provider: OAuthCatalogWriteProvider;
  directive: LookupDirective;
  /** Parent folder for the writable-destination proof. */
  parentId: string;
  /** When true, absence also requires a writable destination parent. */
  requireParentScope: boolean;
  signal?: AbortSignal;
}): Promise<UploadSessionEvent> {
  const { directive } = args;
  try {
    const file = await args.provider.getMetadata({
      writer: directive.writer,
      ref: { id: directive.fileId },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (file.trashed === true) {
      return { type: 'lookup-absent' };
    }
    return { type: 'lookup-found', file };
  } catch (err) {
    if (!isDriveError(err)) {
      return { type: 'lookup-blocked', reason: 'transport-error' };
    }
    if (err.reason !== 'not-found') {
      return { type: 'lookup-blocked', reason: err.reason };
    }
  }
  // File read 404'd: prove access scope before accepting absence.
  const drive = await proveDriveAccess({
    provider: args.provider,
    writer: directive.writer,
    driveId: directive.driveId,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!drive.ok) {
    return {
      type: 'lookup-blocked',
      reason: 'retry' in drive ? drive.reason : `drive-check:${drive.reason}`,
    };
  }
  if (args.requireParentScope) {
    const parent = await proveWritableDestination({
      provider: args.provider,
      writer: directive.writer,
      parentId: args.parentId,
      driveId: directive.driveId,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!parent.ok) {
      return {
        type: 'lookup-blocked',
        reason: 'retry' in parent ? parent.reason : `parent-check:${parent.reason}`,
      };
    }
  }
  return { type: 'lookup-absent' };
}

/**
 * Session renewal: a new resumable session for the SAME generated file ID
 * (spec §6.4). The writable destination is proven first (R9). A 409 means
 * the ID now resolves to an object — look it up instead of assuming the
 * create succeeded; a lookup 404 there is "absent" only under the same
 * proven-access rules (R8) — verify decides match vs conflict.
 */
export async function runRenew(args: {
  provider: OAuthCatalogWriteProvider;
  directive: RenewDirective;
  signal?: AbortSignal;
}): Promise<UploadSessionEvent> {
  const { directive } = args;
  const dest = await proveWritableDestination({
    provider: args.provider,
    writer: directive.writer,
    parentId: directive.upload.parentId,
    driveId: directive.driveId,
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!dest.ok) {
    return {
      type: 'renew-result',
      outcome: {
        kind: 'retry' in dest && dest.retry ? 'retry-later' : 'blocked',
        reason: dest.reason,
      },
    };
  }
  try {
    const start = await args.provider.startUpload({
      writer: directive.writer,
      parentFolderId: directive.upload.parentId,
      name: directive.upload.name,
      mimeType: directive.upload.mimeType,
      totalBytes: decimalBytesToBigInt(directive.upload.totalBytes),
      generatedFileId: directive.generatedFileId,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (start.kind === 'resumable') {
      return {
        type: 'renew-result',
        outcome: { kind: 'resumable', sessionUri: start.sessionUri },
      };
    }
    return {
      type: 'renew-result',
      outcome: { kind: 'created', file: start.file },
    };
  } catch (err) {
    if (!isDriveError(err)) {
      return {
        type: 'renew-result',
        outcome: { kind: 'retry-later', reason: 'transport-error' },
      };
    }
    if (err.reason === 'conflict') {
      // ID collision: look the generated ID up under proven access and let
      // verify decide — a 409 or an unreadable file never proves the file
      // is ours or absent (R8).
      const looked = await runLookup({
        provider: args.provider,
        directive: {
          kind: 'lookup-file',
          attemptId: directive.attemptId,
          generation: directive.generation,
          writer: directive.writer,
          fileId: directive.generatedFileId,
          driveId: directive.driveId,
        },
        parentId: directive.upload.parentId,
        requireParentScope: false,
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
      return looked;
    }
    const outcome = remoteInitOutcomeForError(err);
    return { type: 'renew-result', outcome };
  }
}
