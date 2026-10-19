import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema } from '../../src/shared/contracts/common';
import {
  FileChildrenPageSchema,
  FileDetailSchema,
  MountListResponseSchema,
  SearchPageSchema,
} from '../../src/shared/contracts/drive';
import {
  CatalogCache,
  createCatalogRouter,
} from '../../src/worker/drive/catalog';
import { DriveError } from '../../src/worker/drive/errors';
import {
  resetContainmentCacheForTests,
} from '../../src/worker/drive/containment';
import type { Actor } from '../../src/worker/auth/grants';
import type {
  CatalogEntry,
  CatalogPage,
  DriveFileMeta,
  GetMetadataInput,
  ListChildrenInput,
  OAuthCatalogWriteProvider,
  SearchFilesInput,
} from '../../src/worker/drive/types';
import { resolveResource, ResourceScopeError } from '../../src/worker/drive/shortcuts';
import { actorKey, requireMountAccess } from '../../src/worker/drive/mounts';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const ORIGIN = 'http://worker.test';
const DRIVE_A = '0AAAdrive-aaaa';
const DRIVE_B = '0BBBdrive-bbbb';

// ---------------------------------------------------------------------------
// Fixture actors
// ---------------------------------------------------------------------------

function userActor(id = 'user-1', session = `sess-${id}`): Actor {
  return {
    kind: 'user',
    sessionId: session,
    user: {
      id,
      name: `User ${id}`,
      email: `${id}@example.test`,
      role: 'user',
      disabled: false,
      createdAt: '2026-01-01T00:00:00Z',
    },
  };
}

function adminActor(id = 'admin-1'): Actor {
  return {
    kind: 'user',
    sessionId: `sess-${id}`,
    user: {
      id,
      name: 'Admin',
      email: `${id}@example.test`,
      role: 'admin',
      disabled: false,
      createdAt: '2026-01-01T00:00:00Z',
    },
  };
}

const PUBLIC_ACTOR: Actor = { kind: 'public' };

// ---------------------------------------------------------------------------
// Fixture providers (the only seam the routes use for Google traffic).
// ---------------------------------------------------------------------------

function meta(over: Partial<DriveFileMeta> & { id: string }): DriveFileMeta {
  return {
    name: `file-${over.id}`,
    mimeType: 'application/octet-stream',
    hasThumbnail: false,
    driveId: DRIVE_A,
    ...over,
  } as DriveFileMeta;
}

function entry(over: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    kind: 'file',
    name: `file-${over.id}`,
    mimeType: 'application/octet-stream',
    size: '10',
    modifiedTime: '2026-10-01T00:00:00Z',
    hasThumbnail: false,
    ...over,
  } as CatalogEntry;
}

class FakeOAuthProvider implements OAuthCatalogWriteProvider {
  readonly childrenCalls: ListChildrenInput[] = [];
  readonly searchCalls: SearchFilesInput[] = [];
  readonly metadataCalls: GetMetadataInput[] = [];
  metas = new Map<string, DriveFileMeta | DriveError>();
  children = new Map<string, CatalogPage>();
  searches = new Map<string, CatalogPage>();

  private metaFor(ref: { id: string }): DriveFileMeta {
    const found = this.metas.get(ref.id);
    if (found === undefined) {
      throw new DriveError('not-found', `${ref.id} not found`, { status: 404 });
    }
    if (found instanceof DriveError) throw found;
    return found;
  }

  async listChildren(input: ListChildrenInput): Promise<CatalogPage> {
    this.childrenCalls.push(input);
    const key = `${input.scope.rootFolderId}|${input.parentFolderId}|${input.pageToken ?? ''}`;
    const page = this.children.get(key);
    if (page === undefined) {
      throw new DriveError('unexpected-response', `no fixture children for ${key}`);
    }
    return page;
  }

  async search(input: SearchFilesInput): Promise<CatalogPage> {
    this.searchCalls.push(input);
    const key = `${input.scope.rootFolderId}|${input.query}|${input.folderId ?? ''}|${input.pageToken ?? ''}`;
    const page = this.searches.get(key);
    if (page === undefined) {
      throw new DriveError('unexpected-response', `no fixture search for ${key}`);
    }
    return page;
  }

  async getMetadata(input: GetMetadataInput): Promise<DriveFileMeta> {
    this.metadataCalls.push(input);
    return this.metaFor(input.ref);
  }

  generateId(): Promise<string> {
    return Promise.reject(
      new DriveError('operation-not-allowed', 'catalog-only fixture'),
    );
  }
  createFolder(): never {
    throw new DriveError('operation-not-allowed', 'catalog-only fixture');
  }
  startUpload(): never {
    throw new DriveError('operation-not-allowed', 'catalog-only fixture');
  }
  putChunk(): never {
    throw new DriveError('operation-not-allowed', 'catalog-only fixture');
  }
  probeUpload(): never {
    throw new DriveError('operation-not-allowed', 'catalog-only fixture');
  }
  verifyFile(): never {
    throw new DriveError('operation-not-allowed', 'catalog-only fixture');
  }
  trashFile(): never {
    throw new DriveError('operation-not-allowed', 'catalog-only fixture');
  }
}

// ---------------------------------------------------------------------------
// Router harness: real D1 authz, fixture providers, injectable actor.
// ---------------------------------------------------------------------------

let currentActor: Actor = userActor();

