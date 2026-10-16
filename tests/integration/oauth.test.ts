import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createVault, decodeEnvelope, encodeEnvelope } from '../../src/worker/security/vault';
import {
  oauthClientSecretContext,
  oauthRefreshTokenContext,
  VAULT_KEY_ID,
  type FetchLike,
} from '../../src/worker/drive/tokens';
import {
  createOAuthRouter,
  OAUTH_CALLBACK_PATH,
  type AdminIdentity,
} from '../../src/worker/drive/oauth/routes';
import {
  GOOGLE_ABOUT_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
} from '../../src/worker/drive/oauth/google';
import {
  casUpdateConnection,
  insertConnection,
} from '../../src/worker/drive/oauth/transactions';
import { ApiErrorBodySchema, ConnectionViewSchema } from '../../src/shared/contracts';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const TEST_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CANONICAL = 'https://app.test';
const INSTALLATION = 'install-1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function fixtureFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Router harness.
// ---------------------------------------------------------------------------

interface RouterHarnessOptions {
  admin?: AdminIdentity | { status: number; code: string; message?: string };
  fetchImpl: FetchLike;
  now?: () => number;
}

function makeRouter(options: RouterHarnessOptions) {
  const admin = options.admin ?? { userId: 'admin-1', sessionId: 'sess-1' };
  const requireAdmin = async (): Promise<AdminIdentity> => {
    if ('status' in admin) {
      throw { status: admin.status, code: admin.code, message: admin.message ?? '' };
    }
    return admin;
  };
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    '/api/v1/admin/google',
    createOAuthRouter({
      requireAdmin,
      fetchImpl: options.fetchImpl,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
  return app;
}

function api(
  app: Hono<{ Bindings: Env }>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`${CANONICAL}${path}`, init), env as unknown as Env),
  );
}

// ---------------------------------------------------------------------------
// D1 seeding.
// ---------------------------------------------------------------------------

async function seedSettings(canonicalOrigin: string | null = CANONICAL) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) ' +
      "VALUES (1, ?, 'complete', ?, 1, 0, 0)",
  )
    .bind(INSTALLATION, canonicalOrigin)
    .run();
}

async function seedOAuthClient(
  options: { id?: string; projectId?: string; enabled?: number; version?: number } = {},
): Promise<{ id: string; projectId: string; version: number }> {
  const id = options.id ?? 'oc-1';
  const projectId = options.projectId ?? 'proj-1';
  const vault = createVault(TEST_MASTER_KEY, VAULT_KEY_ID);
  const envelope = encodeEnvelope(
    await vault.sealSecret(
      encoder.encode('client-secret-1'),
      oauthClientSecretContext(id, projectId),
    ),
  );
  await env.DB.prepare(
    'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(
      id,
      projectId,
      'google-client-id-1',
      envelope,
      `${CANONICAL}${OAUTH_CALLBACK_PATH}`,
      options.enabled ?? 1,
      options.version ?? 2,
    )
    .run();
  return { id, projectId, version: options.version ?? 2 };
}

async function seedConnection(options: {
  id?: string;
  oauthClientId?: string;
  principalId?: string;
  state?: string;
  enabled?: number;
  version?: number;
  refreshToken?: string | null;
  scopes?: string;
}): Promise<{ id: string; version: number }> {
  const id = options.id ?? 'conn-1';
  const vault = createVault(TEST_MASTER_KEY, VAULT_KEY_ID);
  const envelope =
    options.refreshToken === null
      ? null
      : encodeEnvelope(
          await vault.sealSecret(
            encoder.encode(options.refreshToken ?? 'refresh-old'),
            oauthRefreshTokenContext(id, 'proj-1'),
          ),
        );
  await env.DB.prepare(
    'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(
      id,
      options.oauthClientId ?? 'oc-1',
      options.principalId ?? 'perm-1',
      'op@example.com',
      envelope,
      options.scopes ?? 'https://www.googleapis.com/auth/drive',
      options.state ?? 'connected',
      options.enabled ?? 1,
      options.version ?? 5,
      'admin-1',
    )
    .run();
  return { id, version: options.version ?? 5 };
}

