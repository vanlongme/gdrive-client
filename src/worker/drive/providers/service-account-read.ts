/**
 * ServiceAccountReadProvider — content-read adapter for the SA pool
 * (spec §5.1, §7.1). The interface has no write methods and the transport it
 * is built on cannot express a Drive mutation: every operation is a
 * fixed-shape read on www.googleapis.com or a validated *.googleusercontent.com
 * thumbnail fetch. There is no path by which this provider could fall back to
 * OAuth bytes, impersonate a user, or write.
 *
 * The SA requests only `drive.readonly` scope via the injected
 * CoordinatorTokenSource; it never signs JWTs, chooses pool members or
 * stores tokens.
 */

import { DriveError } from '../errors';
import {
  createDriveTransport,
  drivePathSegment,
  type DriveTransport,
} from '../transport';
import {
  callDriveApi,
  FILE_READ_META_FIELDS,
  parseFileMeta,
  parseUpstreamContent,
  REVISION_META_FIELDS,
  sendJson,
} from './common';
import {
  saTokenIdentity,
  type CoordinatorTokenSource,
  type TokenFailureKind,
  type DriveFileMeta,
  type DriveRevisionMeta,
  type DriveResourceRef,
  type ExportDocumentInput,
  type GetRevisionInput,
  type OpenContentInput,
  type OpenThumbnailInput,
  type ReadIdentity,
  type ReadMetadataInput,
  type ServiceAccountContentReadProvider,
  type UpstreamContent,
} from '../types';

const EXPORT_MIME_TYPES = { pdf: 'application/pdf' } as const;

/**
 * Google reasons that are REAL per-file caps rather than a verdict
 * mismatch (wave-10 review round-2): a cache-metadata open that hits one
 * of these must still report file_limited exactly as the live path does.
 */
const REAL_FILE_CAP_GOOGLE_REASONS = new Set([
  'downloadQuotaExceeded',
  'fileDownloadLimitExceeded',
]);

/**
 * Media opens that relied on cached — not live-verified — metadata
 * suppress ONLY the 'cannotDownloadFile' file_limited report (wave-10
 * review M2/round-2): that denial may merely prove the cached verdict
 * stale, and the route re-verifies live before answering. Every other
 * file_limited reason (the real per-file caps above), and every
 * rate-limit/auth/upstream class, still reports — they describe the file,
 * the SA or Google, not the verdict.
 */
function suppressCachedMetaReport(
  err: DriveError,
  kind: TokenFailureKind,
): boolean {
  return (
    kind === 'file_limited' &&
    err.googleReasons.includes('cannotDownloadFile') &&
    !err.googleReasons.some((r) => REAL_FILE_CAP_GOOGLE_REASONS.has(r))
  );
}

export interface ServiceAccountReadProviderDeps {
  readonly tokenSource: CoordinatorTokenSource;
  /** Optional prebuilt transport (tests); defaults to the SA allowlist. */
  readonly transport?: DriveTransport;
}

