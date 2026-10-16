/**
 * Scoped share links (architecture §9.3, §10.2; plan T06; wave-3 track B).
 *
 * A share is an opaque, revocable application-level capability bound to a
 * mount-, file- or package scope, an expiry and the mount policy version it
 * was created under. The raw token is returned exactly once at creation;
 * D1 stores only a domain-separated SHA-256 hash, so a database read never
 * reveals a usable credential. Every content request re-validates the row —
 * expiry, revocation and policy version — so a revoke takes effect on the
 * next request.
 *
 * This module owns the share_records lifecycle and scoped admission. Mount
 * rows are read through the injected `getMount` (worker A's surface);
 * session admin checks go through the injected `requireAdmin`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import {
  CreateShareRequestSchema,
  ShareViewSchema,
  type ShareScope,
  type ShareView,
} from '../../shared/contracts/media';
import { requireAdmin as realRequireAdmin } from '../auth/session';
import { getMount as realGetMount } from '../drive/mounts';
import { randomBase64Url, sha256Base64Url } from '../drive/oauth/crypto';

// ---------------------------------------------------------------------------
// Token material
// ---------------------------------------------------------------------------

/** Human-recognizable prefix; the token itself is opaque and random. */
export const SHARE_TOKEN_PREFIX = 'shr_';

export function generateShareToken(): string {
  return `${SHARE_TOKEN_PREFIX}${randomBase64Url(32)}`;
}

/** Domain-separated storage hash; D1 never holds the raw token. */
export function hashShareToken(token: string): Promise<string> {
  return sha256Base64Url(`gdrive/share-token/v1:${token}`);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ShareLinkRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly scopeKind: 'mount' | 'file' | 'package';
  readonly mountId: string | null;
  readonly fileId: string | null;
  readonly packageId: string | null;
  readonly revisionId: string | null;
  readonly indexGeneration: number | null;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly policyVersion: number;
  readonly createdAt: number;
}

interface ShareLinkDbRow {
  id: string;
  token_hash: string;
  created_by: string;
  scope_kind: string;
  mount_id: string | null;
  file_id: string | null;
  package_id: string | null;
  revision_id: string | null;
  index_generation: number | null;
  expires_at: number;
  revoked_at: number | null;
  policy_version: number;
  created_at: number;
}

function rowToShareLink(row: ShareLinkDbRow): ShareLinkRow {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    createdBy: row.created_by,
    scopeKind: row.scope_kind as ShareLinkRow['scopeKind'],
    mountId: row.mount_id,
    fileId: row.file_id,
    packageId: row.package_id,
    revisionId: row.revision_id,
    indexGeneration: row.index_generation,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
  };
}

const SHARE_COLUMNS =
  'id, token_hash, created_by, scope_kind, mount_id, file_id, package_id, ' +
  'revision_id, index_generation, expires_at, revoked_at, policy_version, created_at';

export async function getShareLink(
  db: D1Database,
  shareId: string,
): Promise<ShareLinkRow | null> {
  const row = await db
    .prepare(`SELECT ${SHARE_COLUMNS} FROM share_links WHERE id = ?`)
    .bind(shareId)
    .first<ShareLinkDbRow>();
  return row === null ? null : rowToShareLink(row);
}

/**
 * Resolve a presented share token to its row. Existence only — expiry,
 * revocation and mount policy are checked by `checkShareValid`, which needs
 * the mount row the caller already holds.
 */
export async function resolveShareToken(
  db: D1Database,
  token: string,
): Promise<ShareLinkRow | null> {
  const hash = await hashShareToken(token);
  const row = await db
    .prepare(`SELECT ${SHARE_COLUMNS} FROM share_links WHERE token_hash = ?`)
    .bind(hash)
    .first<ShareLinkDbRow>();
  return row === null ? null : rowToShareLink(row);
}

