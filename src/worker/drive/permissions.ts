/**
 * OAuth Drive permissions adapter for My Drive read-pool grants (wave 7).
 *
 * The app shares a mount's root folder with its pool service accounts as
 * `reader` and removes the grants again. Every call is an OAuth operation
 * issued with the mount's WRITE connection (the caller resolves the writer);
 * SAs never touch permissions. The transport pins the query
 * (`supportsAllDrives=true`, `sendNotificationEmail=false`, fixed `fields`)
 * and the create body (`{type:'user', role:'reader', emailAddress}`), so the
 * only caller-chosen value is the address, which the caller reads from the
 * stored `service_accounts` row and never from a request.
 *
 * Upstream failures are mapped onto stable `grant:*` codes here; Google's
 * own message text never leaves this module.
 */

import { DriveError } from './errors';
import {
  createDriveTransport,
  drivePathSegment,
  type DriveTransport,
} from './transport';
import {
  callDriveApi,
  clampPageSize,
  expectRecord,
  sendJson,
} from './providers/common';
import {
  oauthTokenIdentity,
  type CoordinatorTokenSource,
  type ProviderRequestContext,
  type ResolvedWriter,
} from './types';

/** At most this many Drive permission mutations per sync call (spec §5). */
export const GRANT_SYNC_MAX_MUTATIONS = 20;
/** Used when a rate-limit response carries no Retry-After (spec §5). */
export const GRANT_RETRY_AFTER_DEFAULT_S = 30;

const PERMISSION_LIST_FIELDS = 'permissions(id,type,role,emailAddress),nextPageToken';
const PERMISSION_LIST_MAX_PAGE_SIZE = 100;

export interface DrivePermission {
  readonly id: string;
  readonly type: string;
  readonly role: string;
  /** Absent for non-user grantees (anyone, domain). */
  readonly emailAddress?: string;
}

export interface PermissionsPage {
  readonly permissions: readonly DrivePermission[];
  /** Raw Google page token; pass it back as `pageToken`. */
  readonly nextPageToken?: string;
}

export interface ListPermissionsInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly fileId: string;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export interface CreateReaderPermissionInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly fileId: string;
  /** The stored service-account address; the pinned body carries nothing else. */
  readonly emailAddress: string;
}

export interface DeletePermissionInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly fileId: string;
  readonly permissionId: string;
}

export interface DrivePermissionsProvider {
  listPermissions(input: ListPermissionsInput): Promise<PermissionsPage>;
  /** Share `fileId` with `emailAddress` as reader, no notification e-mail. */
  createReaderPermission(
    input: CreateReaderPermissionInput,
  ): Promise<{ readonly id: string }>;
  deletePermission(input: DeletePermissionInput): Promise<void>;
}

export interface DrivePermissionsProviderDeps {
  readonly tokenSource: CoordinatorTokenSource;
  /** Optional prebuilt transport (tests); defaults to the OAuth allowlist. */
  readonly transport?: DriveTransport;
}

function parsePermissionsPage(json: unknown, operation: string): PermissionsPage {
  const record = expectRecord(json, operation);
  const list = record.permissions;
  if (!Array.isArray(list)) {
    throw new DriveError(
      'unexpected-response',
      `${operation}: response is missing the permissions array`,
      { operation },
    );
  }
  const permissions: DrivePermission[] = list.map((entry) => {
    const item = expectRecord(entry, operation);
    const { id, type, role, emailAddress } = item;
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof type !== 'string' ||
      typeof role !== 'string'
    ) {
      throw new DriveError(
        'unexpected-response',
        `${operation}: permission entry is missing id/type/role`,
        { operation },
      );
    }
    return {
      id,
      type,
      role,
      ...(typeof emailAddress === 'string' && emailAddress !== ''
        ? { emailAddress }
        : {}),
    };
  });
  const nextPageToken = record.nextPageToken;
  return {
    permissions,
    ...(typeof nextPageToken === 'string' && nextPageToken !== ''
      ? { nextPageToken }
      : {}),
  };
}

