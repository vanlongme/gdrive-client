import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DriveFolderListResponseSchema,
} from '../../src/shared/contracts/admin';
import { ApiErrorBodySchema } from '../../src/shared/contracts/common';
import {
  createDriveFolderLister,
  createDriveFoldersRouter,
  type DriveFolderLister,
  type DriveFolderPage,
  type ListOwnedFoldersInput,
} from '../../src/worker/admin/drive-folders-routes';
import type { AdminIdentity } from '../../src/worker/admin/routes';
import { DriveError } from '../../src/worker/drive/errors';
import { createDriveTransport } from '../../src/worker/drive/transport';
import type {
  CoordinatorTokenSource,
  ResolvedWriter,
} from '../../src/worker/drive/types';

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const SETUP_TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ORIGIN = 'http://worker.test';
const CANONICAL_ORIGIN = 'https://worker.test';
const ADMIN = {
  token: SETUP_TOKEN,
  name: 'Admin',
  email: 'admin@example.test',
  password: 'correct-horse-battery-staple',
  canonicalOrigin: CANONICAL_ORIGIN,
};

// ---------------------------------------------------------------------------
// D1 state (copies of the admin.test.ts helpers; they are file-local there)
// ---------------------------------------------------------------------------

async function resetState() {
  for (const table of [
    'mount_drive_permissions',
    'mount_grants',
    'mount_read_credentials',
    'file_readiness',
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
  await resetState();
});

async function seedConnection(
  id: string,
  options: { state?: string; enabled?: number } = {},
) {
  await env.DB.prepare(
    'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0)',
  )
    .bind(`oc-${id}`, 'proj-1', `client-${id}`, 'envelope', 'https://worker.test/cb')
    .run();
  await env.DB.prepare(
    'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, 0)',
  )
    .bind(
      id,
      `oc-${id}`,
      'perm-1',
      'op@example.com',
      null,
      'https://www.googleapis.com/auth/drive',
      options.state ?? 'connected',
      options.enabled ?? 1,
    )
    .run();
}

async function fixtureSeed() {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) ' +
      "VALUES (1, 'install-1', 'complete', ?, 1, 0, 0)",
  )
    .bind(CANONICAL_ORIGIN)
    .run();
  await seedConnection('conn-1');
}

// ---------------------------------------------------------------------------
// Fixture lister + router harness
// ---------------------------------------------------------------------------

class FakeFolderLister implements DriveFolderLister {
  readonly calls: ListOwnedFoldersInput[] = [];
  /** Pages keyed `${parentId}|${pageToken ?? ''}`. */
  pages = new Map<string, DriveFolderPage>();
  error: DriveError | null = null;

  async listOwnedFolders(input: ListOwnedFoldersInput): Promise<DriveFolderPage> {
    this.calls.push(input);
    if (this.error !== null) throw this.error;
    return this.pages.get(`${input.parentId}|${input.pageToken ?? ''}`) ?? { folders: [] };
  }
}

type TestApp = Hono<{ Bindings: Env; Variables: { requestId?: string } }>;

function makeFixtureApp(deps: {
  lister: DriveFolderLister;
  admin?: AdminIdentity | { status: number; code: string };
}): TestApp {
  const admin: AdminIdentity | { status: number; code: string } =
    deps.admin ?? { userId: 'admin-1', sessionId: 'sess-1' };
  const requireAdmin = async (): Promise<AdminIdentity> => {
    if ('status' in admin) throw { status: admin.status, code: admin.code, message: '' };
    return admin;
  };
  const app: TestApp = new Hono();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.route(
    '/api/v1/admin/drive-folders',
    createDriveFoldersRouter({ requireAdmin, folderLister: deps.lister }),
  );
  return app;
}

function fixtureApi(app: TestApp, path: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`${ORIGIN}${path}`), env as unknown as Env),
  );
}

const BASE = '/api/v1/admin/drive-folders';