function makeApp(deps: {
  oauth?: FakeOAuthProvider;
  cache?: CatalogCache;
  now?: () => number;
}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.route(
    '/api/v1/mounts',
    createCatalogRouter({
      resolveActor: () => Promise.resolve(currentActor),
      ...(deps.oauth === undefined ? {} : { oauthProvider: deps.oauth }),
      // Each fixture app gets an isolate-fresh cache — the module default is
      // shared per isolate and would leak pages between tests.
      cache: deps.cache ?? new CatalogCache(),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  return app;
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

// ---------------------------------------------------------------------------
// D1 seeding
// ---------------------------------------------------------------------------

async function seedClient(id = 'oc-1', enabled = 1, version = 3) {
  await env.DB.prepare(
    'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(id, 'proj-1', `client-${id}`, 'envelope-not-opened-in-tests', 'https://app.test/cb', enabled, version)
    .run();
}

async function seedUserRow(id: string, role = 'user') {
  // mount_grants.user_id and google_connections.connected_by reference user.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) ' +
      'VALUES (?, ?, ?, 1, ?, ?, ?, 0)',
  )
    .bind(id, `User ${id}`, `${id}@example.test`, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', role)
    .run();
}

async function seedAdminUser() {
  await seedUserRow('admin-1', 'admin');
}

async function seedConnection(
  id: string,
  options: { clientId?: string; state?: string; enabled?: number; version?: number; principalId?: string } = {},
) {
  await env.DB.prepare(
    'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(
      id,
      options.clientId ?? 'oc-1',
      options.principalId ?? 'perm-1',
      'op@example.com',
      null,
      'https://www.googleapis.com/auth/drive',
      options.state ?? 'connected',
      options.enabled ?? 1,
      options.version ?? 5,
      'admin-1',
    )
    .run();
}

async function seedMount(
  id: string,
  options: {
    driveId?: string;
    catalog?: string;
    write?: string;
    visibility?: string;
    label?: string;
    policyVersion?: number;
    readPoolVersion?: number;
  } = {},
) {
  await env.DB.prepare(
    'INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(
      id,
      options.label ?? `Mount ${id}`,
      options.driveId ?? DRIVE_A,
      options.driveId ?? DRIVE_A,
      options.catalog ?? 'conn-1',
      options.write ?? 'conn-1',
      options.readPoolVersion ?? 1,
      options.visibility ?? 'private',
      options.policyVersion ?? 1,
    )
    .run();
}

async function seedGrant(
  userId: string,
  mountId: string,
  role: 'viewer' | 'uploader',
  operations?: string[],
) {
  const ops = operations ?? (role === 'uploader' ? ['read', 'upload'] : ['read']);
  await env.DB.prepare(
    'INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(userId, mountId, role, JSON.stringify(ops), 'admin-1')
    .run();
}

async function seedReadiness(
  mountId: string,
  fileId: string,
  state: string,
  options: { poolVersion?: number; policyVersion?: number; reason?: string } = {},
) {
  await env.DB.prepare(
    'INSERT INTO file_readiness (mount_id, file_id, reader_access_state, read_pool_version, policy_version, checked_at, reason, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      mountId,
      fileId,
      state,
      options.poolVersion ?? 1,
      options.policyVersion ?? 1,
      1000,
      options.reason ?? null,
      1000,
    )
    .run();
}

async function resetState() {
  // Dependents first — FK references run child → parent.
  for (const table of [
    'mount_drive_permissions',
    'mount_grants',
    'mount_read_credentials',
    'file_readiness',
    'containment_verdicts',
    'mounts',
    'upload_batches',
    'upload_batch_nodes',
    'upload_operations',
    'share_links',
    'media_packages',
    'media_package_resources',
    'audit_events',
    'oauth_transactions',
    'google_connections',
    'google_oauth_clients',
    'service_accounts',
    'session',
    'account',
    'verification',
    'rateLimit',
    'user',
    'setup_throttle',
    'app_settings',
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  resetContainmentCacheForTests();
  await resetState();
  currentActor = userActor();
  await seedAdminUser();
  await seedUserRow('user-1');
  await seedUserRow('user-2');
  await seedClient();
  await seedConnection('conn-1');
  await seedConnection('conn-2', { principalId: 'perm-2' });
});

// ---------------------------------------------------------------------------
// Mount listing
// ---------------------------------------------------------------------------

describe('GET /api/v1/mounts', () => {
  it('lists only granted private mounts for a viewer with safe fields', async () => {
    await seedMount('m-a', { driveId: DRIVE_A });
    await seedMount('m-b', { driveId: DRIVE_B });
    await seedGrant('user-1', 'm-a', 'viewer');
    const res = await api(makeApp({}), '/api/v1/mounts');
    expect(res.status).toBe(200);
    const body = MountListResponseSchema.parse(await res.json());
    expect(body.mounts.map((m) => m.id)).toEqual(['m-a']);
    const view = body.mounts[0]!;
    expect(view.label).toBe('Mount m-a');
    expect(view.rootFolderId).toBe(DRIVE_A);
    expect(view.operations).toEqual(['read']);
    // Internal identities never leak.
    expect(JSON.stringify(view)).not.toContain('conn-1');
    expect(JSON.stringify(view)).not.toContain('catalogConnectionId');
  });

  it('grants uploader read+upload operations and admin all three', async () => {
    await seedMount('m-a');
    await seedMount('m-b');
    await seedGrant('user-1', 'm-a', 'uploader');
    const userRes = await api(makeApp({}), '/api/v1/mounts');
    const userBody = MountListResponseSchema.parse(await userRes.json());
    expect(userBody.mounts[0]!.operations).toEqual(['read', 'upload']);
    expect(userBody.mounts.map((m) => m.id)).toEqual(['m-a']);

    currentActor = adminActor();
    const adminRes = await api(makeApp({}), '/api/v1/mounts');
    const adminBody = MountListResponseSchema.parse(await adminRes.json());
    expect(adminBody.mounts.map((m) => m.id).sort()).toEqual(['m-a', 'm-b']);
    expect(adminBody.mounts[0]!.operations).toEqual(['read', 'upload', 'admin']);
  });

  it('shows public_read mounts to logged-in users without grants', async () => {
    await seedMount('m-pub', { visibility: 'public_read' });
    await seedMount('m-priv');
    const res = await api(makeApp({}), '/api/v1/mounts');
    const body = MountListResponseSchema.parse(await res.json());
    expect(body.mounts.map((m) => m.id)).toEqual(['m-pub']);
    expect(body.mounts[0]!.operations).toEqual(['read']);
  });

  it('shows public_read mounts to anonymous actors and nothing private', async () => {
    currentActor = PUBLIC_ACTOR;
    await seedMount('m-pub', { visibility: 'public_read' });
    await seedMount('m-priv');
    const res = await api(makeApp({}), '/api/v1/mounts');
    const body = MountListResponseSchema.parse(await res.json());
    expect(body.mounts.map((m) => m.id)).toEqual(['m-pub']);
  });
});

// ---------------------------------------------------------------------------
// Children listing
// ---------------------------------------------------------------------------

describe('GET /:m/folders/:f/children', () => {
  it('returns OAuth entries as safe DTOs and records drive scope', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, {
      entries: [
        entry({ id: 'f-1', name: 'report.pdf' }),
        entry({
          id: 'f-2',
          name: 'report.pdf',
          mimeType: 'text/plain',
        }), // duplicate name, distinct id
        entry({ id: 'f-3', name: 'Báo cáo.pdf' }),
        entry({
          id: 'sc-1',
          kind: 'shortcut',
          mimeType: 'application/vnd.google-apps.shortcut',
          shortcutTargetId: 'f-1',
          shortcutTargetResourceKey: 'rk-target',
        }),
      ],
    });
    const res = await api(
      makeApp({ oauth }),
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`,
    );
    expect(res.status).toBe(200);
    const page = FileChildrenPageSchema.parse(await res.json());
    expect(page.entries.map((e) => e.id)).toEqual(['f-1', 'f-2', 'f-3', 'sc-1']);
    // Duplicate + Unicode names survive as display text; ids disambiguate.
    expect(page.entries[0]!.name).toBe('report.pdf');
    expect(page.entries[1]!.name).toBe('report.pdf');
    expect(page.entries[2]!.name).toBe('Báo cáo.pdf');
    expect(page.entries[3]!.shortcutTargetId).toBe('f-1');
    // No resourceKey/connection identity anywhere in the body.
    expect(JSON.stringify(page)).not.toContain('rk-target');
    expect(JSON.stringify(page)).not.toContain('conn-1');
    expect(oauth.childrenCalls[0]!.scope).toEqual({
      mountId: 'm-a',
      rootFolderId: DRIVE_A,
      driveId: DRIVE_A,
    });
    expect(oauth.childrenCalls[0]!.writer.connectionId).toBe('conn-1');
  });

  it('denies children on a mount without a grant', async () => {
    await seedMount('m-a');
    const res = await api(
      makeApp({ oauth: new FakeOAuthProvider() }),
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`,
    );
    expect(res.status).toBe(403);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('denies again after the grant is revoked (no stale authz)', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, { entries: [] });
    const app = makeApp({ oauth });
    expect(
      (await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`)).status,
    ).toBe(200);
    await env.DB.prepare('DELETE FROM mount_grants').run();
    const res = await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    expect(res.status).toBe(403);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('answers 404 FILE_NOT_ACCESSIBLE for a folder outside the mount', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'outside-1',
      meta({ id: 'outside-1', driveId: '0CCCother-drive' }),
    );
    const res = await api(
      makeApp({ oauth }),
      '/api/v1/mounts/m-a/folders/outside-1/children',
    );
    expect(res.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'FILE_NOT_ACCESSIBLE',
    );
  });

  it('rejects listing children of a non-folder resource', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set('file-1', meta({ id: 'file-1' }));
    const res = await api(
      makeApp({ oauth }),
      '/api/v1/mounts/m-a/folders/file-1/children',
    );
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('fails closed GOOGLE_CONNECTION_DISABLED on a disabled catalog connection', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    await env.DB.prepare(
      "UPDATE google_connections SET enabled = 0, state = 'disabled' WHERE id = 'conn-1'",
    ).run();
    const res = await api(
      makeApp({ oauth: new FakeOAuthProvider() }),
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`,
    );
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'GOOGLE_CONNECTION_DISABLED',
    );
  });
});

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

describe('signed opaque cursors', () => {
  async function seedViewerMount() {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
  }

  it('paginates through a minted cursor; encrypted payload hides internals', async () => {
    await seedViewerMount();
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, {
      entries: [entry({ id: 'f-1' })],
      nextPageToken: 'google-pt-2',
    });
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|google-pt-2`, {
      entries: [entry({ id: 'f-2' })],
    });
    const app = makeApp({ oauth });
    const first = FileChildrenPageSchema.parse(
      await (await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`)).json(),
    );
    expect(first.nextCursor).toBeTruthy();
    // The cursor must not expose connection ids or the upstream page token.
    const sealedPart = first.nextCursor!.split('.')[1]!;
    const padded = sealedPart
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(sealedPart.length / 4) * 4, '=');
    const decoded = atob(padded);
    expect(decoded).not.toContain('conn-1');
    expect(decoded).not.toContain('google-pt-2');
    expect(decoded).not.toContain('sess-user-1');
    const second = await api(
      app,
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    const page = FileChildrenPageSchema.parse(await second.json());
    expect(page.entries.map((e) => e.id)).toEqual(['f-2']);
    expect(oauth.childrenCalls[1]!.pageToken).toBe('google-pt-2');
  });

  it('rejects a tampered cursor', async () => {
    await seedViewerMount();
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, {
      entries: [entry({ id: 'f-1' })],
      nextPageToken: 'pt-2',
    });
    const app = makeApp({ oauth });
    const first = FileChildrenPageSchema.parse(
      await (await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`)).json(),
    );
    const bad = `${first.nextCursor}tampered`;
    const res = await api(
      app,
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children?cursor=${encodeURIComponent(bad)}`,
    );
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects a cursor minted for a different query and different session', async () => {
    await seedViewerMount();
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, {
      entries: [entry({ id: 'f-1' })],
      nextPageToken: 'pt-2',
    });
    const app = makeApp({ oauth });
    const first = FileChildrenPageSchema.parse(
      await (await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`)).json(),
    );
    // Wrong folder for the same cursor (in-mount, so resolution succeeds
    // and the cursor subject mismatch is what rejects it).
    oauth.metas.set(
      'folder-x',
      meta({ id: 'folder-x', mimeType: 'application/vnd.google-apps.folder' }),
    );
    const wrongFolder = await api(
      app,
      `/api/v1/mounts/m-a/folders/folder-x/children?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(wrongFolder.status).toBe(400);
    // Same query but a different session (logout/login) — session-bound key.
    currentActor = userActor('user-1', 'sess-new');
    const wrongSession = await api(
      app,
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(wrongSession.status).toBe(400);
  });

  it('rejects an expired cursor and forces a clean restart', async () => {
    await seedViewerMount();
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, {
      entries: [entry({ id: 'f-1' })],
      nextPageToken: 'pt-2',
    });
    let nowMs = 1_000_000;
    const app = makeApp({ oauth, now: () => nowMs });
    const first = FileChildrenPageSchema.parse(
      await (await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`)).json(),
    );
    nowMs += 16 * 60 * 1000; // beyond the 15-minute cursor TTL
    const res = await api(
      app,
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('listing metadata cache', () => {
  it('serves a second identical request from cache within the TTL', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, { entries: [entry({ id: 'f-1' })] });
    const cache = new CatalogCache();
    const app = makeApp({ oauth, cache });
    await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    expect(oauth.childrenCalls.length).toBe(1);
  });

  it('does not share cached pages across sessions or actors', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    await seedGrant('user-2', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, { entries: [entry({ id: 'f-1' })] });
    const app = makeApp({ oauth, cache: new CatalogCache() });
    await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    currentActor = userActor('user-1', 'sess-other'); // same user, new session
    await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    currentActor = userActor('user-2');
    await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    expect(oauth.childrenCalls.length).toBe(3);
  });

  it('expires entries at the TTL boundary', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, { entries: [entry({ id: 'f-1' })] });
    let nowMs = 0;
    const app = makeApp({
      oauth,
      cache: new CatalogCache({ now: () => nowMs }),
      now: () => nowMs,
    });
    await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    nowMs += 30_001;
    await api(app, `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`);
    expect(oauth.childrenCalls.length).toBe(2);
  });

  it('bounds total cached bytes by evicting least-recently-used pages', () => {
    const cache = new CatalogCache({ maxBytes: 4096, now: () => 0 });
    const bigEntry = entry({ id: 'f', name: 'x'.repeat(3000) });
    cache.set('k1', { entries: [bigEntry] });
    cache.set('k2', { entries: [bigEntry] });
    cache.set('k3', { entries: [bigEntry] });
    expect(cache.stats().bytes).toBeLessThanOrEqual(4096);
    expect(cache.get('k1')).toBeUndefined(); // evicted first
    expect(cache.get('k3')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('GET /:m/search', () => {
  it('runs drive-scoped OAuth search and echoes scope', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.searches.set(`${DRIVE_A}|budget||`, {
      entries: [entry({ id: 'f-9', name: 'budget 2026.xlsx' })],
    });
    const res = await api(
      makeApp({ oauth }),
      '/api/v1/mounts/m-a/search?q=budget&scope=drive',
    );
    expect(res.status).toBe(200);
    const page = SearchPageSchema.parse(await res.json());
    expect(page.entries[0]!.id).toBe('f-9');
    expect(page.scope).toBe('drive');
    expect(oauth.searchCalls[0]!.query).toBe('budget');
    expect(oauth.searchCalls[0]!.searchScope).toBe('drive');
  });

  it('requires folderId for folder scope and rejects it for drive scope', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const app = makeApp({ oauth: new FakeOAuthProvider() });
    const missing = await api(app, '/api/v1/mounts/m-a/search?q=x&scope=folder');
    expect(missing.status).toBe(400);
    const stray = await api(
      app,
      `/api/v1/mounts/m-a/search?q=x&scope=drive&folderId=${DRIVE_A}`,
    );
    expect(stray.status).toBe(400);
  });

  it('scope-checks the search folder inside the mount', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'folder-1',
      meta({
        id: 'folder-1',
        mimeType: 'application/vnd.google-apps.folder',
      }),
    );
    oauth.searches.set(`${DRIVE_A}|x|folder-1|`, { entries: [] });
    const res = await api(
      makeApp({ oauth }),
      '/api/v1/mounts/m-a/search?q=x&scope=folder&folderId=folder-1',
    );
    expect(res.status).toBe(200);
    expect(oauth.searchCalls[0]!.folderId).toBe('folder-1');
  });

  it('passes query text through verbatim (provider owns escaping)', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    const nasty = "a' OR 1=1; 'name' contains \"x\" and trashed = false";
    oauth.searches.set(`${DRIVE_A}|${nasty}||`, { entries: [] });
    const res = await api(
      makeApp({ oauth }),
      `/api/v1/mounts/m-a/search?q=${encodeURIComponent(nasty)}&scope=drive`,
    );
    expect(res.status).toBe(200);
    expect(oauth.searchCalls[0]!.query).toBe(nasty);
  });

  it('rejects empty and oversized queries', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const app = makeApp({ oauth: new FakeOAuthProvider() });
    expect((await api(app, '/api/v1/mounts/m-a/search?q=&scope=drive')).status).toBe(400);
    expect(
      (await api(app, `/api/v1/mounts/m-a/search?q=${'x'.repeat(513)}&scope=drive`)).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// File detail + readiness
// ---------------------------------------------------------------------------

describe('GET /:m/files/:f and readiness', () => {
  it('resolves file detail via OAuth, joins the SA readiness projection', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    await seedReadiness('m-a', 'f-1', 'readable');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'f-1',
      meta({ id: 'f-1', name: 'doc.pdf', size: '12345', headRevisionId: 'rev-9' }),
    );
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-a/files/f-1');
    expect(res.status).toBe(200);
    const detail = FileDetailSchema.parse(await res.json());
    expect(detail.id).toBe('f-1');
    expect(detail.name).toBe('doc.pdf');
    expect(detail.readerAccessState).toBe('readable');
    expect(detail.preview?.versionHint).toBe('rev-9');
    // No ambiguous OAuth canDownload, no connection/resource internals.
    const raw = JSON.stringify(detail);
    expect(raw).not.toContain('canDownload');
    expect(raw).not.toContain('conn-1');
    expect(raw).not.toContain('resourceKey');
  });

  it('resolves an in-mount shortcut to its target metadata', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'sc-1',
      meta({
        id: 'sc-1',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTargetId: 'target-1',
        shortcutTargetResourceKey: 'rk-1',
      }),
    );
    oauth.metas.set('target-1', meta({ id: 'target-1', name: 'real.pdf' }));
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-a/files/sc-1');
    expect(res.status).toBe(200);
    const detail = FileDetailSchema.parse(await res.json());
    expect(detail.id).toBe('target-1');
    // The target call carried the target's resource key.
    expect(oauth.metadataCalls[1]!.ref.resourceKey).toBe('rk-1');
  });

  it('rejects a shortcut whose target lives outside the mount', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'sc-out',
      meta({
        id: 'sc-out',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTargetId: 'out-1',
      }),
    );
    oauth.metas.set(
      'out-1',
      meta({ id: 'out-1', driveId: '0CCCother-drive' }),
    );
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-a/files/sc-out');
    expect(res.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'FILE_NOT_ACCESSIBLE',
    );
  });

  it('reports unchecked when no readiness projection exists', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set('f-1', meta({ id: 'f-1' }));
    const detail = FileDetailSchema.parse(
      await (await api(makeApp({ oauth }), '/api/v1/mounts/m-a/files/f-1')).json(),
    );
    expect(detail.readerAccessState).toBe('unchecked');
  });
});

// ---------------------------------------------------------------------------
// Unit-ish scope + authz helpers through the real D1 surface
// ---------------------------------------------------------------------------

describe('requireMountAccess / resolveResource scope', () => {
  it('requireMountAccess returns actor+access+mount for a grant holder', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'uploader');
    const actor = userActor();
    const result = await requireMountAccess(
      env as unknown as { DB: D1Database },
      new Request(`${ORIGIN}/x`),
      'm-a',
      'upload',
      () => Promise.resolve(actor),
    );
    expect(result.mount.id).toBe('m-a');
    expect(result.access.operations.has('upload')).toBe(true);
  });

  it('resourceKey on a direct ref is honored but never widens scope', async () => {
    await seedMount('m-a');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set('f-1', meta({ id: 'f-1', resourceKey: 'rk-file' }));
    const resolved = await resolveResource(
      {
        access: { mountId: 'm-a', role: 'viewer', operations: new Set(['read'] as const) },
        mount: {
          id: 'm-a',
          label: 'm',
          driveId: DRIVE_A,
          rootFolderId: DRIVE_A,
          catalogConnectionId: 'conn-1',
          writeConnectionId: 'conn-1',
          readPoolVersion: 1,
          visibility: 'private',
          policyVersion: 1,
          createdAt: 0,
          updatedAt: 0,
        },
        writer: {
          connectionId: 'conn-1',
          principalId: 'perm-1',
          oauthClientId: 'oc-1',
          projectId: 'proj-1',
          connectionVersion: 1,
          oauthClientVersion: 1,
        },
        provider: oauth,
      },
      { id: 'f-1', resourceKey: 'rk-file' },
    );
    expect(resolved.ref.resourceKey).toBe('rk-file');
    expect(oauth.metadataCalls[0]!.ref.resourceKey).toBe('rk-file');
    // And a resource key cannot open a file in another drive.
    oauth.metas.set('f-2', meta({ id: 'f-2', driveId: '0ZZZother' }));
    await expect(
      resolveResource(
        {
          access: { mountId: 'm-a', role: 'viewer', operations: new Set(['read'] as const) },
          mount: {
            id: 'm-a',
            label: 'm',
            driveId: DRIVE_A,
            rootFolderId: DRIVE_A,
            catalogConnectionId: 'conn-1',
            writeConnectionId: 'conn-1',
            readPoolVersion: 1,
            visibility: 'private',
            policyVersion: 1,
            createdAt: 0,
            updatedAt: 0,
          },
          writer: {
            connectionId: 'conn-1',
            principalId: 'perm-1',
            oauthClientId: 'oc-1',
            projectId: 'proj-1',
            connectionVersion: 1,
            oauthClientVersion: 1,
          },
          provider: oauth,
        },
        { id: 'f-2', resourceKey: 'rk-anything' },
      ),
    ).rejects.toBeInstanceOf(ResourceScopeError);
  });

  it('actorKey binds the session, not just the user id', () => {
    const a = userActor('u-1', 'sess-A');
    const b = userActor('u-1', 'sess-B');
    expect(actorKey(a)).not.toBe(actorKey(b));
    expect(actorKey(a)).toContain('sess-A');
    expect(actorKey(PUBLIC_ACTOR)).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// Reviewer fixes: route-boundary id validation (F5), stale readiness
// projection gating (F6), resolved-folder cursor binding (F9).
// ---------------------------------------------------------------------------

describe('reviewer fixes', () => {
  it('rejects malformed Drive ids with 400 and zero provider calls (F5)', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    const app = makeApp({ oauth });
    const badId = 'bad!!id';
    const detail = await api(app, `/api/v1/mounts/m-a/files/${badId}`);
    expect(detail.status).toBe(400);
    const children = await api(
      app,
      `/api/v1/mounts/m-a/folders/${badId}/children`,
    );
    expect(children.status).toBe(400);
    const search = await api(
      app,
      `/api/v1/mounts/m-a/search?scope=folder&folderId=${badId}&q=x`,
    );
    expect(search.status).toBe(400);
    for (const res of [detail, children, search]) {
      expect(
        ApiErrorBodySchema.parse(await res.json()).error.code,
      ).toBe('VALIDATION_FAILED');
    }
    expect(oauth.metadataCalls).toHaveLength(0);
    expect(oauth.childrenCalls).toHaveLength(0);
    expect(oauth.searchCalls).toHaveLength(0);
  });

  it('reports stale readiness projections as unchecked (F6)', async () => {
    // f-1: pool-version changed since the probe; f-2: policy-version changed.
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    await seedReadiness('m-a', 'f-1', 'readable', { poolVersion: 2 });
    await seedReadiness('m-a', 'f-2', 'blocked', { policyVersion: 9 });
    const oauth = new FakeOAuthProvider();
    oauth.metas.set('f-1', meta({ id: 'f-1' }));
    oauth.metas.set('f-2', meta({ id: 'f-2' }));
    const app = makeApp({ oauth });
    const detail1 = FileDetailSchema.parse(
      await (await api(app, '/api/v1/mounts/m-a/files/f-1')).json(),
    );
    expect(detail1.readerAccessState).toBe('unchecked');
    const detail2 = FileDetailSchema.parse(
      await (await api(app, '/api/v1/mounts/m-a/files/f-2')).json(),
    );
    expect(detail2.readerAccessState).toBe('unchecked');
  });

  it('invalidates a children cursor when a shortcut retargets (F9)', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'sc-folder',
      meta({
        id: 'sc-folder',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTargetId: 'folder-a',
      }),
    );
    oauth.metas.set(
      'folder-a',
      meta({ id: 'folder-a', mimeType: 'application/vnd.google-apps.folder' }),
    );
    oauth.children.set(`${DRIVE_A}|folder-a|`, {
      entries: [entry({ id: 'f-1' })],
      nextPageToken: 'pt-2',
    });
    const app = makeApp({ oauth });
    const first = FileChildrenPageSchema.parse(
      await (
        await api(app, '/api/v1/mounts/m-a/folders/sc-folder/children')
      ).json(),
    );
    expect(first.nextCursor).toBeTruthy();
    // Retarget the shortcut: same route folderId, different resolved parent.
    oauth.metas.set(
      'sc-folder',
      meta({
        id: 'sc-folder',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTargetId: 'folder-b',
      }),
    );
    oauth.metas.set(
      'folder-b',
      meta({ id: 'folder-b', mimeType: 'application/vnd.google-apps.folder' }),
    );
    const res = await api(
      app,
      `/api/v1/mounts/m-a/folders/sc-folder/children?cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
    // The stale page token was never replayed against the new parent.
    expect(oauth.childrenCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// My Drive folder mounts (wave 7): containment replaces driveId equality.
// Fixture tree under MY_ROOT:
//   MY_ROOT/dirA/dirB/fileB                 (inside)
//   MY_ROOT/rootFile                        (inside, direct child)
//   elsewhereRoot/strayDir/strayFile        (outside; chain ends at a folder with no parent)
// ---------------------------------------------------------------------------

const MY_ROOT = 'MyRootFolder01';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** Like meta(), but without a driveId: My Drive files carry none. */
function myMeta(over: Partial<DriveFileMeta> & { id: string }): DriveFileMeta {
  return {
    name: `file-${over.id}`,
    mimeType: 'application/octet-stream',
    hasThumbnail: false,
    ...over,
  } as DriveFileMeta;
}

async function seedMyDriveMount(
  id: string,
  rootFolderId = MY_ROOT,
  options: Parameters<typeof seedMount>[1] = {},
) {
  await seedMount(id, { ...options, driveId: rootFolderId });
  await env.DB.prepare(
    'UPDATE mounts SET drive_id = NULL, root_folder_id = ? WHERE id = ?',
  )
    .bind(rootFolderId, id)
    .run();
}

function seedMyTree(oauth: FakeOAuthProvider) {
  oauth.metas.set('dirA', myMeta({ id: 'dirA', mimeType: FOLDER_MIME, parents: [MY_ROOT] }));
  oauth.metas.set('dirB', myMeta({ id: 'dirB', mimeType: FOLDER_MIME, parents: ['dirA'] }));
  oauth.metas.set('fileB', myMeta({ id: 'fileB', name: 'deep.pdf', parents: ['dirB'] }));
  oauth.metas.set('rootFile', myMeta({ id: 'rootFile', name: 'top.pdf', parents: [MY_ROOT] }));
  oauth.metas.set(
    'elsewhereRoot',
    myMeta({ id: 'elsewhereRoot', mimeType: FOLDER_MIME }),
  );
  oauth.metas.set(
    'strayDir',
    myMeta({ id: 'strayDir', mimeType: FOLDER_MIME, parents: ['elsewhereRoot'] }),
  );
  oauth.metas.set('strayFile', myMeta({ id: 'strayFile', parents: ['strayDir'] }));
}

describe('My Drive folder mount: catalog', () => {
  beforeEach(async () => {
    await seedMyDriveMount('m-my');
    await seedGrant('user-1', 'm-my', 'viewer');
  });

  it('lists the mount root as a MountView rootFolderId', async () => {
    const res = await api(makeApp({}), '/api/v1/mounts');
    const body = MountListResponseSchema.parse(await res.json());
    expect(body.mounts.find((m) => m.id === 'm-my')!.rootFolderId).toBe(MY_ROOT);
  });

  it('lists the root without any ancestor lookup and passes the My Drive scope', async () => {
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${MY_ROOT}|${MY_ROOT}|`, {
      entries: [
        entry({ id: 'c-1', name: 'a.pdf' }),
        entry({ id: 'c-2', name: 'sub', kind: 'folder', mimeType: FOLDER_MIME, size: '0' }),
      ],
    });
    const res = await api(
      makeApp({ oauth }),
      `/api/v1/mounts/m-my/folders/${MY_ROOT}/children`,
    );
    expect(res.status).toBe(200);
    const page = FileChildrenPageSchema.parse(await res.json());
    expect(page.entries.map((e) => e.id)).toEqual(['c-1', 'c-2']);
    expect(oauth.childrenCalls[0]!.scope).toEqual({
      mountId: 'm-my',
      rootFolderId: MY_ROOT,
      driveId: null,
    });
    expect(oauth.childrenCalls[0]!.parentFolderId).toBe(MY_ROOT);
    expect(oauth.metadataCalls).toHaveLength(0);
  });

  it('lists a nested folder after proving only the parent, never each child', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    // The children have NO metadata fixture: any per-child lookup would 404
    // in the fake and (being treated as "outside") would drop the entry or
    // fail the request.
    oauth.children.set(`${MY_ROOT}|dirB|`, {
      entries: [entry({ id: 'kid-1' }), entry({ id: 'kid-2' })],
    });
    const res = await api(
      makeApp({ oauth }),
      '/api/v1/mounts/m-my/folders/dirB/children',
    );
    expect(res.status).toBe(200);
    const page = FileChildrenPageSchema.parse(await res.json());
    expect(page.entries.map((e) => e.id)).toEqual(['kid-1', 'kid-2']);
    const looked = oauth.metadataCalls.map((c) => c.ref.id);
    expect(looked).toContain('dirB');
    expect(looked).not.toContain('kid-1');
    expect(looked).not.toContain('kid-2');
    expect(oauth.childrenCalls[0]!.parentFolderId).toBe('dirB');
  });

  it('answers 404 FILE_NOT_ACCESSIBLE for a folder outside the tree and never lists it', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    const res = await api(
      makeApp({ oauth }),
      '/api/v1/mounts/m-my/folders/strayDir/children',
    );
    expect(res.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'FILE_NOT_ACCESSIBLE',
    );
    expect(oauth.childrenCalls).toHaveLength(0);
  });

  it('returns file detail for a file inside the tree', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/fileB');
    expect(res.status).toBe(200);
    const detail = FileDetailSchema.parse(await res.json());
    expect(detail.id).toBe('fileB');
    expect(detail.name).toBe('deep.pdf');
    expect(oauth.metadataCalls[0]!.writer.connectionId).toBe('conn-1');
  });

  it('returns file detail for a direct child of the root', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/rootFile');
    expect(res.status).toBe(200);
    expect(FileDetailSchema.parse(await res.json()).id).toBe('rootFile');
  });

  it('answers FILE_NOT_ACCESSIBLE for a file outside the tree', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/strayFile');
    expect(res.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'FILE_NOT_ACCESSIBLE',
    );
  });

  it('answers FILE_NOT_ACCESSIBLE for a missing file exactly as for an outside file', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    const outside = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/strayFile');
    const missing = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/NoSuchFile1');
    expect(missing.status).toBe(outside.status);
    const a = ApiErrorBodySchema.parse(await outside.json()).error;
    const b = ApiErrorBodySchema.parse(await missing.json()).error;
    expect(b.code).toBe(a.code);
  });

  it('denies a Shared Drive file (driveId set) inside a My Drive mount', async () => {
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'sdFile',
      myMeta({ id: 'sdFile', parents: [MY_ROOT], driveId: DRIVE_A }),
    );
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/sdFile');
    expect(res.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'FILE_NOT_ACCESSIBLE',
    );
  });

  it('denies a file below a trashed ancestor', async () => {
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      'dirT',
      myMeta({ id: 'dirT', mimeType: FOLDER_MIME, parents: [MY_ROOT], trashed: true }),
    );
    oauth.metas.set('fileT', myMeta({ id: 'fileT', parents: ['dirT'] }));
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/fileT');
    expect(res.status).toBe(404);
  });

  it('resolves a shortcut inside the tree to its in-tree target', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    oauth.metas.set(
      'scIn',
      myMeta({
        id: 'scIn',
        mimeType: SHORTCUT_MIME,
        parents: [MY_ROOT],
        shortcutTargetId: 'fileB',
      }),
    );
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/scIn');
    expect(res.status).toBe(200);
    expect(FileDetailSchema.parse(await res.json()).id).toBe('fileB');
  });

  it('denies a shortcut inside the tree that points outside it', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    oauth.metas.set(
      'scOut',
      myMeta({
        id: 'scOut',
        mimeType: SHORTCUT_MIME,
        parents: [MY_ROOT],
        shortcutTargetId: 'strayFile',
      }),
    );
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/scOut');
    expect(res.status).toBe(404);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'FILE_NOT_ACCESSIBLE',
    );
  });

  it('fails closed (not 200) when an ancestor lookup fails upstream', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    oauth.metas.set('dirB', new DriveError('upstream-unavailable', 'boom'));
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/files/fileB');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await res.json())).not.toContain('boom');
  });
});

describe('Shared Drive mount: scope shape is unchanged', () => {
  it('passes {rootFolderId: driveId, driveId} to the provider', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.children.set(`${DRIVE_A}|${DRIVE_A}|`, { entries: [] });
    const res = await api(
      makeApp({ oauth }),
      `/api/v1/mounts/m-a/folders/${DRIVE_A}/children`,
    );
    expect(res.status).toBe(200);
    expect(oauth.childrenCalls[0]!.scope).toEqual({
      mountId: 'm-a',
      rootFolderId: DRIVE_A,
      driveId: DRIVE_A,
    });
    expect(oauth.metadataCalls).toHaveLength(0);
  });
});

const MY_ROOT_2 = 'MyRootFolder02';

describe('My Drive folder mount: whole-mount search', () => {
  beforeEach(async () => {
    await seedMyDriveMount('m-my');
    await seedGrant('user-1', 'm-my', 'viewer');
  });

  it('filters out-of-tree hits, searches with the My Drive scope, no partial flag', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    oauth.searches.set(`${MY_ROOT}|budget||`, {
      entries: [
        entry({ id: 'in-1', name: 'budget a', parents: ['dirA'] }),
        entry({ id: 'out-1', name: 'budget b', parents: ['strayDir'] }),
        entry({ id: 'in-2', name: 'budget c', parents: [MY_ROOT] }),
        entry({ id: 'out-2', name: 'budget d' }), // no visible parent: cannot be proven, so denied
      ],
    });
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/search?q=budget&scope=drive');
    expect(res.status).toBe(200);
    const page = SearchPageSchema.parse(await res.json());
    expect(page.entries.map((e) => e.id)).toEqual(['in-1', 'in-2']);
    expect(page.scope).toBe('drive');
    expect(page.partial).toBeUndefined();
    expect(page.nextCursor).toBeUndefined();
    expect(oauth.searchCalls).toHaveLength(1);
    expect(oauth.searchCalls[0]!.scope).toEqual({ mountId: 'm-my', rootFolderId: MY_ROOT, driveId: null });
    expect(oauth.searchCalls[0]!.searchScope).toBe('drive');
    expect(oauth.searchCalls[0]!.pageSize).toBe(100);
    // parents never reach the browser.
    expect(JSON.stringify(page)).not.toContain('parents');
  });

  it('reads at most 3 Google pages, flags partial and continues from the sealed cursor', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    const out = (id: string) => entry({ id, parents: ['strayDir'] });
    oauth.searches.set(`${MY_ROOT}|alpha||`, { entries: [out('o1'), out('o2')], nextPageToken: 'g2' });
    oauth.searches.set(`${MY_ROOT}|alpha||g2`, { entries: [out('o3')], nextPageToken: 'g3' });
    oauth.searches.set(`${MY_ROOT}|alpha||g3`, {
      entries: [entry({ id: 'h1', parents: ['dirB'] })],
      nextPageToken: 'g4',
    });
    oauth.searches.set(`${MY_ROOT}|alpha||g4`, {
      entries: [entry({ id: 'h2', parents: [MY_ROOT] })],
    });
    const app = makeApp({ oauth });
    const first = SearchPageSchema.parse(
      await (await api(app, '/api/v1/mounts/m-my/search?q=alpha&scope=drive')).json(),
    );
    expect(oauth.searchCalls.map((c) => c.pageToken)).toEqual([undefined, 'g2', 'g3']);
    expect(first.entries.map((e) => e.id)).toEqual(['h1']);
    expect(first.partial).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    // The wire cursor is sealed: it must not expose Google's token or the state JSON.
    const sealed = first.nextCursor!.split('.')[1]!;
    const padded = sealed.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(sealed.length / 4) * 4, '=');
    expect(atob(padded)).not.toContain('g4');

    const second = SearchPageSchema.parse(
      await (
        await api(
          app,
          `/api/v1/mounts/m-my/search?q=alpha&scope=drive&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json(),
    );
    expect(oauth.searchCalls.at(-1)!.pageToken).toBe('g4');
    expect(second.entries.map((e) => e.id)).toEqual(['h2']);
    expect(second.partial).toBeUndefined();
    expect(second.nextCursor).toBeUndefined();
  });

  it('returns at most 50 hits and resumes inside the Google page without losing hits', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    const hits = Array.from({ length: 60 }, (_, i) => entry({ id: `hit-${i}`, parents: [MY_ROOT] }));
    oauth.searches.set(`${MY_ROOT}|many||`, { entries: hits, nextPageToken: 'g2' });
    oauth.searches.set(`${MY_ROOT}|many||g2`, { entries: [entry({ id: 'hit-60', parents: ['dirA'] })] });
    const app = makeApp({ oauth });
    const first = SearchPageSchema.parse(
      await (await api(app, '/api/v1/mounts/m-my/search?q=many&scope=drive')).json(),
    );
    expect(first.entries).toHaveLength(50);
    expect(first.entries.at(-1)!.id).toBe('hit-49');
    expect(first.partial).toBe(true);
    const second = SearchPageSchema.parse(
      await (
        await api(
          app,
          `/api/v1/mounts/m-my/search?q=many&scope=drive&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json(),
    );
    expect(second.entries.map((e) => e.id)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `hit-${50 + i}`),
      'hit-60',
    ]);
    expect(second.partial).toBeUndefined();
    expect(oauth.searchCalls.map((c) => c.pageToken)).toEqual([undefined, undefined, 'g2']);
  });

  it('rejects a cursor minted for another mount or another query', async () => {
    await seedMyDriveMount('m-my2', MY_ROOT_2);
    await seedGrant('user-1', 'm-my2', 'viewer');
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    oauth.searches.set(`${MY_ROOT}|budget||`, {
      entries: [entry({ id: 'h1', parents: [MY_ROOT] })],
      nextPageToken: 'g2',
    });
    // The collector keeps reading while Google pages remain: two more empty
    // pages reach the 3-page cap with a live continuation, minting a real
    // sealed cursor for the cross-mount/cross-query rejection below.
    oauth.searches.set(`${MY_ROOT}|budget||g2`, { entries: [], nextPageToken: 'g3' });
    oauth.searches.set(`${MY_ROOT}|budget||g3`, { entries: [], nextPageToken: 'g4' });
    const app = makeApp({ oauth });
    const first = SearchPageSchema.parse(
      await (await api(app, '/api/v1/mounts/m-my/search?q=budget&scope=drive')).json(),
    );
    const cursor = encodeURIComponent(first.nextCursor!);
    const callsBefore = oauth.searchCalls.length;
    const otherMount = await api(app, `/api/v1/mounts/m-my2/search?q=budget&scope=drive&cursor=${cursor}`);
    expect(otherMount.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await otherMount.json()).error.code).toBe('VALIDATION_FAILED');
    const otherQuery = await api(app, `/api/v1/mounts/m-my/search?q=other&scope=drive&cursor=${cursor}`);
    expect(otherQuery.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await otherQuery.json()).error.code).toBe('VALIDATION_FAILED');
    expect(oauth.searchCalls.length).toBe(callsBefore);
  });

  it('fails closed (not 200) when a hit ancestor lookup fails upstream', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    oauth.metas.set('dirA', new DriveError('upstream-unavailable', 'boom'));
    oauth.searches.set(`${MY_ROOT}|x||`, { entries: [entry({ id: 'h1', parents: ['dirA'] })] });
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-my/search?q=x&scope=drive');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('keeps scope=folder search on the provider path without filtering or partial', async () => {
    const oauth = new FakeOAuthProvider();
    seedMyTree(oauth);
    oauth.searches.set(`${MY_ROOT}|x|dirA|`, {
      entries: [entry({ id: 'f1' })], // no parents: contained by construction in a proven folder
      nextPageToken: 'g2',
    });
    const res = await api(
      makeApp({ oauth }),
      '/api/v1/mounts/m-my/search?q=x&scope=folder&folderId=dirA',
    );
    expect(res.status).toBe(200);
    const page = SearchPageSchema.parse(await res.json());
    expect(page.entries.map((e) => e.id)).toEqual(['f1']);
    expect(page.nextCursor).toBeTruthy();
    expect(page.partial).toBeUndefined();
    expect(oauth.searchCalls[0]!.searchScope).toBe('folder');
    expect(oauth.searchCalls[0]!.folderId).toBe('dirA');
    expect(oauth.searchCalls[0]!.pageSize).toBeUndefined();
  });
});

describe('Shared Drive mount: whole-drive search is unchanged', () => {
  it('makes one provider call, no pageSize override, no partial flag', async () => {
    await seedMount('m-a');
    await seedGrant('user-1', 'm-a', 'viewer');
    const oauth = new FakeOAuthProvider();
    oauth.searches.set(`${DRIVE_A}|budget||`, {
      entries: [entry({ id: 'f-9', name: 'budget 2026.xlsx' })],
      nextPageToken: 'g2',
    });
    const res = await api(makeApp({ oauth }), '/api/v1/mounts/m-a/search?q=budget&scope=drive');
    expect(res.status).toBe(200);
    const page = SearchPageSchema.parse(await res.json());
    expect(page.entries.map((e) => e.id)).toEqual(['f-9']);
    expect(page.nextCursor).toBeTruthy();
    expect(page.partial).toBeUndefined();
    expect(oauth.searchCalls).toHaveLength(1);
    expect(oauth.searchCalls[0]!.pageSize).toBeUndefined();
    expect(oauth.searchCalls[0]!.scope.driveId).toBe(DRIVE_A);
    expect(oauth.metadataCalls).toHaveLength(0);
  });
});