export async function listShareLinks(
  db: D1Database,
  filter: { mountId?: string } = {},
): Promise<ShareLinkRow[]> {
  const rows =
    filter.mountId === undefined
      ? await db
          .prepare(
            `SELECT ${SHARE_COLUMNS} FROM share_links ORDER BY created_at DESC, id DESC`,
          )
          .all<ShareLinkDbRow>()
      : await db
          .prepare(
            `SELECT ${SHARE_COLUMNS} FROM share_links WHERE mount_id = ? ` +
              'ORDER BY created_at DESC, id DESC',
          )
          .bind(filter.mountId)
          .all<ShareLinkDbRow>();
  return (rows.results ?? []).map(rowToShareLink);
}

export interface InsertShareInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly scope: ShareScope;
  readonly expiresAt: number;
  readonly policyVersion: number;
  readonly now: number;
}

export async function insertShareLink(
  db: D1Database,
  input: InsertShareInput,
): Promise<ShareLinkRow> {
  const scope = input.scope;
  const mountId = scope.mountId;
  const fileId = scope.kind === 'file' ? scope.fileId : null;
  const packageId = scope.kind === 'package' ? scope.packageId : null;
  const revisionId = scope.kind === 'file' ? (scope.revisionId ?? null) : null;
  const indexGeneration =
    scope.kind === 'package' ? (scope.indexGeneration ?? null) : null;
  await db
    .prepare(
      'INSERT INTO share_links (id, token_hash, created_by, scope_kind, mount_id, file_id, ' +
        'package_id, revision_id, index_generation, expires_at, policy_version, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      input.id,
      input.tokenHash,
      input.createdBy,
      scope.kind,
      mountId,
      fileId,
      packageId,
      revisionId,
      indexGeneration,
      input.expiresAt,
      input.policyVersion,
      input.now,
    )
    .run();
  const row = await getShareLink(db, input.id);
  if (row === null) {
    throw new Error('share_links insert did not produce a readable row');
  }
  return row;
}

/** Idempotent revoke: stamps revoked_at once; repeats report prior state. */
export async function revokeShareLink(
  db: D1Database,
  shareId: string,
  now: number,
): Promise<'revoked' | 'already-revoked' | 'not-found'> {
  const existing = await getShareLink(db, shareId);
  if (existing === null) return 'not-found';
  if (existing.revokedAt !== null) return 'already-revoked';
  await db
    .prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, shareId)
    .run();
  return 'revoked';
}

// ---------------------------------------------------------------------------
// Scoped admission
// ---------------------------------------------------------------------------

/** Rebuild the typed scope from a row. */
export function shareScopeOf(row: ShareLinkRow): ShareScope | null {
  if (row.mountId === null) return null;
  switch (row.scopeKind) {
    case 'mount':
      return { kind: 'mount', mountId: row.mountId };
    case 'file':
      if (row.fileId === null) return null;
      return {
        kind: 'file',
        mountId: row.mountId,
        fileId: row.fileId,
        ...(row.revisionId === null ? {} : { revisionId: row.revisionId }),
      };
    case 'package':
      if (row.packageId === null) return null;
      return {
        kind: 'package',
        mountId: row.mountId,
        packageId: row.packageId,
        ...(row.indexGeneration === null
          ? {}
          : { indexGeneration: row.indexGeneration }),
      };
  }
}

export type ShareValidity =
  | 'ok'
  | 'expired'
  | 'revoked'
  | 'policy-changed'
  | 'mount-missing';

/**
 * Re-validate a share against the mount's current policy version and the
 * clock. `mountPolicyVersion` is null when the mount row no longer exists.
 */
export function checkShareValid(
  share: ShareLinkRow,
  mountPolicyVersion: number | null,
  now: number,
): ShareValidity {
  if (mountPolicyVersion === null) return 'mount-missing';
  if (share.revokedAt !== null) return 'revoked';
  if (share.expiresAt <= now) return 'expired';
  if (share.policyVersion !== mountPolicyVersion) return 'policy-changed';
  return 'ok';
}

export interface ShareTarget {
  readonly mountId: string;
  readonly fileId?: string;
  /** Present only when the request explicitly reads a pinned revision. */
  readonly revisionId?: string;
  readonly packageId?: string;
  readonly indexGeneration?: number;
}

