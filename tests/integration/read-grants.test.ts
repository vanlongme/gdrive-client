import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema } from '../../src/shared/contracts/common';
import { MountAdminViewSchema } from '../../src/shared/contracts/admin';
import {
  ReadGrantProbeResponseSchema,
  ReadGrantsSyncResponseSchema,
  type ReadGrantsSyncResponse,
} from '../../src/shared/contracts/read-grants';
import { createAdminRouter, type AdminIdentity } from '../../src/worker/admin/routes';
import { createReadGrantsRouter } from '../../src/worker/admin/read-grants-routes';
import { getAuthInstance } from '../../src/worker/auth/session';
import { DriveError } from '../../src/worker/drive/errors';
import type {
  CreateReaderPermissionInput,
  DeletePermissionInput,
  DrivePermission,
  DrivePermissionsProvider,
  ListPermissionsInput,
  PermissionsPage,
} from '../../src/worker/drive/permissions';
import type {
  DriveFileMeta,
  ReadMetadataInput,
  ServiceAccountContentReadProvider,
} from '../../src/worker/drive/types';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const worker = exports.default;
const ORIGIN = 'http://worker.test';
const CANONICAL_ORIGIN = 'https://worker.test';
const SETUP_TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ROOT_FOLDER = 'folder-root-1';
const SHARED_DRIVE = '0AAAshared-drive';

// ---------------------------------------------------------------------------
// In-memory Drive double for the OAuth permissions adapter. Records every
// call with the writer connection it used and enforces nothing the real
// transport would not (the pinned body/query rules are covered in
// permissions.test.ts).
// ---------------------------------------------------------------------------

class FakeDrive implements DrivePermissionsProvider {
  readonly perms: DrivePermission[] = [];
  readonly lists: ListPermissionsInput[] = [];
  /** Every create attempt, including ones answered with an injected error. */
  readonly creates: CreateReaderPermissionInput[] = [];
  readonly deletes: DeletePermissionInput[] = [];
  /** Per-address failure for createReaderPermission. */
  readonly createFailures = new Map<string, DriveError>();
  /** The create attempt with this 1-based number answers a sharing rate limit once. */
  rateLimitAtAttempt: number | undefined;
  rateLimitRetryAfterMs: number | undefined;
  private seq = 0;
  pageSize = 100;

  /** A permission that exists on Drive without this app (manual share). */
  addForeign(emailAddress: string, role = 'reader'): DrivePermission {
    const perm: DrivePermission = { id: `foreign-${++this.seq}`, type: 'user', role, emailAddress };
    this.perms.push(perm);
    return perm;
  }

  listPermissions(input: ListPermissionsInput): Promise<PermissionsPage> {
    this.lists.push(input);
    const offset = input.pageToken === undefined ? 0 : Number(input.pageToken);
    const next = offset + this.pageSize;
    return Promise.resolve({
      permissions: this.perms.slice(offset, next).map((p) => ({ ...p })),
      ...(next < this.perms.length ? { nextPageToken: String(next) } : {}),
    });
  }

  createReaderPermission(input: CreateReaderPermissionInput): Promise<{ id: string }> {
    this.creates.push(input);
    if (this.rateLimitAtAttempt === this.creates.length) {
      this.rateLimitAtAttempt = undefined;
      return Promise.reject(
        new DriveError('permission-denied', 'sharing limit', {
          status: 403,
          googleReasons: ['sharingRateLimitExceeded'],
          ...(this.rateLimitRetryAfterMs === undefined
            ? {}
            : { retryAfterMs: this.rateLimitRetryAfterMs }),
        }),
      );
    }
    const failure = this.createFailures.get(input.emailAddress);
    if (failure !== undefined) return Promise.reject(failure);
    const perm: DrivePermission = {
      id: `app-${++this.seq}`,
      type: 'user',
      role: 'reader',
      emailAddress: input.emailAddress,
    };
    this.perms.push(perm);
    return Promise.resolve({ id: perm.id });
  }

  deletePermission(input: DeletePermissionInput): Promise<void> {
    this.deletes.push(input);
    const index = this.perms.findIndex((p) => p.id === input.permissionId);
    if (index < 0) {
      return Promise.reject(new DriveError('not-found', 'gone', { status: 404 }));
    }
    this.perms.splice(index, 1);
    return Promise.resolve();
  }

