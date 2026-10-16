import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiErrorBodySchema } from '../../src/shared/contracts/common';
import {
  MountAdminViewSchema,
  MountGrantViewSchema,
  OAuthClientViewSchema,
  ProviderHealthViewSchema,
  ServiceAccountViewSchema,
  UserViewSchema,
} from '../../src/shared/contracts/admin';
import { MountListResponseSchema } from '../../src/shared/contracts/drive';
import { createAdminRouter, type AdminIdentity } from '../../src/worker/admin/routes';
import { getAuthInstance } from '../../src/worker/auth/session';
import { DriveError } from '../../src/worker/drive/errors';
import type {
  DriveFileMeta,
  GetMetadataInput,
  OAuthCatalogWriteProvider,
} from '../../src/worker/drive/types';
import type {
  ListSharedDrivesInput,
  SharedDriveLister,
  SharedDrivesPage,
} from '../../src/worker/drive/providers/google-oauth';

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const SETUP_TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ORIGIN = 'http://worker.test';
const CANONICAL_ORIGIN = 'https://worker.test';
const DRIVE_A = '0AAAdrive-aaaa';

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

async function signIn(email: string, password: string): Promise<Response> {
  return api('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

function sessionCookie(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((v) => v.includes('session_token='));
  expect(cookie, 'sign-in sets a session cookie').toBeTruthy();
  return (cookie as string).split(';')[0]!;
}

async function adminCookie(): Promise<string> {
  return sessionCookie(await signIn(ADMIN.email, ADMIN.password));
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
  // Dependents first — FK references run child → parent.
  for (const table of [
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

// ---------------------------------------------------------------------------
// D1 seeding for real-surface tests
// ---------------------------------------------------------------------------

async function seedMount(
  id: string,
  options: { driveId?: string; visibility?: string; catalog?: string; write?: string } = {},
) {
  await env.DB.prepare(
    'INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1, ?, 1, 0, 0)',
  )
    .bind(
      id,
      `Mount ${id}`,
      options.driveId ?? DRIVE_A,
      options.catalog ?? 'conn-1',
      options.write ?? 'conn-1',
      options.visibility ?? 'private',
    )
    .run();
}

async function seedConnection(id: string, options: { state?: string; enabled?: number } = {}) {
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

async function seedUser(
  id: string,
  options: { email?: string; name?: string; role?: string; banned?: number } = {},
) {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) ' +
      'VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
  )
    .bind(
      id,
      options.name ?? `User ${id}`,
      options.email ?? `${id}@example.test`,
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
      options.role ?? 'user',
      options.banned ?? 0,
    )
    .run();
}

let saKeyJsonPromise: Promise<string> | undefined;

/** A real generated PKCS8 RSA key in the Google SA key JSON shape (test-only). */
function validSaKeyJson(): Promise<string> {
  saKeyJsonPromise ??= (async () => {
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
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
    return JSON.stringify({
      type: 'service_account',
      project_id: 'proj-1',
      client_email: 'reader@proj-1.iam.gserviceaccount.com',
      private_key: pem,
      private_key_id: 'key-1',
    });
  })();
  return saKeyJsonPromise;
}

// ===========================================================================
// Real worker surface (exports.default): real session → real requireAdmin →
// real D1/vault. No fixture is needed where routes never call Google.
// ===========================================================================

describe('admin authorization on the real surface', () => {
  it('rejects admin routes without a session', async () => {
    await completeSetup();
    const res = await api('/api/v1/admin/service-accounts');
    expect(res.status).toBe(401);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'AUTH_REQUIRED',
    );
  });

  it('rejects a signed-in non-admin user on every admin route group', async () => {
    await completeSetup();
    const auth = await getAuthInstance(env);
    await auth.api.createUser({
      body: {
        email: 'plain@example.test',
        name: 'Plain',
        password: 'plain-password-123',
        role: 'user',
      },
    });
    const cookie = sessionCookie(await signIn('plain@example.test', 'plain-password-123'));
    for (const path of [
      '/api/v1/admin/service-accounts',
      '/api/v1/admin/mounts',
      '/api/v1/admin/users',
      '/api/v1/admin/provider-health',
    ]) {
      const res = await api(path, { headers: { cookie } });
      expect(res.status, path).toBe(403);
      expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe('FORBIDDEN');
    }
  });
});

describe('service account credential lifecycle (real vault)', () => {
  it('imports an SA key, lists metadata only, rotates in place, disables', async () => {
    await completeSetup();
    const cookie = await adminCookie();

    const created = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: await validSaKeyJson(),
    });
    expect(created.status).toBe(200);
    const { serviceAccount } = z
      .looseObject({ serviceAccount: ServiceAccountViewSchema })
      .parse(await created.json());
    expect(serviceAccount.email).toBe('reader@proj-1.iam.gserviceaccount.com');
    expect(serviceAccount.keyId).toBe('key-1');
    expect(serviceAccount.enabled).toBe(true);
    expect(serviceAccount.version).toBe(1);
    // Envelope/private key must never appear in any response body.
    const raw = JSON.stringify(serviceAccount);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('envelope');
    // But the vault envelope IS stored server-side.
    const row = await env.DB.prepare(
      'SELECT envelope FROM service_accounts WHERE id = ?',
    )
      .bind(serviceAccount.id)
      .first<{ envelope: string }>();
    expect(row?.envelope.length ?? 0).toBeGreaterThan(20);

    // Same (project, email) rotates the key with a version bump — not a new row.
    const rotated = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: await validSaKeyJson(),
    });
    const again = z
      .looseObject({ serviceAccount: ServiceAccountViewSchema })
      .parse(await rotated.json());
    expect(again.serviceAccount.id).toBe(serviceAccount.id);
    expect(again.serviceAccount.version).toBe(2);

    // A mount reading through this SA gets its read_pool_version bumped in
    // the same batch (readiness projections invalidate on credential change).
    await seedConnection('conn-1');
    await seedMount('m-pool');
    await env.DB.prepare(
      'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES (?, ?, 0, 1, 0)',
    )
      .bind('m-pool', serviceAccount.id)
      .run();

    const disabled = await postJson(
      `/api/v1/admin/service-accounts/${serviceAccount.id}/disable`,
      cookie,
      {},
    );
    expect(disabled.status).toBe(200);
    const off = z
      .looseObject({ serviceAccount: ServiceAccountViewSchema })
      .parse(await disabled.json());
    expect(off.serviceAccount.enabled).toBe(false);
    expect(off.serviceAccount.version).toBe(3);
    const poolMount = await env.DB.prepare(
      'SELECT read_pool_version FROM mounts WHERE id = ?',
    )
      .bind('m-pool')
      .first<{ read_pool_version: number }>();
    expect(poolMount?.read_pool_version).toBe(2);

    const list = await api('/api/v1/admin/service-accounts', {
      headers: { cookie },
    });
    const listed = z
      .looseObject({ serviceAccounts: z.array(ServiceAccountViewSchema) })
      .parse(await list.json());
    expect(listed.serviceAccounts.map((s) => s.id)).toEqual([serviceAccount.id]);
  });

  it('rejects malformed key JSON', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const res = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: '{"type":"not_a_key"}',
    });
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects a PEM wrapper whose DER is not an importable RSA key', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    // Valid PEM wrapper + valid base64, but the DER is random bytes, not a
    // real PKCS8 RSA key — the local WebCrypto validation rejects it.
    const garbageDer = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64))),
    );
    const badKey = JSON.stringify({
      type: 'service_account',
      project_id: 'proj-1',
      client_email: 'reader@proj-1.iam.gserviceaccount.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${garbageDer}\n-----END PRIVATE KEY-----\n`,
    });
    const res = await postJson('/api/v1/admin/service-accounts', cookie, {
      keyJson: badKey,
    });
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
    // No credential row was persisted.
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM service_accounts',
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe('OAuth client import (real vault)', () => {
  it('registers a client, derives the project from the id, disables/enables', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const clientId = '123456789-abcdef.apps.googleusercontent.com';
    const res = await postJson('/api/v1/admin/google/clients', cookie, {
      clientId,
      clientSecret: 'top-secret-value',
    });
    expect(res.status).toBe(200);
    const { client } = z
      .looseObject({ client: OAuthClientViewSchema })
      .parse(await res.json());
    expect(client.clientId).toBe(clientId);
    expect(client.projectId).toBe('123456789');
    expect(client.redirectUri).toBe(
      `${CANONICAL_ORIGIN}/api/v1/admin/google/oauth/callback`,
    );
    expect(JSON.stringify(client)).not.toContain('top-secret-value');
    const disabled = await postJson(
      `/api/v1/admin/google/clients/${client.id}/disable`,
      cookie,
      {},
    );
    const off = z
      .looseObject({ client: OAuthClientViewSchema })
      .parse(await disabled.json());
    expect(off.client.enabled).toBe(false);
    expect(off.client.version).toBe(2);
  });

  it('rejects a non-canonical redirectUri', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const res = await postJson('/api/v1/admin/google/clients', cookie, {
      clientId: '123456789-abcdef.apps.googleusercontent.com',
      clientSecret: 'top-secret-value',
      redirectUri: 'https://evil.example/cb',
    });
    expect(res.status).toBe(400);
  });
});

