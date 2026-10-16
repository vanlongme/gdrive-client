/**
 * T15 failure-matrix gaps (worker B) — upload boundary faults driven through
 * the REAL upload/folders routers with the REAL providers + coordinator DO;
 * only the Google HTTP boundary is faked (fault-fake-google.ts).
 *
 *  - exact 8 MiB default-chunk boundary + short final chunk
 *  - disabling the pinned OAuth connection mid-upload blocks chunk/probe/
 *    mkdir/cleanup with ZERO further upstream writes and no identity fallback
 *  - 409 on the pinned generated ID with different content never mints a
 *    second ID and never marks the upload complete
 */
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { createUploadRouter } from '../../src/worker/transfers/upload-routes';
import { createFolderRouter } from '../../src/worker/transfers/folders';
import { createVault, encodeEnvelope } from '../../src/worker/security/vault';
import {
  oauthClientSecretContext,
  oauthRefreshTokenContext,
  serviceAccountKeyContext,
  VAULT_KEY_ID,
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

function makeApp(chunkSizeBytes?: number) {
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    '/api/v1/uploads',
    createUploadRouter({
      resolveActorFn: () => Promise.resolve(actor),
      ...(chunkSizeBytes === undefined ? {} : { chunkSizeBytes }),
    }),
  );
  app.route(
    '/api/v1/folders',
    createFolderRouter({ resolveActorFn: () => Promise.resolve(actor) }),
  );
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
  confirmedOffset: string;
  readerAccessState?: string;
}

async function initUpload(
  app: Hono<{ Bindings: Env }>,
  key: string,
  content: Uint8Array,
  name = 'f.bin',
): Promise<View> {
  const res = await api(app, '/api/v1/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({
      mountId: 'mount-1',
      parentId: 'folder-1',
      name,
      mimeType: 'application/octet-stream',
      totalBytes: String(content.byteLength),
      sha256: await sha256Hex(content),
      md5: md5Hex(content),
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as View;
}

function putChunk(
  app: Hono<{ Bindings: Env }>,
  id: string,
  generation: number,
  offset: string,
  bytes: Uint8Array,
) {
  return api(app, `/api/v1/uploads/${id}/chunks?generation=${generation}&offset=${offset}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
    body: bytes as unknown as BodyInit,
  });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upload boundary faults (real routers + real providers + fake Google)', () => {
  it('streams an exact 8 MiB chunk then a short final chunk to completion', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    fake.addFolder('folder-1');
    const app = makeApp();
    const CHUNK = 8 * 1024 * 1024;
    const content = new Uint8Array(CHUNK + 5);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;

    const view = await initUpload(app, 'k-8mib', content);
    const first = await putChunk(app, view.uploadId, view.sessionGeneration, '0', content.subarray(0, CHUNK));
    expect(first.status).toBe(200);
    const v1 = (await first.json()) as View;
    expect(v1.state).toBe('uploading');
    expect(v1.confirmedOffset).toBe(String(CHUNK));

    const last = await putChunk(app, view.uploadId, view.sessionGeneration, String(CHUNK), content.subarray(CHUNK));
    expect(last.status).toBe(200);
    const v2 = (await last.json()) as View;
    expect(v2.state).toBe('completed');

    const puts = fake.requests.filter(
      (r) => r.method === 'PUT' && r.url.pathname.startsWith('/upload/'),
    );
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK, 5]);
    expect(puts.every((p) => p.provider === 'google_oauth')).toBe(true);
  });

  it('disabling the pinned OAuth connection blocks chunk/probe/mkdir/cleanup with zero further upstream writes', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    fake.addFolder('folder-1');
    const app = makeApp(8);
    const content = new Uint8Array(12);

    const view = await initUpload(app, 'k-disable', content);
    const first = await putChunk(app, view.uploadId, view.sessionGeneration, '0', content.subarray(0, 8));
    if (first.status !== 200) console.log('FIRST', await first.clone().text(), JSON.stringify(view));
    expect(first.status).toBe(200);

    // Admin disables the pinned write connection mid-upload.
    await env.DB.prepare("UPDATE google_connections SET enabled = 0, state = 'disabled', version = version + 1 WHERE id = 'conn-1'").run();
    const writesAfterDisable = () =>
      fake.requests.filter(
        (r) => r.provider === 'google_oauth' && r.method !== 'GET',
      ).length;
    const before = writesAfterDisable();

    // Chunk: fenced before any upstream call.
    const chunk = await putChunk(app, view.uploadId, view.sessionGeneration, '8', content.subarray(8));
    const chunkBody = (await chunk.json()) as View & { error?: { code: string } };
    expect(chunkBody.state).not.toBe('completed');
    // Probe (reconcile) is blocked identically.
    await api(app, `/api/v1/uploads/${view.uploadId}/reconcile`, { method: 'POST' });
    // mkdir (createFolder depends on the same writer) is refused.
    const mkdir = await api(app, '/api/v1/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'mk-1' },
      body: JSON.stringify({ mountId: 'mount-1', parentId: 'folder-1', name: 'sub' }),
    });
    expect(mkdir.status).not.toBe(200);
    // cleanup (cancel -> trash) cannot reach upstream either.
    await api(app, `/api/v1/uploads/${view.uploadId}/cancel`, { method: 'POST' });

    expect(writesAfterDisable()).toBe(before);
    // And nothing was written through a different identity (SA or B).
    expect(fake.requests.filter((r) => r.provider === 'service_account' && r.method !== 'GET')).toEqual([]);
  });

  it('409 on the pinned generated ID with different content never mints a second ID and never completes', async () => {
    const fake = new FakeGoogle().install();
    await seedWorld(fake);
    fake.addFolder('folder-1');
    // The generated ID is deterministic: 'file-1' already exists upstream
    // with different content.
    fake.addFile('file-1', new Uint8Array([9, 9, 9, 9]), { name: 'other.bin' });
    const app = makeApp();
    const content = new Uint8Array(7);
    const view = await initUpload(app, 'k-409', content);
    // Conflict → blocked/conflict, never completed, never a second ID.
    expect(view.state).not.toBe('completed');
    const genCalls = fake.requests.filter((r) => r.url.pathname.endsWith('/generateIds'));
    expect(genCalls.length).toBe(1);
    // The colliding upstream file was looked up — never overwritten.
    expect(fake.files.get('file-1')?.name).toBe('other.bin');
    expect(fake.files.get('file-1')?.bytes).toEqual(new Uint8Array([9, 9, 9, 9]));
    // And no resumable session for our content was created.
    expect(fake.sessions.size).toBe(0);
  });
});