  emails(): string[] {
    return this.perms.map((p) => p.emailAddress ?? '');
  }
}

class FakeSaProvider implements ServiceAccountContentReadProvider {
  readonly reads: ReadMetadataInput[] = [];
  failure: DriveError | undefined;
  async getReadMetadata(input: ReadMetadataInput): Promise<DriveFileMeta> {
    this.reads.push(input);
    if (this.failure !== undefined) throw this.failure;
    return { id: input.ref.id, name: 'Mounted', mimeType: 'application/vnd.google-apps.folder', hasThumbnail: false };
  }
  getRevision(): never {
    throw new Error('not used');
  }
  openContent(): never {
    throw new Error('not used');
  }
  openThumbnail(): never {
    throw new Error('not used');
  }
  exportDocument(): never {
    throw new Error('not used');
  }
}

// ---------------------------------------------------------------------------
// D1 seeding
// ---------------------------------------------------------------------------

async function resetState() {
  for (const table of [
    'mount_drive_permissions',
    'mount_grants',
    'mount_read_credentials',
    'file_readiness',
    'containment_verdicts',
    'file_metadata_cache', 'file_metadata_tombstones',
    'mounts',
    'audit_events',
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

async function seedConnection(id: string) {
  await env.DB.prepare(
    'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0)',
  )
    .bind(`oc-${id}`, 'proj-1', `client-${id}`, 'envelope', 'https://worker.test/cb')
    .run();
  await env.DB.prepare(
    'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) ' +
      "VALUES (?, ?, 'perm-1', 'op@example.com', NULL, 'https://www.googleapis.com/auth/drive', 'connected', 1, 1, NULL, 0, 0)",
  )
    .bind(id, `oc-${id}`)
    .run();
}

const saId = (n: number) => `sa-${String(n).padStart(2, '0')}`;
const saEmail = (n: number) => `dw-sa-${String(n).padStart(2, '0')}@drive-worker-sa.iam.gserviceaccount.com`;

async function seedServiceAccounts(count: number) {
  for (let n = 1; n <= count; n++) {
    await env.DB.prepare(
      'INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) ' +
        "VALUES (?, 'proj-1', ?, 'k1', 'env', 1, 1, 0, 0)",
    )
      .bind(saId(n), saEmail(n))
      .run();
  }
}

async function seedMount(
  id: string,
  options: { kind: 'my_drive_folder' | 'shared_drive'; pool?: number[] },
) {
  const root = options.kind === 'my_drive_folder' ? ROOT_FOLDER : SHARED_DRIVE;
  await env.DB.prepare(
    'INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, 'conn-c', 'conn-w', 1, 'private', 1, 0, 0)",
  )
    .bind(id, `Mount ${id}`, options.kind === 'my_drive_folder' ? null : SHARED_DRIVE, root)
    .run();
  await setPool(id, options.pool ?? []);
}

async function setPool(mountId: string, pool: number[]) {
  await env.DB.prepare('DELETE FROM mount_read_credentials WHERE mount_id = ?').bind(mountId).run();
  for (const n of pool) {
    await env.DB.prepare(
      'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES (?, ?, 0, 1, 0)',
    )
      .bind(mountId, saId(n))
      .run();
  }
}

interface GrantRowRecord {
  service_account_id: string;
  permission_id: string | null;
  state: string;
  last_error_code: string | null;
}

async function grantRows(mountId: string): Promise<GrantRowRecord[]> {
  const rows = await env.DB.prepare(
    'SELECT service_account_id, permission_id, state, last_error_code FROM mount_drive_permissions WHERE mount_id = ? ORDER BY service_account_id',
  )
    .bind(mountId)
    .all<GrantRowRecord>();
  return rows.results ?? [];
}

// ---------------------------------------------------------------------------
// Fixture app: real routers, injected requireAdmin + Google doubles
// ---------------------------------------------------------------------------

type Admin = AdminIdentity | { status: number; code: string };

function makeApp(deps: { drive?: FakeDrive; sa?: FakeSaProvider; admin?: Admin }) {
  const admin: Admin = deps.admin ?? { userId: 'admin-1', sessionId: 'sess-1' };
  const requireAdmin = async (): Promise<AdminIdentity> => {
    if ('status' in admin) throw { status: admin.status, code: admin.code, message: '' };
    return admin;
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'test-request-id');
    await next();
  });
  app.route(
    '/api/v1/admin',
    createReadGrantsRouter({
      requireAdmin,
      ...(deps.drive === undefined ? {} : { permissions: deps.drive }),
      ...(deps.sa === undefined ? {} : { serviceAccountProvider: deps.sa }),
    }),
  );
  app.route('/api/v1/admin', createAdminRouter({ requireAdmin }));
  return app;
}

function post(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: CANONICAL_ORIGIN },
        body: '{}',
      }),
      env as unknown as Env,
    ),
  );
}