/**
 * Does the share's scope cover this resource? A file share pinned to a
 * revision admits only that revision's mode; an unpinned file share admits
 * current content and any revision of the same file. Mount and package
 * scopes follow their recorded fields; a share never widens into a whole
 * mount it does not name.
 */
export function shareScopeCovers(scope: ShareScope, target: ShareTarget): boolean {
  if (scope.mountId !== target.mountId) return false;
  switch (scope.kind) {
    case 'mount':
      return true;
    case 'file':
      if (target.fileId !== scope.fileId) return false;
      if (
        scope.revisionId !== undefined &&
        target.revisionId !== scope.revisionId
      ) {
        return false;
      }
      return true;
    case 'package':
      if (target.packageId !== scope.packageId) return false;
      if (
        scope.indexGeneration !== undefined &&
        target.indexGeneration !== scope.indexGeneration
      ) {
        return false;
      }
      return true;
  }
}

// ---------------------------------------------------------------------------
// Router (mounted by the coordinator under /api/v1/shares)
// ---------------------------------------------------------------------------

export interface AdminIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

export type RequireAdminFn = (
  request: Request,
  env: Env,
) => Promise<AdminIdentity>;

/** Minimal mount shape share creation needs (A's getMount satisfies it). */
export interface ShareMountRecord {
  readonly id: string;
  readonly policyVersion: number;
}

export interface ShareRouterDeps {
  readonly requireAdmin?: RequireAdminFn;
  readonly getMount?: (
    db: D1Database,
    mountId: string,
  ) => Promise<ShareMountRecord | null>;
  readonly now?: () => number;
}

type RouterContext = Context<{
  Bindings: Env;
  Variables: { requestId?: string };
}>;

