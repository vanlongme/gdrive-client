import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createVault,
  encodeEnvelope,
} from '../../src/worker/security/vault';
import { createCoordinatorTokenSource } from '../../src/worker/drive/coordinator-client';
import type { CoordinatorTokenSource } from '../../src/worker/drive/types';
import {
  oauthClientSecretContext,
  oauthRefreshTokenContext,
  serviceAccountKeyContext,
  setGoogleFetchForTests,
  VAULT_KEY_ID,
  type FetchLike,
  type OAuthTokenIdentity,
  type ServiceAccountTokenIdentity,
  type TokenResult,
} from '../../src/worker/drive/tokens';
import { SA_READ_SCOPE } from '../../src/worker/drive/oauth/google';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const TEST_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
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

function b64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

let saPem = '';
let saPublicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  saPem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  saPublicKey = pair.publicKey;
});

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  // Tables persist between tests in the shared D1; clear what this suite owns.
  await env.DB.prepare('DELETE FROM google_connections').run();
  await env.DB.prepare('DELETE FROM google_oauth_clients').run();
  await env.DB.prepare('DELETE FROM service_accounts').run();
  await env.DB.prepare('DELETE FROM oauth_transactions').run();
});

afterEach(() => {
  setGoogleFetchForTests(undefined);
});

// ---------------------------------------------------------------------------
// D1 seeding helpers (vault-sealed fixture credentials — local only).
// ---------------------------------------------------------------------------

async function seedServiceAccount(
  projectId: string,
  options: { id?: string; email?: string; enabled?: number; version?: number } = {},
): Promise<ServiceAccountTokenIdentity> {
  const id = options.id ?? 'sa-1';
  const email = options.email ?? `sa@${projectId}.iam.gserviceaccount.com`;
  const vault = createVault(TEST_MASTER_KEY, VAULT_KEY_ID);
  const envelope = encodeEnvelope(
    await vault.sealSecret(
      encoder.encode(
        JSON.stringify({
          client_email: email,
          private_key: saPem,
          private_key_id: 'fixture-kid',
          token_uri: 'https://malicious.example/token',
        }),
      ),
      serviceAccountKeyContext(id, projectId),
    ),
  );
  await env.DB.prepare(
    'INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(id, projectId, email, 'fixture-kid', envelope, options.enabled ?? 1, options.version ?? 1)
    .run();
  return {
    provider: 'service_account',
    credentialId: id,
    credentialVersion: options.version ?? 1,
    projectId,
    principalId: email,
    scopes: [SA_READ_SCOPE],
  };
}

async function seedOAuthConnection(
  projectId: string,
  options: {
    connectionId?: string;
    clientId?: string;
    principalId?: string;
    connVersion?: number;
    clientVersion?: number;
    state?: string;
    enabled?: number;
    refreshToken?: string | null;
    scopes?: string;
  } = {},
): Promise<OAuthTokenIdentity> {
  const connectionId = options.connectionId ?? 'conn-1';
  const clientId = options.clientId ?? 'oc-1';
  const vault = createVault(TEST_MASTER_KEY, VAULT_KEY_ID);
  const secretEnvelope = encodeEnvelope(
    await vault.sealSecret(
      encoder.encode('client-secret-1'),
      oauthClientSecretContext(clientId, projectId),
    ),
  );
  await env.DB.prepare(
    'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0)',
  )
    .bind(
      clientId,
      projectId,
      'google-client-id-1',
      secretEnvelope,
      'https://app.test/api/v1/admin/google/oauth/callback',
      options.clientVersion ?? 2,
    )
    .run();
  const refreshEnvelope =
    options.refreshToken === null
      ? null
      : encodeEnvelope(
          await vault.sealSecret(
            encoder.encode(options.refreshToken ?? 'refresh-1'),
            oauthRefreshTokenContext(connectionId, projectId),
          ),
        );
  const principalId = options.principalId ?? 'perm-1';
  await env.DB.prepare(
    'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)',
  )
    .bind(
      connectionId,
      clientId,
      principalId,
      'op@example.com',
      refreshEnvelope,
      options.scopes ?? 'https://www.googleapis.com/auth/drive',
      options.state ?? 'connected',
      options.enabled ?? 1,
      options.connVersion ?? 3,
    )
    .run();
  return {
    provider: 'google_oauth',
    credentialId: connectionId,
    credentialVersion: options.connVersion ?? 3,
    projectId,
    principalId,
    oauthClientId: clientId,
    oauthClientVersion: options.clientVersion ?? 2,
    scopes: ['https://www.googleapis.com/auth/drive'],
  };
}

// ---------------------------------------------------------------------------
// DO wire helpers.
// ---------------------------------------------------------------------------

function coordinatorStub(projectId: string): DurableObjectStub {
  return env.PROJECT_COORDINATOR.get(env.PROJECT_COORDINATOR.idFromName(projectId));
}

// The DO only answers the pinned internal origin (W6-F finding 5); the
// production client in coordinator-client.ts uses the same constant.
const COORDINATOR_ORIGIN = 'https://project-coordinator.internal';

async function admit(
  identity: ServiceAccountTokenIdentity | OAuthTokenIdentity,
  extra: { fileId?: string } = {},
): Promise<TokenResult> {
  const res = await coordinatorStub(identity.projectId).fetch(
    `${COORDINATOR_ORIGIN}/admit`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity, ...extra }),
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as TokenResult;
}

