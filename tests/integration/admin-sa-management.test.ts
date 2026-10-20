import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiErrorBodySchema } from '../../src/shared/contracts/common';
import {
  MountAdminViewSchema,
  ServiceAccountBulkResponseSchema,
  ServiceAccountImportResponseSchema,
  ServiceAccountOverviewResponseSchema,
} from '../../src/shared/contracts/admin';
import {
  createAdminRouter,
  type AdminIdentity,
} from '../../src/worker/admin/routes';

/**
 * Wave-10 worker S: SA-management backend — the overview projection, bulk
 * enable/disable, incremental read-pool add/remove and import duplicate
 * detection. Fixture-app tests stub only requireAdmin; the real-surface
 * tests prove the auth gate. Cooldowns are induced through the real
 * ProjectCoordinator DO's /report-failure protocol, never by editing its
 * storage.
 */

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const SETUP_TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ORIGIN = 'http://worker.test';
const CANONICAL_ORIGIN = 'https://worker.test';
const COORDINATOR_ORIGIN = 'https://project-coordinator.internal';

const ADMIN = {
  token: SETUP_TOKEN,
  name: 'Admin',
  email: 'admin@example.test',
  password: 'correct-horse-battery-staple',
  canonicalOrigin: CANONICAL_ORIGIN,
};

function api(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init));
}

async function completeSetup() {
  const res = await api('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  expect(res.status).toBe(200);
}

async function adminCookie(): Promise<string> {
  const res = await api('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
  });
  const cookie = res.headers
    .getSetCookie()
    .find((v) => v.includes('session_token='));
  expect(cookie, 'sign-in sets a session cookie').toBeTruthy();
  return (cookie as string).split(';')[0]!;
}

function postJson(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin: CANONICAL_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

async function resetState() {
  for (const table of [
    'mount_drive_permissions',
    'mount_grants',
    'mount_read_credentials',
    'file_readiness',
    'containment_verdicts',
    'file_metadata_cache',
    'file_metadata_tombstones',
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

// ---------------------------------------------------------------------------
// D1 seeding
// ---------------------------------------------------------------------------

async function seedConnection(id: string) {
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
      `principal-${id}`,
      `${id}@example.com`,
      null,
      'https://www.googleapis.com/auth/drive',
      'connected',
      1,
    )
    .run();
}

/** driveId null seeds a My Drive folder mount (root must differ from drive). */
async function seedMount(
  id: string,
  options: { label?: string; driveId?: string | null; rootFolderId?: string } = {},
) {
  const driveId = options.driveId === undefined ? `drive-${id}` : options.driveId;
  await env.DB.prepare(
    'INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, 0, 0)',
  )
    .bind(
      id,
      options.label ?? `Mount ${id}`,
      driveId,
      options.rootFolderId ?? driveId ?? `folder-${id}`,
      'conn-1',
      'conn-1',
      'private',
    )
    .run();
}

async function seedServiceAccount(
  id: string,
  options: { projectId?: string; email?: string; keyId?: string; enabled?: number } = {},
) {
  await env.DB.prepare(
    'INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0)',
  )
    .bind(
      id,
      options.projectId ?? 'proj-1',
      options.email ?? `${id}@proj-1.iam.gserviceaccount.com`,
      options.keyId ?? 'key-1',
      'envelope',
      options.enabled ?? 1,
    )
    .run();
}

async function seedPoolMember(mountId: string, serviceAccountId: string) {
  await env.DB.prepare(
    'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES (?, ?, 0, 1, 0)',
  )
    .bind(mountId, serviceAccountId)
    .run();
}

/** Bulk seed: `count` SAs named sa-pool-<i>, all members of `mountId`. */
async function seedPoolBlock(mountId: string, count: number) {
  const saValues: string[] = [];
  const memberValues: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `sa-pool-${i}`;
    saValues.push(
      `('${id}','proj-1','${id}@proj-1.iam.gserviceaccount.com','k','env',1,1,0,0)`,
    );
    memberValues.push(`('${mountId}','${id}',0,1,0)`);
  }
  await env.DB.prepare(
    'INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) ' +
      `VALUES ${saValues.join(',')}`,
  ).run();
  await env.DB.prepare(
    'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) ' +
      `VALUES ${memberValues.join(',')}`,
  ).run();
}

async function seedUser(id: string) {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) ' +
      "VALUES (?, ?, ?, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'admin', 0)",
  )
    .bind(id, `User ${id}`, `${id}@example.test`)
    .run();
}

