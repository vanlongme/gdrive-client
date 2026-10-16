/**
 * T06 share links + media tickets (wave-3 track B): create/list/revoke,
 * hashed token storage, exact scope admission through the content router,
 * expiry/revocation/policy-version enforcement, and ticket TTL/scoping.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Actor } from '../../src/worker/auth/grants';
import type { AuthUser } from '../../src/worker/auth/session';
import { getMount } from '../../src/worker/drive/mounts';
import type {
  DriveFileMeta,
  OpenContentInput,
  ServiceAccountContentReadProvider,
  UpstreamContent,
} from '../../src/worker/drive/types';
import { createContentRouter } from '../../src/worker/transfers/download';
import {
  createShareRouter,
  hashShareToken,
  type ShareRouterDeps,
} from '../../src/worker/security/shares';
import type { ContentRouteDeps } from '../../src/worker/transfers/content-access';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const NOW = 1_700_000_000_000;
const ORIGIN = 'https://app.test';
const encoder = new TextEncoder();

const adminUser: AuthUser = {
  id: 'u-admin',
  name: 'Admin',
  email: 'admin@example.test',
  role: 'admin',
  disabled: false,
  createdAt: new Date(NOW).toISOString(),
};

const userActor = (user: AuthUser): Actor => ({
  kind: 'user',
  user,
  sessionId: 'sess-1',
});
const publicActor: Actor = { kind: 'public' };

async function resetState() {
  for (const table of [
    'audit_events',
    'file_readiness',
    'share_links',
    'mount_grants',
    'mount_read_credentials',
    'service_accounts',
    'mounts',
    'google_connections',
    'google_oauth_clients',
    'session',
    'account',
    'user',
    'app_settings',
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

async function seedBase() {
  await env.DB.prepare(
    "INSERT INTO app_settings (id, installation_id, setup_state, canonical_origin, policies, version, created_at, updated_at) " +
      "VALUES (1, 'install-1', 'complete', ?, '{}', 1, ?, ?)",
  )
    .bind(ORIGIN, NOW, NOW)
    .run();
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, 0)',
  )
    .bind(adminUser.id, adminUser.name, adminUser.email, NOW, NOW, 'admin')
    .run();
  await env.DB.prepare(
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at) VALUES ('oc-1', 'proj-1', 'client-1', 'env', 'https://x/cb', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, granted_scopes, created_at, updated_at) VALUES ('conn-1', 'oc-1', 'p-1', 'drive', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id, visibility, created_at, updated_at) VALUES ('m-1', 'Mount', 'drive-1', 'conn-1', 'conn-1', 'private', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) " +
      "VALUES ('sa-1', 'proj-1', 'sa-1@proj-1.iam.gserviceaccount.com', 'key-sa-1', 'env', 1, 1, ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('m-1', 'sa-1', 10, 1, ?)",
  )
    .bind(NOW)
    .run();
}

const FILE_META: DriveFileMeta = {
  id: 'f-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: '10',
  modifiedTime: '2026-10-01T12:00:00.000Z',
  trashed: false,
  driveId: 'drive-1',
  hasThumbnail: true,
  capabilities: { canDownload: true, canReadRevisions: true },
};

class StubProvider implements ServiceAccountContentReadProvider {
  readonly calls: string[] = [];
  async getReadMetadata() {
    this.calls.push('meta');
    return FILE_META;
  }
  async getRevision(input: { revisionId: string }) {
    this.calls.push('revision');
    return {
      id: input.revisionId,
      size: '10',
      modifiedTime: '2026-09-01T00:00:00.000Z',
      keepForever: true,
    };
  }
  async openContent(_input: OpenContentInput): Promise<UpstreamContent> {
    this.calls.push('content');
    return {
      status: 200,
      contentType: 'text/plain',
      contentLength: 10n,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('0123456789'));
          c.close();
        },
      }),
    };
  }
  async openThumbnail(): Promise<UpstreamContent> {
    this.calls.push('thumbnail');
    return {
      status: 200,
      contentType: 'image/png',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('PNG'));
          c.close();
        },
      }),
    };
  }
  async exportDocument(): Promise<UpstreamContent> {
    this.calls.push('export');
    return {
      status: 200,
      contentType: 'application/pdf',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('PDF'));
          c.close();
        },
      }),
    };
  }
}

interface Harness {
  app: Hono<{ Bindings: Env; Variables: { requestId?: string } }>;
  provider: StubProvider;
}

function makeHarness(
  actor: Actor,
  options: { now?: () => number; adminOk?: boolean; provider?: StubProvider } = {},
): Harness {
  const provider = options.provider ?? new StubProvider();
  const deps: ContentRouteDeps = {
    getMount,
    resolveSessionActor: () => Promise.resolve(actor),
    readProvider: provider,
    now: options.now ?? (() => NOW),
  };
  const shareDeps: ShareRouterDeps = {
    requireAdmin:
      options.adminOk === false
        ? () => Promise.reject({ status: 403, code: 'FORBIDDEN' })
        : () => Promise.resolve({ userId: adminUser.id, sessionId: 'sess-1' }),
    getMount,
    now: options.now ?? (() => NOW),
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/api/v1/mounts', createContentRouter(deps));
  app.route('/api/v1/shares', createShareRouter(shareDeps));
  return { app, provider };
}

function api(
  app: Hono<{ Bindings: Env; Variables: { requestId?: string } }>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env),
  );
}

async function createShare(
  app: Harness['app'],
  scope: unknown,
  extra: Record<string, unknown> = {},
): Promise<{ shareId: string; token: string }> {
  const res = await api(app, '/api/v1/shares', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope,
      expiresAt: new Date(NOW + 7 * 24 * 3600_000).toISOString(),
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { shareId: string; token: string };
  return { shareId: body.shareId, token: body.token };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
  await seedBase();
});

// ---------------------------------------------------------------------------
// Share lifecycle
// ---------------------------------------------------------------------------

describe('share lifecycle', () => {
  it('creates a file share, stores only the token hash, and returns the token once', async () => {
    const { app } = makeHarness(userActor(adminUser));
    const { shareId, token } = await createShare(app, {
      kind: 'file',
      mountId: 'm-1',
      fileId: 'f-1',
    });
    expect(token.startsWith('shr_')).toBe(true);
    const row = await env.DB
      .prepare('SELECT token_hash, scope_kind, file_id FROM share_links WHERE id = ?')
      .bind(shareId)
      .first<{ token_hash: string; scope_kind: string; file_id: string }>();
    expect(row?.token_hash).toBe(await hashShareToken(token));
    expect(row?.token_hash).not.toBe(token);
    expect(row?.scope_kind).toBe('file');
    expect(row?.file_id).toBe('f-1');
  });

  it('lists shares without exposing tokens and revokes idempotently', async () => {
    const { app } = makeHarness(userActor(adminUser));
    const { shareId } = await createShare(app, {
      kind: 'mount',
      mountId: 'm-1',
    });
    const list = await api(app, '/api/v1/shares?mountId=m-1');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { shares: Array<Record<string, unknown>> };
    expect(body.shares).toHaveLength(1);
    expect(body.shares[0]?.shareId).toBe(shareId);
    expect(JSON.stringify(body)).not.toContain('shr_');

    const del1 = await api(app, `/api/v1/shares/${shareId}`, { method: 'DELETE' });
    expect(del1.status).toBe(200);
    const revoked = (await del1.json()) as { revokedAt?: string };
    expect(revoked.revokedAt).toBeDefined();
    const del2 = await api(app, `/api/v1/shares/${shareId}`, { method: 'DELETE' });
    expect(del2.status).toBe(200);
    const missing = await api(app, '/api/v1/shares/nope', { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('rejects invalid create input and non-admin callers', async () => {
    const { app } = makeHarness(userActor(adminUser));
    expect(
      (
        await api(app, '/api/v1/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: { kind: 'file', mountId: 'm-1' } }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(app, '/api/v1/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: { kind: 'file', mountId: 'm-1', fileId: 'f-1' },
            expiresAt: new Date(NOW - 1000).toISOString(),
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(app, '/api/v1/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scope: { kind: 'package', mountId: 'm-1', packageId: 'pkg-x' },
            expiresAt: new Date(NOW + 3600_000).toISOString(),
          }),
        })
      ).status,
    ).toBe(404);

    const denied = makeHarness(userActor(adminUser), { adminOk: false });
    const res = await api(denied.app, '/api/v1/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'mount', mountId: 'm-1' } }),
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Scoped admission through the content router
// ---------------------------------------------------------------------------

describe('share-scoped content admission', () => {
  it('admits a file share for exactly that file and nothing else', async () => {
    const { app, provider } = makeHarness(publicActor);
    const { token } = await createShare(app, {
      kind: 'file',
      mountId: 'm-1',
      fileId: 'f-1',
    });
    const ok = await api(app, `/api/v1/mounts/m-1/files/f-1/content?share=${token}`);
    expect(ok.status).toBe(200);
    expect(provider.calls).toContain('content');

    const other = await api(
      app,
      `/api/v1/mounts/m-1/files/f-OTHER/content?share=${token}`,
    );
    expect(other.status).toBe(403);
  });

  it('admits a mount share across files on that mount only', async () => {
    const { app } = makeHarness(publicActor);
    const { token } = await createShare(app, {
      kind: 'mount',
      mountId: 'm-1',
    });
    const ok = await api(app, `/api/v1/mounts/m-1/files/f-1/content?share=${token}`);
    expect(ok.status).toBe(200);
  });

  it('enforces a revision-pinned share: pinned revision only', async () => {
    const { app } = makeHarness(publicActor);
    const { token } = await createShare(app, {
      kind: 'file',
      mountId: 'm-1',
      fileId: 'f-1',
      revisionId: 'rev-1',
    });
    const pinned = await api(
      app,
      `/api/v1/mounts/m-1/files/f-1/content?mode=revision&revision=rev-1&share=${token}`,
    );
    expect(pinned.status).toBe(200);

    const current = await api(
      app,
      `/api/v1/mounts/m-1/files/f-1/content?share=${token}`,
    );
    expect(current.status).toBe(403);

    const wrongRev = await api(
      app,
      `/api/v1/mounts/m-1/files/f-1/content?mode=revision&revision=rev-2&share=${token}`,
    );
    expect(wrongRev.status).toBe(403);
  });

  it('denies expired, revoked and stale-policy shares', async () => {
    const { app } = makeHarness(publicActor);
    const { token } = await createShare(app, {
      kind: 'file',
      mountId: 'm-1',
      fileId: 'f-1',
    });
    await env.DB.prepare('UPDATE share_links SET revoked_at = ?').bind(NOW).run();
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?share=${token}`)).status,
    ).toBe(403);
    await env.DB.prepare('UPDATE share_links SET revoked_at = NULL').run();
    await env.DB
      .prepare('UPDATE share_links SET expires_at = ?')
      .bind(NOW - 1000)
      .run();
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?share=${token}`)).status,
    ).toBe(403);
    await env.DB
      .prepare('UPDATE share_links SET expires_at = ?, policy_version = 1')
      .bind(NOW + 3600_000)
      .run();
    await env.DB
      .prepare('UPDATE mounts SET policy_version = 2 WHERE id = ?')
      .bind('m-1')
      .run();
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?share=${token}`)).status,
    ).toBe(403);
  });

  it('denies share access on thumbnail/export identically', async () => {
    const { app } = makeHarness(publicActor);
    const { token } = await createShare(app, {
      kind: 'file',
      mountId: 'm-1',
      fileId: 'f-OTHER',
    });
    for (const path of [
      '/api/v1/mounts/m-1/files/f-1/thumbnail',
      '/api/v1/mounts/m-1/files/f-1/export?format=pdf',
    ]) {
      const sep = path.includes('?') ? '&' : '?';
      expect((await api(app, `${path}${sep}share=${token}`)).status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Media tickets
// ---------------------------------------------------------------------------

describe('media tickets', () => {
  it('mints a default-60m ticket for an admitted session user and admits GET/HEAD', async () => {
    const { app, provider } = makeHarness(userActor(adminUser));
    const mint = await api(app, '/api/v1/mounts/m-1/files/f-1/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(mint.status).toBe(201);
    const body = (await mint.json()) as { ticket: string; expiresAt: string };
    expect(body.ticket.startsWith('mtk_')).toBe(true);
    expect(Date.parse(body.expiresAt)).toBe(NOW + 3600_000);

    const res = await api(
      app,
      `/api/v1/mounts/m-1/files/f-1/content?ticket=${body.ticket}`,
    );
    expect(res.status).toBe(200);
    const head = await api(
      app,
      `/api/v1/mounts/m-1/files/f-1/content?ticket=${body.ticket}`,
      { method: 'HEAD' },
    );
    expect(head.status).toBe(200);
    expect(provider.calls).toContain('content');
  });

  it('caps non-admin TTL at the 60-minute default; admin may reach 24h', async () => {
    const viewer: AuthUser = {
      ...adminUser,
      id: 'u-viewer',
      email: 'viewer@example.test',
      role: 'user',
    };
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, 0)',
    )
      .bind(viewer.id, viewer.name, viewer.email, NOW, NOW, 'user')
      .run();
    await env.DB.prepare(
      "INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES (?, 'm-1', 'viewer', '[\"read\"]', ?, ?, ?)",
    )
      .bind(viewer.id, adminUser.id, NOW, NOW)
      .run();
    const { app } = makeHarness(userActor(viewer));
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 7200 }),
    });
    expect(res.status).toBe(400);

    const admin = makeHarness(userActor(adminUser));
    const ok = await api(admin.app, '/api/v1/mounts/m-1/files/f-1/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 86400 }),
    });
    expect(ok.status).toBe(201);
    const over = await api(admin.app, '/api/v1/mounts/m-1/files/f-1/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 86401 }),
    });
    expect(over.status).toBe(400);
  });

  it('binds the ticket to the exact file and rechecks the minting principal', async () => {
    const { app } = makeHarness(userActor(adminUser));
    const mint = await api(app, '/api/v1/mounts/m-1/files/f-1/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { ticket } = (await mint.json()) as { ticket: string };
    // Wrong file: AAD + scope mismatch.
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-OTHER/content?ticket=${ticket}`)).status,
    ).toBe(403);
    // Tampered/foreign ticket.
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?ticket=mtk_garbage`)).status,
    ).toBe(403);
  });

  it('expires tickets and re-validates share principals on use', async () => {
    let now = NOW;
    const { app } = makeHarness(userActor(adminUser), { now: () => now });
    const mint = await api(app, '/api/v1/mounts/m-1/files/f-1/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 60 }),
    });
    const { ticket } = (await mint.json()) as { ticket: string };
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?ticket=${ticket}`)).status,
    ).toBe(200);
    now = NOW + 120_000;
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?ticket=${ticket}`)).status,
    ).toBe(403);
  });

  it('denies share-minted tickets after the share is revoked', async () => {
    const { app } = makeHarness(userActor(adminUser));
    const { shareId, token } = await createShare(app, {
      kind: 'file',
      mountId: 'm-1',
      fileId: 'f-1',
    });
    // Mint under the share actor.
    const mint = await api(
      app,
      `/api/v1/mounts/m-1/files/f-1/tickets?share=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(mint.status).toBe(201);
    const { ticket } = (await mint.json()) as { ticket: string };
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?ticket=${ticket}`)).status,
    ).toBe(200);
    // Revoke the underlying share — the ticket's principal recheck must fail.
    await api(app, `/api/v1/shares/${shareId}`, { method: 'DELETE' });
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?ticket=${ticket}`)).status,
    ).toBe(403);
  });

  it('denies tickets minted for a user whose grant was removed', async () => {
    const viewer: AuthUser = {
      ...adminUser,
      id: 'u-gone',
      email: 'gone@example.test',
      role: 'user',
    };
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, 0)',
    )
      .bind(viewer.id, viewer.name, viewer.email, NOW, NOW, 'user')
      .run();
    await env.DB.prepare(
      "INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES (?, 'm-1', 'viewer', '[\"read\"]', ?, ?, ?)",
    )
      .bind(viewer.id, adminUser.id, NOW, NOW)
      .run();
    const { app } = makeHarness(userActor(viewer));
    const mint = await api(app, '/api/v1/mounts/m-1/files/f-1/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { ticket } = (await mint.json()) as { ticket: string };
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?ticket=${ticket}`)).status,
    ).toBe(200);
    await env.DB
      .prepare('DELETE FROM mount_grants WHERE user_id = ?')
      .bind(viewer.id)
      .run();
    expect(
      (await api(app, `/api/v1/mounts/m-1/files/f-1/content?ticket=${ticket}`)).status,
    ).toBe(403);
  });
});