async function reportFailure(
  identity: ServiceAccountTokenIdentity | OAuthTokenIdentity,
  report: { kind: string; fileId?: string; retryAfterMs?: number },
): Promise<void> {
  const res = await coordinatorStub(identity.projectId).fetch(
    `${COORDINATOR_ORIGIN}/report-failure`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity, report }),
    },
  );
  expect(res.status).toBe(200);
}

async function health(projectId: string): Promise<{ cooldowns: { scope_key: string; until_ms: number }[] }> {
  const res = await coordinatorStub(projectId).fetch(`${COORDINATOR_ORIGIN}/health`);
  return (await res.json()) as { cooldowns: { scope_key: string; until_ms: number }[] };
}

// ---------------------------------------------------------------------------
// Origin assertion (W6-F finding 5): a foreign origin never reaches a
// command, matching the UploadSession.fetch contract.
// ---------------------------------------------------------------------------

describe('origin assertion', () => {
  it('rejects foreign-origin requests before any command handling', async () => {
    const stub = coordinatorStub('proj-origin-check');
    const post = await stub.fetch('https://evil.example/admit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: {} }),
    });
    expect(post.status).toBe(400);
    const postBody = (await post.json()) as { error: { code: string } };
    expect(postBody.error.code).toBe('INVALID_COMMAND');

    const get = await stub.fetch('https://evil.example/health');
    expect(get.status).toBe(400);
    const getBody = (await get.json()) as { error: { code: string } };
    expect(getBody.error.code).toBe('INVALID_COMMAND');
  });
});

// ---------------------------------------------------------------------------
// Service account admission.
// ---------------------------------------------------------------------------