async function readConnectionRow(id: string) {
  return env.DB.prepare(
    'SELECT id, principal_id, state, enabled, version, refresh_envelope, granted_scopes, connected_by, oauth_client_id ' +
      'FROM google_connections WHERE id = ?',
  )
    .bind(id)
    .first<{
      id: string;
      principal_id: string;
      state: string;
      enabled: number;
      version: number;
      refresh_envelope: string | null;
      granted_scopes: string;
      connected_by: string | null;
      oauth_client_id: string;
    }>();
}

async function openRefresh(id: string, envelope: string): Promise<string> {
  const vault = createVault(TEST_MASTER_KEY, VAULT_KEY_ID);
  return decoder.decode(
    await vault.openSecret(decodeEnvelope(envelope), oauthRefreshTokenContext(id, 'proj-1')),
  );
}

interface TxRow {
  id: string;
  admin_session_id: string;
  installation_id: string;
  oauth_client_id: string;
  client_version: number;
  purpose: string;
  target_connection_id: string | null;
  redirect_uri: string;
  pkce_envelope: string | null;
  expires_at: number;
  consumed_at: number | null;
}

async function latestTransaction(): Promise<TxRow | null> {
  return env.DB.prepare(
    'SELECT id, admin_session_id, installation_id, oauth_client_id, client_version, purpose, ' +
      'target_connection_id, redirect_uri, pkce_envelope, expires_at, consumed_at ' +
      'FROM oauth_transactions ORDER BY created_at DESC LIMIT 1',
  ).first<TxRow>();
}

/** Default Google fixture: code exchange + refresh grant + about.get + revoke. */
function googleFixture(options: {
  accessToken?: string;
  refreshToken?: string;
  scopes?: string;
  expiresIn?: number;
  permissionId?: string;
  email?: string;
  tokenStatus?: number;
  tokenBody?: unknown;
  aboutStatus?: number;
  aboutBody?: unknown;
}) {
  return fixtureFetch((call) => {
    const url = new URL(call.url);
    if (`${url.origin}${url.pathname}` === GOOGLE_TOKEN_ENDPOINT) {
      if (options.tokenBody !== undefined || options.tokenStatus !== undefined) {
        return json(options.tokenBody ?? { error: 'server_error' }, options.tokenStatus ?? 500);
      }
      const grant: Record<string, unknown> = {
        access_token: options.accessToken ?? 'at-1',
        expires_in: options.expiresIn ?? 3600,
        scope: options.scopes ?? 'https://www.googleapis.com/auth/drive',
        token_type: 'Bearer',
      };
      if (options.refreshToken !== undefined) grant.refresh_token = options.refreshToken;
      return json(grant);
    }
    if (`${url.origin}${url.pathname}` === GOOGLE_ABOUT_ENDPOINT) {
      if (options.aboutBody !== undefined || options.aboutStatus !== undefined) {
        return json(options.aboutBody ?? {}, options.aboutStatus ?? 500);
      }
      return json({
        user: {
          permissionId: options.permissionId ?? 'perm-1',
          emailAddress: options.email ?? 'op@example.com',
        },
      });
    }
    if (`${url.origin}${url.pathname}` === GOOGLE_REVOKE_ENDPOINT) {
      return new Response(null, { status: 200 });
    }
    return new Response('unexpected url', { status: 500 });
  });
}