describe('grants on the real surface', () => {
  it('upserts viewer/uploader grants and revokes immediately', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    await seedConnection('conn-1');
    await seedMount('m-a');
    await seedUser('viewer-1');
    await seedUser('uploader-1');

    const grantRes = await postJson('/api/v1/admin/mounts/m-a/grants', cookie, {
      userId: 'viewer-1',
      role: 'viewer',
    });
    expect(grantRes.status).toBe(200);
    const { grants } = z
      .looseObject({ grants: z.array(MountGrantViewSchema) })
      .parse(await grantRes.json());
    expect(grants).toHaveLength(1);
    expect(grants[0]!.role).toBe('viewer');
    expect(grants[0]!.operations).toEqual(['read']);
    expect(grants[0]!.grantedBy).toBeTruthy();

    // The granted user exists for the mount-grants FK.
    const viewer = await env.DB.prepare('SELECT id FROM "user" WHERE id = ?')
      .bind('viewer-1')
      .first<{ id: string }>();
    expect(viewer?.id).toBe('viewer-1');

    // Uploader with explicit operation subset.
    const up = await postJson('/api/v1/admin/mounts/m-a/grants', cookie, {
      userId: 'uploader-1',
      role: 'uploader',
      operations: ['read'],
    });
    const upGrants = z
      .looseObject({ grants: z.array(MountGrantViewSchema) })
      .parse(await up.json());
    expect(upGrants.grants).toHaveLength(2);
    expect(
      upGrants.grants.find((g) => g.userId === 'uploader-1')!.operations,
    ).toEqual(['read']);

    // Operations must be a subset of the role ceiling.
    const bad = await postJson('/api/v1/admin/mounts/m-a/grants', cookie, {
      userId: 'viewer-1',
      role: 'viewer',
      operations: ['read', 'upload'],
    });
    expect(bad.status).toBe(400);

    const del = await api('/api/v1/admin/mounts/m-a/grants/viewer-1', {
      method: 'DELETE',
      headers: { cookie, origin: CANONICAL_ORIGIN },
    });
    expect(del.status).toBe(200);
    const remaining = z
      .looseObject({ grants: z.array(MountGrantViewSchema) })
      .parse(await del.json());
    expect(remaining.grants.map((g) => g.userId)).toEqual(['uploader-1']);
  });
});