describe('maintenance gate caching (wave-9 L2)', () => {
  it('fails closed on a D1 error but never caches the fail-closed verdict', async () => {
    const projectId = 'proj-maint-cache';
    const stub = coordinatorStub(projectId);
    const identity: ServiceAccountTokenIdentity = {
      provider: 'service_account',
      credentialId: 'sa-none',
      credentialVersion: 1,
      projectId,
      principalId: 'sa-none@x.iam.gserviceaccount.com',
      scopes: [SA_READ_SCOPE],
    };
    let realDB: D1Database | undefined;
    // Break only maintenance_state reads inside the live DO instance.
    await runInDurableObject(stub, async (instance) => {
      const holder = instance as unknown as { env: Env };
      realDB = holder.env.DB;
      const inner = realDB!;
      holder.env = {
        ...holder.env,
        DB: {
          prepare(sql: string) {
            if (sql.includes('maintenance_state')) {
              const stmt = {
                bind: () => stmt,
                first: () => Promise.reject(new Error('D1 read failed')),
                all: () => Promise.reject(new Error('D1 read failed')),
                run: () => Promise.reject(new Error('D1 read failed')),
                raw: () => Promise.reject(new Error('D1 read failed')),
              };
              return stmt as unknown as D1PreparedStatement;
            }
            return inner.prepare(sql);
          },
          batch: (s: D1PreparedStatement[]) => inner.batch(s),
          exec: (q: string) => inner.exec(q),
          dump: () => inner.dump(),
          withSession: (() => inner.withSession()) as D1Database['withSession'],
        } as D1Database,
      };
    });
    const during = (await admit(identity)) as {
      ok: boolean;
      code?: string;
      detail?: string;
    };
    expect(during.ok).toBe(false);
    expect(during.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(during.detail).toBe('maintenance_mode');

    // Restore D1: the very next admission must RE-READ maintenance_state —
    // the error verdict may not be cached under the 2 s TTL (L2).
    await runInDurableObject(stub, async (instance) => {
      const holder = instance as unknown as { env: Env };
      holder.env = { ...holder.env, DB: realDB! };
    });
    const after = (await admit(identity)) as { ok: boolean; code?: string };
    expect(after.ok).toBe(false);
    // Past the maintenance gate now: identity verification answers instead.
    expect(after.code).toBe('CREDENTIAL_DISABLED');
  });
});

describe('service account admission', () => {
  it('issues a token via a verifiably-signed readonly JWT, then serves from RAM cache', async () => {
    const identity = await seedServiceAccount('proj-sa-1');
    const { fetchImpl, calls } = fixtureFetch(() =>
      json({ access_token: 'sa-token-1', expires_in: 3600 }),
    );
    setGoogleFetchForTests(fetchImpl);

    const first = await admit(identity);
    expect(first).toMatchObject({ ok: true, accessToken: 'sa-token-1' });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');

    // Verify the signed assertion: readonly scope, fixed audience, no sub.
    const params = new URLSearchParams(calls[0]?.init?.body as string);
    const assertion = params.get('assertion') ?? '';
    const [h, p, s] = assertion.split('.');
    const claims = JSON.parse(decoder.decode(b64urlToBytes(p ?? ''))) as Record<string, unknown>;
    expect(claims.iss).toBe(identity.principalId);
    expect(claims.scope).toBe(SA_READ_SCOPE);
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect('sub' in claims).toBe(false);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      saPublicKey,
      b64urlToBytes(s ?? '') as Uint8Array<ArrayBuffer>,
      encoder.encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);

    const second = await admit(identity);
    expect(second).toMatchObject({ ok: true, accessToken: 'sa-token-1' });
    expect(calls.length).toBe(1); // RAM cache hit — no second upstream grant.
  });

  it('single-flights concurrent admissions into one upstream grant', async () => {
    const identity = await seedServiceAccount('proj-sa-2');
    let tokenCalls = 0;
    const { fetchImpl } = fixtureFetch(async () => {
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json({ access_token: 'sa-shared', expires_in: 3600 });
    });
    setGoogleFetchForTests(fetchImpl);
    const results = await Promise.all([
      admit(identity),
      admit(identity),
      admit(identity),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ ok: true, accessToken: 'sa-shared' });
    }
    expect(tokenCalls).toBe(1);
  });

  it('rejects a stale version pin even while a token is cached', async () => {
    const identity = await seedServiceAccount('proj-sa-3');
    setGoogleFetchForTests(fixtureFetch(() => json({ access_token: 't', expires_in: 3600 })).fetchImpl);
    expect((await admit(identity)).ok).toBe(true);
    await env.DB.prepare('UPDATE service_accounts SET version = 9 WHERE id = ?')
      .bind(identity.credentialId)
      .run();
    const stale = await admit(identity);
    expect(stale).toMatchObject({ ok: false, code: 'CREDENTIAL_VERSION_CHANGED' });
  });

  it('rejects disabled credentials before any upstream call', async () => {
    const identity = await seedServiceAccount('proj-sa-4', { enabled: 0 });
    const { fetchImpl, calls } = fixtureFetch(() => json({ access_token: 't', expires_in: 1 }));
    setGoogleFetchForTests(fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_DISABLED' });
    expect(calls.length).toBe(0);
  });

  it('refuses scopes outside drive.readonly without calling upstream', async () => {
    const identity = await seedServiceAccount('proj-sa-5');
    const { fetchImpl, calls } = fixtureFetch(() => json({ access_token: 't', expires_in: 1 }));
    setGoogleFetchForTests(fetchImpl);
    const result = await admit({
      ...identity,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    expect(result).toMatchObject({ ok: false, code: 'UPSTREAM_AUTH_FAILED' });
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cooldowns.
// ---------------------------------------------------------------------------

describe('cooldown and health', () => {
  it('turns a reported rate limit into credential cooldown persisted in storage', async () => {
    const identity = await seedServiceAccount('proj-cd-1');
    await reportFailure(identity, { kind: 'rate_limit' });
    const result = await admit(identity);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('COOLDOWN');
      expect(result.retryAfterMs ?? 0).toBeGreaterThan(0);
    }
    const snapshot = await health('proj-cd-1');
    expect(
      snapshot.cooldowns.some((row) => row.scope_key === `cred:service_account:${identity.credentialId}`),
    ).toBe(true);
  });

  it('scopes file cooldowns to the named file only', async () => {
    const identity = await seedServiceAccount('proj-cd-2');
    setGoogleFetchForTests(fixtureFetch(() => json({ access_token: 'tok', expires_in: 3600 })).fetchImpl);
    await reportFailure(identity, { kind: 'file_limited', fileId: 'file-9' });
    const blocked = await admit(identity, { fileId: 'file-9' });
    expect(blocked).toMatchObject({ ok: false, code: 'COOLDOWN' });
    // The same credential without the file context is unaffected.
    const allowed = await admit(identity);
    expect(allowed).toMatchObject({ ok: true, accessToken: 'tok' });
  });

  it('quarantines a credential whose upstream grant is rejected', async () => {
    const identity = await seedServiceAccount('proj-cd-3');
    setGoogleFetchForTests(
      fixtureFetch(() => json({ error: 'invalid_grant' }, 400)).fetchImpl,
    );
    const first = await admit(identity);
    expect(first).toMatchObject({ ok: false, code: 'UPSTREAM_AUTH_FAILED' });
    const second = await admit(identity);
    expect(second).toMatchObject({ ok: false, code: 'COOLDOWN' });
  });

  it('invalidates the cached grant on a reported auth failure (one fresh retry)', async () => {
    const identity = await seedServiceAccount('proj-cd-4');
    let tokenCalls = 0;
    const { fetchImpl } = fixtureFetch(() => {
      tokenCalls += 1;
      return json({ access_token: `sa-token-${tokenCalls}`, expires_in: 3600 });
    });
    setGoogleFetchForTests(fetchImpl);
    expect((await admit(identity)).ok).toBe(true);
    expect(tokenCalls).toBe(1);
    // Caller observed a 401 on the access token: report invalidates the cache.
    await reportFailure(identity, { kind: 'auth' });
    const retry = await admit(identity);
    expect(retry).toMatchObject({ ok: true, accessToken: 'sa-token-2' });
    expect(tokenCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// OAuth admission.
// ---------------------------------------------------------------------------

describe('oauth admission', () => {
  it('refreshes through the pinned connection/client and caches the grant', async () => {
    const identity = await seedOAuthConnection('proj-oauth-1');
    const { fetchImpl, calls } = fixtureFetch(() =>
      json({ access_token: 'oauth-at', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' }),
    );
    setGoogleFetchForTests(fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: true, accessToken: 'oauth-at' });
    const params = new URLSearchParams(calls[0]?.init?.body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-1');
    expect(params.get('client_secret')).toBe('client-secret-1');
  });

  it('maps invalid_grant to needs_reauth and persists the state transition', async () => {
    const identity = await seedOAuthConnection('proj-oauth-2');
    setGoogleFetchForTests(fixtureFetch(() => json({ error: 'invalid_grant' }, 400)).fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'OAUTH_NEEDS_REAUTH' });
    const row = await env.DB.prepare(
      'SELECT state, version FROM google_connections WHERE id = ?',
    )
      .bind(identity.credentialId)
      .first<{ state: string; version: number }>();
    expect(row?.state).toBe('needs_reauth');
    expect(row?.version).toBe(identity.credentialVersion + 1);
    // Once marked, subsequent admissions fail fast without an upstream call.
    const again = await admit({ ...identity, credentialVersion: identity.credentialVersion + 1 });
    expect(again).toMatchObject({ ok: false, code: 'OAUTH_NEEDS_REAUTH' });
  });

  it('rejects admission for a connection pinned to needs_reauth', async () => {
    const identity = await seedOAuthConnection('proj-oauth-3', { state: 'needs_reauth' });
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'OAUTH_NEEDS_REAUTH' });
  });

  it('rejects a connection missing its refresh token', async () => {
    const identity = await seedOAuthConnection('proj-oauth-4', { refreshToken: null });
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'OAUTH_NEEDS_REAUTH' });
  });

  it('cooldowns the credential after an upstream 5xx from the token endpoint', async () => {
    const identity = await seedOAuthConnection('proj-oauth-5');
    setGoogleFetchForTests(
      fixtureFetch(() => new Response('upstream exploded', { status: 503 })).fetchImpl,
    );
    const first = await admit(identity);
    expect(first).toMatchObject({ ok: false, code: 'UPSTREAM_UNAVAILABLE' });
    const second = await admit(identity);
    expect(second).toMatchObject({ ok: false, code: 'COOLDOWN' });
  });

  it('does not vend a token when the credential is disabled mid-grant', async () => {
    const identity = await seedOAuthConnection('proj-oauth-6');
    let tokenCalls = 0;
    const { fetchImpl } = fixtureFetch(async () => {
      tokenCalls += 1;
      // Simulate an admin disconnect racing the in-flight refresh grant.
      await env.DB.prepare(
        "UPDATE google_connections SET enabled = 0, state = 'disabled', version = version + 1 WHERE id = ?",
      )
        .bind(identity.credentialId)
        .run();
      return json({ access_token: 'stale-token', expires_in: 3600 });
    });
    setGoogleFetchForTests(fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_DISABLED' });
    expect(tokenCalls).toBe(1);
    // The dropped token was never cached: a second admission fails the same
    // way without another upstream grant.
    const second = await admit(identity);
    expect(second).toMatchObject({ ok: false, code: 'CREDENTIAL_DISABLED' });
    expect(tokenCalls).toBe(1);
  });

  it('vends the grant when our own rotation CAS bumped the version', async () => {
    const identity = await seedOAuthConnection('proj-oauth-7');
    const { fetchImpl } = fixtureFetch(() =>
      json({ access_token: 'rotated-at', expires_in: 3600, refresh_token: 'refresh-2' }),
    );
    setGoogleFetchForTests(fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: true, accessToken: 'rotated-at' });
    const row = await env.DB.prepare(
      'SELECT version FROM google_connections WHERE id = ?',
    )
      .bind(identity.credentialId)
      .first<{ version: number }>();
    expect(row?.version).toBe(identity.credentialVersion + 1);
  });

  it('rejects the vend when the OAuth client is disabled mid-grant', async () => {
    const identity = await seedOAuthConnection('proj-oauth-8');
    const { fetchImpl } = fixtureFetch(async () => {
      await env.DB.prepare('UPDATE google_oauth_clients SET enabled = 0 WHERE id = ?')
        .bind(identity.oauthClientId)
        .run();
      return json({ access_token: 'stale', expires_in: 3600 });
    });
    setGoogleFetchForTests(fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_DISABLED' });
  });

  it('rejects the vend when the OAuth client version bumps mid-grant', async () => {
    const identity = await seedOAuthConnection('proj-oauth-9');
    const { fetchImpl } = fixtureFetch(async () => {
      await env.DB.prepare(
        'UPDATE google_oauth_clients SET version = version + 1 WHERE id = ?',
      )
        .bind(identity.oauthClientId)
        .run();
      return json({ access_token: 'stale', expires_in: 3600 });
    });
    setGoogleFetchForTests(fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_VERSION_CHANGED' });
  });

  it('rejects the vend when the connection version alone bumps mid-grant', async () => {
    const identity = await seedOAuthConnection('proj-oauth-10');
    const { fetchImpl } = fixtureFetch(async () => {
      await env.DB.prepare(
        'UPDATE google_connections SET version = version + 1 WHERE id = ?',
      )
        .bind(identity.credentialId)
        .run();
      return json({ access_token: 'stale', expires_in: 3600 });
    });
    setGoogleFetchForTests(fetchImpl);
    const result = await admit(identity);
    expect(result).toMatchObject({ ok: false, code: 'CREDENTIAL_VERSION_CHANGED' });
  });
});

// ---------------------------------------------------------------------------
// Integration contract: the frozen CoordinatorTokenSource type must be
// assignable so B providers cannot drift against the DO implementation.
// ---------------------------------------------------------------------------

describe('frozen CoordinatorTokenSource contract', () => {
  it('createCoordinatorTokenSource satisfies the frozen interface end to end', async () => {
    const identity = await seedServiceAccount('proj-sa-contract');
    const { fetchImpl } = fixtureFetch(() =>
      json({ access_token: 'contract-token', expires_in: 3600 }),
    );
    setGoogleFetchForTests(fetchImpl);
    // Compile-time drift guard + wire-level roundtrip in one assertion.
    const source: CoordinatorTokenSource = createCoordinatorTokenSource(env);
    const result = await source.getToken(identity, { fileId: 'file-1' });
    expect(result).toMatchObject({ ok: true, accessToken: 'contract-token' });
    await source.reportFailure(identity, { kind: 'rate_limit', retryAfterMs: 1 });
    const cooled = await source.getToken(identity);
    expect(cooled).toMatchObject({ ok: false, code: 'COOLDOWN' });
  });
});