describe('drive-folders route (fixture lister)', () => {
  it('defaults parentId to root, resolves the connection writer and forwards paging', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    lister.pages.set('root|', {
      folders: [
        { id: 'fold-1', name: 'Photos' },
        { id: 'fold-2', name: 'Báo cáo' },
      ],
      nextPageToken: 'tok-2',
    });
    const res = await fixtureApi(
      makeFixtureApp({ lister }),
      `${BASE}?connectionId=conn-1&pageSize=10`,
    );
    expect(res.status).toBe(200);
    const body = DriveFolderListResponseSchema.parse(await res.json());
    expect(body.folders).toEqual([
      { id: 'fold-1', name: 'Photos' },
      { id: 'fold-2', name: 'Báo cáo' },
    ]);
    expect(body.nextPageToken).toBe('tok-2');
    expect(lister.calls).toHaveLength(1);
    expect(lister.calls[0]!.parentId).toBe('root');
    expect(lister.calls[0]!.writer.connectionId).toBe('conn-1');
    expect(lister.calls[0]!.pageSize).toBe(10);
    expect(lister.calls[0]!.pageToken).toBeUndefined();
  });

  it('passes parentId and the opaque pageToken through; omits nextPageToken on the last page', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    lister.pages.set('fold-1|tok-2', { folders: [{ id: 'fold-3', name: 'Trips' }] });
    const res = await fixtureApi(
      makeFixtureApp({ lister }),
      `${BASE}?connectionId=conn-1&parentId=fold-1&pageToken=tok-2`,
    );
    expect(res.status).toBe(200);
    const raw = (await res.json()) as Record<string, unknown>;
    const body = DriveFolderListResponseSchema.parse(raw);
    expect(body.folders.map((f) => f.id)).toEqual(['fold-3']);
    expect('nextPageToken' in raw).toBe(false);
    expect(lister.calls[0]!.parentId).toBe('fold-1');
    expect(lister.calls[0]!.pageToken).toBe('tok-2');
    expect(lister.calls[0]!.pageSize).toBeUndefined();
  });

  it('rejects a missing connectionId with the shared validation envelope', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    const res = await fixtureApi(makeFixtureApp({ lister }), BASE);
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('VALIDATION_FAILED');
    expect(lister.calls).toHaveLength(0);
  });

  it('rejects parentIds outside the Drive id charset before any provider call', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    const app = makeFixtureApp({ lister });
    const bad = [
      'a%27b', // a'b
      'x%20y', // x y
      'a%2Fb', // a/b
      '..%2Fx', // ../x
      '%27%20or%20%27x', // ' or 'x
      'a%0Ab', // newline
      '', // empty
      'x'.repeat(257), // over the length bound
    ];
    for (const parentId of bad) {
      const res = await fixtureApi(app, `${BASE}?connectionId=conn-1&parentId=${parentId}`);
      expect(res.status, parentId).toBe(400);
      expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('VALIDATION_FAILED');
    }
    expect(lister.calls).toHaveLength(0);
  });

  it('rejects a non-positive, non-integer or oversized pageSize and an oversized pageToken', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    const app = makeFixtureApp({ lister });
    for (const query of [
      'pageSize=0',
      'pageSize=-3',
      'pageSize=abc',
      'pageSize=101',
      `pageToken=${'t'.repeat(2049)}`,
    ]) {
      const res = await fixtureApi(app, `${BASE}?connectionId=conn-1&${query}`);
      expect(res.status, query).toBe(400);
      expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('VALIDATION_FAILED');
    }
    expect(lister.calls).toHaveLength(0);
  });

  it('rejects an unknown connection and never calls the provider', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    const res = await fixtureApi(makeFixtureApp({ lister }), `${BASE}?connectionId=missing`);
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('GOOGLE_CONNECTION_DISABLED');
    expect(lister.calls).toHaveLength(0);
  });

  it('rejects a disabled connection', async () => {
    await fixtureSeed();
    await env.DB.prepare(
      "UPDATE google_connections SET enabled = 0, state = 'disabled' WHERE id = 'conn-1'",
    ).run();
    const lister = new FakeFolderLister();
    const res = await fixtureApi(makeFixtureApp({ lister }), `${BASE}?connectionId=conn-1`);
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('GOOGLE_CONNECTION_DISABLED');
    expect(lister.calls).toHaveLength(0);
  });

  it('maps a needs_reauth connection to GOOGLE_REAUTH_REQUIRED', async () => {
    await fixtureSeed();
    await env.DB.prepare(
      "UPDATE google_connections SET state = 'needs_reauth' WHERE id = 'conn-1'",
    ).run();
    const res = await fixtureApi(
      makeFixtureApp({ lister: new FakeFolderLister() }),
      `${BASE}?connectionId=conn-1`,
    );
    expect(res.status).toBe(502);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('GOOGLE_REAUTH_REQUIRED');
  });

  it('maps lister DriveErrors into the shared error envelope', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    lister.error = new DriveError('rate-limited', 'upstream slow down', { retryAfterMs: 2000 });
    const res = await fixtureApi(makeFixtureApp({ lister }), `${BASE}?connectionId=conn-1`);
    expect(res.status).toBe(429);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.requestId).toBe('test-request-id');
  });

  it('denies non-admin callers before touching the provider', async () => {
    await fixtureSeed();
    const lister = new FakeFolderLister();
    const res = await fixtureApi(
      makeFixtureApp({ lister, admin: { status: 403, code: 'FORBIDDEN' } }),
      `${BASE}?connectionId=conn-1`,
    );
    expect(res.status).toBe(403);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('FORBIDDEN');
    expect(lister.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The real lister against the real transport allowlist (fake fetch only).
// ---------------------------------------------------------------------------

const WRITER: ResolvedWriter = {
  connectionId: 'conn-1',
  principalId: 'perm-1',
  oauthClientId: 'oc-conn-1',
  projectId: 'proj-1',
  connectionVersion: 1,
  oauthClientVersion: 1,
};

const TOKENS: CoordinatorTokenSource = {
  getToken: () =>
    Promise.resolve({ ok: true, accessToken: 'tok-123', expiresAtMs: Date.now() + 60_000 }),
  reportFailure: () => Promise.resolve(),
};

function listerWithFetch(handler: (req: Request) => Response) {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const req = new Request(input, init);
    requests.push(req);
    return Promise.resolve(handler(req));
  };
  const lister = createDriveFolderLister({
    tokenSource: TOKENS,
    transport: createDriveTransport('google_oauth', { fetchImpl }),
  });
  return { lister, requests };
}

const jsonBody = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('createDriveFolderLister', () => {
  it('issues oauth.files.list with the pinned owner/folder query on corpora=user', async () => {
    const { lister, requests } = listerWithFetch(() =>
      jsonBody({ files: [{ id: 'f1', name: 'Photos' }], nextPageToken: 'n2' }),
    );
    const page = await lister.listOwnedFolders({
      writer: WRITER,
      parentId: 'root',
      pageToken: 'p1',
      pageSize: 25,
    });
    expect(page).toEqual({ folders: [{ id: 'f1', name: 'Photos' }], nextPageToken: 'n2' });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe('/drive/v3/files');
    expect(url.searchParams.get('corpora')).toBe('user');
    expect(url.searchParams.get('q')).toBe(
      "'root' in parents and mimeType = 'application/vnd.google-apps.folder' and 'me' in owners and trashed = false",
    );
    expect(url.searchParams.get('fields')).toBe('nextPageToken,files(id,name)');
    expect(url.searchParams.get('pageSize')).toBe('25');
    expect(url.searchParams.get('pageToken')).toBe('p1');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.has('driveId')).toBe(false);
    expect(url.searchParams.has('includeItemsFromAllDrives')).toBe(false);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer tok-123');
    expect(requests[0]!.method).toBe('GET');
  });

  it('refuses a parent id outside the Drive charset without any fetch', async () => {
    const { lister, requests } = listerWithFetch(() => jsonBody({ files: [] }));
    await expect(
      lister.listOwnedFolders({ writer: WRITER, parentId: "x' or name contains 'y" }),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
    expect(requests).toHaveLength(0);
  });

  it('rejects a malformed upstream listing as unexpected-response', async () => {
    for (const body of [{}, { files: [{ id: 'f1' }] }, { files: [{ name: 'x' }] }, { files: 'nope' }]) {
      const { lister } = listerWithFetch(() => jsonBody(body));
      await expect(
        lister.listOwnedFolders({ writer: WRITER, parentId: 'root' }),
      ).rejects.toMatchObject({ reason: 'unexpected-response' });
    }
  });
});

// ---------------------------------------------------------------------------
// Real surface: the router mounted in createApp() (needs the app.ts line).
// ---------------------------------------------------------------------------

function api(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function adminCookie(): Promise<string> {
  const setup = await api('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  expect(setup.status).toBe(200);
  const signIn = await api('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  const cookie = signIn.headers.getSetCookie().find((v) => v.includes('session_token='));
  expect(cookie, 'sign-in sets a session cookie').toBeTruthy();
  return (cookie as string).split(';')[0]!;
}

describe('drive-folders route (real surface)', () => {
  it('denies an unauthenticated caller', async () => {
    await adminCookie(); // completes setup so the gate under test is the admin guard
    const res = await api(`${BASE}?connectionId=conn-1`);
    expect([401, 403]).toContain(res.status);
  });

  it('rejects a missing connectionId and a bad parentId for an admin', async () => {
    const cookie = await adminCookie();
    const missing = await api(BASE, { headers: { cookie } });
    expect(missing.status).toBe(400);
    const bad = await api(`${BASE}?connectionId=conn-1&parentId=a%27b`, { headers: { cookie } });
    expect(bad.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await bad.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown connection', async () => {
    const cookie = await adminCookie();
    const res = await api(`${BASE}?connectionId=missing`, { headers: { cookie } });
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('GOOGLE_CONNECTION_DISABLED');
  });

  it('surfaces honest re-auth when the connection holds no refresh grant', async () => {
    const cookie = await adminCookie();
    await seedConnection('conn-1', { state: 'connected' });
    const res = await api(`${BASE}?connectionId=conn-1`, { headers: { cookie } });
    // The seeded connection has no refresh envelope: token admission must fail
    // closed with the shared envelope, never a fabricated folder list.
    expect(res.status).toBe(502);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('GOOGLE_REAUTH_REQUIRED');
  });
});
