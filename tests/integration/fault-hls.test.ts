/**
 * T15 failure-matrix gap (worker B) — two concurrent advances on the same
 * media package must publish exactly one complete ready generation (spec
 * §14: "two tabs advance; only one generation ready"). Real package router +
 * real providers + coordinator DO; only the Google boundary is faked.
 */
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { createPackageRouter } from '../../src/worker/media/package-routes';
import { createVault, encodeEnvelope } from '../../src/worker/security/vault';
import {
  oauthClientSecretContext,
  oauthRefreshTokenContext,
  serviceAccountKeyContext,
  VAULT_KEY_ID,
} from '../../src/worker/drive/tokens';
import type { Actor } from '../../src/worker/auth/grants';
import { FakeGoogle } from './fault-fake-google';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];
const TEST_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ORIGIN = 'http://worker.test';
const encoder = new TextEncoder();

const actor: Actor = {
  kind: 'user',
  user: {
    id: 'user-1', name: 'U', email: 'u@test', role: 'user', disabled: false,
    createdAt: new Date(0).toISOString(),
  },
  sessionId: 'sess-1',
};

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000
media.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.0,
seg0.ts
#EXT-X-ENDLIST
`;

let saPemPromise: Promise<string> | undefined;
function saPem(): Promise<string> {
  saPemPromise ??= (async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign'],
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
    'media_package_resources', 'media_packages', 'file_readiness',
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
  await env.DB.prepare(
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('client-1', 'proj-1', 'cid-1', ?, 'https://app.test/cb', 1, 1, 0, 0)",
  )
    .bind(encodeEnvelope(await vault.sealSecret(encoder.encode('s1'), oauthClientSecretContext('client-1', 'proj-1'))))
    .run();
  await env.DB.prepare(
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-1', 'client-1', 'perm-1', 'w@test', ?, 'https://www.googleapis.com/auth/drive', 'connected', 1, 1, 'user-1', 0, 0)",
  )
    .bind(encodeEnvelope(await vault.sealSecret(encoder.encode('ort-1'), oauthRefreshTokenContext('conn-1', 'proj-1'))))
    .run();
  await env.DB.prepare(
    "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-1', 'proj-1', 'sa-1@proj-1.iam.gserviceaccount.com', 'k1', ?, 1, 1, 0, 0)",
  )
    .bind(
      encodeEnvelope(
        await vault.sealSecret(
          encoder.encode(JSON.stringify({
            client_email: 'sa-1@proj-1.iam.gserviceaccount.com',
            private_key: await saPem(),
            private_key_id: 'k1',
          })),
          serviceAccountKeyContext('sa-1', 'proj-1'),
        ),
      ),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('mount-1', 'M', ?, 'conn-1', 'conn-1', 1, 'private', 1, 0, 0)",
  ).bind(fake.driveId).run();
  await env.DB.prepare(
    "INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('mount-1', 'sa-1', 1, 1, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES ('user-1', 'mount-1', 'uploader', '[\"read\",\"upload\"]', 'user-1', 0, 0)",
  ).run();
}

function api(app: Hono<{ Bindings: Env }>, path: string, init?: RequestInit) {
  return Promise.resolve(
    app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('media package concurrent advance', () => {
  it('two racing advances publish exactly one complete ready generation', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    fake.addFolder('hls-dir');
    fake.addFile('f-master', encoder.encode(MASTER), {
      name: 'master.m3u8', mimeType: 'application/vnd.apple.mpegurl', parentId: 'hls-dir',
    });
    fake.addFile('f-media', encoder.encode(MEDIA), {
      name: 'media.m3u8', mimeType: 'application/vnd.apple.mpegurl', parentId: 'hls-dir',
    });
    fake.addFile('f-seg0', encoder.encode('SEGMENT0'), {
      name: 'seg0.ts', mimeType: 'video/mp2t', parentId: 'hls-dir',
    });

    const app = new Hono<{ Bindings: Env }>();
    app.route(
      '/api/v1/media-packages',
      createPackageRouter({ resolveSessionActor: () => Promise.resolve(actor) }),
    );
    const created = await api(app, '/api/v1/media-packages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mountId: 'mount-1', entryFileId: 'f-master' }),
    });
    expect(created.status).toBe(201);
    const { packageId } = (await created.json()) as { packageId: string };

    // Race pairs of advances until a complete reply lands.
    interface AdvanceBody { state?: string; complete?: boolean; indexGeneration?: number }
    let last: AdvanceBody = {};
    for (let i = 0; i < 30 && last.complete !== true; i++) {
      const [a, b] = await Promise.all([
        api(app, `/api/v1/media-packages/${packageId}/advance`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        }),
        api(app, `/api/v1/media-packages/${packageId}/advance`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        }),
      ]);
      last = (await a.json()) as AdvanceBody;
      const other = (await b.json()) as AdvanceBody;
      if (other.complete === true) last = other;
    }
    expect(last.complete).toBe(true);
    expect(last.state).toBe('ready');

    // Exactly one ready generation exists and it indexes the full graph —
    // no half-published racing generation survives.
    const pkg = await env.DB.prepare(
      'SELECT state, index_generation FROM media_packages WHERE id = ?',
    ).bind(packageId).first<{ state: string; index_generation: number }>();
    expect(pkg?.state).toBe('ready');
    const gens = await env.DB.prepare(
      'SELECT DISTINCT index_generation AS g FROM media_package_resources WHERE package_id = ?',
    ).bind(packageId).all<{ g: number }>();
    expect(gens.results.length).toBe(1);
    expect(gens.results[0]?.g).toBe(pkg?.index_generation);

    // Playlist + segment serve through the SA identity only, addressed by
    // the rewritten rN resource ids.
    const masterRes = await api(app, `/api/v1/media-packages/${packageId}/resources/r1`);
    expect(masterRes.status).toBe(200);
    const text = await masterRes.text();
    const segRef = text.split('\n').find((l) => /^r\d+/.test(l));
    expect(segRef).toBeTruthy();
    const segRes = await api(app, `/api/v1/media-packages/${packageId}/resources/${segRef}`);
    expect(segRes.status).toBe(200);
    const mediaCalls = fake.requests.filter(
      (r) => r.url.searchParams.get('alt') === 'media',
    );
    expect(mediaCalls.length).toBeGreaterThanOrEqual(2);
    expect(mediaCalls.every((r) => r.provider === 'service_account')).toBe(true);
  });
});