async function seedGrantRow(
  mountId: string,
  serviceAccountId: string,
  state: 'pending' | 'granted' | 'revoking' | 'failed',
) {
  await env.DB.prepare(
    'INSERT INTO mount_drive_permissions (mount_id, service_account_id, permission_id, state, last_error_code, updated_at) ' +
      'VALUES (?, ?, ?, ?, NULL, 0)',
  )
    .bind(mountId, serviceAccountId, state === 'granted' ? 'perm-1' : null, state)
    .run();
}

// ---------------------------------------------------------------------------
// Fixture app: real router + real D1/DO bindings, stubbed admin identity.
// ---------------------------------------------------------------------------

const ADMIN_IDENTITY: AdminIdentity = { userId: 'admin-1', sessionId: 'sess-1' };

function makeFixtureApp(admin: AdminIdentity | { status: number; code: string } = ADMIN_IDENTITY) {
  const requireAdmin = async (): Promise<AdminIdentity> => {
    if ('status' in admin) throw { status: admin.status, code: admin.code, message: '' };
    return admin;
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.route('/api/v1/admin', createAdminRouter({ requireAdmin }));
  return app;
}

function fixtureApi(
  app: Hono<{ Bindings: Env; Variables: { requestId?: string } }>,
  path: string,
  init?: RequestInit,
  envOverride?: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${ORIGIN}${path}`, init),
      (envOverride ?? env) as unknown as Env,
    ),
  );
}

function fixturePost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A D1 binding proxy that counts prepare() calls — proves no N+1. */
function countingDb() {
  let prepareCalls = 0;
  const db = new Proxy(env.DB, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'prepare') {
        return (...args: unknown[]) => {
          prepareCalls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    db,
    get prepareCalls() {
      return prepareCalls;
    },
  };
}

/**
 * A D1 binding whose next batch() is preceded by a concurrent pool write:
 * the read_pool_version moves between the route's snapshot read and its
 * write batch, exactly the interleaving a second admin would produce.
 */
function racingDb(mountId: string) {
  let raced = false;
  const db = new Proxy(env.DB, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await env.DB.prepare(
              'UPDATE mounts SET read_pool_version = read_pool_version + 1 WHERE id = ?',
            )
              .bind(mountId)
              .run();
          }
          return (target.batch as (s: D1PreparedStatement[]) => unknown).call(
            target,
            statements,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return db;
}

function coordinatorStub(projectId: string) {
  return env.PROJECT_COORDINATOR.get(
    env.PROJECT_COORDINATOR.idFromName(projectId),
  );
}

/** Induce a real credential cooldown in the project coordinator. */
async function reportRateLimit(
  projectId: string,
  serviceAccountId: string,
): Promise<void> {
  const res = await coordinatorStub(projectId).fetch(
    `${COORDINATOR_ORIGIN}/report-failure`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identity: {
          provider: 'service_account',
          credentialId: serviceAccountId,
          credentialVersion: 1,
          projectId,
          principalId: `${serviceAccountId}@proj.iam.gserviceaccount.com`,
          scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        },
        report: { kind: 'rate_limit' },
      }),
    },
  );
  expect(res.status).toBe(200);
}

// ===========================================================================
// GET /service-accounts/overview
// ===========================================================================

describe('service account overview', () => {
  it('is admin-only on the real surface', async () => {
    await completeSetup();
    const anon = await api('/api/v1/admin/service-accounts/overview');
    expect(anon.status).toBe(401);
    expect(ApiErrorBodySchema.parse(await anon.json()).error.code).toBe(
      'AUTH_REQUIRED',
    );
  });

  it('lists every SA once with mounts, grant states and cooldown flags', async () => {
    await seedConnection('conn-1');
    await seedMount('m-sd', { label: 'Shared Drive' });
    await seedMount('m-md', { label: 'My Drive', driveId: null });
    await seedServiceAccount('sa-1');
    await seedServiceAccount('sa-2', { projectId: 'proj-cd-w10' });
    await seedServiceAccount('sa-3');
    await seedPoolMember('m-sd', 'sa-1');
    await seedPoolMember('m-md', 'sa-1');
    await seedPoolMember('m-md', 'sa-2');
    await seedGrantRow('m-md', 'sa-1', 'granted');
    await reportRateLimit('proj-cd-w10', 'sa-2');

    const app = makeFixtureApp();
    const res = await fixtureApi(app, '/api/v1/admin/service-accounts/overview');
    expect(res.status).toBe(200);
    const body = ServiceAccountOverviewResponseSchema.parse(await res.json());
    expect(body.serviceAccounts.map((sa) => sa.id)).toEqual([
      'sa-1',
      'sa-2',
      'sa-3',
    ]);

    const sa1 = body.serviceAccounts[0]!;
    expect(sa1.mounts).toEqual([
      { id: 'm-md', label: 'My Drive' },
      { id: 'm-sd', label: 'Shared Drive' },
    ]);
    // Grants only cover My Drive memberships; the Shared Drive pool never
    // produces a grant entry.
    expect(sa1.grants).toEqual([{ mountId: 'm-md', state: 'granted' }]);
    expect(sa1.coolingDown).toBe(false);
    expect(sa1.cooldownUntil).toBeNull();

    const sa2 = body.serviceAccounts[1]!;
    expect(sa2.mounts).toEqual([{ id: 'm-md', label: 'My Drive' }]);
    // In the pool but never synced: no grant row -> 'none'.
    expect(sa2.grants).toEqual([{ mountId: 'm-md', state: 'none' }]);
    expect(sa2.coolingDown).toBe(true);
    expect(sa2.cooldownUntil).not.toBeNull();
    expect(new Date(sa2.cooldownUntil!).getTime()).toBeGreaterThan(Date.now());

    const sa3 = body.serviceAccounts[2]!;
    expect(sa3.mounts).toEqual([]);
    expect(sa3.grants).toEqual([]);
    expect(sa3.coolingDown).toBe(false);
    // No secret material ever surfaces in the projection.
    expect(JSON.stringify(body)).not.toContain('envelope');
  });

  it('reports an unknown cooldown when a project health check fails', async () => {
    await seedServiceAccount('sa-ok', { projectId: 'proj-ok' });
    await seedServiceAccount('sa-bad', { projectId: 'proj-bad' });
    // A coordinator namespace whose proj-bad DO never answers: that project's
    // cooldown is unknown, not falsely "not cooling down" and never a 500.
    const flakyCoordinator = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async () =>
          name === 'proj-bad'
            ? Promise.reject(new Error('DO unreachable'))
            : Promise.resolve(
                new Response(JSON.stringify({ cooldowns: [] }), {
                  headers: { 'content-type': 'application/json' },
                }),
              ),
      }),
    } as unknown as Env['PROJECT_COORDINATOR'];
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/service-accounts/overview',
      undefined,
      { ...env, PROJECT_COORDINATOR: flakyCoordinator },
    );
    expect(res.status).toBe(200);
    const body = ServiceAccountOverviewResponseSchema.parse(await res.json());
    const byId = new Map(body.serviceAccounts.map((sa) => [sa.id, sa]));
    expect(byId.get('sa-ok')?.coolingDown).toBe(false);
    expect(byId.get('sa-bad')?.coolingDown).toBeNull();
    expect(byId.get('sa-bad')?.cooldownUntil).toBeNull();
  });

  it('uses a constant number of D1 queries regardless of SA/mount count', async () => {
    await seedConnection('conn-1');
    await seedMount('m-sd');
    await seedMount('m-md', { driveId: null });
    for (const id of ['sa-1', 'sa-2', 'sa-3', 'sa-4']) {
      await seedServiceAccount(id);
      await seedPoolMember(id === 'sa-4' ? 'm-sd' : 'm-md', id);
    }
    await seedGrantRow('m-md', 'sa-1', 'granted');
    await seedGrantRow('m-md', 'sa-2', 'failed');

    const { db, prepareCalls } = countingDb();
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/service-accounts/overview',
      undefined,
      { ...env, DB: db },
    );
    expect(res.status).toBe(200);
    // 4 SAs across 2 mounts: SAs + memberships + grant rows = 3 prepares.
    // A per-SA lookup loop would need at least 1 + 4 prepares.
    expect(prepareCalls).toBeLessThanOrEqual(3);
  });
});

// ===========================================================================
// POST /service-accounts/bulk
// ===========================================================================

describe('service account bulk enable/disable', () => {
  it('is admin-only on the real surface', async () => {
    await completeSetup();
    const res = await api('/api/v1/admin/service-accounts/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'disable', ids: ['sa-1'] }),
    });
    expect(res.status).toBe(401);
  });

  it('disables many ids with per-id results, version and read-pool bumps', async () => {
    await seedUser('admin-1'); // audit_events.actor_user_id FK target
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedServiceAccount('sa-1');
    await seedServiceAccount('sa-2');
    await seedServiceAccount('sa-3', { enabled: 0 });
    await seedPoolMember('m-a', 'sa-1');

    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/service-accounts/bulk',
      fixturePost({ action: 'disable', ids: ['sa-1', 'sa-2', 'sa-3', 'sa-missing'] }),
    );
    expect(res.status).toBe(200);
    const body = ServiceAccountBulkResponseSchema.parse(await res.json());
    expect(body.results).toHaveLength(4);

    const byId = new Map(body.results.map((r) => [r.id, r]));
    expect(byId.get('sa-1')).toMatchObject({
      ok: true,
      serviceAccount: { enabled: false, version: 2 },
    });
    expect(byId.get('sa-2')).toMatchObject({
      ok: true,
      serviceAccount: { enabled: false, version: 2 },
    });
    // Already disabled: same semantics as the single endpoint — no write, no
    // version bump, still an ok result.
    expect(byId.get('sa-3')).toMatchObject({
      ok: true,
      serviceAccount: { enabled: false, version: 1 },
    });
    // Unknown ids are explicit per-id errors, never silently skipped.
    const missing = byId.get('sa-missing')!;
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.serviceAccount).toBeUndefined();

    // The containing mount's read_pool_version bumped exactly once for the
    // credential change, matching single-endpoint invalidation.
    const mount = await env.DB.prepare(
      'SELECT read_pool_version FROM mounts WHERE id = ?',
    )
      .bind('m-a')
      .first<{ read_pool_version: number }>();
    expect(mount?.read_pool_version).toBe(2);

    const audits = await env.DB.prepare(
      "SELECT target_id, operation FROM audit_events WHERE operation = 'admin.service-account.disable' ORDER BY target_id",
    ).all<{ target_id: string; operation: string }>();
    expect((audits.results ?? []).map((r) => r.target_id)).toEqual([
      'sa-1',
      'sa-2',
      'sa-3',
    ]);
  });

  it('re-enables ids and bumps pool versions on each changed credential', async () => {
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedServiceAccount('sa-1', { enabled: 0 });
    await seedServiceAccount('sa-2', { enabled: 0 });
    await seedPoolMember('m-a', 'sa-1');
    await seedPoolMember('m-a', 'sa-2');

    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/service-accounts/bulk',
      fixturePost({ action: 'enable', ids: ['sa-1', 'sa-2'] }),
    );
    expect(res.status).toBe(200);
    const body = ServiceAccountBulkResponseSchema.parse(await res.json());
    expect(body.results.every((r) => r.ok)).toBe(true);
    // Two changed credentials in one mount: the pool version moves by the
    // per-credential bump semantics of the single endpoint.
    const mount = await env.DB.prepare(
      'SELECT read_pool_version FROM mounts WHERE id = ?',
    )
      .bind('m-a')
      .first<{ read_pool_version: number }>();
    expect(mount?.read_pool_version).toBe(3);
  });

  it('answers with the post-write database state, not the pre-read rows', async () => {
    await seedConnection('conn-1');
    for (const id of ['sa-1', 'sa-2', 'sa-3']) await seedServiceAccount(id);
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/service-accounts/bulk',
      fixturePost({ action: 'disable', ids: ['sa-1', 'sa-2', 'sa-3'] }),
    );
    expect(res.status).toBe(200);
    const body = ServiceAccountBulkResponseSchema.parse(await res.json());
    // Every reported view equals the row as it stands after the write.
    for (const result of body.results) {
      expect(result.ok).toBe(true);
      const row = await env.DB.prepare(
        'SELECT enabled, version FROM service_accounts WHERE id = ?',
      )
        .bind(result.id)
        .first<{ enabled: number; version: number }>();
      expect(result.serviceAccount?.enabled).toBe(row?.enabled === 1);
      expect(result.serviceAccount?.version).toBe(row?.version);
    }
  });

  it('rejects malformed payloads and honours the 200-id cap', async () => {
    const app = makeFixtureApp();
    for (const body of [
      { action: 'bogus', ids: ['sa-1'] },
      { action: 'disable', ids: [] },
      { action: 'disable', ids: Array.from({ length: 201 }, (_, i) => `sa-${i}`) },
      { action: 'disable' },
      { action: 'disable', ids: ['sa-1'], extra: true },
    ]) {
      const res = await fixtureApi(
        app,
        '/api/v1/admin/service-accounts/bulk',
        fixturePost(body),
      );
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });
});

// ===========================================================================
// POST /mounts/:id/read-pool/add and /remove
// ===========================================================================

describe('read-pool add/remove', () => {
  it('adds members atomically with a single readPoolVersion bump', async () => {
    await seedUser('admin-1'); // audit_events.actor_user_id FK target
    await seedConnection('conn-1');
    await seedMount('m-a');
    for (const id of ['sa-1', 'sa-2', 'sa-3']) await seedServiceAccount(id);
    const app = makeFixtureApp();

    const res = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-1', 'sa-2'] }),
    );
    expect(res.status).toBe(200);
    const { mount } = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await res.json());
    expect(mount.readPool.map((sa) => sa.id).sort()).toEqual(['sa-1', 'sa-2']);
    expect(mount.readPoolVersion).toBe(2);

    // Adding an existing member plus a new one: no duplicate row, one bump.
    const again = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-2', 'sa-3'] }),
    );
    expect(again.status).toBe(200);
    const after = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await again.json());
    expect(after.mount.readPool.map((sa) => sa.id).sort()).toEqual([
      'sa-1',
      'sa-2',
      'sa-3',
    ]);
    expect(after.mount.readPoolVersion).toBe(3);

    const audit = await env.DB.prepare(
      "SELECT operation FROM audit_events WHERE operation = 'admin.mount.read-pool.add'",
    ).all<{ operation: string }>();
    expect(audit.results ?? []).toHaveLength(2);
  });

  it('fails the whole add when an id does not exist', async () => {
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedServiceAccount('sa-1');
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-1', 'sa-missing'] }),
    );
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
    const pool = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM mount_read_credentials WHERE mount_id = ?',
    )
      .bind('m-a')
      .first<{ n: number }>();
    expect(pool?.n).toBe(0);
    const mount = await env.DB.prepare(
      'SELECT read_pool_version FROM mounts WHERE id = ?',
    )
      .bind('m-a')
      .first<{ read_pool_version: number }>();
    expect(mount?.read_pool_version).toBe(1);
  });

  it('removes members atomically', async () => {
    await seedConnection('conn-1');
    await seedMount('m-a');
    for (const id of ['sa-1', 'sa-2', 'sa-3']) {
      await seedServiceAccount(id);
      await seedPoolMember('m-a', id);
    }
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/remove',
      fixturePost({ serviceAccountIds: ['sa-2'] }),
    );
    expect(res.status).toBe(200);
    const { mount } = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await res.json());
    expect(mount.readPool.map((sa) => sa.id).sort()).toEqual(['sa-1', 'sa-3']);
    expect(mount.readPoolVersion).toBe(2);

    // Removing an existing-but-not-member id is a valid no-op that still
    // bumps the pool version, matching the PUT's unconditional bump.
    const noop = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/remove',
      fixturePost({ serviceAccountIds: ['sa-2'] }),
    );
    expect(noop.status).toBe(200);
    const again = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await noop.json());
    expect(again.mount.readPool.map((sa) => sa.id).sort()).toEqual([
      'sa-1',
      'sa-3',
    ]);
    expect(again.mount.readPoolVersion).toBe(3);
  });

  it('rejects an add that would push the pool past 100 members', async () => {
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedPoolBlock('m-a', 100);
    await seedServiceAccount('sa-new');
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-new'] }),
    );
    expect(res.status).toBe(400);
    const error = ApiErrorBodySchema.parse(await res.json());
    expect(error.error.code).toBe('VALIDATION_FAILED');
    // Nothing changed: still 100 members and no read-pool version bump.
    const pool = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM mount_read_credentials WHERE mount_id = ?',
    )
      .bind('m-a')
      .first<{ n: number }>();
    expect(pool?.n).toBe(100);
    const mount = await env.DB.prepare(
      'SELECT read_pool_version FROM mounts WHERE id = ?',
    )
      .bind('m-a')
      .first<{ read_pool_version: number }>();
    expect(mount?.read_pool_version).toBe(1);
  });

  it('allows adds up to exactly 100 and does not double-count members', async () => {
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedPoolBlock('m-a', 99);
    await seedServiceAccount('sa-new');
    const app = makeFixtureApp();

    // 99 members + 1 new id + 1 already-member id = still 100: the member id
    // is an ON CONFLICT no-op, not a new seat.
    const res = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-new', 'sa-pool-0'] }),
    );
    expect(res.status).toBe(200);
    const { mount } = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await res.json());
    expect(mount.readPool).toHaveLength(100);

    // One more brand-new id tips it over the cap.
    await seedServiceAccount('sa-one-more');
    const over = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-one-more'] }),
    );
    expect(over.status).toBe(400);
  });

  it('answers 409 and writes nothing when the pool version raced the add', async () => {
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedServiceAccount('sa-1');
    await seedServiceAccount('sa-2');
    const db = racingDb('m-a');
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-1', 'sa-2'] }),
      { ...env, DB: db },
    );
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'READ_POOL_CONFLICT',
    );
    // No seats were taken and no audit was written — the caller reloads
    // and retries against the new version.
    const pool = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM mount_read_credentials WHERE mount_id = ?',
    )
      .bind('m-a')
      .first<{ n: number }>();
    expect(pool?.n).toBe(0);
    // Only the concurrent writer's bump landed.
    const mount = await env.DB.prepare(
      'SELECT read_pool_version FROM mounts WHERE id = ?',
    )
      .bind('m-a')
      .first<{ read_pool_version: number }>();
    expect(mount?.read_pool_version).toBe(2);
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE operation = 'admin.mount.read-pool.add'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(0);
  });

  it('guards remove with the same version check', async () => {
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedServiceAccount('sa-1');
    await seedPoolMember('m-a', 'sa-1');
    const db = racingDb('m-a');
    const app = makeFixtureApp();
    const res = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-a/read-pool/remove',
      fixturePost({ serviceAccountIds: ['sa-1'] }),
      { ...env, DB: db },
    );
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'READ_POOL_CONFLICT',
    );
    // The member row survived and only the concurrent bump landed.
    const pool = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM mount_read_credentials WHERE mount_id = ?',
    )
      .bind('m-a')
      .first<{ n: number }>();
    expect(pool?.n).toBe(1);
    const mount = await env.DB.prepare(
      'SELECT read_pool_version FROM mounts WHERE id = ?',
    )
      .bind('m-a')
      .first<{ read_pool_version: number }>();
    expect(mount?.read_pool_version).toBe(2);
  });

  it('validates the mount, caps and admin requirement', async () => {
    await seedConnection('conn-1');
    const app = makeFixtureApp();
    const missing = await fixtureApi(
      app,
      '/api/v1/admin/mounts/m-missing/read-pool/add',
      fixturePost({ serviceAccountIds: ['sa-1'] }),
    );
    expect(missing.status).toBe(404);

    await seedMount('m-a');
    for (const body of [
      { serviceAccountIds: [] },
      { serviceAccountIds: Array.from({ length: 101 }, (_, i) => `sa-${i}`) },
      {},
    ]) {
      const res = await fixtureApi(
        app,
        '/api/v1/admin/mounts/m-a/read-pool/add',
        fixturePost(body),
      );
      expect(res.status).toBe(400);
    }

    const denied = makeFixtureApp({ status: 403, code: 'FORBIDDEN' });
    const forbidden = await fixtureApi(
      denied,
      '/api/v1/admin/mounts/m-a/read-pool/remove',
      fixturePost({ serviceAccountIds: ['sa-1'] }),
    );
    expect(forbidden.status).toBe(403);
  });
});

// ===========================================================================
// Import duplicate detection (duplicatePolicy 'skip')
// ===========================================================================

let saKeyCounter = 0;
async function generateSaPrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const b of der) binary += String.fromCharCode(b);
  const b64 = btoa(binary).match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function saKeyJsonFor(
  email: string,
  pem: string,
  keyId: string | null,
): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'proj-dup',
    client_email: email,
    private_key: pem,
    ...(keyId === null ? {} : { private_key_id: keyId }),
  });
}

async function validSaKeyJson(email: string, keyId: string): Promise<string> {
  return saKeyJsonFor(email, await generateSaPrivateKeyPem(), keyId);
}

describe('import duplicate detection', () => {
  it('reports duplicate without a write when the same key id is re-imported', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const keyJson = await validSaKeyJson(
      `sa-${++saKeyCounter}@proj-dup.iam.gserviceaccount.com`,
      'key-dup-1',
    );
    const first = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson,
      duplicatePolicy: 'skip',
    });
    expect(first.status).toBe(200);
    const imported = ServiceAccountImportResponseSchema.parse(
      await first.json(),
    );
    expect(imported.outcome).toBe('imported');

    const second = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson,
      duplicatePolicy: 'skip',
    });
    expect(second.status).toBe(200);
    const dup = ServiceAccountImportResponseSchema.parse(await second.json());
    expect(dup.outcome).toBe('duplicate');
    expect(dup.serviceAccount.id).toBe(imported.serviceAccount.id);
    // A skipped duplicate never rotates: version stays 1.
    expect(dup.serviceAccount.version).toBe(1);
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE operation LIKE 'admin.service-account.%'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('answers conflict under skip when the key id differs — never rotates', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const email = `sa-${++saKeyCounter}@proj-dup.iam.gserviceaccount.com`;
    const first = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: await validSaKeyJson(email, 'key-old'),
      duplicatePolicy: 'skip',
    });
    expect(first.status).toBe(200);
    const res = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: await validSaKeyJson(email, 'key-new'),
      duplicatePolicy: 'skip',
    });
    expect(res.status).toBe(200);
    const conflict = ServiceAccountImportResponseSchema.parse(await res.json());
    expect(conflict.outcome).toBe('conflict');
    // Nothing was written: the stored key id and version are untouched.
    expect(conflict.serviceAccount.keyId).toBe('key-old');
    expect(conflict.serviceAccount.version).toBe(1);
    const row = await env.DB.prepare(
      'SELECT key_id, version FROM service_accounts WHERE email = ?',
    )
      .bind(email)
      .first<{ key_id: string; version: number }>();
    expect(row).toEqual({ key_id: 'key-old', version: 1 });
    // Only the original import was audited — a conflict writes nothing.
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE operation LIKE 'admin.service-account.%'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('rotates the key only when rotate policy is explicit', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const email = `sa-${++saKeyCounter}@proj-dup.iam.gserviceaccount.com`;
    await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: await validSaKeyJson(email, 'key-old'),
      duplicatePolicy: 'skip',
    });
    // The conflicted file re-sent with an explicit rotate policy.
    const res = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: await validSaKeyJson(email, 'key-new'),
      duplicatePolicy: 'rotate',
    });
    expect(res.status).toBe(200);
    const rotated = ServiceAccountImportResponseSchema.parse(await res.json());
    expect(rotated.outcome).toBe('rotated');
    expect(rotated.serviceAccount.keyId).toBe('key-new');
    expect(rotated.serviceAccount.version).toBe(2);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE operation = 'admin.service-account.rotate'",
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('compares key-material fingerprints when private_key_id is missing', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const email = `sa-${++saKeyCounter}@proj-dup.iam.gserviceaccount.com`;
    const pem = await generateSaPrivateKeyPem();
    // First import stores the identity with an empty key_id column.
    const first = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: saKeyJsonFor(email, pem, null),
      duplicatePolicy: 'skip',
    });
    expect(first.status).toBe(200);
    expect(
      ServiceAccountImportResponseSchema.parse(await first.json()).outcome,
    ).toBe('imported');

    // The same key material with no key id is a duplicate, never '' === ''.
    const again = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: saKeyJsonFor(email, pem, null),
      duplicatePolicy: 'skip',
    });
    expect(again.status).toBe(200);
    expect(
      ServiceAccountImportResponseSchema.parse(await again.json()).outcome,
    ).toBe('duplicate');

    // Different key material without a key id is a conflict, not a skip and
    // never a silent rotate.
    const other = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: saKeyJsonFor(email, await generateSaPrivateKeyPem(), null),
      duplicatePolicy: 'skip',
    });
    expect(other.status).toBe(200);
    const conflict = ServiceAccountImportResponseSchema.parse(
      await other.json(),
    );
    expect(conflict.outcome).toBe('conflict');
    expect(conflict.serviceAccount.version).toBe(1);
    const row = await env.DB.prepare(
      'SELECT version FROM service_accounts WHERE email = ?',
    )
      .bind(email)
      .first<{ version: number }>();
    expect(row?.version).toBe(1);
  });

  it('fingerprints the stored key when only one side carries a key id', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const email = `sa-${++saKeyCounter}@proj-dup.iam.gserviceaccount.com`;
    const pem = await generateSaPrivateKeyPem();
    // Stored with a key id; the same material re-sent without one matches by
    // fingerprint — the missing id alone never proves a duplicate.
    await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: saKeyJsonFor(email, pem, 'key-stored'),
      duplicatePolicy: 'skip',
    });
    const same = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: saKeyJsonFor(email, pem, null),
      duplicatePolicy: 'skip',
    });
    expect(same.status).toBe(200);
    expect(
      ServiceAccountImportResponseSchema.parse(await same.json()).outcome,
    ).toBe('duplicate');

    const different = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: saKeyJsonFor(email, await generateSaPrivateKeyPem(), null),
      duplicatePolicy: 'skip',
    });
    expect(different.status).toBe(200);
    expect(
      ServiceAccountImportResponseSchema.parse(await different.json()).outcome,
    ).toBe('conflict');
  });

  it('keeps default rotate semantics and reports the outcome', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const email = `sa-${++saKeyCounter}@proj-dup.iam.gserviceaccount.com`;
    const keyJson = await validSaKeyJson(email, 'key-same');
    await postJson('/api/v1/admin/service-accounts', cookie, { keyJson });
    const res = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson,
    });
    expect(res.status).toBe(200);
    const rotated = ServiceAccountImportResponseSchema.parse(await res.json());
    expect(rotated.outcome).toBe('rotated');
    expect(rotated.serviceAccount.version).toBe(2);
  });
});