async function startConnect(
  app: Hono<{ Bindings: Env }>,
  body: unknown = { purpose: 'connect', oauthClientId: 'oc-1' },
): Promise<{ status: number; authorizationUrl?: string; state?: string }> {
  const res = await api(app, '/api/v1/admin/google/oauth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return { status: res.status };
  const payload = (await res.json()) as { authorizationUrl: string };
  const url = new URL(payload.authorizationUrl);
  return {
    status: res.status,
    authorizationUrl: payload.authorizationUrl,
    state: url.searchParams.get('state') ?? undefined,
  };
}

function callback(
  app: Hono<{ Bindings: Env }>,
  params: { state?: string; code?: string; error?: string },
  origin: string = CANONICAL,
): Promise<Response> {
  const query = new URLSearchParams();
  if (params.state !== undefined) query.set('state', params.state);
  if (params.code !== undefined) query.set('code', params.code);
  if (params.error !== undefined) query.set('error', params.error);
  return Promise.resolve(
    app.fetch(
      new Request(`${origin}/api/v1/admin/google/oauth/callback?${query}`),
      env as unknown as Env,
    ),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  // FK order: transactions reference clients/connections.
  await env.DB.prepare('DELETE FROM oauth_transactions').run();
  await env.DB.prepare('DELETE FROM google_connections').run();
  await env.DB.prepare('DELETE FROM google_oauth_clients').run();
  await env.DB.prepare('DELETE FROM service_accounts').run();
  // google_connections.connected_by references "user" — seed the fixture admin.
  await env.DB.prepare(
    'INSERT OR REPLACE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) ' +
      "VALUES ('admin-1', 'Admin', 'admin@fixture.test', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'admin')",
  ).run();
  await seedSettings();
});

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

describe('oauth start', () => {
  it('creates a bound one-use transaction and returns the Google URL', async () => {
    const { fetchImpl } = googleFixture({});
    const app = makeRouter({ fetchImpl, now: () => 1_000_000 });
    await seedOAuthClient();
    const start = await startConnect(app);
    expect(start.status).toBe(200);
    const url = new URL(start.authorizationUrl ?? '');
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(`${CANONICAL}${OAUTH_CALLBACK_PATH}`);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const tx = await latestTransaction();
    expect(tx).not.toBeNull();
    expect(tx?.admin_session_id).toBe('sess-1');
    expect(tx?.installation_id).toBe(INSTALLATION);
    expect(tx?.redirect_uri).toBe(`${CANONICAL}${OAUTH_CALLBACK_PATH}`);
    expect(tx?.pkce_envelope).not.toBeNull();
    expect(tx?.purpose).toBe('connect');
    expect(tx?.expires_at).toBe(1_000_000 + 600_000);
    expect(tx?.consumed_at).toBeNull();
  });

  it('rejects unauthenticated and non-admin callers', async () => {
    const { fetchImpl } = googleFixture({});
    const unauth = makeRouter({
      admin: { status: 401, code: 'AUTH_REQUIRED' },
      fetchImpl,
    });
    await seedOAuthClient();
    expect(
      (
        await api(unauth, '/api/v1/admin/google/oauth/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ purpose: 'connect', oauthClientId: 'oc-1' }),
        })
      ).status,
    ).toBe(401);

    const nonAdmin = makeRouter({ admin: { status: 403, code: 'FORBIDDEN' }, fetchImpl });
    expect(
      (
        await api(nonAdmin, '/api/v1/admin/google/oauth/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ purpose: 'connect', oauthClientId: 'oc-1' }),
        })
      ).status,
    ).toBe(403);
  });

  it('maps a 503 auth failure to AUTH_UNAVAILABLE truthfully', async () => {
    const { fetchImpl } = googleFixture({});
    const app = makeRouter({ admin: { status: 503, code: 'AUTH_UNAVAILABLE' }, fetchImpl });
    const res = await api(app, '/api/v1/admin/google/connections');
    expect(res.status).toBe(503);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('oauth callback', () => {
  it('exchanges the code, resolves the principal and activates the connection', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new', permissionId: 'perm-9' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const start = await startConnect(app);
    const res = await callback(app, { state: start.state, code: 'code-1' });
    expect(res.status).toBe(200);
    const view = ConnectionViewSchema.parse(
      ((await res.json()) as { connection: unknown }).connection,
    );
    expect(view.state).toBe('connected');
    expect(view.grantedScopes).toEqual(['https://www.googleapis.com/auth/drive']);
    const row = await readConnectionRow(view.id);
    expect(row?.principal_id).toBe('perm-9');
    expect(row?.refresh_envelope).not.toBeNull();
    expect(await openRefresh(view.id, row?.refresh_envelope ?? '')).toBe('refresh-new');
    expect(row?.connected_by).toBe('admin-1');
    const tx = await latestTransaction();
    expect(tx?.consumed_at).not.toBeNull();
  });

  it('burns the state on replay', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const start = await startConnect(app);
    expect((await callback(app, { state: start.state, code: 'code-1' })).status).toBe(200);
    const replay = await callback(app, { state: start.state, code: 'code-1' });
    expect(replay.status).toBe(400);
  });

  it('rejects a callback bound to another admin session', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new' });
    const admin = { userId: 'admin-1', sessionId: 'sess-1' };
    const app = makeRouter({ fetchImpl, admin });
    await seedOAuthClient();
    const start = await startConnect(app);
    const other = makeRouter({ fetchImpl, admin: { userId: 'admin-1', sessionId: 'sess-2' } });
    const res = await callback(other, { state: start.state, code: 'code-1' });
    expect(res.status).toBe(403);
  });

  it('rejects an expired state', async () => {
    let now = 1_000_000;
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new' });
    const app = makeRouter({ fetchImpl, now: () => now });
    await seedOAuthClient();
    const start = await startConnect(app);
    now += 601_000;
    const res = await callback(app, { state: start.state, code: 'code-1' });
    expect(res.status).toBe(400);
  });

  it('rejects when the OAuth client row changed mid-flow', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const start = await startConnect(app);
    await env.DB.prepare('UPDATE google_oauth_clients SET version = version + 1').run();
    const res = await callback(app, { state: start.state, code: 'code-1' });
    expect(res.status).toBe(409);
  });

  it('rejects a callback that lands on a different origin than the stored redirect', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const start = await startConnect(app);
    const res = await callback(
      app,
      { state: start.state, code: 'code-1' },
      'https://other.test',
    );
    expect(res.status).toBe(400);
  });

  it('keeps the connection non-durable when Google returns no refresh token', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: undefined, permissionId: 'perm-2' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const start = await startConnect(app);
    const res = await callback(app, { state: start.state, code: 'code-1' });
    expect(res.status).toBe(200);
    const view = ConnectionViewSchema.parse(
      ((await res.json()) as { connection: unknown }).connection,
    );
    expect(view.state).toBe('needs_reauth');
    const row = await readConnectionRow(view.id);
    expect(row?.refresh_envelope).toBeNull();
  });

  it('fails without activating a connection when the exchange returns invalid_grant', async () => {
    const { fetchImpl } = googleFixture({ tokenBody: { error: 'invalid_grant' }, tokenStatus: 400 });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const start = await startConnect(app);
    const res = await callback(app, { state: start.state, code: 'code-1' });
    expect(res.status).toBe(400);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe('GOOGLE_REAUTH_REQUIRED');
    expect(
      (await env.DB.prepare('SELECT id FROM google_connections').all()).results?.length ?? 0,
    ).toBe(0);
  });
});