describe('users on the real surface', () => {
  it('creates a user, lists them, disables (bans + drops sessions), enables', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const created = await postJson('/api/v1/admin/users', cookie, {
      name: 'Second User',
      email: 'second@example.test',
      password: 'second-password-123',
      role: 'user',
    });
    expect(created.status).toBe(200);
    const { user } = z.looseObject({ user: UserViewSchema }).parse(await created.json());
    expect(user.email).toBe('second@example.test');
    expect(user.role).toBe('user');
    expect(user.disabled).toBe(false);

    // The new user can sign in for real.
    const userCookie = sessionCookie(await signIn('second@example.test', 'second-password-123'));
    expect(userCookie).toContain('session_token');

    const list = await api('/api/v1/admin/users', { headers: { cookie } });
    const { users } = z
      .looseObject({ users: z.array(UserViewSchema) })
      .parse(await list.json());
    expect(users.map((u) => u.email).sort()).toEqual(
      [ADMIN.email, 'second@example.test'].sort(),
    );

    const disabled = await postJson(
      `/api/v1/admin/users/${user.id}/disable`,
      cookie,
      {},
    );
    expect(disabled.status).toBe(200);
    const off = z.looseObject({ user: UserViewSchema }).parse(await disabled.json());
    expect(off.user.disabled).toBe(true);
    // The live session was dropped — subsequent requests fail closed.
    const session = await api('/api/v1/session', { headers: { cookie: userCookie } });
    expect(session.status).toBe(401);

    const enabled = await postJson(
      `/api/v1/admin/users/${user.id}/enable`,
      cookie,
      {},
    );
    const on = z.looseObject({ user: UserViewSchema }).parse(await enabled.json());
    expect(on.user.disabled).toBe(false);
  });

  it('refuses to let an admin disable their own account', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const me = await api('/api/v1/session', { headers: { cookie } });
    const { user } = z.looseObject({ user: z.looseObject({ id: z.string() }) }).parse(
      await me.json(),
    );
    const res = await postJson(`/api/v1/admin/users/${user.id}/disable`, cookie, {});
    expect(res.status).toBe(400);
  });
});

