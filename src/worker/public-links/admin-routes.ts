/**
 * Admin router for /api/v1/public-links (wave 8 Phase B2). Mirrors
 * shares.ts: every handler re-resolves the admin session; folder identity
 * is proven through the mount's OAuth catalog connection before a row is
 * written; shareMaxLifetimeSeconds bounds/creates expiry.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { apiError as buildApiError, type ApiErrorCode } from '../../shared/contracts/common';
import {
  CreatePublicLinkRequestSchema,
  UpdatePublicLinkRequestSchema,
} from '../../shared/contracts/public-links';
import { requireAdmin as realRequireAdmin } from '../auth/session';
import { recordAudit } from '../admin/routes';
import { assertInMount, mountScopeOf, oauthParentLookup } from '../drive/containment';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { createGoogleOAuthProvider } from '../drive/providers/google-oauth';
import { FOLDER_MIME_TYPE } from '../drive/providers/common';
import { validateDriveId } from '../drive/transport';
import {
  ApiRequestError,
  failureFromError,
  getMount,
  requireUsableOAuthWriter,
  type MountRecord,
} from '../drive/mounts';
import type { OAuthCatalogWriteProvider } from '../drive/types';
import type { RequireAdminFn } from '../security/shares';
import { generatePublicLinkId, generatePublicLinkSlug, hashPublicLinkPassword } from './crypto';
import {
  getPublicLinkById,
  listPublicLinks,
  publicLinkView,
  type PublicLinkRow,
} from './links';

export interface PublicLinkAdminDeps {
  readonly requireAdmin?: RequireAdminFn;
  readonly oauthProvider?: OAuthCatalogWriteProvider;
  readonly getMount?: (db: D1Database, id: string) => Promise<MountRecord | null>;
  readonly now?: () => number;
}

type RC = Context<{ Bindings: Env; Variables: { requestId?: string } }>;

function fail(c: RC, status: ContentfulStatusCode, code: ApiErrorCode, message: string): Response {
  return c.json(buildApiError(code, message, c.get('requestId') ?? crypto.randomUUID()), status);
}

function errRes(c: RC, err: unknown): Response {
  const failure = failureFromError(err, { provider: 'google_oauth', surface: 'catalog' });
  return fail(c, failure.status as ContentfulStatusCode, failure.code, failure.message);
}

async function adminOrResponse(c: RC, requireAdmin: RequireAdminFn) {
  try {
    return { admin: await requireAdmin(c.req.raw, c.env) };
  } catch (err) {
    return { response: errRes(c, err) };
  }
}

async function maxLifetimeMs(db: D1Database): Promise<number | null> {
  const row = await db.prepare('SELECT policies FROM app_settings WHERE id = 1').first<{ policies: string }>();
  if (row === null) return null;
  try {
    const value = (JSON.parse(row.policies) as Record<string, unknown>).shareMaxLifetimeSeconds;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null;
  } catch {
    return null;
  }
}

/** expiresAt|null -> effective ms; capped installs impose the cap. */
function effectiveExpiry(
  requested: string | null,
  capMs: number | null,
  now: number,
): { ok: true; expiresAt: number | null } | { ok: false; response: 'past' | 'over-cap' } {
  if (requested === null) {
    return { ok: true, expiresAt: capMs === null ? null : now + capMs };
  }
  const ms = Date.parse(requested);
  if (!Number.isFinite(ms) || ms <= now) return { ok: false, response: 'past' };
  if (capMs !== null && ms - now > capMs) return { ok: false, response: 'over-cap' };
  return { ok: true, expiresAt: ms };
}