describe('reconnect', () => {
  it('CAS-updates the pinned connection when the same principal re-consents', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new', permissionId: 'perm-1' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'needs_reauth', version: 5 });
    const res = await api(app, '/api/v1/admin/google/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'reconnect', connectionId: id }),
    });
    expect(res.status).toBe(200);
    const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
    const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
    const tx = await latestTransaction();
    expect(tx?.purpose).toBe('reconnect');
    expect(tx?.target_connection_id).toBe(id);

    const cb = await callback(app, { state, code: 'code-2' });
    expect(cb.status).toBe(200);
    const row = await readConnectionRow(id);
    expect(row?.state).toBe('connected');
    expect(row?.version).toBe(6);
    expect(await openRefresh(id, row?.refresh_envelope ?? '')).toBe('refresh-new');
  });

  it('refuses to move the pinned writer to a different principal', async () => {
    const { fetchImpl } = googleFixture({
      refreshToken: 'refresh-new',
      permissionId: 'perm-different',
    });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'needs_reauth', version: 5 });
    const res = await api(app, '/api/v1/admin/google/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'reconnect', connectionId: id }),
    });
    const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
    const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
    const cb = await callback(app, { state, code: 'code-2' });
    expect(cb.status).toBe(403);
    const row = await readConnectionRow(id);
    expect(row?.state).toBe('needs_reauth');
    expect(row?.version).toBe(5);
  });

  it('keeps the stored refresh token when the reconnect grant omits one', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: undefined, permissionId: 'perm-1' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'needs_reauth', version: 5 });
    const res = await api(app, '/api/v1/admin/google/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'reconnect', connectionId: id }),
    });
    const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
    const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
    const cb = await callback(app, { state, code: 'code-2' });
    expect(cb.status).toBe(200);
    const row = await readConnectionRow(id);
    expect(row?.state).toBe('connected');
    expect(await openRefresh(id, row?.refresh_envelope ?? '')).toBe('refresh-old');
  });
});