describe('mounts list and provider health on the real surface', () => {
  it('serves the catalog mount list through the real session pipeline', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    await seedConnection('conn-1');
    await seedMount('m-pub', { visibility: 'public_read' });
    const res = await api('/api/v1/mounts', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { mounts } = MountListResponseSchema.parse(await res.json());
    expect(mounts.map((m) => m.id)).toEqual(['m-pub']);
    expect(mounts[0]!.rootFolderId).toBe(DRIVE_A);
    expect(mounts[0]!.operations).toEqual(['read', 'upload', 'admin']);
  });

  it('returns admin mount views incl. read pool members', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    await seedConnection('conn-1');
    await seedMount('m-a');
    const res = await api('/api/v1/admin/mounts', { headers: { cookie } });
    expect(res.status).toBe(200);
    const { mounts } = z
      .looseObject({ mounts: z.array(MountAdminViewSchema) })
      .parse(await res.json());
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.driveId).toBe(DRIVE_A);
    expect(mounts[0]!.catalogConnectionId).toBe('conn-1');
    expect(mounts[0]!.readPool).toEqual([]);
  });

  it('reports OAuth vs SA health separately (real coordinator health)', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    await seedConnection('conn-1', { state: 'connected' });
    const res = await api('/api/v1/admin/provider-health', { headers: { cookie } });
    expect(res.status).toBe(200);
    const view = ProviderHealthViewSchema.parse(await res.json());
    expect(view.oauthConnections).toEqual([
      { connectionId: 'conn-1', state: 'connected', enabled: true },
    ]);
    expect(view.serviceAccounts).toEqual([]);
  });
});

// ===========================================================================
// Fixture-app surface for provider-dependent paths: mount create/patch and
// read-pool mapping validate the Shared Drive through the OAuth provider.
// ===========================================================================

class FakeOAuthProvider implements OAuthCatalogWriteProvider {
  readonly metadataCalls: GetMetadataInput[] = [];
  metas = new Map<string, DriveFileMeta | DriveError>();
  /** Per-connection overrides keyed `${connectionId}|${fileId}` (checked first). */
  metasByWriter = new Map<string, DriveFileMeta | DriveError>();

  async getMetadata(input: GetMetadataInput): Promise<DriveFileMeta> {
    this.metadataCalls.push(input);
    const found =
      this.metasByWriter.get(`${input.writer.connectionId}|${input.ref.id}`) ??
      this.metas.get(input.ref.id);
    if (found === undefined) {
      throw new DriveError('not-found', `${input.ref.id} not found`, { status: 404 });
    }
    if (found instanceof DriveError) throw found;
    return found;
  }