function expiryFailure(c: RC, kind: 'past' | 'over-cap'): Response {
  return fail(c, 400, 'VALIDATION_FAILED',
    kind === 'past' ? 'Link expiry must be in the future.' : 'Link expiry exceeds the configured maximum lifetime.');
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

export function createPublicLinkAdminRouter(deps: PublicLinkAdminDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const getMountFn = deps.getMount ?? getMount;
  const now = deps.now ?? Date.now;
  const providerFor = (env: Env): OAuthCatalogWriteProvider =>
    deps.oauthProvider ?? createGoogleOAuthProvider({ tokenSource: createCoordinatorTokenSource(env) });

  app.get('/', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const mountId = c.req.query('mountId');
    const links = await listPublicLinks(c.env.DB, mountId === undefined || mountId === '' ? undefined : mountId);
    const mounts = new Map<string, MountRecord | null>();
    const linksOut = [];
    for (const link of links) {
      if (!mounts.has(link.mountId)) mounts.set(link.mountId, await getMountFn(c.env.DB, link.mountId));
      linksOut.push(publicLinkView(link, mounts.get(link.mountId) ?? null, now()));
    }
    return c.json({ links: linksOut });
  });

  app.post('/', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
    }
    const parsed = CreatePublicLinkRequestSchema.safeParse(body);
    if (!parsed.success) return fail(c, 400, 'VALIDATION_FAILED', 'Invalid public link request.');
    const input = parsed.data;
    const requestId = c.get('requestId') ?? crypto.randomUUID();

    const mount = await getMountFn(c.env.DB, input.mountId);
    if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');

    // Prove the folder exists, is a folder and sits inside the mount —
    // through the OAuth catalog connection only.
    const provider = providerFor(c.env);
    const scope = mountScopeOf(mount);
    let folderName: string;
    try {
      const folderId = validateDriveId(input.folderId, 'public-links.create');
      const writer = (await requireUsableOAuthWriter(c.env.DB, mount.catalogConnectionId, 'catalog')).writer;
      const meta = await provider.getMetadata({ writer, ref: { id: folderId } });
      if (meta.id !== folderId) {
        throw new ApiRequestError(400, 'VALIDATION_FAILED', 'The folder id did not resolve to the same folder.');
      }
      if (meta.mimeType !== FOLDER_MIME_TYPE || meta.trashed === true) {
        throw new ApiRequestError(400, 'VALIDATION_FAILED', 'The link target must be a folder.');
      }
      await assertInMount(scope, meta, oauthParentLookup({ provider, writer }));
      folderName = meta.name;
    } catch (err) {
      if (err instanceof ApiRequestError) return errRes(c, err);
      return errRes(c, err);
    }

    const cap = await maxLifetimeMs(c.env.DB);
    const expiry = effectiveExpiry(input.expiresAt, cap, now());
    if (!expiry.ok) return expiryFailure(c, expiry.response);

    const ts = now();
    const passwordHash = input.password === null ? null : await hashPublicLinkPassword(input.password);
    // Retry slug generation on a UNIQUE collision (folder or slug).
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = generatePublicLinkId();
      const slug = generatePublicLinkSlug(folderName);
      try {
        await c.env.DB.prepare(
          'INSERT INTO public_folder_links (id, slug, mount_id, folder_id, folder_name, password_hash, ' +
            'credential_version, allow_zip, expires_at, policy_version, created_by, created_at, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
        ).bind(id, slug, mount.id, input.folderId, folderName, passwordHash,
          input.allowZip ? 1 : 0, expiry.expiresAt, mount.policyVersion, auth.admin.userId, ts, ts).run();
      } catch (err) {
        if (isUniqueViolation(err)) {
          const existing = await c.env.DB.prepare(
            'SELECT id, expires_at, policy_version FROM public_folder_links WHERE mount_id = ? AND folder_id = ? AND revoked_at IS NULL',
          ).bind(mount.id, input.folderId).first<{ id: string; expires_at: number | null; policy_version: number }>();
          if (existing !== null) {
            // Only a truly ACTIVE link conflicts (review M4): an expired or
            // policy-invalidated row is auto-revoked so a fresh link can be
            // issued without an extra round trip.
            const expired = existing.expires_at !== null && existing.expires_at <= ts;
            const invalidated = existing.policy_version !== mount.policyVersion;
            if (!expired && !invalidated) {
              return fail(c, 409, 'PUBLIC_LINK_CONFLICT', 'An active public link already exists for this folder.');
            }
            await c.env.DB.prepare(
              'UPDATE public_folder_links SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL',
            ).bind(ts, ts, existing.id).run();
            await recordAudit(c.env.DB, {
              requestId, actorUserId: auth.admin.userId, operation: 'public-link.revoke',
              targetType: 'public_link', targetId: existing.id, result: 'ok', nowMs: ts,
            });
            continue;
          }
          continue; // slug collision — regenerate
        }
        throw err;
      }
      const row = await getPublicLinkById(c.env.DB, id);
      if (row === null) return fail(c, 500, 'INTERNAL_ERROR', 'Internal error.');
      await recordAudit(c.env.DB, {
        requestId, actorUserId: auth.admin.userId, operation: 'public-link.create',
        targetType: 'public_link', targetId: id, result: 'ok', nowMs: ts,
      });
      return c.json({ link: publicLinkView(row, mount, now()) }, 201);
    }
    return fail(c, 500, 'INTERNAL_ERROR', 'Could not allocate a link slug.');
  });

  app.patch('/:id', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const link = await getPublicLinkById(c.env.DB, c.req.param('id'));
    if (link === null) return fail(c, 404, 'NOT_FOUND', 'Public link not found.');
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
    }
    const parsed = UpdatePublicLinkRequestSchema.safeParse(body);
    if (!parsed.success) return fail(c, 400, 'VALIDATION_FAILED', 'Invalid public link update.');
    const input = parsed.data;
    const ts = now();

    // Only SET the columns the caller actually sent (reviews R5 + L-c):
    // writing stale-read values back lets a concurrent PATCH undo another
    // admin's password/expiry/allowZip change. credential_version
    // increments in SQL so concurrent PATCHes can never lose a bump and
    // re-validate stale cookies (review L3).
    const sets: string[] = [];
    const binds: (string | number | null)[] = [];
    if (input.password !== undefined) {
      sets.push('password_hash = ?', 'credential_version = credential_version + 1');
      binds.push(typeof input.password === 'string' ? await hashPublicLinkPassword(input.password) : null);
    }
    if (input.expiresAt !== undefined) {
      const cap = await maxLifetimeMs(c.env.DB);
      const expiry = effectiveExpiry(input.expiresAt, cap, ts);
      if (!expiry.ok) return expiryFailure(c, expiry.response);
      sets.push('expires_at = ?');
      binds.push(expiry.expiresAt);
    }
    if (input.allowZip !== undefined) {
      sets.push('allow_zip = ?');
      binds.push(input.allowZip ? 1 : 0);
    }
    sets.push('updated_at = ?');
    binds.push(ts, link.id);
    await c.env.DB
      .prepare(`UPDATE public_folder_links SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
    const row = (await getPublicLinkById(c.env.DB, link.id)) as PublicLinkRow;
    const mount = await getMountFn(c.env.DB, link.mountId);
    await recordAudit(c.env.DB, {
      requestId: c.get('requestId') ?? crypto.randomUUID(),
      actorUserId: auth.admin.userId, operation: 'public-link.update',
      targetType: 'public_link', targetId: link.id, result: 'ok', nowMs: ts,
    });
    return c.json({ link: publicLinkView(row, mount, now()) });
  });

  app.delete('/:id', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const link = await getPublicLinkById(c.env.DB, c.req.param('id'));
    if (link === null) return fail(c, 404, 'NOT_FOUND', 'Public link not found.');
    const ts = now();
    if (link.revokedAt === null) {
      await c.env.DB.prepare('UPDATE public_folder_links SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
        .bind(ts, ts, link.id).run();
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId, operation: 'public-link.revoke',
        targetType: 'public_link', targetId: link.id, result: 'ok', nowMs: ts,
      });
    }
    const row = (await getPublicLinkById(c.env.DB, link.id)) as PublicLinkRow;
    const mount = await getMountFn(c.env.DB, link.mountId);
    return c.json({ link: publicLinkView(row, mount, now()) });
  });

  return app;
}