export function createServiceAccountReadProvider(
  deps: ServiceAccountReadProviderDeps,
): ServiceAccountContentReadProvider {
  const tokenSource = deps.tokenSource;
  const transport = deps.transport ?? createDriveTransport('service_account');

  function authed<T>(
    identity: ReadIdentity,
    operation: string,
    run: (bearer: string) => Promise<T>,
    options: {
      fileId?: string;
      signal?: AbortSignal;
      metaFromCache?: boolean;
    } = {},
  ): Promise<T> {
    return callDriveApi(tokenSource, saTokenIdentity(identity), operation, run, {
      ...(options.fileId === undefined ? {} : { fileId: options.fileId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.metaFromCache === true
        ? { suppressReport: suppressCachedMetaReport }
        : {}),
    });
  }

  function resourceKeyHeaders(ref: DriveResourceRef): Record<string, string> {
    return ref.resourceKey === undefined
      ? {}
      : { 'X-Goog-Drive-Resource-Keys': `${ref.id}/${ref.resourceKey}` };
  }

  return {
    getReadMetadata(input: ReadMetadataInput): Promise<DriveFileMeta> {
      const operation = 'sa.files.get';
      const file = drivePathSegment(input.ref.id, operation);
      return authed(input.identity, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: `/drive/v3/files/${file}`,
            query: {
              supportsAllDrives: true,
              fields: FILE_READ_META_FIELDS,
            },
            headers: resourceKeyHeaders(input.ref),
            signal: input.signal,
          },
          operation,
          (json) => parseFileMeta(json, operation),
        ),
      { fileId: input.ref.id });
    },

    async getRevision(input: GetRevisionInput): Promise<DriveRevisionMeta> {
      const operation = 'sa.revisions.get';
      const file = drivePathSegment(input.ref.id, operation);
      const revision = drivePathSegment(input.revisionId, operation);
      const json = await authed(input.identity, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: `/drive/v3/files/${file}/revisions/${revision}`,
            query: { fields: REVISION_META_FIELDS },
            headers: resourceKeyHeaders(input.ref),
            signal: input.signal,
          },
          operation,
          (parsed) => parsed,
        ),
      { fileId: input.ref.id });
      const record = json as Record<string, unknown>;
      const id = record.id;
      if (typeof id !== 'string' || id === '') {
        throw new DriveError(
          'unexpected-response',
          `${operation}: revision metadata carried no id`,
          { operation },
        );
      }
      const size = record.size;
      if (size !== undefined && (typeof size !== 'string' || !/^[0-9]+$/.test(size))) {
        throw new DriveError(
          'unexpected-response',
          `${operation}: non-decimal revision size`,
          { operation },
        );
      }
      return {
        id,
        size: size === undefined ? undefined : (size as DriveRevisionMeta['size']),
        mimeType:
          typeof record.mimeType === 'string' ? record.mimeType : undefined,
        modifiedTime:
          typeof record.modifiedTime === 'string'
            ? record.modifiedTime
            : undefined,
        keepForever: record.keepForever === true,
      };
    },

    async openContent(input: OpenContentInput): Promise<UpstreamContent> {
      const operation =
        input.revisionId === undefined ? 'sa.files.media' : 'sa.revisions.media';
      const file = drivePathSegment(input.ref.id, operation);
      const path =
        input.revisionId === undefined
          ? `/drive/v3/files/${file}`
          : `/drive/v3/files/${file}/revisions/${drivePathSegment(input.revisionId, operation)}`;
      const headers: Record<string, string> = resourceKeyHeaders(input.ref);
      if (input.range !== undefined) {
        if (input.range.start < 0n || input.range.end < input.range.start) {
          throw new DriveError(
            'invalid-input',
            `${operation}: range must be a non-empty inclusive byte range`,
            { operation },
          );
        }
        headers.Range = `bytes=${input.range.start.toString(10)}-${input.range.end.toString(10)}`;
      }
      const res = await authed(input.identity, operation, (bearer) =>
        transport.send({
          operation,
          token: bearer,
          path,
          query: {
            alt: 'media',
            supportsAllDrives: true,
          },
          headers,
          signal: input.signal,
        }),
      {
        fileId: input.ref.id,
        signal: input.signal,
        ...(input.metaFromCache === true ? { metaFromCache: true } : {}),
      });
      return parseUpstreamContent(res, operation);
    },

    async openThumbnail(input: OpenThumbnailInput): Promise<UpstreamContent> {
      let link: unknown = input.thumbnailLink;
      const metadataOperation = 'sa.files.get';
      if (link === undefined) {
        // Legacy path: the caller did not carry an admission thumbnailLink
        // (a metadata-cache hit carries none). This files.get stands in for
        // the admission metadata read, so it must re-prove the same
        // download verdict the route's checkFileMeta would have (wave-10
        // review M3): canDownload === false denies exactly like the live
        // path, and a missing flag stays inconclusive — failover-eligible.
        const file = drivePathSegment(input.ref.id, metadataOperation);
        const json = await authed(input.identity, metadataOperation, (bearer) =>
          sendJson(
            transport,
            {
              operation: metadataOperation,
              token: bearer,
              path: `/drive/v3/files/${file}`,
              query: { fields: 'thumbnailLink,capabilities(canDownload)' },
              headers: resourceKeyHeaders(input.ref),
              signal: input.signal,
            },
            metadataOperation,
            (parsed) => parsed,
          ),
        { fileId: input.ref.id });
        const record = json as Record<string, unknown>;
        const capabilities =
          typeof record.capabilities === 'object' && record.capabilities !== null
            ? (record.capabilities as Record<string, unknown>)
            : undefined;
        const canDownload = capabilities?.canDownload;
        if (canDownload === false) {
          throw new DriveError(
            'download-restricted',
            `${metadataOperation}: file may not be downloaded by this identity`,
            { operation: metadataOperation },
          );
        }
        if (canDownload !== true) {
          throw new DriveError(
            'upstream-unavailable',
            `${metadataOperation}: download capability was not affirmed`,
            { operation: metadataOperation },
          );
        }
        link = record.thumbnailLink;
      }
      if (typeof link !== 'string' || link === '') {
        throw new DriveError(
          'not-found',
          `${metadataOperation}: file has no upstream thumbnail`,
          { operation: metadataOperation },
        );
      }
      const operation = 'sa.thumbnail.fetch';
      const res = await authed(input.identity, operation, (bearer) =>
        transport.send({
          operation,
          token: bearer,
          absoluteUrl: link,
          signal: input.signal,
        }),
      {
        fileId: input.ref.id,
        ...(input.metaFromCache === true ? { metaFromCache: true } : {}),
      });
      return parseUpstreamContent(res, operation);
    },

    async exportDocument(input: ExportDocumentInput): Promise<UpstreamContent> {
      const operation = 'sa.files.export';
      const file = drivePathSegment(input.ref.id, operation);
      const res = await authed(input.identity, operation, (bearer) =>
        transport.send({
          operation,
          token: bearer,
          path: `/drive/v3/files/${file}/export`,
          query: { mimeType: EXPORT_MIME_TYPES[input.format] },
          headers: resourceKeyHeaders(input.ref),
          signal: input.signal,
        }),
      {
        fileId: input.ref.id,
        ...(input.metaFromCache === true ? { metaFromCache: true } : {}),
      });
      return parseUpstreamContent(res, operation);
    },
  };
}