  listChildren(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  search(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  generateId(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  createFolder(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  startUpload(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  putChunk(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  probeUpload(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  verifyFile(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
  trashFile(): never {
    throw new DriveError('operation-not-allowed', 'admin fixture');
  }
}

function driveRootMeta(over: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id: DRIVE_A,
    name: 'Team Drive',
    mimeType: 'application/vnd.google-apps.folder',
    driveId: DRIVE_A,
    hasThumbnail: false,
    ...over,
  } as DriveFileMeta;
}

function makeFixtureApp(deps: {
  oauth?: FakeOAuthProvider;
  drives?: SharedDriveLister;
  admin?: AdminIdentity | { status: number; code: string };
}) {
  const admin: AdminIdentity | { status: number; code: string } =
    deps.admin ?? { userId: 'admin-1', sessionId: 'sess-1' };
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
    createAdminRouter({
      requireAdmin,
      ...(deps.oauth === undefined ? {} : { oauthProvider: deps.oauth }),
      ...(deps.drives === undefined ? {} : { sharedDriveLister: deps.drives }),
    }),
  );
  return app;
}

function fixtureApi(
  app: Hono<{ Bindings: Env; Variables: { requestId?: string } }>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env),
  );
}

async function fixtureSeed() {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) " +
      "VALUES (1, 'install-1', 'complete', ?, 1, 0, 0)",
  )
    .bind(CANONICAL_ORIGIN)
    .run();
  await seedConnection('conn-1');
  await seedConnection('conn-2', {});
}

describe('mount create/update/read-pool (fixture provider)', () => {
  it('creates a mount validating the Shared Drive + write capability', async () => {
    await fixtureSeed();
    await env.DB.prepare(
      'INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) ' +
        "VALUES ('sa-1', 'proj-1', 'r@p.iam.gserviceaccount.com', 'k1', 'env', 1, 1, 0, 0)",
    ).run();
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(DRIVE_A, driveRootMeta({ capabilities: { canAddChildren: true } }));
    const app = makeFixtureApp({ oauth });
    const res = await fixtureApi(app, '/api/v1/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Team Drive',
        driveId: DRIVE_A,
        catalogConnectionId: 'conn-1',
        writeConnectionId: 'conn-2',
        serviceAccountIds: ['sa-1'],
        visibility: 'private',
      }),
    });
    expect(res.status).toBe(200);
    const { mount } = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await res.json());
    expect(mount.driveId).toBe(DRIVE_A);
    expect(mount.catalogConnectionId).toBe('conn-1');
    expect(mount.writeConnectionId).toBe('conn-2');
    expect(mount.readPool.map((sa) => sa.id)).toEqual(['sa-1']);
    // Two Shared Drive root checks happened: catalog + write connection.
    expect(oauth.metadataCalls.length).toBe(2);
    expect(oauth.metadataCalls[0]!.writer.connectionId).toBe('conn-1');
    expect(oauth.metadataCalls[1]!.writer.connectionId).toBe('conn-2');
  });

  it('rejects mount creation when driveId is not a Shared Drive root', async () => {
    await fixtureSeed();
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      DRIVE_A,
      driveRootMeta({ mimeType: 'application/octet-stream' }),
    );
    const res = await fixtureApi(makeFixtureApp({ oauth }), '/api/v1/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Not a drive',
        driveId: DRIVE_A,
        catalogConnectionId: 'conn-1',
        writeConnectionId: 'conn-1',
        serviceAccountIds: [],
        visibility: 'private',
      }),
    });
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects mount creation when canAddChildren is missing (not proven)', async () => {
    await fixtureSeed();
    const oauth = new FakeOAuthProvider();
    // Shared Drive root resolves fine, but capabilities are absent —
    // missing capability must fail, only canAddChildren === true passes.
    oauth.metas.set(DRIVE_A, driveRootMeta({ capabilities: {} }));
    const app = makeFixtureApp({ oauth });
    const res = await fixtureApi(app, '/api/v1/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'No write proof',
        driveId: DRIVE_A,
        catalogConnectionId: 'conn-1',
        writeConnectionId: 'conn-1',
        serviceAccountIds: [],
        visibility: 'private',
      }),
    });
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
    const mounts = await env.DB.prepare('SELECT COUNT(*) AS n FROM mounts').first<{
      n: number;
    }>();
    expect(mounts?.n).toBe(0);
  });

  it('rejects mount creation when the separate writer resolves a different drive', async () => {
    await fixtureSeed();
    const oauth = new FakeOAuthProvider();
    oauth.metas.set(
      DRIVE_A,
      driveRootMeta({ capabilities: { canAddChildren: true } }),
    );
    // The write connection's identity sees a different drive entirely —
    // scope must be proven per identity, not inferred from the catalog view.
    oauth.metasByWriter.set(
      `conn-2|${DRIVE_A}`,
      driveRootMeta({
        id: '0CCCother-drive',
        driveId: '0CCCother-drive',
        capabilities: { canAddChildren: true },
      }),
    );
    const app = makeFixtureApp({ oauth });
    const res = await fixtureApi(app, '/api/v1/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'Wrong writer scope',
        driveId: DRIVE_A,
        catalogConnectionId: 'conn-1',
        writeConnectionId: 'conn-2',
        serviceAccountIds: [],
        visibility: 'private',
      }),
    });
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
    const mounts = await env.DB.prepare('SELECT COUNT(*) AS n FROM mounts').first<{
      n: number;
    }>();
    expect(mounts?.n).toBe(0);
  });

  it('rejects mount creation on a disabled connection', async () => {
    await fixtureSeed();
    await env.DB.prepare(
      "UPDATE google_connections SET enabled = 0, state = 'disabled' WHERE id = 'conn-1'",
    ).run();
    const res = await fixtureApi(makeFixtureApp({ oauth: new FakeOAuthProvider() }), '/api/v1/admin/mounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'x',
        driveId: DRIVE_A,
        catalogConnectionId: 'conn-1',
        writeConnectionId: 'conn-1',
        serviceAccountIds: [],
        visibility: 'private',
      }),
    });
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'GOOGLE_CONNECTION_DISABLED',
    );
  });

  it('PATCH bumps policyVersion only on authz-relevant changes', async () => {
    await fixtureSeed();
    await seedMount('m-a', { visibility: 'private' });
    const app = makeFixtureApp({ oauth: new FakeOAuthProvider() });
    const relabel = await fixtureApi(app, '/api/v1/admin/mounts/m-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed' }),
    });
    const relabeled = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await relabel.json());
    expect(relabeled.mount.label).toBe('Renamed');
    expect(relabeled.mount.policyVersion).toBe(1);

    const flip = await fixtureApi(app, '/api/v1/admin/mounts/m-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public_read' }),
    });
    const flipped = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await flip.json());
    expect(flipped.mount.visibility).toBe('public_read');
    expect(flipped.mount.policyVersion).toBe(2);
  });

  it('replaces the read pool atomically and bumps readPoolVersion', async () => {
    await fixtureSeed();
    await seedMount('m-a');
    for (const id of ['sa-1', 'sa-2']) {
      await env.DB.prepare(
        'INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0)',
      )
        .bind(id, 'proj-1', `${id}@p.iam.gserviceaccount.com`, 'k1', 'env')
        .run();
    }
    const app = makeFixtureApp({});
    const res = await fixtureApi(app, '/api/v1/admin/mounts/m-a/read-pool', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [
          { serviceAccountId: 'sa-2', priority: 5, weight: 2 },
          { serviceAccountId: 'sa-1' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { mount } = z
      .looseObject({ mount: MountAdminViewSchema })
      .parse(await res.json());
    expect(mount.readPool.map((sa) => sa.id)).toEqual(['sa-2', 'sa-1']);
    expect(mount.readPoolVersion).toBe(2);
  });
});

describe('concurrent credential imports (reviewer F13)', () => {
  it('concurrent same-identity SA imports never 500 and never duplicate', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const keyJson = await validSaKeyJson();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        postJson('/api/v1/admin/service-accounts', cookie, { keyJson }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses).not.toContain(500);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    // At least one request wins the insert; the rest rotate or conflict.
    expect(statuses).toContain(200);
    for (const res of results) {
      if (res.status === 409) {
        expect(
          ApiErrorBodySchema.parse(await res.json()).error.code,
        ).toBe('IDEMPOTENCY_CONFLICT');
      }
    }
    const rows = await env.DB
      .prepare(
        "SELECT id FROM service_accounts WHERE project_id = 'proj-1' AND email = 'reader@proj-1.iam.gserviceaccount.com'",
      )
      .all();
    expect(rows.results).toHaveLength(1);
  });

  it('concurrent same-client OAuth imports never 500 and never duplicate', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const clientId = '777777777-race.apps.googleusercontent.com';
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        postJson('/api/v1/admin/google/clients', cookie, {
          clientId,
          clientSecret: 'secret-race',
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses).not.toContain(500);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    expect(statuses).toContain(200);
    const rows = await env.DB
      .prepare('SELECT id FROM google_oauth_clients WHERE client_id = ?')
      .bind(clientId)
      .all();
    expect(rows.results).toHaveLength(1);
    // The imported secret must not surface in any error body.
    for (const res of results) {
      expect(await res.text()).not.toContain('secret-race');
    }
  });
});

