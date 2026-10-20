/**
 * Mount records, actor resolution and mount-scoped authorization
 * (architecture §5.2, §9.3; wave-3 contract, worker A).
 *
 * This module is the single server-side path that turns an HTTP request into
 * an authorized mount operation. Every downstream route (catalog, content,
 * upload, readiness) resolves the actor and the mount access through here —
 * no handler infers permission from Google roles, listing caches or client
 * claims.
 *
 * Frozen wave-3 exports (announced to the coordinator):
 *   - getMount(db, mountId): Promise<MountRecord | null>
 *   - resolveActor(request, env): Promise<Actor> — authenticated app user or
 *     anonymous 'public'; invalid credentials fail closed with AuthError.
 *   - requireMountAccess(env, request, mountId, operation):
 *       Promise<{ actor, access, mount }> — throws ApiRequestError/AuthError.
 *   - resolveWriter(db, connectionId, pinned?): Promise<ResolvedWriter|null>
 *     — resolves a connection to the pinned-writer tuple with CURRENT row
 *     versions; an optional pinned identity must match exactly or the call
 *     returns null (never substitutes another Google identity).
 *   - listReadPool(db, mountId): Promise<ReadPoolEntry[]> — the SA read pool
 *     with current credential versions for content admission.
 *   - listMountAccesses(db, actor): Promise<MountAccessEntry[]> — mounts the
 *     actor can see with the operations they hold.
 */

import { authorizeMount, type Actor, type MountAccess, type MountOperation } from '../auth/grants';
import { AuthError, getAuthSession } from '../auth/session';
import { getBootstrapConfig } from '../security/bootstrap-config';
import { readCanonicalOrigin } from '../auth/better-auth';
import { getRequestHints } from '../timing';
import type { ApiErrorCode } from '../../shared/contracts/common';
import type { MountVisibility } from '../../shared/contracts/drive';
import {
  readConnection,
  readOAuthClient,
  type ConnectionRow,
  type OAuthClientRow,
} from './oauth/transactions';
import type { PinnedWriter, ReadIdentity, ResolvedWriter } from './types';
import { DriveError, driveErrorToApiCode } from './errors';
import { ResourceScopeError } from './containment';

// ---------------------------------------------------------------------------
// Mount record (mounts table projection; the internal connection ids are
// server-side — user-facing DTOs are built in contracts/drive.ts).
// ---------------------------------------------------------------------------

/** Derived from drive_id: NULL means a My Drive folder mount. */
export type MountKind = 'shared_drive' | 'my_drive_folder';

