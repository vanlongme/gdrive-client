/**
 * T15 failure-matrix gaps (worker B) — provider independence. The real
 * content/upload routers drive the REAL providers against the coordinator DO;
 * only the Google HTTP boundary is faked. Covers spec §14:
 *  - disable one SA blocks only that SA's reads (OAuth upload unaffected)
 *  - disable OAuth never fails download-by-ID while SA/mount stay valid
 *  - SA failure never falls back to OAuth content bytes
 *  - OAuth refresh races single-flight into one upstream grant
 *  - a callback grant missing the write scope never enables a write conn
 */
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { createContentRouter } from '../../src/worker/transfers/download';
import { createUploadRouter } from '../../src/worker/transfers/upload-routes';
import { createOAuthRouter } from '../../src/worker/drive/oauth/routes';
import { createVault, encodeEnvelope } from '../../src/worker/security/vault';
import {
  oauthClientSecretContext,
  oauthRefreshTokenContext,
  serviceAccountKeyContext,
  setGoogleFetchForTests,
  VAULT_KEY_ID,
  type OAuthTokenIdentity,
} from '../../src/worker/drive/tokens';
import type { Actor } from '../../src/worker/auth/grants';
import { FakeGoogle, md5Hex, sha256Hex } from './fault-fake-google';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];
const TEST_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ORIGIN = 'http://worker.test';
const encoder = new TextEncoder();

const actor: Actor = {
  kind: 'user',
  user: {
    id: 'user-1',
    name: 'U',
    email: 'u@test',
    role: 'user',
    disabled: false,
    createdAt: new Date(0).toISOString(),
  },
  sessionId: 'sess-1',
};

let saPemPromise: Promise<string> | undefined;
function saPem(): Promise<string> {
  saPemPromise ??= (async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    let binary = '';
    for (const b of der) binary += String.fromCharCode(b);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  })();
  return saPemPromise;
}

async function resetState() {
  for (const table of [
    'upload_batch_nodes', 'upload_batches', 'upload_operations', 'file_readiness',
    'mount_grants', 'mount_read_credentials', 'mounts', 'google_connections',
    'oauth_transactions', 'google_oauth_clients', 'service_accounts', 'user', 'app_settings',
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

async function seedWorld(fake: FakeGoogle) {
  const vault = createVault(TEST_MASTER_KEY, VAULT_KEY_ID);
  await env.DB.prepare(
    "INSERT INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) VALUES (1, 'install-1', 'complete', 'https://app.test', 1, 0, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('user-1', 'U', 'u@test', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'user')",
  ).run();
  const secretEnv = encodeEnvelope(
    await vault.sealSecret(encoder.encode('client-secret-1'), oauthClientSecretContext('client-1', 'proj-1')),
  );
  await env.DB.prepare(
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('client-1', 'proj-1', 'cid-1', ?, 'https://app.test/cb', 1, 1, 0, 0)",
  )
    .bind(secretEnv)
    .run();
  const refreshEnv = encodeEnvelope(
    await vault.sealSecret(encoder.encode('ort-1'), oauthRefreshTokenContext('conn-1', 'proj-1')),
  );
  await env.DB.prepare(
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-1', 'client-1', 'perm-1', 'w@test', ?, 'https://www.googleapis.com/auth/drive', 'connected', 1, 1, 'user-1', 0, 0)",
  )
    .bind(refreshEnv)
    .run();
  const saEnv = encodeEnvelope(
    await vault.sealSecret(
      encoder.encode(
        JSON.stringify({
          client_email: 'sa-1@proj-1.iam.gserviceaccount.com',
          private_key: await saPem(),
          private_key_id: 'k1',
        }),
      ),
      serviceAccountKeyContext('sa-1', 'proj-1'),
    ),
  );
  await env.DB.prepare(
    "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-1', 'proj-1', 'sa-1@proj-1.iam.gserviceaccount.com', 'k1', ?, 1, 1, 0, 0)",
  )
    .bind(saEnv)
    .run();
  await env.DB.prepare(
    "INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('mount-1', 'M', ?, 'conn-1', 'conn-1', 1, 'private', 1, 0, 0)",
  )
    .bind(fake.driveId)
    .run();
  await env.DB.prepare(
    "INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('mount-1', 'sa-1', 1, 1, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES ('user-1', 'mount-1', 'uploader', '[\"read\",\"upload\"]', 'user-1', 0, 0)",
  ).run();
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/v1/uploads', createUploadRouter({ resolveActorFn: () => Promise.resolve(actor) }));
  app.route('/api/v1/mounts', createContentRouter({ resolveSessionActor: () => Promise.resolve(actor) }));
  return app;
}

function api(app: Hono<{ Bindings: Env }>, path: string, init?: RequestInit) {
  return Promise.resolve(
    app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env),
  );
}

interface View {
  uploadId: string;
  state: string;
  sessionGeneration: number;
  readerAccessState?: string;
}

async function uploadFile(
  app: Hono<{ Bindings: Env }>,
  key: string,
  content: Uint8Array,
): Promise<{ view: View; fileId: string }> {
  const res = await api(app, '/api/v1/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({
      mountId: 'mount-1',
      parentId: 'folder-1',
      name: `${key}.bin`,
      mimeType: 'application/octet-stream',
      totalBytes: String(content.byteLength),
      sha256: await sha256Hex(content),
      md5: md5Hex(content),
    }),
  });
  expect(res.status).toBe(200);
  const init = (await res.json()) as View;
  const put = await api(app, `/api/v1/uploads/${init.uploadId}/chunks?generation=${init.sessionGeneration}&offset=0`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(content.byteLength) },
    body: content as unknown as BodyInit,
  });
  const done = (await put.json()) as View;
  const fileId = `file-${key === 'k-a' ? '1' : key === 'k-b' ? '2' : '1'}`;
  void fileId;
  return { view: done, fileId: '' };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