function fail(
  c: RouterContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): Response {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  return c.json(buildApiError(code, message, requestId), status);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function shareView(row: ShareLinkRow): ShareView | null {
  const scope = shareScopeOf(row);
  if (scope === null) return null;
  return ShareViewSchema.parse({
    shareId: row.id,
    scope,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    ...(row.revokedAt === null ? {} : { revokedAt: iso(row.revokedAt) }),
    policyVersion: row.policyVersion,
  });
}

interface AuthErrorLike {
  readonly status: number;
  readonly code: string;
  readonly message?: string;
}

function isAuthErrorLike(err: unknown): err is AuthErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

async function adminOrResponse(
  c: RouterContext,
  requireAdmin: RequireAdminFn,
): Promise<{ admin: AdminIdentity } | { response: Response }> {
  try {
    return { admin: await requireAdmin(c.req.raw, c.env) };
  } catch (err) {
    if (
      isAuthErrorLike(err) &&
      (err.status === 401 || err.status === 403 || err.status === 503)
    ) {
      const code: ApiErrorCode =
        err.status === 401
          ? 'AUTH_REQUIRED'
          : err.status === 403
            ? 'FORBIDDEN'
            : 'AUTH_UNAVAILABLE';
      return {
        response: fail(
          c,
          err.status as ContentfulStatusCode,
          code,
          typeof err.message === 'string' && err.message.length > 0
            ? err.message
            : 'Authorization failed.',
        ),
      };
    }
    return { response: fail(c, 500, 'INTERNAL_ERROR', 'Internal error.') };
  }
}

/**
 * Optional share-lifetime cap from app_settings.policies
 * (`{"shareMaxLifetimeSeconds": n}`). Absent or malformed policies impose no
 * cap — the value is an operator tuneable, not a security boundary, since
 * share expiry is always explicit.
 */
async function shareMaxLifetimeMs(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare('SELECT policies FROM app_settings WHERE id = 1')
    .first<{ policies: string }>();
  if (row === null) return null;
  try {
    const policies = JSON.parse(row.policies) as Record<string, unknown>;
    const value = policies.shareMaxLifetimeSeconds;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

async function auditShareEvent(
  db: D1Database,
  input: {
    actorUserId: string;
    shareId: string;
    operation: string;
    result: string;
    requestId: string;
    now: number;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO audit_events (id, actor_kind, actor_user_id, actor_share_id, ' +
          'operation, target_type, target_id, result, request_id, created_at) ' +
          "VALUES (?, 'user', ?, ?, ?, 'share', ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        input.actorUserId,
        input.shareId,
        input.operation,
        input.shareId,
        input.result,
        input.requestId,
        input.now,
      )
      .run();
  } catch {
    // Audit persistence must never mask the authorized operation result.
  }
}

/**
 * The production default resolves the mount through worker A's getMount
 * (frozen wave-3 contract); tests inject a fixture instead.
 */
async function defaultGetMount(
  db: D1Database,
  mountId: string,
): Promise<ShareMountRecord | null> {
  const mount = await realGetMount(db, mountId);
  if (mount === null) return null;
  return { id: mount.id, policyVersion: mount.policyVersion };
}

export function createShareRouter(deps: ShareRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const getMount = deps.getMount ?? defaultGetMount;
  const now = deps.now ?? Date.now;

  // POST / — create a scoped share. Admin-only (spec §9.3): the token is
  // returned once in this response and never stored or shown again.
  app.post('/', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
    }
    const parsed = CreateShareRequestSchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, 'VALIDATION_FAILED', 'Invalid share request.');
    }
    const { scope, expiresAt } = parsed.data;

    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
      return fail(c, 400, 'VALIDATION_FAILED', 'Share expiry must be in the future.');
    }
    const cap = await shareMaxLifetimeMs(c.env.DB);
    if (cap !== null && expiresAtMs - now() > cap) {
      return fail(
        c,
        400,
        'VALIDATION_FAILED',
        'Share expiry exceeds the configured maximum lifetime.',
      );
    }

    const mount = await getMount(c.env.DB, scope.mountId);
    if (mount === null) {
      return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
    }
    if (scope.kind === 'package') {
      const pkg = await c.env.DB
        .prepare('SELECT mount_id FROM media_packages WHERE id = ?')
        .bind(scope.packageId)
        .first<{ mount_id: string }>();
      if (pkg === null || pkg.mount_id !== scope.mountId) {
        return fail(c, 404, 'NOT_FOUND', 'Media package not found in this mount.');
      }
    }

    const id = crypto.randomUUID();
    const token = generateShareToken();
    const row = await insertShareLink(c.env.DB, {
      id,
      tokenHash: await hashShareToken(token),
      createdBy: auth.admin.userId,
      scope,
      expiresAt: expiresAtMs,
      policyVersion: mount.policyVersion,
      now: now(),
    });
    const view = shareView(row);
    if (view === null) {
      return fail(c, 500, 'INTERNAL_ERROR', 'Internal error.');
    }
    await auditShareEvent(c.env.DB, {
      actorUserId: auth.admin.userId,
      shareId: row.id,
      operation: 'share.create',
      result: 'ok',
      requestId: c.get('requestId') ?? crypto.randomUUID(),
      now: now(),
    });
    return c.json({ ...view, token }, 201);
  });

  // GET / — admin list, optionally filtered by mount.
  app.get('/', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const mountId = c.req.query('mountId');
    const rows = await listShareLinks(
      c.env.DB,
      mountId === undefined || mountId === '' ? {} : { mountId },
    );
    const shares = rows
      .map(shareView)
      .filter((view): view is ShareView => view !== null);
    return c.json({ shares });
  });

  // DELETE /:shareId — revoke. Idempotent: an already-revoked share returns
  // its current view rather than an error.
  app.delete('/:shareId', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const shareId = c.req.param('shareId');
    const result = await revokeShareLink(c.env.DB, shareId, now());
    if (result === 'not-found') {
      return fail(c, 404, 'NOT_FOUND', 'Share not found.');
    }
    const row = await getShareLink(c.env.DB, shareId);
    if (row === null) {
      return fail(c, 500, 'INTERNAL_ERROR', 'Internal error.');
    }
    const view = shareView(row);
    if (view === null) {
      return fail(c, 500, 'INTERNAL_ERROR', 'Internal error.');
    }
    if (result === 'revoked') {
      await auditShareEvent(c.env.DB, {
        actorUserId: auth.admin.userId,
        shareId,
        operation: 'share.revoke',
        result: 'ok',
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        now: now(),
      });
    }
    return c.json(view);
  });

  return app;
}