async function sync(app: ReturnType<typeof makeApp>, mountId: string): Promise<ReadGrantsSyncResponse> {
  const res = await post(app, `/api/v1/admin/mounts/${mountId}/read-grants/sync`);
  expect(res.status).toBe(200);
  return ReadGrantsSyncResponseSchema.parse(await res.json());
}

async function syncUntilDone(app: ReturnType<typeof makeApp>, mountId: string, maxCalls = 20) {
  const results: ReadGrantsSyncResponse[] = [];
  for (let call = 0; call < maxCalls; call++) {
    const result = await sync(app, mountId);
    results.push(result);
    if (result.remaining === 0) return results;
  }
  throw new Error('sync did not converge');
}

async function fixtureSeed() {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) " +
      "VALUES (1, 'install-1', 'complete', ?, 1, 0, 0)",
  )
    .bind(CANONICAL_ORIGIN)
    .run();
  await seedConnection('conn-c');
  await seedConnection('conn-w');
  // audit_events.actor_user_id references "user"; the injected admin must exist.
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) ' +
      "VALUES ('admin-1', 'Admin', 'admin-1@example.test', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'admin', 0)",
  ).run();
}

// ===========================================================================

describe('POST /mounts/:id/read-grants/sync', () => {
  it('grants an initial pool of 90 in five calls of at most 20 mutations', async () => {
    await fixtureSeed();
    await seedServiceAccounts(90);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: Array.from({ length: 90 }, (_, i) => i + 1) });
    const drive = new FakeDrive();
    const app = makeApp({ drive });

    const results: ReadGrantsSyncResponse[] = [];
    const createsAfterEachCall: number[] = [];
    for (let call = 0; call < 5; call++) {
      results.push(await sync(app, 'm-1'));
      createsAfterEachCall.push(drive.creates.length);
    }
    expect(results.map((r) => r.remaining)).toEqual([70, 50, 30, 10, 0]);
    expect(createsAfterEachCall).toEqual([20, 40, 60, 80, 90]);
    expect(results[4]).toMatchObject({ ready: 90, total: 90 });
    expect(results[4]?.retryAfterSeconds).toBeUndefined();
    expect(results[0]).toMatchObject({ ready: 20, total: 90 });

    // Every grant targets the mount root with the stored address, through the WRITE connection.
    expect(new Set(drive.creates.map((c) => c.emailAddress)).size).toBe(90);
    for (const call of drive.creates) {
      expect(call.fileId).toBe(ROOT_FOLDER);
      expect(call.writer.connectionId).toBe('conn-w');
    }
    expect(drive.emails().sort()).toEqual(Array.from({ length: 90 }, (_, i) => saEmail(i + 1)).sort());
    const rows = await grantRows('m-1');
    expect(rows).toHaveLength(90);
    expect(rows.every((r) => r.state === 'granted' && r.permission_id !== null && r.last_error_code === null)).toBe(true);

    // The DTO carries ids, states and codes only: no address or permission id.
    const body = JSON.stringify(results);
    expect(body).not.toContain('@');
    expect(body).not.toContain('app-');

    // A converged pool is a no-op: one list call, no mutation.
    const before = drive.creates.length;
    const idle = await sync(app, 'm-1');
    expect(idle).toMatchObject({ remaining: 0, ready: 90, total: 90 });
    expect(drive.creates.length).toBe(before);
    expect(drive.deletes).toHaveLength(0);

    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE operation = 'admin.mount.read-grants.sync'").first<{ n: number }>();
    expect(audit?.n).toBe(6);
  });

  it('pages through the live permission list', async () => {
    await fixtureSeed();
    await seedServiceAccounts(5);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2, 3, 4, 5] });
    const drive = new FakeDrive();
    drive.pageSize = 2;
    for (let n = 1; n <= 5; n++) drive.addForeign(saEmail(n));
    const app = makeApp({ drive });
    const result = await sync(app, 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 5, total: 5 });
    expect(drive.lists.map((l) => l.pageToken)).toEqual([undefined, '2', '4']);
    expect(drive.creates).toHaveLength(0);
  });

  it('adopts a permission that is already on Drive instead of creating a duplicate', async () => {
    await fixtureSeed();
    await seedServiceAccounts(3);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2, 3] });
    const drive = new FakeDrive();
    const preShared = drive.addForeign(saEmail(2), 'writer');
    const app = makeApp({ drive });

    const result = await sync(app, 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 3, total: 3 });
    expect(drive.creates.map((c) => c.emailAddress)).toEqual([saEmail(1), saEmail(3)]);
    expect(drive.perms.filter((p) => p.emailAddress === saEmail(2))).toEqual([preShared]);
    const rows = await grantRows('m-1');
    const adopted = rows.find((r) => r.service_account_id === saId(2));
    expect(adopted).toMatchObject({ state: 'granted', permission_id: null });

    // Re-running changes nothing.
    await sync(app, 'm-1');
    expect(drive.creates).toHaveLength(2);
  });

  it('matches addresses case-insensitively when adopting', async () => {
    await fixtureSeed();
    await seedServiceAccounts(1);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1] });
    const drive = new FakeDrive();
    drive.addForeign(saEmail(1).toUpperCase());
    const result = await sync(makeApp({ drive }), 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 1 });
    expect(drive.creates).toHaveLength(0);
  });

  it('deletes only app-created permissions when SAs leave the pool', async () => {
    await fixtureSeed();
    await seedServiceAccounts(4);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2, 3, 4] });
    const drive = new FakeDrive();
    const preShared = drive.addForeign(saEmail(3)); // adopted, not app-created
    const friend = drive.addForeign('friend@example.test'); // unrelated share
    const app = makeApp({ drive });
    await syncUntilDone(app, 'm-1');
    const appCreatedForSa1 = drive.perms.find((p) => p.emailAddress === saEmail(1));
    expect(appCreatedForSa1?.id).toMatch(/^app-/);

    // Remove SA 1 (app-created) and SA 3 (adopted) from the pool.
    await setPool('m-1', [2, 4]);
    const result = await sync(app, 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 2, total: 2 });
    expect(result.grants.map((g) => g.serviceAccountId)).toEqual([saId(2), saId(4)]);
    expect(drive.deletes.map((d) => d.permissionId)).toEqual([appCreatedForSa1?.id]);
    for (const d of drive.deletes) {
      expect(d.fileId).toBe(ROOT_FOLDER);
      expect(d.writer.connectionId).toBe('conn-w');
    }
    expect(drive.perms).toContainEqual(preShared);
    expect(drive.perms).toContainEqual(friend);
    expect(drive.perms.some((p) => p.emailAddress === saEmail(1))).toBe(false);
    expect((await grantRows('m-1')).map((r) => r.service_account_id)).toEqual([saId(2), saId(4)]);
  });

  it('never deletes a permission whose id the app did not record', async () => {
    await fixtureSeed();
    await seedServiceAccounts(2);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2] });
    const drive = new FakeDrive();
    const app = makeApp({ drive });
    await syncUntilDone(app, 'm-1');
    // Someone re-shares SA 1 by hand under a new permission id after the app's grant vanished.
    const original = drive.perms.find((p) => p.emailAddress === saEmail(1));
    drive.perms.splice(drive.perms.indexOf(original as DrivePermission), 1);
    const manual = drive.addForeign(saEmail(1));
    await sync(app, 'm-1');
    expect(drive.creates.filter((c) => c.emailAddress === saEmail(1))).toHaveLength(1);
    expect((await grantRows('m-1')).find((r) => r.service_account_id === saId(1))).toMatchObject({ state: 'granted', permission_id: null });

    await setPool('m-1', [2]);
    await sync(app, 'm-1');
    expect(drive.deletes).toHaveLength(0);
    expect(drive.perms).toContainEqual(manual);
  });

  it('keeps the recorded app-created id when a manual share for the same SA is also live', async () => {
    await fixtureSeed();
    await seedServiceAccounts(2);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2] });
    const drive = new FakeDrive();
    const app = makeApp({ drive });
    await syncUntilDone(app, 'm-1');
    const appCreated = drive.perms.find((p) => p.emailAddress === saEmail(1));
    expect(appCreated?.id).toMatch(/^app-/);

    // An operator shares the same SA by hand; the foreign permission now sits
    // ahead of the app-created one, so the email lookup picks it.
    const manual = drive.addForeign(saEmail(1));
    drive.perms.unshift(drive.perms.splice(drive.perms.indexOf(manual), 1)[0] as DrivePermission);

    const result = await sync(app, 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 2 });
    expect(drive.creates.filter((c) => c.emailAddress === saEmail(1))).toHaveLength(1);
    expect((await grantRows('m-1')).find((r) => r.service_account_id === saId(1))).toMatchObject({
      state: 'granted',
      permission_id: appCreated?.id,
    });
  });

  it('deletes the app-created permission, not the foreign one, when the SA leaves the pool', async () => {
    await fixtureSeed();
    await seedServiceAccounts(2);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2] });
    const drive = new FakeDrive();
    const app = makeApp({ drive });
    await syncUntilDone(app, 'm-1');
    const appCreated = drive.perms.find((p) => p.emailAddress === saEmail(1)) as DrivePermission;
    const manual = drive.addForeign(saEmail(1));
    drive.perms.unshift(drive.perms.splice(drive.perms.indexOf(manual), 1)[0] as DrivePermission);
    await sync(app, 'm-1');

    await setPool('m-1', [2]);
    const result = await sync(app, 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 1, total: 1 });
    expect(drive.deletes.map((d) => d.permissionId)).toEqual([appCreated.id]);
    expect(drive.perms).toContainEqual(manual);
    expect(drive.perms).not.toContainEqual(appCreated);
    expect((await grantRows('m-1')).map((r) => r.service_account_id)).toEqual([saId(2)]);
  });

  it('clears the recorded id and adopts the foreign share once the app-created one is gone', async () => {
    await fixtureSeed();
    await seedServiceAccounts(1);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1] });
    const drive = new FakeDrive();
    const app = makeApp({ drive });
    await syncUntilDone(app, 'm-1');
    const stale = drive.perms.find((p) => p.emailAddress === saEmail(1)) as DrivePermission;
    drive.perms.splice(drive.perms.indexOf(stale), 1);
    drive.addForeign(saEmail(1));

    const result = await sync(app, 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 1 });
    expect(drive.creates.filter((c) => c.emailAddress === saEmail(1))).toHaveLength(1);
    expect((await grantRows('m-1'))[0]).toMatchObject({ state: 'granted', permission_id: null });
  });

  it('records a lost create answer: a pending row finds its permission and keeps the id', async () => {
    await fixtureSeed();
    await seedServiceAccounts(2);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2] });
    await env.DB.prepare(
      "INSERT INTO mount_drive_permissions (mount_id, service_account_id, permission_id, state, last_error_code, updated_at) VALUES ('m-1', ?, NULL, 'pending', NULL, 0)",
    )
      .bind(saId(1))
      .run();
    const drive = new FakeDrive();
    const created = drive.addForeign(saEmail(1)); // the create reached Drive, the reply was lost
    const app = makeApp({ drive });
    const result = await sync(app, 'm-1');
    expect(result).toMatchObject({ remaining: 0, ready: 2 });
    expect(drive.creates.map((c) => c.emailAddress)).toEqual([saEmail(2)]);
    expect((await grantRows('m-1')).find((r) => r.service_account_id === saId(1))).toMatchObject({
      state: 'granted',
      permission_id: created.id,
    });

    await setPool('m-1', [2]);
    await sync(app, 'm-1');
    expect(drive.deletes.map((d) => d.permissionId)).toEqual([created.id]);
  });

  it('stops on a sharing rate limit with Retry-After and resumes without duplicates', async () => {
    await fixtureSeed();
    await seedServiceAccounts(30);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: Array.from({ length: 30 }, (_, i) => i + 1) });
    const drive = new FakeDrive();
    drive.rateLimitAtAttempt = 5;
    drive.rateLimitRetryAfterMs = 45_000;
    const app = makeApp({ drive });

    const first = await sync(app, 'm-1');
    expect(first.retryAfterSeconds).toBe(45);
    expect(first.ready).toBe(4);
    expect(first.remaining).toBe(26);
    expect(drive.creates).toHaveLength(5); // the call stopped at the throttled attempt
    const throttled = first.grants.find((g) => g.serviceAccountId === saId(5));
    expect(throttled).toEqual({ serviceAccountId: saId(5), state: 'pending', errorCode: 'grant:rate_limited' });
    expect(first.grants.find((g) => g.serviceAccountId === saId(6))).toEqual({ serviceAccountId: saId(6), state: 'pending' });
    expect((await grantRows('m-1')).find((r) => r.service_account_id === saId(5))).toMatchObject({ state: 'pending', last_error_code: 'grant:rate_limited' });

    const rest = await syncUntilDone(app, 'm-1');
    expect(rest.map((r) => r.remaining)).toEqual([6, 0]);
    expect(rest.every((r) => r.retryAfterSeconds === undefined)).toBe(true);
    expect(rest[rest.length - 1]).toMatchObject({ ready: 30, total: 30 });
    expect(drive.perms).toHaveLength(30);
    expect(new Set(drive.emails()).size).toBe(30);
    expect(drive.creates).toHaveLength(31); // 30 grants + the one throttled attempt, no duplicates
    expect((await grantRows('m-1')).find((r) => r.service_account_id === saId(5))).toMatchObject({ state: 'granted', last_error_code: null });
  });

  it('defaults Retry-After to 30 seconds', async () => {
    await fixtureSeed();
    await seedServiceAccounts(2);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2] });
    const drive = new FakeDrive();
    drive.rateLimitAtAttempt = 1;
    const result = await sync(makeApp({ drive }), 'm-1');
    expect(result).toMatchObject({ retryAfterSeconds: 30, ready: 0, remaining: 2 });
  });

  it('marks other failures with stable codes, keeps going and retries them last', async () => {
    await fixtureSeed();
    await seedServiceAccounts(4);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2, 3, 4] });
    const drive = new FakeDrive();
    drive.createFailures.set(
      saEmail(2),
      new DriveError('invalid-request', 'Google says: no such account', { status: 400, googleReasons: ['invalidSharingRequest'] }),
    );
    drive.createFailures.set(saEmail(3), new DriveError('permission-denied', 'denied', { status: 403 }));
    const app = makeApp({ drive });

    const first = await sync(app, 'm-1');
    expect(first).toMatchObject({ remaining: 0, ready: 2, total: 4 });
    expect(first.grants).toEqual([
      { serviceAccountId: saId(1), state: 'granted' },
      { serviceAccountId: saId(2), state: 'failed', errorCode: 'grant:invalid_principal' },
      { serviceAccountId: saId(3), state: 'failed', errorCode: 'grant:forbidden' },
      { serviceAccountId: saId(4), state: 'granted' },
    ]);
    expect(JSON.stringify(first)).not.toContain('Google says');

    // A later sync retries failed grants, after fresh work.
    await env.DB.prepare('DELETE FROM mount_drive_permissions WHERE mount_id = ? AND service_account_id = ?').bind('m-1', saId(4)).run();
    drive.perms.splice(drive.perms.findIndex((p) => p.emailAddress === saEmail(4)), 1);
    drive.creates.length = 0;
    const second = await sync(app, 'm-1');
    expect(drive.creates.map((c) => c.emailAddress)).toEqual([saEmail(4), saEmail(2), saEmail(3)]);
    expect(second).toMatchObject({ remaining: 0, ready: 2 });
  });

  it('turns a failed grant into an adoption once the permission shows up on Drive', async () => {
    await fixtureSeed();
    await seedServiceAccounts(1);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1] });
    const drive = new FakeDrive();
    drive.createFailures.set(saEmail(1), new DriveError('permission-denied', 'denied', { status: 403 }));
    const app = makeApp({ drive });
    expect((await sync(app, 'm-1')).grants[0]).toMatchObject({ state: 'failed', errorCode: 'grant:forbidden' });
    drive.addForeign(saEmail(1));
    const healed = await sync(app, 'm-1');
    expect(healed).toMatchObject({ ready: 1, remaining: 0 });
    expect((await grantRows('m-1'))[0]).toMatchObject({ state: 'granted', permission_id: null, last_error_code: null });
  });

  it('surfaces an unusable writer connection as a request error, not a row failure', async () => {
    await fixtureSeed();
    await seedServiceAccounts(1);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1] });
    const drive = new FakeDrive();
    drive.createFailures.set(saEmail(1), new DriveError('unauthorized', 'token rejected', { status: 401 }));
    const res = await post(makeApp({ drive }), '/api/v1/admin/mounts/m-1/read-grants/sync');
    expect(res.status).toBe(502);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('GOOGLE_REAUTH_REQUIRED');
  });

  it('answers 409 MOUNT_KIND_UNSUPPORTED for a Shared Drive mount without calling Drive', async () => {
    await fixtureSeed();
    await seedServiceAccounts(1);
    await seedMount('m-sd', { kind: 'shared_drive', pool: [1] });
    const drive = new FakeDrive();
    const app = makeApp({ drive });
    const res = await post(app, '/api/v1/admin/mounts/m-sd/read-grants/sync');
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('MOUNT_KIND_UNSUPPORTED');
    expect(drive.lists).toHaveLength(0);
    expect(drive.creates).toHaveLength(0);
    expect(await grantRows('m-sd')).toHaveLength(0);
  });

  it('answers 404 for an unknown mount', async () => {
    await fixtureSeed();
    const res = await post(makeApp({ drive: new FakeDrive() }), '/api/v1/admin/mounts/nope/read-grants/sync');
    expect(res.status).toBe(404);
  });

  it('rejects callers that are not admins', async () => {
    await fixtureSeed();
    await seedServiceAccounts(1);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1] });
    const drive = new FakeDrive();
    for (const [status, code] of [[403, 'FORBIDDEN'], [401, 'AUTH_REQUIRED']] as const) {
      const app = makeApp({ drive, admin: { status, code } });
      for (const path of ['/api/v1/admin/mounts/m-1/read-grants/sync', `/api/v1/admin/mounts/m-1/read-grants/${saId(1)}/probe`]) {
        const res = await post(app, path);
        expect(res.status, path).toBe(status);
        expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(code);
      }
    }
    expect(drive.lists).toHaveLength(0);
    expect(drive.creates).toHaveLength(0);
  });
});