// ===========================================================================
// Wave 5 / T11 remainder: GET /shared-drives — admin-only, paged listing of
// Shared Drives visible to the chosen OAuth catalog connection (drives.list
// with useDomainAdminAccess=false). The fixture lister proves the identity
// and paging plumbing; the real surface proves the auth gate and shared
// error envelope. No SA path and no cross-provider fallback exist.
// ===========================================================================

class FakeSharedDriveLister implements SharedDriveLister {
  readonly calls: ListSharedDrivesInput[] = [];
  /** Pages keyed by the input pageToken ('' for the first page). */
  pages = new Map<string, SharedDrivesPage>();
  error: DriveError | null = null;

  async listSharedDrives(
    input: ListSharedDrivesInput,
  ): Promise<SharedDrivesPage> {
    this.calls.push(input);
    if (this.error !== null) throw this.error;
    return this.pages.get(input.pageToken ?? '') ?? { drives: [] };
  }
}

const SharedDrivesResponseSchema = z.looseObject({
  drives: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  nextPageToken: z.string().optional(),
});

describe('shared drives listing (fixture lister)', () => {
  it('lists drives through the resolved catalog writer and forwards paging', async () => {
    await fixtureSeed();
    const lister = new FakeSharedDriveLister();
    lister.pages.set('', {
      drives: [
        { id: 'drive-1', name: 'Team Alpha' },
        { id: 'drive-2', name: 'Team Beta' },
      ],
      nextPageToken: 'tok-2',
    });
    const app = makeFixtureApp({ drives: lister });
    const res = await fixtureApi(
      app,
      '/api/v1/admin/shared-drives?connectionId=conn-1&pageSize=10',
    );
    expect(res.status).toBe(200);
    const body = SharedDrivesResponseSchema.parse(await res.json());
    expect(body.drives.map((d) => d.id)).toEqual(['drive-1', 'drive-2']);
    expect(body.nextPageToken).toBe('tok-2');
    // The lister saw exactly the writer resolved for the requested connection.
    expect(lister.calls).toHaveLength(1);
    expect(lister.calls[0]!.writer.connectionId).toBe('conn-1');
    expect(lister.calls[0]!.pageSize).toBe(10);
    expect(lister.calls[0]!.pageToken).toBeUndefined();
  });

  it('passes the opaque pageToken through on the next request', async () => {
    await fixtureSeed();
    const lister = new FakeSharedDriveLister();
    lister.pages.set('tok-2', { drives: [{ id: 'drive-3', name: 'Team Gamma' }] });
    const res = await fixtureApi(
      makeFixtureApp({ drives: lister }),
      '/api/v1/admin/shared-drives?connectionId=conn-1&pageToken=tok-2',
    );
    expect(res.status).toBe(200);
    const body = SharedDrivesResponseSchema.parse(await res.json());
    expect(body.drives.map((d) => d.id)).toEqual(['drive-3']);
    expect(lister.calls[0]!.pageToken).toBe('tok-2');
    expect(lister.calls[0]!.pageSize).toBeUndefined();
  });

  it('rejects a missing connectionId with the shared validation envelope', async () => {
    await fixtureSeed();
    const lister = new FakeSharedDriveLister();
    const res = await fixtureApi(
      makeFixtureApp({ drives: lister }),
      '/api/v1/admin/shared-drives',
    );
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(lister.calls).toHaveLength(0);
  });

  it('rejects a non-positive or non-integer pageSize', async () => {
    await fixtureSeed();
    for (const bad of ['0', '-3', 'abc']) {
      const res = await fixtureApi(
        makeFixtureApp({ drives: new FakeSharedDriveLister() }),
        `/api/v1/admin/shared-drives?connectionId=conn-1&pageSize=${bad}`,
      );
      expect(res.status).toBe(400);
      expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  it('rejects an unknown connection and never calls the provider', async () => {
    await fixtureSeed();
    const lister = new FakeSharedDriveLister();
    const res = await fixtureApi(
      makeFixtureApp({ drives: lister }),
      '/api/v1/admin/shared-drives?connectionId=missing',
    );
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'GOOGLE_CONNECTION_DISABLED',
    );
    expect(lister.calls).toHaveLength(0);
  });

  it('rejects a disabled connection', async () => {
    await fixtureSeed();
    await env.DB.prepare(
      "UPDATE google_connections SET enabled = 0, state = 'disabled' WHERE id = 'conn-1'",
    ).run();
    const res = await fixtureApi(
      makeFixtureApp({ drives: new FakeSharedDriveLister() }),
      '/api/v1/admin/shared-drives?connectionId=conn-1',
    );
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'GOOGLE_CONNECTION_DISABLED',
    );
  });

  it('maps a needs_reauth connection to GOOGLE_REAUTH_REQUIRED', async () => {
    await fixtureSeed();
    await env.DB.prepare(
      "UPDATE google_connections SET state = 'needs_reauth' WHERE id = 'conn-1'",
    ).run();
    const res = await fixtureApi(
      makeFixtureApp({ drives: new FakeSharedDriveLister() }),
      '/api/v1/admin/shared-drives?connectionId=conn-1',
    );
    expect(res.status).toBe(502);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'GOOGLE_REAUTH_REQUIRED',
    );
  });

  it('maps lister DriveErrors into the shared error envelope', async () => {
    await fixtureSeed();
    const lister = new FakeSharedDriveLister();
    lister.error = new DriveError('rate-limited', 'upstream slow down', {
      retryAfterMs: 2000,
    });
    const res = await fixtureApi(
      makeFixtureApp({ drives: lister }),
      '/api/v1/admin/shared-drives?connectionId=conn-1',
    );
    expect(res.status).toBe(429);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.requestId).toBe('test-request-id');
  });

  it('denies non-admin callers before touching the provider', async () => {
    await fixtureSeed();
    const lister = new FakeSharedDriveLister();
    const res = await fixtureApi(
      makeFixtureApp({
        drives: lister,
        admin: { status: 403, code: 'FORBIDDEN' },
      }),
      '/api/v1/admin/shared-drives?connectionId=conn-1',
    );
    expect(res.status).toBe(403);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'FORBIDDEN',
    );
    expect(lister.calls).toHaveLength(0);
  });
});

describe('shared drives listing (real surface)', () => {
  it('rejects a missing connectionId through the real router', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const res = await api('/api/v1/admin/shared-drives', {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects an unknown connection through the real router', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    const res = await api('/api/v1/admin/shared-drives?connectionId=missing', {
      headers: { cookie },
    });
    expect(res.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'GOOGLE_CONNECTION_DISABLED',
    );
  });

  it('surfaces honest re-auth when the connection holds no refresh grant', async () => {
    await completeSetup();
    const cookie = await adminCookie();
    await seedConnection('conn-1', { state: 'connected' });
    const res = await api('/api/v1/admin/shared-drives?connectionId=conn-1', {
      headers: { cookie },
    });
    // The seeded connection has no refresh envelope, so token admission must
    // fail closed with the shared envelope — never a fabricated drive list.
    expect(res.status).toBe(502);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe(
      'GOOGLE_REAUTH_REQUIRED',
    );
  });
});