describe('callback races (frozen target, fenced CAS)', () => {
  /** Google fixture whose token exchange mutates D1 mid-flight. */
  function racingFixture(mutate: () => Promise<void>) {
    return fixtureFetch(async (call) => {
      const url = new URL(call.url);
      if (`${url.origin}${url.pathname}` === GOOGLE_TOKEN_ENDPOINT) {
        await mutate();
        return json({
          access_token: 'at',
          expires_in: 3600,
          refresh_token: 'refresh-late',
          scope: 'https://www.googleapis.com/auth/drive',
        });
      }
      if (`${url.origin}${url.pathname}` === GOOGLE_ABOUT_ENDPOINT) {
        return json({ user: { permissionId: 'perm-1', emailAddress: 'op@example.com' } });
      }
      return new Response('unexpected', { status: 500 });
    });
  }

  async function startReconnect(app: Hono<{ Bindings: Env }>, connectionId: string) {
    const res = await api(app, '/api/v1/admin/google/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'reconnect', connectionId }),
    });
    const { authorizationUrl } = (await res.json()) as { authorizationUrl: string };
    return new URL(authorizationUrl).searchParams.get('state') ?? '';
  }

  it('rejects the callback when the OAuth client is disabled mid-flight', async () => {
    const { fetchImpl } = racingFixture(async () => {
      await env.DB.prepare('UPDATE google_oauth_clients SET enabled = 0').run();
    });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'needs_reauth', version: 5 });
    const state = await startReconnect(app, id);
    const res = await callback(app, { state, code: 'code-9' });
    expect(res.status).toBe(409);
    // Row untouched: version and sealed refresh envelope preserved.
    const row = await readConnectionRow(id);
    expect(row?.version).toBe(5);
    expect(row?.state).toBe('needs_reauth');
    expect(await openRefresh(id, row?.refresh_envelope ?? '')).toBe('refresh-old');
  });

  it('rejects the callback when the OAuth client version bumps mid-flight', async () => {
    const { fetchImpl } = racingFixture(async () => {
      await env.DB.prepare('UPDATE google_oauth_clients SET version = version + 1').run();
    });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'needs_reauth', version: 5 });
    const state = await startReconnect(app, id);
    const res = await callback(app, { state, code: 'code-9' });
    expect(res.status).toBe(409);
    const row = await readConnectionRow(id);
    expect(row?.version).toBe(5);
    expect(await openRefresh(id, row?.refresh_envelope ?? '')).toBe('refresh-old');
  });

  it('does not resurrect the refresh envelope when disconnect wins the race', async () => {
    const { fetchImpl } = racingFixture(async () => {
      // The concurrent disconnect: disable + clear envelope, version bump.
      await env.DB.prepare(
        "UPDATE google_connections SET enabled = 0, state = 'disabled', " +
          'refresh_envelope = NULL, version = version + 1 WHERE id = ?',
      )
        .bind('conn-1')
        .run();
    });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'needs_reauth', version: 5 });
    const state = await startReconnect(app, id);
    const res = await callback(app, { state, code: 'code-9' });
    expect(res.status).toBe(409);
    const row = await readConnectionRow(id);
    expect(row?.state).toBe('disabled');
    expect(row?.enabled).toBe(0);
    expect(row?.refresh_envelope).toBeNull();
    expect(row?.version).toBe(6);
  });

  it('does not overwrite a competing reconnect that won the race', async () => {
    const { fetchImpl } = racingFixture(async () => {
      // A competing reconnect landed first: bumped version + new envelope.
      await env.DB.prepare(
        'UPDATE google_connections SET version = version + 1, ' +
          "state = 'connected' WHERE id = ?",
      )
        .bind('conn-1')
        .run();
    });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'needs_reauth', version: 5 });
    const state = await startReconnect(app, id);
    const res = await callback(app, { state, code: 'code-9' });
    expect(res.status).toBe(409);
    const row = await readConnectionRow(id);
    expect(row?.version).toBe(6);
    expect(row?.state).toBe('connected');
    // Our stale grant did not replace the winner's material.
    expect(await openRefresh(id, row?.refresh_envelope ?? '')).toBe('refresh-old');
  });

  it('rejects a connect callback when the client changed mid-flight', async () => {
    const { fetchImpl } = racingFixture(async () => {
      await env.DB.prepare('UPDATE google_oauth_clients SET version = version + 1').run();
    });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const start = await startConnect(app);
    const res = await callback(app, { state: start.state, code: 'code-9' });
    expect(res.status).toBe(409);
    expect(
      (await env.DB.prepare('SELECT id FROM google_connections').all()).results?.length ?? 0,
    ).toBe(0);
  });

  it('connect onto an existing (client, principal) row is refused: use reconnect', async () => {
    const { fetchImpl } = googleFixture({ refreshToken: 'refresh-new', permissionId: 'perm-1' });
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'connected', version: 5 });
    const start = await startConnect(app);
    const res = await callback(app, { state: start.state, code: 'code-9' });
    expect(res.status).toBe(409);
    const row = await readConnectionRow(id);
    expect(row?.version).toBe(5);
    expect(row?.state).toBe('connected');
    expect(await openRefresh(id, row?.refresh_envelope ?? '')).toBe('refresh-old');
  });
});

