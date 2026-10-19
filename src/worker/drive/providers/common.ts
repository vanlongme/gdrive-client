/**
 * Shared internals for the two Drive providers: the bounded token/re-auth
 * policy, bounded JSON reading and response-shape parsing. All parsing is
 * defensive — unexpected upstream shapes surface as 'unexpected-response'
 * instead of propagating malformed data into typed contracts.
 */

import type { DecimalBytes } from '../../../shared/contracts/common';
import { decimalBytesFromBigInt, DECIMAL_BYTES_PATTERN } from '../../../shared/contracts/common';
import {
  DriveError,
  failureKindForDriveError,
  readBoundedBodyText,
  tokenResultToDriveError,
} from '../errors';
import type { DriveTransport, TransportRequest } from '../transport';
import type {
  CatalogEntry,
  CatalogPage,
  CoordinatorTokenSource,
  DriveFileMeta,
  TokenIdentity,
  UpstreamContent,
} from '../types';

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';

/** Metadata shape the OAuth catalog/verify paths consume. */
export const FILE_META_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'modifiedTime',
  'trashed',
  'parents',
  'driveId',
  'ownedByMe',
  'headRevisionId',
  'md5Checksum',
  'sha256Checksum',
  'resourceKey',
  'thumbnailLink',
  'shortcutDetails(targetId,targetMimeType,targetResourceKey)',
  'capabilities(canDownload,canAddChildren,canTrash,canReadRevisions)',
].join(',');

/** Listing/search fields; thumbnail presence only, never the URL. */
export const FILE_LIST_FIELDS = [
  'nextPageToken',
  'files(id,name,mimeType,size,modifiedTime,parents,shortcutDetails(targetId,targetMimeType,targetResourceKey),resourceKey,thumbnailLink)',
].join(',');

/** SA metadata fields incl. read-side capabilities (spec §7.1). */
export const FILE_READ_META_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'modifiedTime',
  'trashed',
  'parents',
  'driveId',
  'headRevisionId',
  'md5Checksum',
  'sha256Checksum',
  'resourceKey',
  'thumbnailLink',
  'shortcutDetails(targetId,targetMimeType,targetResourceKey)',
  'capabilities(canDownload,canReadRevisions)',
].join(',');

export const REVISION_META_FIELDS = [
  'id',
  'mimeType',
  'modifiedTime',
  'size',
  'keepForever',
].join(',');

const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Bounded token + re-auth policy (frozen CoordinatorTokenSource)
// ---------------------------------------------------------------------------

/**
 * Acquire a token, run the operation, and apply the bounded auth policy:
 * on an upstream 401 the failure is reported to the coordinator and exactly
 * one fresh token is requested before a single retry. Requests carrying a
 * streamed body never re-auth (the body is consumed) and no failure ever
 * triggers a retry under a different identity (spec §5.4).
 */
