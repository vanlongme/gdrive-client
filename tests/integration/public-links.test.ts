/** Public folder links integration tests (wave 8 B2): admin lifecycle,
 * anonymous meta/children/content/archive with descendant enforcement,
 * locked unlock flow (cookie MAC + throttle), expiry/policy invalidation,
 * and the app-level mounting/gate contract. */

import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/worker/app';
import type { CatalogEntry, DriveFileMeta, OAuthCatalogWriteProvider, ServiceAccountContentReadProvider, UpstreamContent } from '../../src/worker/drive/types';
import { createPublicLinkAdminRouter } from '../../src/worker/public-links/admin-routes';
import { createPublicLinkRouter, type PublicLinkRouterDeps } from '../../src/worker/public-links/public-routes';
import { PUBLIC_LINK_COOKIE_NAME } from '../../src/worker/public-links/crypto';
import { resetDescendantCacheForTests } from '../../src/worker/drive/containment';

const TEST_MIGRATIONS = JSON.parse((env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS) as D1Migration[];
const NOW = 1_700_000_000_000;
const ORIGIN = 'https://app.test';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const enc = new TextEncoder();
const tick = () => new Promise((r) => setTimeout(r, 0));
const STREAM_TIMEOUT = 15_000;

// Drive tree: drive-1 root -> pub-root -> {sub -> file-in-sub, file-in-root, shortcut, native-doc}; drive-1 -> outside -> file-outside
const META: Record<string, DriveFileMeta> = {
  'drive-1': { id: 'drive-1', name: 'Drive', mimeType: FOLDER, parents: [], driveId: 'drive-1', hasThumbnail: false },
  'pub-root': { id: 'pub-root', name: 'Public Folder', mimeType: FOLDER, parents: ['drive-1'], driveId: 'drive-1', hasThumbnail: false },
  'sub': { id: 'sub', name: 'Sub Dir', mimeType: FOLDER, parents: ['pub-root'], driveId: 'drive-1', hasThumbnail: false },
  'outside': { id: 'outside', name: 'Secret', mimeType: FOLDER, parents: ['drive-1'], driveId: 'drive-1', hasThumbnail: false },
  'file-in-root': { id: 'file-in-root', name: 'a.txt', mimeType: 'text/plain', size: '5', parents: ['pub-root'], driveId: 'drive-1', modifiedTime: '2026-01-01T00:00:00Z', hasThumbnail: false },
  'file-in-sub': { id: 'file-in-sub', name: 'b.txt', mimeType: 'text/plain', size: '3', parents: ['sub'], driveId: 'drive-1', modifiedTime: '2026-01-02T00:00:00Z', hasThumbnail: false },
  'file-outside': { id: 'file-outside', name: 's.txt', mimeType: 'text/plain', size: '9', parents: ['outside'], driveId: 'drive-1', hasThumbnail: false },
  'shortcut-1': { id: 'shortcut-1', name: 'lnk', mimeType: SHORTCUT, parents: ['pub-root'], driveId: 'drive-1', shortcutTargetId: 'file-outside', hasThumbnail: false },
  'file-other-mount': { id: 'file-other-mount', name: 'om.txt', mimeType: 'text/plain', size: '4', parents: ['om-root'], driveId: 'drive-9', hasThumbnail: false },
  'native-doc': { id: 'native-doc', name: 'Doc', mimeType: 'application/vnd.google-apps.document', parents: ['pub-root'], driveId: 'drive-1', hasThumbnail: false },
};
const KIDS: Record<string, string[]> = {
  'drive-1': ['pub-root', 'outside'],
  'pub-root': ['sub', 'file-in-root', 'shortcut-1', 'native-doc'],
  'sub': ['file-in-sub'],
  'outside': ['file-outside'],
};
const BODIES: Record<string, string> = { 'file-in-root': 'hello', 'file-in-sub': 'bye', 'file-outside': 'secret!!!' };

const oauthFixture: OAuthCatalogWriteProvider = {
  listChildren: async (i) => ({
    entries: (KIDS[i.parentFolderId] ?? []).map((id) => {
      const m = META[id]!;
      return { id, kind: m.mimeType === FOLDER ? 'folder' : m.mimeType === SHORTCUT ? 'shortcut' : 'file', name: m.name, mimeType: m.mimeType, size: m.size ?? '0', modifiedTime: m.modifiedTime, shortcutTargetId: m.shortcutTargetId, parents: m.parents, hasThumbnail: false } as CatalogEntry;
    }),
  }),
  search: async () => ({ entries: [] }),
  getMetadata: async (i) => META[i.ref.id] ?? (() => { throw Object.assign(new Error('nf'), { reason: 'not-found', status: 404 }); })(),
  generateId: async () => 'g', createFolder: async () => META['pub-root']!, startUpload: async () => ({ kind: 'resumable', sessionUri: 'x', generatedFileId: 'g' }),
  putChunk: async () => ({ kind: 'incomplete', confirmedOffset: 0n }), probeUpload: async () => ({ kind: 'incomplete', confirmedOffset: 0n }),
  verifyFile: async (i) => META[i.ref.id]!, trashFile: async () => {},
};

const saFixture: ServiceAccountContentReadProvider = {
  getReadMetadata: async (i) => ({ ...META[i.ref.id]!, capabilities: { canDownload: true } }),
  getRevision: async () => ({ id: 'r', keepForever: true }),
  openContent: async (i) => {
    const text = BODIES[i.ref.id] ?? '';
    const bytes = enc.encode(text);
    const body = i.range ? bytes.subarray(Number(i.range.start), Number(i.range.end) + 1) : bytes;
    return {
      status: i.range ? 206 : 200, contentType: 'text/plain',
      contentLength: BigInt(body.byteLength),
      ...(i.range ? { contentRange: `bytes ${i.range.start}-${i.range.end}/${bytes.byteLength}` } : {}),
      body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close(); } }),
    } as UpstreamContent;
  },
  openThumbnail: async () => ({ status: 200, body: new ReadableStream({ start(c) { c.close(); } }) }),
  exportDocument: async () => ({ status: 200, body: new ReadableStream({ start(c) { c.close(); } }) }),
};

