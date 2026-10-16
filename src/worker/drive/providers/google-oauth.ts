/**
 * GoogleOAuthProvider — operator-OAuth catalog and write adapter (spec §5.1).
 * Covers listing/search/metadata, ID generation, folder/file create, the
 * resumable-upload verbs (start/chunk/probe), verification and trash.
 *
 * Every method resolves its token through the injected
 * CoordinatorTokenSource for exactly the declared writer identity; the
 * provider never selects or substitutes a Google identity. This adapter is
 * never injected into content-serving routes: it has no content methods and
 * cannot emit user bytes (spec §7.1).
 */

import { DriveError, readBoundedBodyText } from '../errors';
import {
  assertUploadSessionUri,
  createDriveTransport,
  drivePathSegment,
  validateDriveId,
  type DriveTransport,
} from '../transport';
import {
  callDriveApi,
  clampPageSize,
  escapeDriveQueryTerm,
  expectRecord,
  FILE_LIST_FIELDS,
  FILE_META_FIELDS,
  FOLDER_MIME_TYPE,
  parseCatalogPage,
  parseFileMeta,
  parseResumeRangeHeader,
  sendJson,
} from './common';
import {
  oauthTokenIdentity,
  type CoordinatorTokenSource,
  type CreateFolderInput,
  type DriveFileMeta,
  type GenerateIdInput,
  type GetMetadataInput,
  type ListChildrenInput,
  type OAuthCatalogWriteProvider,
  type ProbeUploadInput,
  type ProviderRequestContext,
  type PutChunkInput,
  type ResolvedWriter,
  type SearchFilesInput,
  type StartUploadInput,
  type TrashFileInput,
  type UploadProgressResult,
  type UploadStart,
  type VerifyFileInput,
} from '../types';

const MAX_UPLOAD_RESULT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Shared Drive listing (spec §11.3 step 6; wave-5 T11). Admin-only surface:
// drives.list runs under the OAuth catalog identity the caller resolved —
// never an SA and never a fallback — and the transport pins
// useDomainAdminAccess=false so only drives that operator can see appear.
// ---------------------------------------------------------------------------

export interface SharedDriveEntry {
  readonly id: string;
  readonly name: string;
}

export interface SharedDrivesPage {
  readonly drives: readonly SharedDriveEntry[];
  /** Raw Google page token; the route echoes it back for the next page. */
  readonly nextPageToken?: string;
}

export interface ListSharedDrivesInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export interface SharedDriveLister {
  listSharedDrives(input: ListSharedDrivesInput): Promise<SharedDrivesPage>;
}

/** The provider object this module creates (OAuth catalog/write + drives). */
export interface GoogleOAuthProvider
  extends OAuthCatalogWriteProvider,
    SharedDriveLister {}

const SHARED_DRIVE_LIST_FIELDS = 'nextPageToken,drives(id,name)';