export function createDrivePermissionsProvider(
  deps: DrivePermissionsProviderDeps,
): DrivePermissionsProvider {
  const tokenSource = deps.tokenSource;
  const transport = deps.transport ?? createDriveTransport('google_oauth');

  return {
    async listPermissions(input) {
      const operation = 'oauth.permissions.list';
      const file = drivePathSegment(input.fileId, operation);
      return await callDriveApi(
        tokenSource,
        oauthTokenIdentity(input.writer),
        operation,
        (bearer) =>
          sendJson(
            transport,
            {
              operation,
              token: bearer,
              path: `/drive/v3/files/${file}/permissions`,
              query: {
                supportsAllDrives: true,
                fields: PERMISSION_LIST_FIELDS,
                pageSize: Math.min(
                  clampPageSize(input.pageSize ?? PERMISSION_LIST_MAX_PAGE_SIZE),
                  PERMISSION_LIST_MAX_PAGE_SIZE,
                ),
                pageToken: input.pageToken,
              },
              signal: input.signal,
            },
            operation,
            (json) => parsePermissionsPage(json, operation),
          ),
      );
    },

    async createReaderPermission(input) {
      const operation = 'oauth.permissions.create';
      const file = drivePathSegment(input.fileId, operation);
      return await callDriveApi(
        tokenSource,
        oauthTokenIdentity(input.writer),
        operation,
        (bearer) =>
          sendJson(
            transport,
            {
              operation,
              token: bearer,
              path: `/drive/v3/files/${file}/permissions`,
              query: {
                sendNotificationEmail: false,
                supportsAllDrives: true,
                fields: 'id',
              },
              body: {
                kind: 'json',
                json: {
                  type: 'user',
                  role: 'reader',
                  emailAddress: input.emailAddress,
                },
              },
              signal: input.signal,
            },
            operation,
            (json) => {
              const id = expectRecord(json, operation).id;
              if (typeof id !== 'string' || id === '') {
                throw new DriveError(
                  'unexpected-response',
                  `${operation}: response carried no permission id`,
                  { operation },
                );
              }
              return { id };
            },
          ),
      );
    },

    async deletePermission(input) {
      const operation = 'oauth.permissions.delete';
      const file = drivePathSegment(input.fileId, operation);
      const permission = drivePathSegment(input.permissionId, operation);
      await callDriveApi(
        tokenSource,
        oauthTokenIdentity(input.writer),
        operation,
        async (bearer) => {
          const res = await transport.send({
            operation,
            token: bearer,
            path: `/drive/v3/files/${file}/permissions/${permission}`,
            query: { supportsAllDrives: true },
            signal: input.signal,
          });
          // 204 carries no body; release the connection either way.
          await res.body?.cancel().catch(() => undefined);
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Stable grant error codes
// ---------------------------------------------------------------------------

export type GrantErrorCode =
  | 'grant:rate_limited'
  | 'grant:forbidden'
  | 'grant:not_found'
  | 'grant:invalid_principal'
  | 'grant:upstream';

/**
 * Google 403 reasons that mean "slow down". `sharingRateLimitExceeded` is
 * specific to sharing and arrives as a plain 403, which errors.ts classifies
 * as `permission-denied`, so it is recognised here by its reason token.
 */
const GRANT_RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  'sharingRateLimitExceeded',
  'userRateLimitExceeded',
  'rateLimitExceeded',
]);

/** Map a DriveError from a permissions.* call onto a stable grant code. */
export function grantErrorCodeOf(err: DriveError): GrantErrorCode {
  if (
    err.reason === 'rate-limited' ||
    err.googleReasons.some((reason) => GRANT_RATE_LIMIT_REASONS.has(reason))
  ) {
    return 'grant:rate_limited';
  }
  switch (err.reason) {
    case 'permission-denied':
      return 'grant:forbidden';
    case 'not-found':
      return 'grant:not_found';
    case 'invalid-request':
      return 'grant:invalid_principal';
    default:
      return 'grant:upstream';
  }
}

/**
 * Failures that say nothing about one grant: the writer connection itself is
 * unusable (re-auth, disabled, stale version) or the call was cancelled. The
 * sync route surfaces these as a request-level error instead of marking rows.
 */
export function isConnectionLevelGrantError(err: DriveError): boolean {
  return (
    err.reason === 'unauthorized' ||
    err.reason === 'credential-disabled' ||
    err.reason === 'credential-version-changed' ||
    err.reason === 'aborted'
  );
}

/** Seconds a client should wait after a rate limit (Retry-After, else 30). */
export function retryAfterSecondsOf(err: DriveError): number {
  return err.retryAfterMs === undefined
    ? GRANT_RETRY_AFTER_DEFAULT_S
    : Math.max(1, Math.ceil(err.retryAfterMs / 1000));
}