async function reset() {
  for (const t of ['mount_drive_permissions', 'audit_events', 'file_readiness', 'public_link_unlock_attempts', 'public_folder_links', 'site_branding', 'share_links', 'mount_grants', 'mount_read_credentials', 'service_accounts', 'containment_verdicts',
    'mounts', 'google_connections', 'google_oauth_clients', 'session', 'account', 'user', 'app_settings']) {
    await env.DB.prepare(`DELETE FROM "${t}"`).run();
  }
  resetDescendantCacheForTests();
}

async function seed() {
  await env.DB.prepare("INSERT INTO app_settings (id, installation_id, setup_state, canonical_origin, policies, version, created_at, updated_at) VALUES (1, 'i1', 'complete', ?, '{}', 1, ?, ?)").bind(ORIGIN, NOW, NOW).run();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, 0)').bind('u-admin', 'Admin Person', 'admin@x.test', NOW, NOW, 'admin').run();
  await env.DB.prepare("INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at) VALUES ('oc1','p1','cid','e','https://x/cb',?,?)").bind(NOW, NOW).run();
  await env.DB.prepare("INSERT INTO google_connections (id, oauth_client_id, principal_id, granted_scopes, state, enabled, version, created_at, updated_at) VALUES ('conn1','oc1','p-1','drive','connected',1,1,?,?)").bind(NOW, NOW).run();
  await env.DB.prepare("INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, visibility, policy_version, created_at, updated_at) VALUES ('m1','Team Drive','drive-1','drive-1','conn1','conn1','private',1,?,?)").bind(NOW, NOW).run();
  await env.DB.prepare("INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa1','p1','sa@x','k','e',1,1,?,?)").bind(NOW, NOW).run();
  await env.DB.prepare("INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('m1','sa1',10,1,?)").bind(NOW).run();
}

function harness(opts: { adminOk?: boolean; deps?: Partial<PublicLinkRouterDeps> } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => { c.set('requestId', 'req-t'); await next(); });
  const requireAdmin = opts.adminOk === false
    ? () => Promise.reject({ status: 403, code: 'FORBIDDEN', message: 'x' })
    : () => Promise.resolve({ userId: 'u-admin', sessionId: 's1' });
  app.route('/api/v1/p', createPublicLinkRouter({ oauthProvider: oauthFixture, readProvider: saFixture, now: () => NOW, ...opts.deps }));
  app.route('/api/v1/public-links', createPublicLinkAdminRouter({ requireAdmin: requireAdmin as never, oauthProvider: oauthFixture, now: () => NOW }));
  return app;
}
type TestApp = Hono<{ Bindings: Env; Variables: { requestId?: string } }>;
const api = (app: TestApp, p: string, init?: RequestInit, envOverride?: Env) =>
  Promise.resolve(app.fetch(new Request(`${ORIGIN}${p}`, init), envOverride ?? (env as unknown as Env)));

