/**
 * Chunk streaming driver (spec §6.3, plan T08). Runs in the ordinary
 * Worker: it validates the declared Content-Length against the claimed
 * chunk BEFORE any byte is delivered, then hands the request body to the
 * provider, whose transport pipes it through FixedLengthStream into the
 * upstream fetch concurrently — never buffered, cloned or teed.
 *
 * Outcome mapping: 308/200/201 are the only definitive progress verdicts;
 * a definite 404/410 on the session URI means the session is dead; auth and
 * permission verdicts block; EVERYTHING else — timeout, abort, transport
 * failure, 5xx — is outcome-unknown: bytes may have landed, so canonical
 * state moves to reconciling and the probe decides (spec §6.4).
 */

import { ApiRequestError } from '../drive/mounts';
import { DriveError, isDriveError } from '../drive/errors';
import { recordUploadChunk } from '../admin/metrics';
import type { OAuthCatalogWriteProvider } from '../drive/types';
import {
  decimalBytesFromBigInt,
  decimalBytesToBigInt,
} from '../../shared/contracts/common';
import type { UploadDirective, UploadSessionEvent } from './upload-internal';

export type PutChunkDirective = Extract<UploadDirective, { kind: 'put-chunk' }>;

/**
 * Stream one claimed chunk. Returns the event to commit against the live
 * attempt; throws ApiRequestError for client-visible claim violations
 * (missing/mismatched length, absent body) before touching the body.
 */
export async function streamChunk(args: {
  provider: OAuthCatalogWriteProvider;
  directive: PutChunkDirective;
  body: ReadableStream<Uint8Array> | null;
  /** Raw Content-Length header value, already parsed by the route. */
  declaredLength: number | undefined;
  signal?: AbortSignal;
}): Promise<UploadSessionEvent> {
  const { directive } = args;
  if (args.declaredLength === undefined) {
    throw new ApiRequestError(
      400,
      'VALIDATION_FAILED',
      'A Content-Length header is required for chunk uploads.',
    );
  }
  if (args.declaredLength !== directive.chunkBytes) {
    throw new ApiRequestError(
      409,
      'VALIDATION_FAILED',
      'Content-Length does not match the expected chunk length.',
    );
  }
  if (args.body === null) {
    throw new ApiRequestError(
      400,
      'VALIDATION_FAILED',
      'Chunk upload requires a request body.',
    );
  }

  const startedMs = Date.now();
  try {
    const result = await args.provider.putChunk({
      writer: directive.writer,
      sessionUri: directive.sessionUri,
      offset: decimalBytesToBigInt(directive.offset),
      chunkBytes: directive.chunkBytes,
      totalBytes: decimalBytesToBigInt(directive.totalBytes),
      body: args.body,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (result.kind === 'incomplete') {
      // Newly confirmed bytes = upstream's absolute offset minus where
      // this chunk started — never the admitted chunk length (spec §13).
      const delta = result.confirmedOffset - decimalBytesToBigInt(directive.offset);
      recordUploadChunk({
        durationMs: Date.now() - startedMs,
        outcome: 'confirmed',
        confirmedBytes: delta > 0n ? delta : 0n,
      });
      return {
        type: 'chunk-incomplete',
        confirmedOffset: decimalBytesFromBigInt(result.confirmedOffset),
      };
    }
    recordUploadChunk({
      durationMs: Date.now() - startedMs,
      outcome: 'confirmed',
      confirmedBytes:
        decimalBytesToBigInt(directive.totalBytes) -
        decimalBytesToBigInt(directive.offset),
    });
    return { type: 'chunk-completed', file: result.file };
  } catch (err) {
    const durationMs = Date.now() - startedMs;
    if (!isDriveError(err)) {
      recordUploadChunk({ durationMs, outcome: 'retry' });
      return { type: 'chunk-outcome-unknown' };
    }
    const event = eventForDriveError(err);
    recordUploadChunk({ durationMs, outcome: outcomeForChunkEvent(event) });
    return event;
  }
}

/** Retry/reauth/blocked accounting for a definitive chunk verdict. */
function outcomeForChunkEvent(
  event: UploadSessionEvent,
): 'retry' | 'blocked' | 'reauth' {
  if (event.type === 'chunk-blocked') {
    return event.reason === 'unauthorized' ? 'reauth' : 'blocked';
  }
  // outcome-unknown / session-expired both drive reconcile+renew — retries.
  return 'retry';
}

/** Map a definitive/ambiguous Drive failure onto the chunk event fence. */
export function eventForDriveError(err: DriveError): UploadSessionEvent {
  switch (err.reason) {
    case 'not-found':
    case 'gone':
    case 'conflict':
      // 404/410: session is dead. 409 on a PUT means the session no longer
      // accepts this range — same recovery path (lookup, then renew).
      return { type: 'chunk-session-expired' };
    case 'unauthorized':
    case 'permission-denied':
    case 'credential-disabled':
    case 'storage-full':
      return { type: 'chunk-blocked', reason: err.reason };
    default:
      return { type: 'chunk-outcome-unknown' };
  }
}

/** Map a provider failure onto the remote-init/renew outcome vocabulary. */
export function remoteInitOutcomeForError(err: DriveError): {
  kind: 'blocked' | 'retry-later' | 'expired';
  reason: string;
} {
  switch (err.reason) {
    case 'unauthorized':
    case 'permission-denied':
    case 'credential-disabled':
    case 'storage-full':
    case 'invalid-request':
    case 'invalid-input':
    case 'precondition-failed':
      return { kind: 'blocked', reason: err.reason };
    case 'not-found':
    case 'gone':
      return { kind: 'expired', reason: err.reason };
    default:
      return { kind: 'retry-later', reason: err.reason };
  }
}