afterEach(() => {
  setGoogleFetchForTests(undefined);
  vi.unstubAllGlobals();
});

describe('provider independence faults', () => {
  it('disabling the only SA blocks reads but never the OAuth upload path', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    fake.addFolder('folder-1');
    const app = makeApp();

    // Upload completes with the SA disabled — reader state is the only thing
    // affected, never the write path.
    await env.DB.prepare("UPDATE service_accounts SET enabled = 0, version = version + 1 WHERE id = 'sa-1'").run();
    const { view } = await uploadFile(app, 'k-a', new Uint8Array(9));
    expect(view.state).toBe('completed');
    const puts = fake.requests.filter(
      (r) => r.method === 'PUT' && r.url.pathname.startsWith('/upload/'),
    );
    expect(puts.length).toBe(1);
    expect(puts[0]?.provider).toBe('google_oauth');

    const fileId = [...fake.sessions.values()][0]!.meta.id!;
    // With the SA disabled the content read cannot proceed — no fallback.
    const denied = await api(app, `/api/v1/mounts/mount-1/files/${fileId}/content`);
    expect(denied.status).not.toBe(200);
    // Re-enable: the same file reads fine.
    await env.DB.prepare("UPDATE service_accounts SET enabled = 1, version = version + 1 WHERE id = 'sa-1'").run();
    const ok = await api(app, `/api/v1/mounts/mount-1/files/${fileId}/content`);
    expect(ok.status).toBe(200);
  });

  it('disabling the OAuth connection never fails download-by-ID while SA/mount stay valid', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    fake.addFolder('folder-1');
    const app = makeApp();

    const { view } = await uploadFile(app, 'k-b', new Uint8Array(7));
    expect(view.state).toBe('completed');
    const fileId = [...fake.sessions.values()][0]!.meta.id!;

    await env.DB.prepare("UPDATE google_connections SET enabled = 0, state = 'disabled', version = version + 1 WHERE id = 'conn-1'").run();
    const res = await api(app, `/api/v1/mounts/mount-1/files/${fileId}/content`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(7));
  });

  it('an SA read failure never falls back to OAuth content bytes', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    fake.addFolder('folder-1');
    const app = makeApp();

    const { view } = await uploadFile(app, 'k-c', new Uint8Array(5));
    expect(view.state).toBe('completed');
    const fileId = [...fake.sessions.values()][0]!.meta.id!;
    fake.saDeniedFiles.add(fileId);
    const res = await api(app, `/api/v1/mounts/mount-1/files/${fileId}/content`);
    expect(res.status).not.toBe(200);
    const oauthMedia = fake.requests.filter(
      (r) => r.provider === 'google_oauth' && r.url.searchParams.get('alt') === 'media',
    );
    expect(oauthMedia).toEqual([]);
  });

  it('concurrent OAuth refresh admissions single-flight into one upstream grant', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    setGoogleFetchForTests(fake.fetch);
    // A second project+connection so the DO token cache is cold — earlier
    // tests in this file already warmed 'proj-1'.
    const vault = createVault(TEST_MASTER_KEY, VAULT_KEY_ID);
    await env.DB.prepare(
      "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('client-2', 'proj-2', 'cid-2', ?, 'https://app.test/cb', 1, 1, 0, 0)",
    )
      .bind(
        encodeEnvelope(
          await vault.sealSecret(encoder.encode('client-secret-2'), oauthClientSecretContext('client-2', 'proj-2')),
        ),
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-2', 'client-2', 'perm-2', 'w2@test', ?, 'https://www.googleapis.com/auth/drive', 'connected', 1, 1, 'user-1', 0, 0)",
    )
      .bind(
        encodeEnvelope(
          await vault.sealSecret(encoder.encode('ort-2'), oauthRefreshTokenContext('conn-2', 'proj-2')),
        ),
      )
      .run();
    const identity: OAuthTokenIdentity = {
      provider: 'google_oauth',
      credentialId: 'conn-2',
      credentialVersion: 1,
      projectId: 'proj-2',
      principalId: 'perm-2',
      oauthClientId: 'client-2',
      oauthClientVersion: 1,
      scopes: ['https://www.googleapis.com/auth/drive'],
    };
    const stub = env.PROJECT_COORDINATOR.get(env.PROJECT_COORDINATOR.idFromName('proj-2'));
    const admit = () =>
      stub.fetch('https://project-coordinator.internal/admit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identity }),
      }).then((r) => r.json() as Promise<{ ok: boolean; accessToken?: string }>);
    const results = await Promise.all([admit(), admit(), admit()]);
    for (const r of results) expect(r.ok).toBe(true);
    const grants = fake.requests.filter(
      (r) => r.url.hostname === 'oauth2.googleapis.com' && r.url.pathname === '/token',
    );
    expect(grants.length).toBe(1);
  });

  it('a callback grant missing the write scope never enables a write connection', async () => {
    const fake = new FakeGoogle().install();
    fake.nextExchangeScope = 'https://www.googleapis.com/auth/drive.readonly';
    await seedWorld(fake);
    const app = new Hono<{ Bindings: Env }>();
    app.route(
      '/api/v1/admin/google',
      createOAuthRouter({
        fetchImpl: fake.fetch,
        requireAdmin: () =>
          Promise.resolve({ userId: 'user-1', sessionId: 'sess-1' }),
      }),
    );

    const start = await api(app, '/api/v1/admin/google/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'connect', oauthClientId: 'client-1' }),
    });
    expect(start.status).toBe(200);
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const tx = await env.DB.prepare(
      'SELECT redirect_uri FROM oauth_transactions ORDER BY created_at DESC LIMIT 1',
    ).first<{ redirect_uri: string }>();
    // The callback must land on the exact stored redirect URI.
    const cb = await Promise.resolve(
      app.fetch(
        new Request(`${tx!.redirect_uri}?state=${encodeURIComponent(state)}&code=c1`),
        env as unknown as Env,
      ),
    );
    expect(cb.status).toBe(200);
    const { connection } = (await cb.json()) as { connection: { state: string } };
    // Whatever the exact surface state, it must not be a usable write conn:
    // 'connected' would mean the mount-validation path could admit it.
    expect(connection.state).not.toBe('connected');
  });
});