describe('POST /mounts/:id/read-grants/:serviceAccountId/probe', () => {
  it('reports ok when the SA can read the mount root', async () => {
    await fixtureSeed();
    await seedServiceAccounts(2);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2] });
    const sa = new FakeSaProvider();
    const res = await post(makeApp({ sa }), `/api/v1/admin/mounts/m-1/read-grants/${saId(2)}/probe`);
    expect(res.status).toBe(200);
    expect(ReadGrantProbeResponseSchema.parse(await res.json())).toEqual({ serviceAccountId: saId(2), result: 'ok' });
    expect(sa.reads).toHaveLength(1);
    expect(sa.reads[0]?.ref.id).toBe(ROOT_FOLDER);
    expect(sa.reads[0]?.identity).toMatchObject({ serviceAccountId: saId(2), email: saEmail(2) });
  });

  it('reports grant:not_visible when the SA cannot see the root', async () => {
    await fixtureSeed();
    await seedServiceAccounts(1);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1] });
    for (const failure of [
      new DriveError('not-found', 'x', { status: 404 }),
      new DriveError('permission-denied', 'x', { status: 403 }),
    ]) {
      const sa = new FakeSaProvider();
      sa.failure = failure;
      const res = await post(makeApp({ sa }), `/api/v1/admin/mounts/m-1/read-grants/${saId(1)}/probe`);
      expect(res.status).toBe(200);
      expect(ReadGrantProbeResponseSchema.parse(await res.json())).toEqual({
        serviceAccountId: saId(1),
        result: 'grant:not_visible',
      });
    }
  });

  it('surfaces SA outages as request errors and rejects unknown pool members and Shared Drive mounts', async () => {
    await fixtureSeed();
    await seedServiceAccounts(2);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1] });
    await seedMount('m-sd', { kind: 'shared_drive', pool: [1] });
    const sa = new FakeSaProvider();
    sa.failure = new DriveError('credential-disabled', 'disabled');
    const app = makeApp({ sa });
    const outage = await post(app, `/api/v1/admin/mounts/m-1/read-grants/${saId(1)}/probe`);
    expect(outage.status).toBe(502);
    expect(ApiErrorBodySchema.parse(await outage.json()).error.code).toBe('READ_PROVIDER_UNAVAILABLE');

    expect((await post(app, `/api/v1/admin/mounts/m-1/read-grants/${saId(2)}/probe`)).status).toBe(404);
    const shared = await post(app, `/api/v1/admin/mounts/m-sd/read-grants/${saId(1)}/probe`);
    expect(shared.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await shared.json()).error.code).toBe('MOUNT_KIND_UNSUPPORTED');
  });
});