export interface MountRecord {
  readonly id: string;
  readonly label: string;
  /** null => My Drive folder mount. */
  readonly driveId: string | null;
  /** Shared Drive: equals driveId. */
  readonly rootFolderId: string;
  readonly catalogConnectionId: string;
  readonly writeConnectionId: string;
  readonly readPoolVersion: number;
  readonly visibility: MountVisibility;
  readonly policyVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MountRow {
  id: string;
  label: string;
  drive_id: string | null;
  root_folder_id: string;
  catalog_connection_id: string;
  write_connection_id: string;
  read_pool_version: number;
  visibility: string;
  policy_version: number;
  created_at: number;
  updated_at: number;
}

export const MOUNT_COLUMNS =
  'id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, ' +
  'read_pool_version, visibility, policy_version, created_at, updated_at';

export function toMountRecord(r: MountRow): MountRecord {
  return {
    id: r.id,
    label: r.label,
    driveId: r.drive_id,
    rootFolderId: r.root_folder_id,
    catalogConnectionId: r.catalog_connection_id,
    writeConnectionId: r.write_connection_id,
    readPoolVersion: r.read_pool_version,
    visibility: r.visibility === 'public_read' ? 'public_read' : 'private',
    policyVersion: r.policy_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Fetch one mount by id; null when absent. */
export async function getMount(
  db: D1Database,
  mountId: string,
): Promise<MountRecord | null> {
  const row = await db
    .prepare(`SELECT ${MOUNT_COLUMNS} FROM mounts WHERE id = ?`)
    .bind(mountId)
    .first<MountRow>();
  return row === null ? null : toMountRecord(row);
}

// ---------------------------------------------------------------------------
// Typed request failure. Routes translate this (plus AuthError and
// DriveError) into the shared ApiErrorBody envelope; statuses stay inside
// the standard taxonomy via statusForApiCode.
// ---------------------------------------------------------------------------

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Canonical HTTP status for each error code the wave-3 routes emit. */
export function statusForApiCode(code: ApiErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'SETUP_TOKEN_INVALID':
    case 'MOUNT_ROOT_NOT_FOLDER':
    case 'MOUNT_ROOT_NOT_OWNED':
    case 'MOUNT_ROOT_IS_MY_DRIVE':
    case 'MOUNT_ROOT_TRASHED':
    case 'MOUNT_ROOT_NOT_WRITABLE':
    case 'MOUNT_WRITER_MISMATCH':
      return 400;
    case 'AUTH_REQUIRED':
      return 401;
    case 'FORBIDDEN':
    case 'ORIGIN_REJECTED':
    case 'PUBLIC_LINK_PASSWORD_REQUIRED':
    case 'PUBLIC_LINK_INVALID_PASSWORD':
    case 'PUBLIC_LINK_ARCHIVE_DISABLED':
      return 403;
    case 'NOT_FOUND':
    case 'FILE_NOT_ACCESSIBLE':
      return 404;
    case 'FILE_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
    case 'GOOGLE_CONNECTION_DISABLED':
    case 'SETUP_ALREADY_COMPLETED':
    case 'SETUP_IN_PROGRESS':
    case 'MEDIA_PACKAGE_NOT_READY':
    case 'SNAPSHOT_UNAVAILABLE':
    case 'CONTENT_CHANGED':
    case 'UPLOAD_EXPIRED':
    case 'UPLOAD_NEEDS_RECONCILIATION':
    case 'MOUNT_KIND_UNSUPPORTED':
    case 'PUBLIC_LINK_CONFLICT':
    case 'READ_POOL_CONFLICT':
      return 409;
    case 'PUBLIC_LINK_EXPIRED':
      return 410;
    case 'PUBLIC_LINK_TOO_LARGE':
      return 413;
    case 'PREVIEW_UNSUPPORTED':
      return 415;
    case 'RATE_LIMITED':
    case 'PROJECT_LIMITED':
      return 429;
    case 'GOOGLE_REAUTH_REQUIRED':
    case 'DRIVE_UNAVAILABLE':
    case 'READ_PROVIDER_UNAVAILABLE':
    case 'FILE_NOT_READABLE_BY_POOL':
      return 502;
    case 'STORAGE_FULL':
      return 507;
    case 'SETUP_REQUIRED':
    case 'SETUP_STATUS_UNAVAILABLE':
    case 'AUTH_UNAVAILABLE':
    case 'BOOTSTRAP_SECRETS_INVALID':
      return 503;
    case 'AUTH_NOT_IMPLEMENTED':
    case 'SETUP_NOT_IMPLEMENTED':
      return 501;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Actor resolution
// ---------------------------------------------------------------------------

export interface MountAccessEnv {
  readonly DB: D1Database;
  readonly APP_MASTER_KEY?: string;
}

export type ResolveActorFn = (
  request: Request,
  env: MountAccessEnv,
) => Promise<Actor>;

/**
 * Resolve the request into an Actor. A valid session yields a 'user' actor;
 * no session yields 'public' (anonymous — only public_read mounts authorize).
 * The share actor kind is resolved by the share routes (T06), not here.
 *
 * Fail closed: missing bootstrap secrets, unreadable/incomplete setup state,
 * auth infrastructure failure or a disabled account all throw AuthError —
 * an ambiguous request must never degrade to anonymous access silently.
 */
export async function resolveActor(
  request: Request,
  env: MountAccessEnv,
): Promise<Actor> {
  const bootstrap = getBootstrapConfig(env);
  if (!bootstrap.ok) {
    throw new AuthError(
      503,
      'BOOTSTRAP_SECRETS_INVALID',
      'Worker bootstrap secrets are missing or malformed.',
    );
  }
  // The app middleware resolves the settings row and session once per
  // request and stashes them as request hints; without hints (unit-test
  // harnesses) the reads happen exactly as before.
  const hints = getRequestHints(request);
  const canonicalOrigin =
    hints === undefined
      ? await readCanonicalOrigin(env.DB)
      : hints.canonicalOrigin;
  if (canonicalOrigin === null) {
    throw new AuthError(
      503,
      'SETUP_REQUIRED',
      'Initial setup has not completed.',
    );
  }
  let session;
  if (hints !== undefined) {
    if (hints.session === 'error') {
      throw new AuthError(
        503,
        'AUTH_UNAVAILABLE',
        'Authentication is unavailable.',
      );
    }
    session = hints.session;
  } else {
    try {
      session = await getAuthSession(request, env);
    } catch {
      throw new AuthError(
        503,
        'AUTH_UNAVAILABLE',
        'Authentication is unavailable.',
      );
    }
  }
  if (session === null) return { kind: 'public' };
  if (session.user.disabled) {
    throw new AuthError(403, 'FORBIDDEN', 'This account is disabled.');
  }
  return { kind: 'user', user: session.user, sessionId: session.sessionId };
}

export interface MountAccessResult {
  readonly actor: Actor;
  readonly access: MountAccess;
  readonly mount: MountRecord;
}

/**
 * Resolve actor + mount + grant and require `operation` on the mount.
 * Unknown mounts answer 404; any missing capability answers 403 — the
 * decision is always the fresh authorizeMount read, never a listing cache.
 * The optional actor resolver is the test seam; production callers use the
 * real session resolution.
 */
export async function requireMountAccess(
  env: MountAccessEnv,
  request: Request,
  mountId: string,
  operation: MountOperation,
  resolveActorFn: ResolveActorFn = resolveActor,
): Promise<MountAccessResult> {
  // Actor resolution and the mount read are independent: run them
  // concurrently. The attach-only catch keeps a rejection on the loser
  // from surfacing as an unhandled rejection when the winner throws first.
  const actorP = resolveActorFn(request, env);
  actorP.catch(() => undefined);
  const mountP = getMount(env.DB, mountId);
  mountP.catch(() => undefined);
  const actor = await actorP;
  const mount = await mountP;
  if (mount === null) {
    throw new ApiRequestError(404, 'NOT_FOUND', 'Mount not found.');
  }
  const access = await authorizeMount(env.DB, actor, mountId, mount);
  if (access === null || !access.operations.has(operation)) {
    throw new ApiRequestError(
      403,
      'FORBIDDEN',
      'This operation is not permitted on the mount.',
    );
  }
  return { actor, access, mount };
}

export interface MountAccessEntry {
  readonly mount: MountRecord;
  readonly access: MountAccess;
}

/**
 * Every mount the actor can see, with the operations they hold — admin sees
 * all mounts, a user sees mounts with effective grants, a share actor's
 * scoped mount (resolved by T06), and anonymous callers see public_read
 * mounts only. The result goes through authorizeMount for each mount so the
 * listing can never widen what the single decision path allows.
 */
export async function listMountAccesses(
  db: D1Database,
  actor: Actor,
): Promise<MountAccessEntry[]> {
  let mountIds: string[];
  if (actor.kind === 'user' && actor.user.role === 'admin' && !actor.user.disabled) {
    const rows = await db.prepare('SELECT id FROM mounts ORDER BY created_at, id').all<{ id: string }>();
    mountIds = (rows.results ?? []).map((r) => r.id);
  } else if (actor.kind === 'user' && !actor.user.disabled) {
    // Granted mounts UNION public mounts: an authenticated user without a
    // grant still sees public_read mounts (authorizeMount grants them
    // read-only). authorizeMount is applied per mount below so a grant can
    // narrow but never widen.
    const rows = await db
      .prepare(
        'SELECT mount_id AS id FROM mount_grants WHERE user_id = ? ' +
          "UNION SELECT id FROM mounts WHERE visibility = 'public_read' ORDER BY id",
      )
      .bind(actor.user.id)
      .all<{ id: string }>();
    mountIds = (rows.results ?? []).map((r) => r.id);
  } else if (actor.kind === 'share') {
    mountIds = [actor.mountId];
  } else {
    const rows = await db
      .prepare("SELECT id FROM mounts WHERE visibility = 'public_read' ORDER BY created_at, id")
      .all<{ id: string }>();
    mountIds = (rows.results ?? []).map((r) => r.id);
  }
  const entries: MountAccessEntry[] = [];
  for (const mountId of mountIds) {
    const mount = await getMount(db, mountId);
    if (mount === null) continue;
    const access = await authorizeMount(db, actor, mountId, mount);
    if (access === null) continue;
    entries.push({ mount, access });
  }
  return entries;
}

/**
 * Server-side cache/cursor actor key: per user+session, per share or
 * anonymous. The session is bound so a logout or account switch can never
 * reuse a cursor or a cached page minted for the previous session; the raw
 * session id only ever lives inside the encrypted cursor payload and the
 * isolate-local cache key — never in a public DTO.
 */
export function actorKey(actor: Actor): string {
  switch (actor.kind) {
    case 'user':
      return `user:${actor.user.id}:session:${actor.sessionId}`;
    case 'share':
      return `share:${actor.shareId}`;
    case 'public':
      return 'public';
  }
}

// ---------------------------------------------------------------------------
// OAuth writer resolution
// ---------------------------------------------------------------------------

export interface ResolvedWriterState {
  readonly writer: ResolvedWriter;
  readonly connection: ConnectionRow;
  readonly client: OAuthClientRow;
}

/**
 * Resolve a connection row into the pinned-writer tuple observed NOW, with
 * current row versions (coordinator admission re-verifies these on every
 * token request). Returns null when the connection or its client is missing.
 */
export async function resolveWriterState(
  db: D1Database,
  connectionId: string,
): Promise<ResolvedWriterState | null> {
  const connection = await readConnection(db, connectionId);
  if (connection === null) return null;
  const client = await readOAuthClient(db, connection.oauthClientId);
  if (client === null) return null;
  return {
    writer: {
      connectionId: connection.id,
      principalId: connection.principalId,
      oauthClientId: connection.oauthClientId,
      projectId: client.projectId,
      connectionVersion: connection.version,
      oauthClientVersion: client.version,
    },
    connection,
    client,
  };
}

/**
 * Frozen wave-3 export: resolve the OAuth writer for `connectionId`. When
 * `pinned` is given, every pinned identity field must match exactly —
 * reconnect under a different principal or client NEVER substitutes for the
 * pinned writer; the caller gets null and decides (blocked/retry), never a
 * different Google identity.
 */
export async function resolveWriter(
  db: D1Database,
  connectionId: string,
  pinned?: PinnedWriter,
): Promise<ResolvedWriter | null> {
  const state = await resolveWriterState(db, connectionId);
  if (state === null) return null;
  if (pinned !== undefined) {
    const w = state.writer;
    if (
      pinned.connectionId !== w.connectionId ||
      pinned.principalId !== w.principalId ||
      pinned.oauthClientId !== w.oauthClientId ||
      pinned.projectId !== w.projectId
    ) {
      return null;
    }
  }
  return state.writer;
}

/**
 * Resolve the catalog writer for a mount and require it usable for OAuth
 * catalog/write operations right now. Disabled connections throw
 * GOOGLE_CONNECTION_DISABLED and needs_reauth throws GOOGLE_REAUTH_REQUIRED
 * — catalog never degrades to a different provider or connection.
 */
export async function requireUsableOAuthWriter(
  db: D1Database,
  connectionId: string,
  surface: string,
): Promise<ResolvedWriterState> {
  const state = await resolveWriterState(db, connectionId);
  if (state === null) {
    throw new ApiRequestError(
      409,
      'GOOGLE_CONNECTION_DISABLED',
      `The ${surface} OAuth connection no longer exists; an administrator must reconnect it.`,
    );
  }
  if (!state.connection.enabled || state.connection.state === 'disabled') {
    throw new ApiRequestError(
      409,
      'GOOGLE_CONNECTION_DISABLED',
      `The ${surface} OAuth connection is disabled.`,
    );
  }
  if (state.connection.state === 'needs_reauth') {
    throw new ApiRequestError(
      502,
      'GOOGLE_REAUTH_REQUIRED',
      `The ${surface} OAuth connection requires re-authentication.`,
    );
  }
  if (!state.client.enabled) {
    throw new ApiRequestError(
      409,
      'GOOGLE_CONNECTION_DISABLED',
      'The OAuth client for this connection is disabled.',
    );
  }
  return state;
}

// ---------------------------------------------------------------------------
// Service-account read pool
// ---------------------------------------------------------------------------

export interface ReadPoolEntry {
  /** Read identity with the current credential version for token admission. */
  readonly identity: ReadIdentity;
  readonly priority: number;
  readonly weight: number;
  /** False entries are kept for diagnostics; admission filters them out. */
  readonly enabled: boolean;
}

/**
 * The mount's SA read pool ordered for selection (highest priority, then
 * weight). Entries carry the CURRENT service_accounts.version — staleness is
 * rejected at admission as CREDENTIAL_VERSION_CHANGED.
 */
export async function listReadPool(
  db: D1Database,
  mountId: string,
): Promise<ReadPoolEntry[]> {
  const rows = await db
    .prepare(
      'SELECT m.service_account_id AS sa_id, m.priority AS priority, m.weight AS weight, ' +
        'sa.email AS email, sa.project_id AS project_id, sa.version AS version, sa.enabled AS enabled ' +
        'FROM mount_read_credentials m JOIN service_accounts sa ON sa.id = m.service_account_id ' +
        'WHERE m.mount_id = ? ORDER BY m.priority DESC, m.weight DESC, sa.id',
    )
    .bind(mountId)
    .all<{
      sa_id: string;
      priority: number;
      weight: number;
      email: string;
      project_id: string;
      version: number;
      enabled: number;
    }>();
  return (rows.results ?? []).map((r) => ({
    identity: {
      serviceAccountId: r.sa_id,
      serviceAccountVersion: r.version,
      email: r.email,
      projectId: r.project_id,
    },
    priority: r.priority,
    weight: r.weight,
    enabled: r.enabled === 1,
  }));
}

// ---------------------------------------------------------------------------
// Shared route-level error translation
// ---------------------------------------------------------------------------

export interface ApiFailure {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

function isAuthErrorLike(err: unknown): err is { status: number; code: string; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

const KNOWN_API_CODES: ReadonlySet<string> = new Set([
  'AUTH_REQUIRED', 'FORBIDDEN', 'DRIVE_UNAVAILABLE', 'FILE_NOT_ACCESSIBLE',
  'RATE_LIMITED', 'PROJECT_LIMITED', 'STORAGE_FULL', 'GOOGLE_REAUTH_REQUIRED',
  'GOOGLE_CONNECTION_DISABLED', 'READ_PROVIDER_UNAVAILABLE',
  'FILE_NOT_READABLE_BY_POOL', 'UPLOAD_EXPIRED', 'UPLOAD_NEEDS_RECONCILIATION',
  'FILE_CONFLICT', 'SNAPSHOT_UNAVAILABLE', 'CONTENT_CHANGED',
  'MEDIA_PACKAGE_NOT_READY', 'PREVIEW_UNSUPPORTED', 'VALIDATION_FAILED',
  'NOT_FOUND', 'SETUP_REQUIRED', 'SETUP_TOKEN_INVALID',
  'SETUP_ALREADY_COMPLETED', 'SETUP_IN_PROGRESS', 'SETUP_STATUS_UNAVAILABLE',
  'SETUP_NOT_IMPLEMENTED', 'AUTH_NOT_IMPLEMENTED', 'AUTH_UNAVAILABLE',
  'ORIGIN_REJECTED', 'BOOTSTRAP_SECRETS_INVALID', 'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
]);

function safeMessage(message: unknown, fallback: string): string {
  return typeof message === 'string' && message.length > 0 && message.length <= 300
    ? message
    : fallback;
}

/**
 * Translate a thrown error into the shared ApiErrorBody fields. ApiRequestError
 * and AuthError carry their own status/code; injected auth fixtures (plain
 * {status, code} objects) are honored like AuthError; DriveError maps through
 * the provider-aware driveErrorToApiCode; anything else is INTERNAL_ERROR.
 * `surface` selects the provider/context pair used for DriveError mapping.
 */
export function failureFromError(
  err: unknown,
  context: { provider: 'google_oauth' | 'service_account'; surface: 'catalog' | 'content' | 'upload' | 'upload-session' },
): ApiFailure {
  if (err instanceof ApiRequestError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      ...(err.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: err.retryAfterSeconds }),
    };
  }
  if (err instanceof AuthError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err instanceof ResourceScopeError) {
    // Out-of-mount is indistinguishable from missing (spec §9).
    return { status: 404, code: 'FILE_NOT_ACCESSIBLE', message: 'The file is not accessible.' };
  }
  if (
    isAuthErrorLike(err) &&
    (err.status === 401 || err.status === 403 || err.status === 503)
  ) {
    const fallback: ApiErrorCode =
      err.status === 401 ? 'AUTH_REQUIRED' : err.status === 403 ? 'FORBIDDEN' : 'AUTH_UNAVAILABLE';
    const code = KNOWN_API_CODES.has(err.code) ? (err.code as ApiErrorCode) : fallback;
    const fallbackMessage =
      err.status === 401
        ? 'Authentication is required.'
        : err.status === 403
          ? 'Forbidden.'
          : 'Authentication is unavailable.';
    return {
      status: err.status,
      code,
      message: safeMessage(err.message, fallbackMessage),
    };
  }
  if (err instanceof DriveError) {
    const code = driveErrorToApiCodeFor(err, context);
    const status = statusForApiCode(code);
    const retryAfterSeconds =
      err.retryAfterMs === undefined
        ? undefined
        : Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    return {
      status,
      code,
      message: 'The upstream Google Drive request failed.',
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error.' };
}

function driveErrorToApiCodeFor(
  err: DriveError,
  context: { provider: 'google_oauth' | 'service_account'; surface: 'catalog' | 'content' | 'upload' | 'upload-session' },
): ApiErrorCode {
  return driveErrorToApiCode(err, context);
}
