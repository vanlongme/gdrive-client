/**
 * Admin My Drive folder browser (wave 7, spec section 7).
 *
 *   GET /api/v1/admin/drive-folders?connectionId&parentId=root|<id>&pageToken
 *
 * Lists the folders the chosen OAuth catalog connection OWNS directly under
 * one parent in its personal My Drive, so an administrator can pick a mount
 * root. It runs `oauth.files.list` with `corpora=user` under the operator
 * identity named by connectionId: no SA path and no fallback exist.
 *
 * Invariants:
 *   - admin session re-verified per request (requireAdmin);
 *   - parentId is 'root' or a Drive id (charset-validated) before any D1 or
 *     Google call, so it can never inject into the `q` term;
 *   - the response carries only {id, name} (strict Zod schema); no
 *     connection ids, principal ids or credentials.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import { DriveFolderListResponseSchema } from '../../shared/contracts/admin';
import { requireAdmin as realRequireAdmin } from '../auth/session';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { DriveError } from '../drive/errors';
import { failureFromError, requireUsableOAuthWriter } from '../drive/mounts';
import {
  callDriveApi,
  clampPageSize,
  expectRecord,
  FOLDER_MIME_TYPE,
  sendJson,
} from '../drive/providers/common';
import { createDriveTransport, validateDriveId, type DriveTransport } from '../drive/transport';
import {
  oauthTokenIdentity,
  type CoordinatorTokenSource,
  type ProviderRequestContext,
  type ResolvedWriter,
} from '../drive/types';
import type { AdminIdentity, RequireAdminFn } from './routes';

// ---------------------------------------------------------------------------
// Lister (oauth.files.list, corpora=user)
// ---------------------------------------------------------------------------

export interface DriveFolderEntry {
  readonly id: string;
  readonly name: string;
}

export interface DriveFolderPage {
  readonly folders: readonly DriveFolderEntry[];
  /** Raw Google page token; the route echoes it back for the next page. */
  readonly nextPageToken?: string;
}

export interface ListOwnedFoldersInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  /** 'root' (the My Drive root alias) or a Drive folder id. */
  readonly parentId: string;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export interface DriveFolderLister {
  listOwnedFolders(input: ListOwnedFoldersInput): Promise<DriveFolderPage>;
}

const FOLDER_LIST_FIELDS = 'nextPageToken,files(id,name)';
const OPERATION = 'oauth.files.list';

function parseFolderPage(json: unknown): DriveFolderPage {
  const record = expectRecord(json, OPERATION);
  const files = record.files;
  if (!Array.isArray(files)) {
    throw new DriveError(
      'unexpected-response',
      `${OPERATION}: folder listing is missing the files array`,
      { operation: OPERATION },
    );
  }
  const folders: DriveFolderEntry[] = files.map((entry) => {
    const item = expectRecord(entry, OPERATION);
    const id = item.id;
    const name = item.name;
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') {
      throw new DriveError(
        'unexpected-response',
        `${OPERATION}: folder entry is missing id/name`,
        { operation: OPERATION },
      );
    }
    return { id, name };
  });
  const next = record.nextPageToken;
  return {
    folders,
    ...(typeof next === 'string' && next !== '' ? { nextPageToken: next } : {}),
  };
}

export function createDriveFolderLister(deps: {
  readonly tokenSource: CoordinatorTokenSource;
  readonly transport?: DriveTransport;
}): DriveFolderLister {
  const transport = deps.transport ?? createDriveTransport('google_oauth');
  return {
    async listOwnedFolders(input) {
      const parent = validateDriveId(input.parentId, OPERATION);
      const q =
        `'${parent}' in parents and mimeType = '${FOLDER_MIME_TYPE}' ` +
        `and 'me' in owners and trashed = false`;
      return callDriveApi(
        deps.tokenSource,
        oauthTokenIdentity(input.writer),
        OPERATION,
        (bearer) =>
          sendJson(
            transport,
            {
              operation: OPERATION,
              token: bearer,
              path: '/drive/v3/files',
              query: {
                q,
                corpora: 'user',
                supportsAllDrives: true,
                fields: FOLDER_LIST_FIELDS,
                pageSize: clampPageSize(input.pageSize),
                pageToken: input.pageToken,
                orderBy: 'name_natural',
              },
              signal: input.signal,
            },
            OPERATION,
            parseFolderPage,
          ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface DriveFoldersRouterDeps {
  readonly requireAdmin?: RequireAdminFn;
  /** Fixture lister in tests; production builds the real one per request. */
  readonly folderLister?: DriveFolderLister;
}

type RouterContext = Context<{
  Bindings: Env;
  Variables: { requestId?: string };
}>;

const MAX_PAGE_TOKEN_CHARS = 2048;

function fail(
  c: RouterContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  return c.json(buildApiError(code, message, requestId, retryAfterSeconds), status);
}

function errorResponse(c: RouterContext, err: unknown): Response {
  const failure = failureFromError(err, { provider: 'google_oauth', surface: 'catalog' });
  return fail(
    c,
    failure.status as ContentfulStatusCode,
    failure.code,
    failure.message,
    failure.retryAfterSeconds,
  );
}

async function adminOrResponse(
  c: RouterContext,
  requireAdmin: RequireAdminFn,
): Promise<{ admin: AdminIdentity } | { response: Response }> {
  try {
    return { admin: await requireAdmin(c.req.raw, c.env) };
  } catch (err) {
    return { response: errorResponse(c, err) };
  }
}

function isDriveFolderRef(raw: string): boolean {
  try {
    validateDriveId(raw, 'admin.drive-folders');
    return true;
  } catch {
    return false;
  }
}

export function createDriveFoldersRouter(deps: DriveFoldersRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const listerFor = (env: Env): DriveFolderLister =>
    deps.folderLister ??
    createDriveFolderLister({ tokenSource: createCoordinatorTokenSource(env) });

  app.get('/', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const connectionId = c.req.query('connectionId');
      if (connectionId === undefined || connectionId.trim() === '') {
        return fail(c, 400, 'VALIDATION_FAILED', 'The connectionId query parameter is required.');
      }
      const parentId = c.req.query('parentId') ?? 'root';
      if (!isDriveFolderRef(parentId)) {
        return fail(c, 400, 'VALIDATION_FAILED', "parentId must be 'root' or a Drive folder id.");
      }
      const pageSizeParam = c.req.query('pageSize');
      let pageSize: number | undefined;
      if (pageSizeParam !== undefined) {
        const parsed = Number(pageSizeParam);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          return fail(c, 400, 'VALIDATION_FAILED', 'pageSize must be an integer between 1 and 100.');
        }
        pageSize = parsed;
      }
      const pageTokenParam = c.req.query('pageToken');
      const pageToken =
        pageTokenParam === undefined || pageTokenParam === '' ? undefined : pageTokenParam;
      if (pageToken !== undefined && pageToken.length > MAX_PAGE_TOKEN_CHARS) {
        return fail(c, 400, 'VALIDATION_FAILED', 'pageToken is too long.');
      }

      const state = await requireUsableOAuthWriter(c.env.DB, connectionId, 'catalog');
      const page = await listerFor(c.env).listOwnedFolders({
        writer: state.writer,
        parentId,
        ...(pageToken === undefined ? {} : { pageToken }),
        ...(pageSize === undefined ? {} : { pageSize }),
        signal: c.req.raw.signal,
      });
      return c.json(
        DriveFolderListResponseSchema.parse({
          folders: page.folders.map((f) => ({ id: f.id, name: f.name })),
          ...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }),
        }),
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}