export async function callDriveApi<T>(
  tokenSource: CoordinatorTokenSource,
  identity: TokenIdentity,
  operation: string,
  run: (bearer: string) => Promise<T>,
  options: { hasStreamBody?: boolean; fileId?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const admission =
    options.fileId === undefined ? undefined : { fileId: options.fileId };
  const first = await tokenSource.getToken(identity, admission);
  if (!first.ok) throw tokenResultToDriveError(first, operation);
  let bearer = first.accessToken;
  let reauthed = false;

  for (;;) {
    try {
      return await run(bearer);
    } catch (err) {
      if (!(err instanceof DriveError)) throw err;
      const failureKind = failureKindForDriveError(err);
      // A call that was already aborted never reports: a denied request's
      // speculated media open must not push the SA into cooldown (M4).
      if (failureKind !== undefined && options.signal?.aborted !== true) {
        try {
          await tokenSource.reportFailure(identity, {
            kind: failureKind,
            ...(err.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: err.retryAfterMs }),
            ...(options.fileId === undefined
              ? {}
              : { fileId: options.fileId }),
          });
        } catch {
          // Health reporting must never mask the real error.
        }
      }
      if (
        err.reason === 'unauthorized' &&
        !reauthed &&
        options.hasStreamBody !== true
      ) {
        reauthed = true;
        const second = await tokenSource.getToken(identity, admission);
        if (!second.ok) throw tokenResultToDriveError(second, operation);
        bearer = second.accessToken;
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded JSON reading + shape parsing
// ---------------------------------------------------------------------------

export async function sendJson<T>(
  transport: DriveTransport,
  request: TransportRequest,
  operation: string,
  parse: (json: unknown) => T,
): Promise<T> {
  const res = await transport.send(request);
  const text = await readBoundedBodyText(res.body, MAX_JSON_RESPONSE_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DriveError(
      'unexpected-response',
      `${operation}: upstream returned a malformed JSON body`,
      { operation },
    );
  }
  return parse(json);
}

export function expectRecord(
  json: unknown,
  operation: string,
): Record<string, unknown> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: expected a JSON object`,
      { operation },
    );
  }
  return json as Record<string, unknown>;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  operation: string,
): string {
  const value = optionalString(record, key);
  if (value === undefined) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: missing required string field ${key}`,
      { operation },
    );
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseSize(
  record: Record<string, unknown>,
  operation: string,
): DecimalBytes | undefined {
  const size = record.size;
  if (size === undefined || size === null) return undefined;
  if (typeof size !== 'string' || !DECIMAL_BYTES_PATTERN.test(size)) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: non-decimal size in file metadata`,
      { operation },
    );
  }
  return decimalBytesFromBigInt(BigInt(size));
}

function optionalShortcutDetails(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = record.shortcutDetails;
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseFileMeta(json: unknown, operation: string): DriveFileMeta {
  const record = expectRecord(json, operation);
  const capabilitiesRecord =
    typeof record.capabilities === 'object' && record.capabilities !== null
      ? (record.capabilities as Record<string, unknown>)
      : undefined;
  const capabilities =
    capabilitiesRecord === undefined
      ? undefined
      : {
          canDownload: optionalBoolean(capabilitiesRecord, 'canDownload'),
          canAddChildren: optionalBoolean(capabilitiesRecord, 'canAddChildren'),
          canTrash: optionalBoolean(capabilitiesRecord, 'canTrash'),
          canReadRevisions: optionalBoolean(
            capabilitiesRecord,
            'canReadRevisions',
          ),
        };
  const shortcut = optionalShortcutDetails(record);
  return {
    id: requireString(record, 'id', operation),
    name: requireString(record, 'name', operation),
    mimeType: requireString(record, 'mimeType', operation),
    size: parseSize(record, operation),
    modifiedTime: optionalString(record, 'modifiedTime'),
    trashed: optionalBoolean(record, 'trashed'),
    parents: Array.isArray(record.parents)
      ? record.parents.filter((p): p is string => typeof p === 'string')
      : undefined,
    driveId: optionalString(record, 'driveId'),
    ownedByMe: optionalBoolean(record, 'ownedByMe'),
    headRevisionId: optionalString(record, 'headRevisionId'),
    md5Checksum: optionalString(record, 'md5Checksum'),
    sha256Checksum: optionalString(record, 'sha256Checksum'),
    resourceKey: optionalString(record, 'resourceKey'),
    hasThumbnail: optionalString(record, 'thumbnailLink') !== undefined,
    thumbnailLink: optionalString(record, 'thumbnailLink'),
    shortcutTargetId:
      shortcut === undefined ? undefined : optionalString(shortcut, 'targetId'),
    shortcutTargetMimeType:
      shortcut === undefined
        ? undefined
        : optionalString(shortcut, 'targetMimeType'),
    shortcutTargetResourceKey:
      shortcut === undefined
        ? undefined
        : optionalString(shortcut, 'targetResourceKey'),
    capabilities,
  };
}

function parseCatalogEntry(json: unknown, operation: string): CatalogEntry {
  const record = expectRecord(json, operation);
  const mimeType = requireString(record, 'mimeType', operation);
  const shortcut = optionalShortcutDetails(record);
  const kind: CatalogEntry['kind'] =
    mimeType === FOLDER_MIME_TYPE
      ? 'folder'
      : mimeType === SHORTCUT_MIME_TYPE
        ? 'shortcut'
        : 'file';
  return {
    id: requireString(record, 'id', operation),
    kind,
    name: requireString(record, 'name', operation),
    mimeType,
    size: parseSize(record, operation) ?? decimalBytesFromBigInt(0n),
    modifiedTime: optionalString(record, 'modifiedTime'),
    shortcutTargetId:
      kind === 'shortcut' && shortcut !== undefined
        ? optionalString(shortcut, 'targetId')
        : undefined,
    shortcutTargetResourceKey:
      kind === 'shortcut' && shortcut !== undefined
        ? optionalString(shortcut, 'targetResourceKey')
        : undefined,
    resourceKey: optionalString(record, 'resourceKey'),
    parents: Array.isArray(record.parents)
      ? record.parents.filter((p): p is string => typeof p === 'string')
      : undefined,
    hasThumbnail: optionalString(record, 'thumbnailLink') !== undefined,
  };
}

export function parseCatalogPage(json: unknown, operation: string): CatalogPage {
  const record = expectRecord(json, operation);
  const files = record.files;
  if (!Array.isArray(files)) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: listing response is missing the files array`,
      { operation },
    );
  }
  return {
    entries: files.map((entry) => parseCatalogEntry(entry, operation)),
    nextPageToken: optionalString(record, 'nextPageToken'),
  };
}

/** Escape a raw term for interpolation inside a Drive `q` clause. */
export function escapeDriveQueryTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new DriveError('invalid-input', 'pageSize must be a positive integer');
  }
  return Math.min(pageSize, MAX_LIST_PAGE_SIZE);
}

/**
 * Interpret a resumable-upload `Range` response header as Google's confirmed
 * byte count. Absent header means zero bytes confirmed (spec §6.4); any
 * other shape is an unexpected response, not a guess.
 */
export function parseResumeRangeHeader(
  header: string | null,
  operation: string,
): bigint {
  if (header === null) return 0n;
  const match = /^bytes=0-([0-9]+)$/.exec(header.trim());
  if (match === null || match[1] === undefined) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: unrecognized resume Range header`,
      { operation },
    );
  }
  return BigInt(match[1]) + 1n;
}

/** Wrap a pass-through binary Response into the typed UpstreamContent. */
export function parseUpstreamContent(
  res: Response,
  operation: string,
): UpstreamContent {
  const status = res.status;
  if (status !== 200 && status !== 206) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: unexpected status ${status} on a content response`,
      { operation },
    );
  }
  const body = res.body;
  if (body === null) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: content response carried no body`,
      { operation },
    );
  }
  const contentLengthRaw = res.headers.get('content-length');
  const contentLength =
    contentLengthRaw !== null && /^[0-9]+$/.test(contentLengthRaw)
      ? BigInt(contentLengthRaw)
      : undefined;
  const contentRange = res.headers.get('content-range') ?? undefined;
  if (status === 206) {
    if (
      contentRange === undefined ||
      !/^bytes [0-9]+-[0-9]+\/([0-9]+|\*)$/.test(contentRange)
    ) {
      throw new DriveError(
        'unexpected-response',
        `${operation}: 206 response carried an invalid Content-Range`,
        { operation },
      );
    }
  }
  return {
    status,
    contentType: res.headers.get('content-type') ?? undefined,
    contentLength,
    contentRange,
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
    body,
  };
}