describe('connection write fences', () => {
  it('CAS refuses to write when the client row changed since the snapshot', async () => {
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'connected', version: 5 });
    // Client moved after the callback snapshot was taken.
    await env.DB.prepare('UPDATE google_oauth_clients SET version = version + 1').run();
    const applied = await casUpdateConnection(
      env.DB,
      id,
      5,
      {
        refreshEnvelope: 'envelope',
        grantedScopes: 'https://www.googleapis.com/auth/drive',
        displayEmail: 'op@example.com',
        state: 'connected',
        nowMs: 1,
      },
      { id: 'oc-1', version: 2 },
    );
    expect(applied).toBe(false);
    const row = await readConnectionRow(id);
    expect(row?.version).toBe(5);
  });

  it('INSERT...SELECT refuses to land when the client row changed', async () => {
    await seedOAuthClient();
    await env.DB.prepare('UPDATE google_oauth_clients SET version = version + 1').run();
    const inserted = await insertConnection(
      env.DB,
      {
        id: 'conn-late',
        oauthClientId: 'oc-1',
        principalId: 'perm-1',
        displayEmail: 'op@example.com',
        refreshEnvelope: 'envelope',
        grantedScopes: 'https://www.googleapis.com/auth/drive',
        state: 'connected',
        connectedBy: 'admin-1',
        nowMs: 1,
      },
      { id: 'oc-1', version: 2 },
    );
    expect(inserted).toBe(false);
    expect(
      (await env.DB.prepare('SELECT id FROM google_connections').all()).results?.length ?? 0,
    ).toBe(0);
  });
});

describe('disconnect and revoke', () => {
  it('disconnect disables locally and clears the refresh token with no Google call', async () => {
    const { fetchImpl, calls } = googleFixture({});
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'connected' });
    const res = await api(app, `/api/v1/admin/google/connections/${id}/disconnect`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const row = await readConnectionRow(id);
    expect(row?.state).toBe('disabled');
    expect(row?.enabled).toBe(0);
    expect(row?.refresh_envelope).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('revoke calls the fixed revoke endpoint then disables', async () => {
    const { fetchImpl, calls } = googleFixture({});
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    const { id } = await seedConnection({ state: 'connected' });
    const res = await api(app, `/api/v1/admin/google/connections/${id}/revoke`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedUpstream: boolean };
    expect(body.revokedUpstream).toBe(true);
    const revokeCall = calls.find((call) => call.url.startsWith(GOOGLE_REVOKE_ENDPOINT));
    expect(revokeCall).toBeDefined();
    expect(new URLSearchParams(revokeCall?.init?.body as string).get('token')).toBe(
      'refresh-old',
    );
    const row = await readConnectionRow(id);
    expect(row?.state).toBe('disabled');
    expect(row?.refresh_envelope).toBeNull();
  });

  it('lists connections without exposing envelopes or principals', async () => {
    const { fetchImpl } = googleFixture({});
    const app = makeRouter({ fetchImpl });
    await seedOAuthClient();
    await seedConnection({ state: 'connected' });
    const res = await api(app, '/api/v1/admin/google/connections');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: Record<string, unknown>[] };
    expect(body.connections.length).toBe(1);
    const view = ConnectionViewSchema.parse(body.connections[0]);
    expect(view.displayEmail).toBe('op@example.com');
    expect('refresh_envelope' in (body.connections[0] ?? {})).toBe(false);
    expect('principalId' in (body.connections[0] ?? {})).toBe(false);
    expect('principal_id' in (body.connections[0] ?? {})).toBe(false);
  });
});