async function createLink(app: TestApp, extra: Record<string, unknown> = {}) {
  const res = await api(app, '/api/v1/public-links', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mountId: 'm1', folderId: 'pub-root', password: null, expiresAt: null, allowZip: false, ...extra }),
  });
  return res;
}
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

beforeEach(async () => { await applyD1Migrations(env.DB, TEST_MIGRATIONS); await reset(); await seed(); });

describe('admin lifecycle', () => {
  it('creates, lists, patches, revokes; conflict on second active link', async () => {
    const app = harness();
    const res = await createLink(app, { allowZip: true });
    expect(res.status).toBe(201);
    const { link } = (await res.json()) as { link: Record<string, unknown> };
    expect(link.slug).toMatch(/^public-folder-[a-z2-7]{26}$/);
    expect(link.path).toBe(`/public/${link.slug}`);
    expect(link.mountLabel).toBe('Team Drive');
    expect(link.folderName).toBe('Public Folder');
    expect(link.createdByEmail).toBe('admin@x.test');
    expect(link.status).toBe('active');
    expect(link.hasPassword).toBe(false);
    expect(JSON.stringify(link)).not.toContain('password_hash');
    expect(JSON.stringify(link)).not.toContain('credential_version');
    // Conflict:
    expect((await createLink(app)).status).toBe(409);
    // List:
    const list = (await (await api(app, '/api/v1/public-links?mountId=m1')).json()) as { links: unknown[] };
    expect(list.links).toHaveLength(1);
    // Patch password + allowZip off:
    const patch = await api(app, `/api/v1/public-links/${link.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-12345', allowZip: false }) });
    expect(patch.status).toBe(200);
    const v2 = (await patch.json()) as { link: { hasPassword: boolean; allowZip: boolean } };
    expect(v2.link.hasPassword).toBe(true);
    expect(v2.link.allowZip).toBe(false);
    // Revoke idempotent:
    expect((await api(app, `/api/v1/public-links/${link.id}`, { method: 'DELETE' })).status).toBe(200);
    const again = await api(app, `/api/v1/public-links/${link.id}`, { method: 'DELETE' });
    expect(((await again.json()) as { link: { status: string } }).link.status).toBe('revoked');
    expect((await api(app, '/api/v1/public-links/nope', { method: 'DELETE' })).status).toBe(404);
    // New link allowed after revoke:
    expect((await createLink(app)).status).toBe(201);
  });
  it('enforces shareMaxLifetimeSeconds (null expiry gets capped, over-cap rejected)', async () => {
    await env.DB.prepare("UPDATE app_settings SET policies = '{\"shareMaxLifetimeSeconds\": 3600}' WHERE id = 1").run();
    const app = harness();
    const res = await createLink(app);
    expect(res.status).toBe(201);
    const { link } = (await res.json()) as { link: { expiresAt: string | null } };
    expect(link.expiresAt).toBe(new Date(NOW + 3600_000).toISOString());
    const over = await createLink(app, { folderId: 'outside', expiresAt: new Date(NOW + 7200_000).toISOString() });
    expect(over.status).toBe(400);
    const past = await createLink(app, { folderId: 'outside', expiresAt: new Date(NOW - 1000).toISOString() });
    expect(past.status).toBe(400);
  });
  it('rejects non-admin callers and out-of-mount folders', async () => {
    expect((await createLink(harness({ adminOk: false }))).status).toBe(403);
    const app = harness();
    expect((await createLink(app, { folderId: 'missing' })).status).not.toBe(201);
    expect((await createLink(app, { folderId: 'file-in-root' })).status).toBe(400); // not a folder
  });
});

describe('anonymous meta + children', () => {
  it('serves meta, counts views, hides shortcuts, walks breadcrumbs', async () => {
    const app = harness();
    const { link } = (await (await createLink(app)).json()) as { link: { slug: string } };
    expect((await api(app, '/api/v1/p/unknown-slug')).status).toBe(404);
    const meta = (await (await api(app, `/api/v1/p/${link.slug}`)).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ slug: link.slug, folderName: 'Public Folder', rootFolderId: 'pub-root', sharedByName: 'Admin Person', expiresAt: null, allowZip: false, locked: false });
    const row = await env.DB.prepare('SELECT view_count FROM public_folder_links WHERE slug = ?').bind(link.slug).first<{ view_count: number }>();
    expect(row?.view_count).toBe(1);
    // Children of root:
    const kids = (await (await api(app, `/api/v1/p/${link.slug}/children`)).json()) as { entries: { id: string; kind: string; size: string | null }[]; breadcrumbs: { id: string }[]; nextPageToken: string | null };
    expect(kids.breadcrumbs).toEqual([{ id: 'pub-root', name: 'Public Folder' }]);
    const ids = kids.entries.map((e) => e.id);
    expect(ids).toEqual(['sub', 'file-in-root', 'native-doc']); // shortcut hidden
    expect(kids.entries.find((e) => e.id === 'sub')?.size).toBeNull();
    // Descendant folder:
    const sub = (await (await api(app, `/api/v1/p/${link.slug}/children?folderId=sub`)).json()) as { breadcrumbs: { id: string }[]; entries: unknown[] };
    expect(sub.breadcrumbs.map((b) => b.id)).toEqual(['pub-root', 'sub']);
    expect(sub.entries).toHaveLength(1);
    // Outside the link root: indistinguishable 404.
    for (const f of ['outside', 'drive-1']) {
      const res = await api(app, `/api/v1/p/${link.slug}/children?folderId=${f}`);
      expect(res.status).toBe(404);
    }
  });
});

describe('content + archive', () => {
  it('streams file bytes via SA, honors Range, counts downloads, 404s outside', async () => {
    const app = harness();
    const { link } = (await (await createLink(app)).json()) as { link: { slug: string } };
    const res = await api(app, `/api/v1/p/${link.slug}/files/file-in-sub/content`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('bye');
    expect(res.headers.get('content-disposition')).toContain('b.txt');
    const ranged = await api(app, `/api/v1/p/${link.slug}/files/file-in-sub/content`, { headers: { range: 'bytes=0-1' } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('by');
    expect((await api(app, `/api/v1/p/${link.slug}/files/file-in-sub/content`, { method: 'HEAD' })).status).toBe(200);
    const dl = await api(app, `/api/v1/p/${link.slug}/files/file-in-sub/content?download=1`);
    expect(dl.headers.get('content-disposition')).toContain('attachment');
    // download_count now increments when the first chunk is pulled (R1):
    // consume the body so the counter actually fires.
    expect(await dl.text()).toBe('bye');
    const row = await env.DB.prepare('SELECT download_count FROM public_folder_links WHERE slug = ?').bind(link.slug).first<{ download_count: number }>();
    expect(row?.download_count).toBe(1);
    expect((await api(app, `/api/v1/p/${link.slug}/files/file-outside/content`)).status).toBe(404);
    expect((await api(app, `/api/v1/p/${link.slug}/files/shortcut-1/content`)).status).toBe(404);
  });
  it('archive streams a real zip; allowZip=false -> 403; caps -> 413', async () => {
    const app = harness({ deps: { archiveMaxFiles: 50 } });
    const { link } = (await (await createLink(app, { allowZip: true })).json()) as { link: { slug: string } };
    const res = await api(app, `/api/v1/p/${link.slug}/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('.zip');
    const zip = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const text = new TextDecoder().decode(zip);
    expect(text).toContain('hello');
    expect(text).toContain('skipped-files.txt'); // native-doc skipped
    // disabled link:
    const { link: l2 } = (await (await createLink(app, { folderId: 'outside', allowZip: false })).json()) as { link: { slug: string } };
    expect((await api(app, `/api/v1/p/${l2.slug}/archive`)).status).toBe(403);
    // cap exceeded (archiveMaxFiles=50 default fixture tree has 2; use tiny cap):
    const app2 = harness({ deps: { archiveMaxFiles: 1 } });
    const { link: l3 } = (await (await createLink(app2, { folderId: 'sub' })).json()) as { link: { slug: string } };
    const big = await api(app2, `/api/v1/p/${l3.slug}/archive?folderId=pub-root`);
    expect(big.status).toBe(403); // folderId outside l3's root -> 404 not 413
    void big;
  });
  it('archive over caps answers 413', async () => {
    const app = harness({ deps: { archiveMaxBytes: 4n } });
    const { link } = (await (await createLink(app, { allowZip: true })).json()) as { link: { slug: string } };
    const res = await api(app, `/api/v1/p/${link.slug}/archive`);
    expect(res.status).toBe(413);
  });
});

describe('locked links', () => {
  const PW = 's3cret-pw';
  async function lockedLink(app: TestApp) {
    const { link } = (await (await createLink(app, { password: PW })).json()) as { link: { slug: string } };
    return link;
  }
  it('requires the cookie everywhere, issues it on unlock, binds it to credentialVersion', async () => {
    const app = harness();
    const link = await lockedLink(app);
    const meta = (await (await api(app, `/api/v1/p/${link.slug}`)).json()) as { locked: boolean };
    expect(meta.locked).toBe(true);
    for (const p of ['children', 'files/file-in-root/content', 'archive']) {
      const res = await api(app, `/api/v1/p/${link.slug}/${p}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PUBLIC_LINK_PASSWORD_REQUIRED');
    }
    // Wrong password:
    const bad = await api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope1234' }) });
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('PUBLIC_LINK_INVALID_PASSWORD');
    // Right password:
    const ok = await api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
    expect(ok.status).toBe(204);
    const cookie = cookieOf(ok);
    expect(cookie).toContain(`${PUBLIC_LINK_COOKIE_NAME}=`);
    expect(ok.headers.get('set-cookie')).toContain('HttpOnly');
    expect(ok.headers.get('set-cookie')).toContain('Path=/api/v1/p/');
    const kids = await api(app, `/api/v1/p/${link.slug}/children`, { headers: { cookie } });
    expect(kids.status).toBe(200);
    // Password change bumps credential_version -> old cookie dies.
    const list = (await (await api(app, '/api/v1/public-links')).json()) as { links: { id: string }[] };
    await api(app, `/api/v1/public-links/${list.links[0]!.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'new-pw-999' }) });
    expect((await api(app, `/api/v1/p/${link.slug}/children`, { headers: { cookie } })).status).toBe(403);
    const ok2 = await api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'new-pw-999' }) });
    expect(ok2.status).toBe(204);
  });
  it('throttles repeated failures to 429 with retryAfterSeconds', async () => {
    const app = harness();
    const link = await lockedLink(app);
    const post = () => api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' }, body: JSON.stringify({ password: 'bad-bad' }) });
    // Exactly 5 attempts verify before the lock trips (review R2a).
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(403);
    const sixth = await post();
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as { error: { code: string; retryAfterSeconds: number } };
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    // Even the correct password is throttled now:
    const correct = await api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' }, body: JSON.stringify({ password: PW }) });
    expect(correct.status).toBe(429);
    // A different IP is untouched:
    const other = await api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' }, body: JSON.stringify({ password: PW }) });
    expect(other.status).toBe(204);
    // No IP persisted:
    const stored = await env.DB.prepare('SELECT key FROM public_link_unlock_attempts').all<{ key: string }>();
    for (const r of stored.results ?? []) expect(r.key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('validity', () => {
  it('expired, revoked and policy-changed links answer 410', async () => {
    const app = harness();
    const { link } = (await (await createLink(app)).json()) as { link: { slug: string; id: string } };
    await env.DB.prepare('UPDATE public_folder_links SET expires_at = ? WHERE id = ?').bind(NOW - 1, link.id).run();
    expect((await api(app, `/api/v1/p/${link.slug}`)).status).toBe(410);
    expect(((await (await api(app, `/api/v1/p/${link.slug}`)).json()) as { error: { code: string } }).error.code).toBe('PUBLIC_LINK_EXPIRED');
    await env.DB.prepare('UPDATE public_folder_links SET expires_at = NULL, revoked_at = ? WHERE id = ?').bind(NOW, link.id).run();
    expect((await api(app, `/api/v1/p/${link.slug}`)).status).toBe(410);
    await env.DB.prepare('UPDATE public_folder_links SET revoked_at = NULL WHERE id = ?').bind(link.id).run();
    await env.DB.prepare('UPDATE mounts SET policy_version = 2 WHERE id = ?').bind('m1').run();
    expect((await api(app, `/api/v1/p/${link.slug}`)).status).toBe(410);
    const view = (await (await api(app, '/api/v1/public-links')).json()) as { links: { status: string }[] };
    expect(view.links[0]!.status).toBe('invalidated');
  });
});

describe('app-level gates (createApp)', () => {
  it('/api/v1/p requires completed setup; /api/v1/site does not', async () => {
    await reset();
    const app = createApp();
    const p = await app.fetch(new Request(`${ORIGIN}/api/v1/p/whatever`), env as unknown as Env, createExecutionContext());
    expect(p.status).toBe(503);
    expect(((await p.json()) as { error: { code: string } }).error.code).toBe('SETUP_REQUIRED');
    const site = await app.fetch(new Request(`${ORIGIN}/api/v1/site`), env as unknown as Env, createExecutionContext());
    expect(site.status).toBe(200);
  });
  it('mounted /p answers 404 for unknown slug with noindex + no-store post-setup', async () => {
    const app = createApp();
    const res = await app.fetch(new Request(`${ORIGIN}/api/v1/p/nothing-here`), env as unknown as Env, createExecutionContext());
    expect(res.status).toBe(404);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-control')).toContain('no-store');
    // Admin API requires auth: no session -> 401.
    const admin = await app.fetch(new Request(`${ORIGIN}/api/v1/public-links`), env as unknown as Env, createExecutionContext());
    expect(admin.status).toBe(401);
  });
});

// --- Security-review regression tests (H1/H2/M1/M3/M4/L5/L7) ---------------

describe('concurrent + aggregate unlock throttling (H2, M2)', () => {
  const PW = 's3cret-pw';
  async function lockedLink(app: TestApp, deps?: Partial<PublicLinkRouterDeps>) {
    void deps;
    const { link } = (await (await createLink(app, { password: PW })).json()) as { link: { slug: string } };
    return link;
  }
  it('N parallel wrong unlocks admit at most the limit before 429', async () => {
    const app = harness();
    const link = await lockedLink(app);
    const post = () => api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' }, body: JSON.stringify({ password: 'bad-bad' }) });
    const results = await Promise.all(Array.from({ length: 10 }, post));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 403).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(4);
    const row = await env.DB.prepare('SELECT failures FROM public_link_unlock_attempts').first<{ failures: number }>();
    expect(row?.failures).toBe(10); // every attempt reserved atomically
  });
  it('per-link aggregate limit stops rotating-IP guessing', async () => {
    const app = harness({ deps: { unlockAggregateMaxAttempts: 4 } });
    const link = await lockedLink(app);
    const post = (ip: string) => api(app, `/api/v1/p/${link.slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ password: 'bad-bad' }) });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(`10.0.0.${i}`)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 403).length).toBeLessThanOrEqual(4);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(4);
  });
});

describe('cross-mount + outside-archive containment (review)', () => {
  it('rejects a file id from another mount and an archive folderId outside the root with 404', async () => {
    const app = harness();
    const { link } = (await (await createLink(app, { allowZip: true })).json()) as { link: { slug: string } };
    // META['file-other-mount'] sits on drive-9: outside mount AND outside link.
    const res = await api(app, `/api/v1/p/${link.slug}/files/file-other-mount/content`);
    expect(res.status).toBe(404);
    // archive pointed above the link root.
    const arch = await api(app, `/api/v1/p/${link.slug}/archive?folderId=outside`);
    expect(arch.status).toBe(404);
    const arch2 = await api(app, `/api/v1/p/${link.slug}/archive?folderId=drive-1`);
    expect(arch2.status).toBe(404);
  });
});

describe('HEAD + counters (L7)', () => {
  it('HEAD on /:slug returns headers without incrementing view_count', async () => {
    const app = harness();
    const { link } = (await (await createLink(app)).json()) as { link: { slug: string } };
    const head = await api(app, `/api/v1/p/${link.slug}`, { method: 'HEAD' });
    expect([200, 404, 405]).toContain(head.status); // must exist; never counts
    const row = await env.DB.prepare('SELECT view_count FROM public_folder_links WHERE slug = ?').bind(link.slug).first<{ view_count: number }>();
    expect(row?.view_count).toBe(0);
    await api(app, `/api/v1/p/${link.slug}`);
    const row2 = await env.DB.prepare('SELECT view_count FROM public_folder_links WHERE slug = ?').bind(link.slug).first<{ view_count: number }>();
    expect(row2?.view_count).toBe(1);
  });
});

describe('create over a dead link (M4)', () => {
  it('auto-revokes expired/invalidated links instead of 409', async () => {
    const app = harness();
    const { link } = (await (await createLink(app)).json()) as { link: { slug: string; id: string } };
    // Truly active -> 409 (already covered); now expire it -> create succeeds.
    await env.DB.prepare('UPDATE public_folder_links SET expires_at = ? WHERE id = ?').bind(NOW - 1, link.id).run();
    const res = await createLink(app);
    expect(res.status).toBe(201);
    const { link: l2 } = (await res.json()) as { link: { id: string; slug: string } };
    expect(l2.id).not.toBe(link.id);
    const old = await env.DB.prepare('SELECT revoked_at FROM public_folder_links WHERE id = ?').bind(link.id).first<{ revoked_at: number | null }>();
    expect(old?.revoked_at).not.toBeNull();
    // Policy-invalidated likewise:
    await env.DB.prepare('UPDATE public_folder_links SET policy_version = 99, revoked_at = NULL WHERE id = ?').bind(l2.id).run();
    expect((await createLink(app)).status).toBe(201);
  });
});

describe('zip name sanitization (M3)', () => {
  it('a folder named ".." cannot produce "../" in an entry name', async () => {
    META['dotdot'] = { id: 'dotdot', name: '..', mimeType: FOLDER, parents: ['pub-root'], driveId: 'drive-1', hasThumbnail: false };
    KIDS['pub-root'] = [...(KIDS['pub-root'] ?? []), 'dotdot'];
    KIDS['dotdot'] = [];
    const app = harness();
    const { link } = (await (await createLink(app, { allowZip: true })).json()) as { link: { slug: string } };
    const res = await api(app, `/api/v1/p/${link.slug}/archive`);
    expect(res.status).toBe(200);
    const zip = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder('latin1').decode(zip);
    expect(text).not.toContain('../');
    delete META['dotdot'];
    KIDS['pub-root'] = KIDS['pub-root'].filter((id) => id !== 'dotdot');
    delete KIDS['dotdot'];
  });
});

describe('archive caps inside the entry loop (M1)', () => {
  it('rejects mid-listing when the entry cap is exceeded', async () => {
    // Seed a folder whose listing overflows a tiny total-entry cap on page 1.
    META['wide'] = { id: 'wide', name: 'Wide', mimeType: FOLDER, parents: ['pub-root'], driveId: 'drive-1', hasThumbnail: false };
    KIDS['wide'] = ['a1', 'a2', 'a3', 'a4', 'a5'];
    for (const id of KIDS['wide'] ?? []) {
      META[id] = { id, name: `${id}.txt`, mimeType: 'text/plain', size: '1', parents: ['wide'], driveId: 'drive-1', hasThumbnail: false };
    }
    const app = harness({ deps: { archiveMaxEntries: 3 } });
    const { link } = (await (await createLink(app, { folderId: 'wide', allowZip: true })).json()) as { link: { slug: string } };
    const res = await api(app, `/api/v1/p/${link.slug}/archive`);
    expect(res.status).toBe(413);
    for (const id of KIDS['wide'] ?? []) delete META[id];
    delete KIDS['wide'];
    delete META['wide'];
  });
});

// --- Security review round 2 (R1/R2/R5/R6/R7) -------------------------------

describe('throttle exactness + aggregate hygiene (R2)', () => {
  const PW = 's3cret-pw';
  async function lockedLink(app: TestApp) {
    const { link } = (await (await createLink(app, { password: PW })).json()) as { link: { slug: string } };
    return link;
  }
  const post = (app: TestApp, slug: string, ip: string, password: string) =>
    api(app, `/api/v1/p/${slug}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ password }) });

  it('the per-link aggregate counts only FAILED attempts (R2b)', async () => {
    const app = harness({ deps: { unlockAggregateMaxAttempts: 3 } });
    const link = await lockedLink(app);
    // Two failures consume most of the tiny injected cap.
    expect((await post(app, link.slug, '10.0.1.1', 'bad-bad')).status).toBe(403);
    expect((await post(app, link.slug, '10.0.1.2', 'bad-bad')).status).toBe(403);
    // Successes refund their reservation: six of them never trip the cap.
    for (let i = 0; i < 6; i++) {
      expect((await post(app, link.slug, `10.0.2.${i}`, PW)).status).toBe(204);
    }
    // The third failure still verifies; the fourth exceeds the aggregate.
    expect((await post(app, link.slug, '10.0.1.3', 'bad-bad')).status).toBe(403);
    expect((await post(app, link.slug, '10.0.1.4', 'bad-bad')).status).toBe(429);
  });

  it('migration indexes the unlock-attempt prune column (R2c)', async () => {
    const idx = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'public_link_unlock_attempts_updated_idx'")
      .first<{ name: string }>();
    expect(idx?.name).toBe('public_link_unlock_attempts_updated_idx');
  });
});

describe('PATCH writes only the columns the caller sent (R5, L-c)', () => {
  /** env with DB.prepare spying on UPDATE public_folder_links statements. */
  function spyEnv(updates: string[]): Env {
    const spyDb = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === 'prepare' && typeof value === 'function') {
          return (sql: string) => {
            if (/UPDATE\s+public_folder_links/i.test(sql)) updates.push(sql);
            return (value as (s: string) => unknown).call(target, sql);
          };
        }
        return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(target) : value;
      },
    });
    return new Proxy(env as unknown as Record<string, unknown>, {
      get: (t, p) => (p === 'DB' ? spyDb : Reflect.get(t, p)),
    }) as unknown as Env;
  }
  const patch = (app: TestApp, id: string, body: Record<string, unknown>, envOverride?: Env) =>
    api(app, `/api/v1/public-links/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, envOverride);

  it('a non-password PATCH does not SET password_hash or credential_version', async () => {
    const app = harness();
    const { link } = (await (await createLink(app, { password: 'keep-me-1' })).json()) as { link: { id: string } };
    const updates: string[] = [];
    const res = await patch(app, link.id, { allowZip: true }, spyEnv(updates));
    expect(res.status).toBe(200);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((s) => s.includes('password_hash') || s.includes('credential_version'))).toBe(false);
    // ...and the stored credentials are byte-identical afterwards.
    const row = await env.DB.prepare('SELECT credential_version FROM public_folder_links WHERE id = ?').bind(link.id).first<{ credential_version: number }>();
    expect(row?.credential_version).toBe(1);
  });

  it('a password-only PATCH does not SET expires_at or allow_zip (L-c)', async () => {
    const app = harness();
    const { link } = (await (await createLink(app, { allowZip: true })).json()) as { link: { id: string } };
    const updates: string[] = [];
    const res = await patch(app, link.id, { password: 'rotate-1234' }, spyEnv(updates));
    expect(res.status).toBe(200);
    expect(updates.length).toBeGreaterThan(0);
    const update = updates.find((s) => s.includes('password_hash'))!;
    expect(update).toBeDefined();
    expect(update).not.toContain('expires_at');
    expect(update).not.toContain('allow_zip');
    // The untouched columns kept their values — allowZip stays enabled.
    const row = await env.DB.prepare('SELECT allow_zip FROM public_folder_links WHERE id = ?').bind(link.id).first<{ allow_zip: number }>();
    expect(row?.allow_zip).toBe(1);
  });
});

describe('anonymous error collapse on the content route (R6)', () => {
  it('a disabled OAuth connection answers a generic 503, not its diagnostic code', async () => {
    const app = harness();
    const { link } = (await (await createLink(app)).json()) as { link: { slug: string } };
    await env.DB.prepare("UPDATE google_connections SET enabled = 0 WHERE id = 'conn1'").run();
    const res = await api(app, `/api/v1/p/${link.slug}/files/file-in-sub/content`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('AUTH_UNAVAILABLE');
    expect(body.error.message).toBe('This link is temporarily unavailable.');
  });
});

describe('download counters are pull-driven (R1, R7)', () => {
  it('download=1 keeps upstream bounded with no reads and counts on first chunk (R1)', { timeout: STREAM_TIMEOUT }, async () => {
    let upstreamPulls = 0;
    const countingSa: ServiceAccountContentReadProvider = {
      ...saFixture,
      openContent: async () => ({
        status: 200,
        contentType: 'text/plain',
        contentLength: 64n * 1024n,
        body: new ReadableStream<Uint8Array>({
          pull(c) {
            upstreamPulls++;
            if (upstreamPulls <= 32) c.enqueue(new Uint8Array(2048));
            else c.close();
          },
        }),
      } as UpstreamContent),
    };
    const app = harness({ deps: { readProvider: countingSa } });
    const { link } = (await (await createLink(app)).json()) as { link: { slug: string } };
    const res = await api(app, `/api/v1/p/${link.slug}/files/file-in-sub/content?download=1`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      await tick();
      // Only queue-fill pulls are allowed — the old start() copier drained
      // all 32 upstream chunks before the first read.
      expect(upstreamPulls).toBeLessThanOrEqual(4);
      const first = await reader.read();
      expect(first.done).toBe(false);
      const row = await env.DB.prepare('SELECT download_count FROM public_folder_links WHERE slug = ?').bind(link.slug).first<{ download_count: number }>();
      expect(row?.download_count).toBe(1);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('archive increments download_count on the first pulled chunk (R7)', { timeout: STREAM_TIMEOUT }, async () => {
    const app = harness();
    const { link } = (await (await createLink(app, { allowZip: true })).json()) as { link: { slug: string } };
    const res = await api(app, `/api/v1/p/${link.slug}/archive`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const first = await reader.read();
      expect(first.done).toBe(false);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const row = await env.DB.prepare('SELECT download_count FROM public_folder_links WHERE slug = ?').bind(link.slug).first<{ download_count: number }>();
    expect(row?.download_count).toBe(1);
  });
});