function parseSharedDrivesPage(
  json: unknown,
  operation: string,
): SharedDrivesPage {
  const record = expectRecord(json, operation);
  const list = record.drives;
  if (!Array.isArray(list)) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: drives list response is missing the drives array`,
      { operation },
    );
  }
  const drives: SharedDriveEntry[] = list.map((entry) => {
    const item = expectRecord(entry, operation);
    const id = item.id;
    const name = item.name;
    if (typeof id !== 'string' || id === '' || typeof name !== 'string') {
      throw new DriveError(
        'unexpected-response',
        `${operation}: drive entry is missing id/name`,
        { operation },
      );
    }
    return { id, name };
  });
  const nextPageToken = record.nextPageToken;
  return {
    drives,
    ...(typeof nextPageToken === 'string' && nextPageToken !== ''
      ? { nextPageToken }
      : {}),
  };
}

export interface GoogleOAuthProviderDeps {
  readonly tokenSource: CoordinatorTokenSource;
  /** Optional prebuilt transport (tests); defaults to the OAuth allowlist. */
  readonly transport?: DriveTransport;
}

export function createGoogleOAuthProvider(
  deps: GoogleOAuthProviderDeps,
): GoogleOAuthProvider {
  const tokenSource = deps.tokenSource;
  const transport = deps.transport ?? createDriveTransport('google_oauth');

  function authed<T>(
    writer: ResolvedWriter,
    operation: string,
    run: (bearer: string) => Promise<T>,
    options: { hasStreamBody?: boolean; fileId?: string } = {},
  ): Promise<T> {
    return callDriveApi(
      tokenSource,
      oauthTokenIdentity(writer),
      operation,
      run,
      options,
    );
  }

  function resourceKeyHeaders(ref: {
    id: string;
    resourceKey?: string;
  }): Record<string, string> {
    return ref.resourceKey === undefined
      ? {}
      : { 'X-Goog-Drive-Resource-Keys': `${ref.id}/${ref.resourceKey}` };
  }

  function listOrSearch(
    writer: ResolvedWriter,
    q: string,
    driveId: string,
    pageToken: string | undefined,
    pageSize: number | undefined,
    signal: AbortSignal | undefined,
  ) {
    return authed(writer, 'oauth.files.list', (bearer) =>
      sendJson(
        transport,
        {
          operation: 'oauth.files.list',
          token: bearer,
          path: '/drive/v3/files',
          query: {
            q,
            corpora: 'drive',
            driveId,
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: FILE_LIST_FIELDS,
            pageSize: clampPageSize(pageSize),
            pageToken,
            orderBy: 'folder,name_natural',
          },
          signal,
        },
        'oauth.files.list',
        (json) => parseCatalogPage(json, 'oauth.files.list'),
      ),
    );
  }

  /** Interpret a resumable-upload response: 308+Range or 200/201+file JSON. */
  async function readUploadProgress(
    res: Response,
    operation: string,
  ): Promise<UploadProgressResult> {
    if (res.status === 308) {
      return {
        kind: 'incomplete',
        confirmedOffset: parseResumeRangeHeader(
          res.headers.get('range'),
          operation,
        ),
      };
    }
    const text = await readBoundedBodyText(res.body, MAX_UPLOAD_RESULT_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new DriveError(
        'unexpected-response',
        `${operation}: upload completion carried a malformed body`,
        { operation },
      );
    }
    return { kind: 'completed', file: parseFileMeta(json, operation) };
  }

  return {
    listSharedDrives(input: ListSharedDrivesInput): Promise<SharedDrivesPage> {
      const operation = 'oauth.drives.list';
      return authed(input.writer, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: '/drive/v3/drives',
            query: {
              pageSize: clampPageSize(input.pageSize),
              pageToken: input.pageToken,
              fields: SHARED_DRIVE_LIST_FIELDS,
              useDomainAdminAccess: false,
            },
            signal: input.signal,
          },
          operation,
          (json) => parseSharedDrivesPage(json, operation),
        ),
      );
    },

    listChildren(input: ListChildrenInput) {
      const parent = validateDriveId(input.parentFolderId, 'oauth.files.list');
      const driveId = validateDriveId(input.driveId, 'oauth.files.list');
      const q = `'${parent}' in parents and trashed = false`;
      return listOrSearch(
        input.writer,
        q,
        driveId,
        input.pageToken,
        input.pageSize,
        input.signal,
      );
    },

    async search(input: SearchFilesInput) {
      const operation = 'oauth.files.list';
      const driveId = validateDriveId(input.driveId, operation);
      const term = input.query.trim();
      if (term === '') {
        throw new DriveError(
          'invalid-input',
          `${operation}: search query must not be empty`,
          { operation },
        );
      }
      let q = `name contains '${escapeDriveQueryTerm(term)}' and trashed = false`;
      if (input.scope === 'folder') {
        if (input.folderId === undefined) {
          throw new DriveError(
            'invalid-input',
            `${operation}: folder scope requires folderId`,
            { operation },
          );
        }
        const folder = validateDriveId(input.folderId, operation);
        q += ` and '${folder}' in parents`;
      }
      return listOrSearch(
        input.writer,
        q,
        driveId,
        input.pageToken,
        input.pageSize,
        input.signal,
      );
    },

    getMetadata(input: GetMetadataInput): Promise<DriveFileMeta> {
      const operation = 'oauth.files.get';
      const file = drivePathSegment(input.ref.id, operation);
      return authed(input.writer, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: `/drive/v3/files/${file}`,
            query: { supportsAllDrives: true, fields: FILE_META_FIELDS },
            headers: resourceKeyHeaders(input.ref),
            signal: input.signal,
          },
          operation,
          (json) => parseFileMeta(json, operation),
        ),
      { fileId: input.ref.id });
    },

    async generateId(input: GenerateIdInput): Promise<string> {
      const operation = 'oauth.files.generateIds';
      const json = await authed(input.writer, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: '/drive/v3/files/generateIds',
            query: {
              count: 1,
              space: 'drive',
              type: 'file',
              supportsAllDrives: true,
            },
            signal: input.signal,
          },
          operation,
          (parsed) => parsed,
        ),
      );
      const record = json as { ids?: unknown };
      const ids = record.ids;
      const id = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : '';
      return validateDriveId(id, operation);
    },

    createFolder(input: CreateFolderInput): Promise<DriveFileMeta> {
      const operation = 'oauth.files.create';
      const parent = validateDriveId(input.parentFolderId, operation);
      const generatedId = validateDriveId(input.generatedId, operation);
      return authed(input.writer, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: '/drive/v3/files',
            query: { supportsAllDrives: true, fields: FILE_META_FIELDS },
            body: {
              kind: 'json',
              json: {
                id: generatedId,
                name: input.name,
                mimeType: FOLDER_MIME_TYPE,
                parents: [parent],
              },
            },
            signal: input.signal,
          },
          operation,
          (json) => parseFileMeta(json, operation),
        ),
      );
    },

    async startUpload(input: StartUploadInput): Promise<UploadStart> {
      const operation = 'oauth.files.create';
      const parent = validateDriveId(input.parentFolderId, operation);
      const generatedId = validateDriveId(input.generatedFileId, operation);
      const metadata = {
        id: generatedId,
        name: input.name,
        mimeType: input.mimeType,
        parents: [parent],
      };

      // Zero-byte branch (spec §6.5): metadata-only create, no session.
      if (input.totalBytes === 0n) {
        const file = await authed(input.writer, operation, (bearer) =>
          sendJson(
            transport,
            {
              operation,
              token: bearer,
              path: '/drive/v3/files',
              query: { supportsAllDrives: true, fields: FILE_META_FIELDS },
              body: { kind: 'json', json: metadata },
              signal: input.signal,
            },
            operation,
            (json) => parseFileMeta(json, operation),
          ),
        );
        return { kind: 'created-empty', file };
      }

      const res = await authed(input.writer, 'oauth.upload.start', (bearer) =>
        transport.send({
          operation: 'oauth.upload.start',
          token: bearer,
          path: '/upload/drive/v3/files',
          query: { uploadType: 'resumable', supportsAllDrives: true },
          headers: {
            'X-Upload-Content-Type': input.mimeType,
            'X-Upload-Content-Length': input.totalBytes.toString(10),
          },
          body: { kind: 'json', json: metadata },
          signal: input.signal,
        }),
      );
      const location = res.headers.get('location');
      if (location === null) {
        throw new DriveError(
          'unexpected-response',
          'oauth.upload.start: resumable initiation returned no session URI',
          { operation: 'oauth.upload.start' },
        );
      }
      return {
        kind: 'resumable',
        sessionUri: assertUploadSessionUri(location),
        generatedFileId: generatedId,
      };
    },

    async putChunk(input: PutChunkInput): Promise<UploadProgressResult> {
      const operation = 'oauth.upload.chunk';
      if (input.chunkBytes < 1 || input.chunkBytes > 16 * 1024 * 1024) {
        throw new DriveError(
          'invalid-input',
          `${operation}: chunk size is outside the 4/8/16 MiB policy`,
          { operation },
        );
      }
      if (
        input.offset < 0n ||
        input.totalBytes <= 0n ||
        input.offset + BigInt(input.chunkBytes) > input.totalBytes
      ) {
        throw new DriveError(
          'invalid-input',
          `${operation}: chunk range exceeds the declared total`,
          { operation },
        );
      }
      const last = input.offset + BigInt(input.chunkBytes) - 1n;
      const res = await authed(
        input.writer,
        operation,
        (bearer) =>
          transport.send({
            operation,
            token: bearer,
            absoluteUrl: assertUploadSessionUri(input.sessionUri),
            headers: {
              'Content-Range': `bytes ${input.offset.toString(10)}-${last.toString(10)}/${input.totalBytes.toString(10)}`,
            },
            body: {
              kind: 'stream',
              stream: input.body,
              bytes: input.chunkBytes,
            },
            signal: input.signal,
          }),
        { hasStreamBody: true },
      );
      return readUploadProgress(res, operation);
    },

    async probeUpload(input: ProbeUploadInput): Promise<UploadProgressResult> {
      const operation = 'oauth.upload.probe';
      if (input.totalBytes <= 0n) {
        throw new DriveError(
          'invalid-input',
          `${operation}: total must be positive`,
          { operation },
        );
      }
      const res = await authed(input.writer, operation, (bearer) =>
        transport.send({
          operation,
          token: bearer,
          absoluteUrl: assertUploadSessionUri(input.sessionUri),
          headers: {
            'Content-Range': `bytes */${input.totalBytes.toString(10)}`,
            'Content-Length': '0',
          },
          signal: input.signal,
        }),
      );
      return readUploadProgress(res, operation);
    },

    verifyFile(input: VerifyFileInput): Promise<DriveFileMeta> {
      const operation = 'oauth.files.get';
      const file = drivePathSegment(input.ref.id, operation);
      return authed(input.writer, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: `/drive/v3/files/${file}`,
            query: { supportsAllDrives: true, fields: FILE_META_FIELDS },
            headers: resourceKeyHeaders(input.ref),
            signal: input.signal,
          },
          operation,
          (json) => parseFileMeta(json, operation),
        ),
      { fileId: input.ref.id });
    },

    async trashFile(input: TrashFileInput): Promise<void> {
      const operation = 'oauth.files.update';
      const file = drivePathSegment(input.ref.id, operation);
      await authed(input.writer, operation, (bearer) =>
        sendJson(
          transport,
          {
            operation,
            token: bearer,
            path: `/drive/v3/files/${file}`,
            query: { supportsAllDrives: true },
            headers: resourceKeyHeaders(input.ref),
            body: { kind: 'json', json: { trashed: true } },
            signal: input.signal,
          },
          operation,
          (json) => json,
        ),
      { fileId: input.ref.id });
    },
  };
}