describe('admin mount view', () => {
  it('exposes readGrants {ready,total} for My Drive mounts only', async () => {
    await fixtureSeed();
    await seedServiceAccounts(3);
    await seedMount('m-1', { kind: 'my_drive_folder', pool: [1, 2, 3] });
    await seedMount('m-sd', { kind: 'shared_drive', pool: [1] });
    const drive = new FakeDrive();
    drive.addForeign(saEmail(1));
    const app = makeApp({ drive });
    await sync(app, 'm-1');

    const view = async (id: string) => {
      const res = await Promise.resolve(app.fetch(new Request(`${ORIGIN}/api/v1/admin/mounts/${id}`), env as unknown as Env));
      expect(res.status).toBe(200);
      return MountAdminViewSchema.parse(((await res.json()) as { mount: unknown }).mount);
    };
    expect((await view('m-1')).readGrants).toEqual({ ready: 3, total: 3 });
    expect('readGrants' in (await view('m-sd'))).toBe(false);

    await setPool('m-1', [1, 2, 3]);
    await env.DB.prepare("UPDATE mount_drive_permissions SET state = 'failed' WHERE service_account_id = ?").bind(saId(2)).run();
    expect((await view('m-1')).readGrants).toEqual({ ready: 2, total: 3 });
  });
});

// ---------------------------------------------------------------------------
// Real worker surface: session, admin role and the mutation origin check.
// ---------------------------------------------------------------------------

describe('read-grants routes on the real surface', () => {
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

  async function cookieFor(email: string, password: string): Promise<string> {
    const res = await api('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const cookie = res.headers.getSetCookie().find((v) => v.includes('session_token='));
    expect(cookie, 'sign-in sets a session cookie').toBeTruthy();
    return (cookie as string).split(';')[0]!;
  }

  it('requires a session, the admin role and a trusted origin', async () => {
    const setup = await api('/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    expect(setup.status).toBe(200);
    const auth = await getAuthInstance(env);
    await auth.api.createUser({
      body: { email: 'plain@example.test', name: 'Plain', password: 'plain-password-123', role: 'user' },
    });
    const plain = await cookieFor('plain@example.test', 'plain-password-123');
    const admin = await cookieFor(ADMIN.email, ADMIN.password);
    const paths = ['/api/v1/admin/mounts/m-1/read-grants/sync', `/api/v1/admin/mounts/m-1/read-grants/${saId(1)}/probe`];

    for (const path of paths) {
      const anonymous = await api(path, { method: 'POST', headers: { origin: CANONICAL_ORIGIN } });
      expect(anonymous.status, `${path} anonymous`).toBe(401);

      const nonAdmin = await api(path, { method: 'POST', headers: { cookie: plain, origin: CANONICAL_ORIGIN } });
      expect(nonAdmin.status, `${path} non-admin`).toBe(403);
      expect(ApiErrorBodySchema.parse(await nonAdmin.json()).error.code).toBe('FORBIDDEN');

      const foreign = await api(path, { method: 'POST', headers: { cookie: admin, origin: 'https://evil.example' } });
      expect(foreign.status, `${path} foreign origin`).toBe(403);
      expect(ApiErrorBodySchema.parse(await foreign.json()).error.code).toBe('ORIGIN_REJECTED');

      // An admin on a trusted origin reaches the handler (unknown mount => 404).
      const reached = await api(path, { method: 'POST', headers: { cookie: admin, origin: CANONICAL_ORIGIN } });
      expect(reached.status, `${path} admin`).toBe(404);
    }
  });
});
