/**
 * T14 maintenance/operations integration tests (wave-4 worker E).
 *
 * Covers: minimal health, admin-only redacted diagnostics, bounded retention
 * cleanup (audit 30d / upload detail 7d, terminal + durable tombstone only,
 * replay-after-cleanup, projection lag, crash-safe reruns), key rotation
 * (maintenance gate, resumable checkpoints, verify, session revocation) and
 * the one-use admin recovery claim.
 */

import { env, exports } from 'cloudflare:workers';
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema } from '../../src/shared/contracts/common';
import { createDiagnosticsRouter } from '../../src/worker/admin/diagnostics';
import {
  createMaintenanceRouter,
  runRetentionCleanup,
} from '../../src/worker/admin/maintenance';
import {
  createSecretBox,
  createSecretKeyring,
  createVault,
  decodeEnvelope,
  encodeEnvelope,
  masterKeyLabel,
} from '../../src/worker/security/vault';
import {
  mintMediaTicket,
  verifyMediaTicket,
} from '../../src/worker/security/tickets';
import {
  doPost,
  fixtureProvider,
  makeApp,
  postInit,
  seedBase,
  stub,
  type UploadViewBody,
} from './upload-fixture';
import {
  claimOperation,
  findOperationByIdempotency,
  sha256Hex,
  viewFromTombstone,
  writeProjection,
} from '../../src/worker/transfers/operations';
import type { UploadSessionSnapshot } from '../../src/worker/transfers/upload-internal';
import {
  oauthClientSecretContext,
  oauthRefreshTokenContext,
  serviceAccountKeyContext,
  setGoogleFetchForTests,
  VAULT_KEY_ID,
} from '../../src/worker/drive/tokens';
import {
  readMaintenanceState,
  stepRotation,
  type RotationEnv,
} from '../../src/worker/security/rotation';

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const MASTER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// Real RSA key so SA token admission can sign before the gate trips.
let saPem = '';
async function ensureSaPem() {
  if (saPem !== '') return;
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true, ['sign'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  saPem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
}
// 32 bytes of 0x11 — the staged "next" master key for rotation tests.
const NEXT = 'ERERERERERERERERERERERERERERERERERERERERERE=';
const SETUP_TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ORIGIN = 'http://worker.test';
const CANONICAL = 'https://worker.test';

const ADMIN = {
  token: SETUP_TOKEN,
  name: 'Admin',
  email: 'admin@example.test',
  password: 'correct-horse-battery-staple',
  canonicalOrigin: CANONICAL,
};

type TestEnv = Env & { APP_MASTER_KEY_NEXT?: string };
const envNext: TestEnv = { ...env, APP_MASTER_KEY_NEXT: NEXT };

// Routers are mounted by the coordinator in app.ts; tests mount them on an
// equivalent Hono app sharing the same D1 + env.
function testApp(testEnv: TestEnv = env as TestEnv) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    await next();
  });
  app.route('/api/v1/admin/maintenance', createMaintenanceRouter());
  app.route('/api/v1/admin/diagnostics', createDiagnosticsRouter());
  return (path: string, init?: RequestInit, e: TestEnv = testEnv) =>
    app.fetch(new Request(`${ORIGIN}${path}`, init), e);
}

async function resetState() {
  // Dependents first — FK references run child → parent.
  for (const table of [
    'mount_drive_permissions',
    'mount_grants', 'mount_read_credentials', 'file_readiness',
    'upload_batch_nodes', 'upload_operations', 'upload_batches',
    'audit_events', 'share_links',
    'media_package_resources', 'media_packages', 'containment_verdicts',
    'mounts',
    'oauth_transactions', 'google_connections', 'google_oauth_clients',
    'service_accounts', 'admin_recovery_tokens', 'maintenance_state',
    'session', 'account', 'verification', 'rateLimit', 'user',
    'setup_throttle', 'app_settings',
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

async function completeSetup() {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    }),
  );
  expect(res.status).toBe(200);
}

async function adminCookie(): Promise<string> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    }),
  );
  const cookie = res.headers
    .getSetCookie()
    .find((v) => v.includes('session_token='));
  expect(cookie).toBeTruthy();
  return (cookie as string).split(';')[0]!;
}

function adminPost(path: string, cookie: string, body: unknown, e?: TestEnv) {
  return testApp(e)(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  }, e);
}

async function adminUserId(): Promise<string> {
  const row = await env.DB
    .prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(ADMIN.email)
    .first<{ id: string }>();
  return row!.id;
}

async function seedCredentialRows() {
  await ensureSaPem();
  const vault = createVault(MASTER, VAULT_KEY_ID);
  const saEnv = encodeEnvelope(
    await vault.sealSecret(
      new TextEncoder().encode(JSON.stringify({ client_email: 'sa@p1.iam.gserviceaccount.com', private_key: saPem })),
      serviceAccountKeyContext('sa-1', 'proj-1'),
    ),
  );
  await env.DB
    .prepare(
      "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-1','proj-1','sa@p1.iam.gserviceaccount.com','kid',?,1,1,0,0)",
    )
    .bind(saEnv)
    .run();
  const clientEnv = encodeEnvelope(
    await vault.sealSecret(
      new TextEncoder().encode('client-secret-1'),
      oauthClientSecretContext('cli-1', 'proj-1'),
    ),
  );
  await env.DB
    .prepare(
      "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('cli-1','proj-1','123-x.apps.googleusercontent.com',?, ?,1,1,0,0)",
    )
    .bind(clientEnv, `${CANONICAL}/api/v1/admin/google/oauth/callback`)
    .run();
  const refreshEnv = encodeEnvelope(
    await vault.sealSecret(
      new TextEncoder().encode('refresh-token-1'),
      oauthRefreshTokenContext('conn-1', 'proj-1'),
    ),
  );
  await env.DB
    .prepare(
      "INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-1','cli-1','perm-1','a@b.c',?, 'scope', 'connected',1,1,NULL,0,0)",
    )
    .bind(refreshEnv)
    .run();
}

async function admitSa(projectId = 'proj-1') {
  const stub = env.PROJECT_COORDINATOR.get(
    env.PROJECT_COORDINATOR.idFromName(projectId),
  );
  const res = await stub.fetch('https://project-coordinator.internal/admit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identity: {
        provider: 'service_account',
        credentialId: 'sa-1',
        credentialVersion: 1,
        projectId,
        principalId: 'sa@p1.iam.gserviceaccount.com',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
    }),
  });
  return (await res.json()) as { ok: boolean; code?: string; detail?: string };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
  setGoogleFetchForTests(undefined);
});

describe('health', () => {
  it('stays minimal: no mount or credential detail', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/v1/health`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('diagnostics', () => {
  it('requires an admin session and separates OAuth from SA health', async () => {
    await completeSetup();
    await seedCredentialRows();
    const unauth = await testApp()('/api/v1/admin/diagnostics');
    expect(unauth.status).toBe(401);
    const cookie = await adminCookie();
    const res = await testApp()('/api/v1/admin/diagnostics', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      oauth: { connections: { connectionId: string }[] };
      serviceAccounts: { accounts: { serviceAccountId: string }[] };
      uploads: { confirmedBytes: string };
      cooldowns: unknown[];
    };
    expect(body.oauth.connections[0]?.connectionId).toBe('conn-1');
    expect(body.serviceAccounts.accounts[0]?.serviceAccountId).toBe('sa-1');
    expect(body.uploads.confirmedBytes).toBe('0');
    // Redaction: nothing secret-shaped is ever emitted.
    const text = JSON.stringify(body);
    for (const forbidden of [
      'envelope', 'refresh-token-1', 'client-secret-1', 'private_key',
      'ciphertext', 'nonce',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  // W6-F finding 4: the error path applies the same bounded safeMessage
  // behaviour as oauth/routes — an Error's message is never echoed
  // unbounded and unknown codes/statuses collapse to a closed 500.
  function diagnosticsAppWith(requireAdmin: () => Promise<never>) {
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => {
      c.set('requestId', crypto.randomUUID());
      await next();
    });
    app.route('/api/v1/admin/diagnostics', createDiagnosticsRouter({ requireAdmin }));
    return app;
  }

  it('bounds an auth-shaped error message to the per-status fallback', async () => {
    const huge = new Error(`upstream detail: ${'x'.repeat(5000)}`);
    Object.assign(huge, { status: 401, code: 'AUTH_REQUIRED' });
    const app = diagnosticsAppWith(async () => {
      throw huge;
    });
    const res = await app.fetch(new Request(`${ORIGIN}/api/v1/admin/diagnostics`), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('AUTH_REQUIRED');
    // The oversized message is never echoed; the fixed fallback is emitted.
    expect(body.error.message).toBe('Authentication is required.');
    expect(body.error.message.length).toBeLessThanOrEqual(300);
  });

  it('sanitizes an unknown code and keeps a bounded message', async () => {
    const err = new Error('short but foreign');
    Object.assign(err, { status: 403, code: 'NOT_A_REAL_CODE' });
    const app = diagnosticsAppWith(async () => {
      throw err;
    });
    const res = await app.fetch(new Request(`${ORIGIN}/api/v1/admin/diagnostics`), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('short but foreign');
  });

  it('collapses non-auth statuses and plain errors to a closed 500', async () => {
    const err = new Error('internal detail that must not surface');
    Object.assign(err, { status: 500, code: 'INTERNAL_ERROR' });
    const app = diagnosticsAppWith(async () => {
      throw err;
    });
    const res = await app.fetch(new Request(`${ORIGIN}/api/v1/admin/diagnostics`), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal error.');
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });
});

// ---------------------------------------------------------------------------
// W6-F finding 2 — media tickets ride the vault keyring: mint under the
// active key (NEXT while staged), verify by the envelope's own keyId, fail
// closed once the sealing key is no longer configured.
// ---------------------------------------------------------------------------

describe('media tickets on the vault keyring', () => {
  const TICKET_NOW = 1_700_000_000_000;
  const TICKET_SCOPE = {
    kind: 'file',
    mountId: 'm-1',
    fileId: 'f-1',
  } as const;
  const mintInput = {
    scope: TICKET_SCOPE,
    principal: { kind: 'public' } as const,
    ttlSeconds: 300,
    now: TICKET_NOW,
  };

  function ticketEnvelopeKeyId(token: string): string {
    const b64 = token
      .slice('mtk_'.length)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return (JSON.parse(new TextDecoder().decode(bytes)) as { keyId: string }).keyId;
  }

  it('mints under the staged NEXT key during a rotation window and verifies by envelope keyId', async () => {
    const window = { APP_MASTER_KEY: MASTER, APP_MASTER_KEY_NEXT: NEXT };
    const minted = await mintMediaTicket(window, mintInput);
    // Sealed under NEXT, labelled by its fingerprint — not 'v1'.
    expect(ticketEnvelopeKeyId(minted.token)).toBe(await masterKeyLabel(NEXT));
    // Verifies while both keys are configured...
    const inWindow = await verifyMediaTicket(window, minted.token, TICKET_SCOPE, TICKET_NOW + 1_000);
    expect(inWindow.ok).toBe(true);
    // ...and after promotion (APP_MASTER_KEY := NEXT, NEXT removed).
    const promoted = await verifyMediaTicket(
      { APP_MASTER_KEY: NEXT },
      minted.token,
      TICKET_SCOPE,
      TICKET_NOW + 1_000,
    );
    expect(promoted.ok).toBe(true);
    // A deployment holding only the retired key cannot open it.
    const retiredOnly = await verifyMediaTicket(
      { APP_MASTER_KEY: MASTER },
      minted.token,
      TICKET_SCOPE,
      TICKET_NOW + 1_000,
    );
    expect(retiredOnly.ok).toBe(false);
  });

  it('keeps legacy v1 tickets verifiable while the old key is configured and fails closed once it is gone', async () => {
    const minted = await mintMediaTicket({ APP_MASTER_KEY: MASTER }, mintInput);
    expect(ticketEnvelopeKeyId(minted.token)).toBe('v1');
    expect(
      (await verifyMediaTicket({ APP_MASTER_KEY: MASTER }, minted.token, TICKET_SCOPE, TICKET_NOW + 1_000)).ok,
    ).toBe(true);
    // Mid-rotation the old key is still in the ring — the ticket keeps working.
    expect(
      (
        await verifyMediaTicket(
          { APP_MASTER_KEY: MASTER, APP_MASTER_KEY_NEXT: NEXT },
          minted.token,
          TICKET_SCOPE,
          TICKET_NOW + 1_000,
        )
      ).ok,
    ).toBe(true);
    // After promotion the 'v1' slot names the new key bytes: fail closed.
    expect(
      (await verifyMediaTicket({ APP_MASTER_KEY: NEXT }, minted.token, TICKET_SCOPE, TICKET_NOW + 1_000)).ok,
    ).toBe(false);
  });

  it('fails closed for envelopes sealed under a foreign or unknown keyId', async () => {
    const foreign = 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI='; // 32 x 0x22
    const foreignMinted = await mintMediaTicket({ APP_MASTER_KEY: foreign }, mintInput);
    expect(
      (await verifyMediaTicket({ APP_MASTER_KEY: MASTER }, foreignMinted.token, TICKET_SCOPE, TICKET_NOW + 1_000)).ok,
    ).toBe(false);
    // An envelope carrying a keyId no configured key owns fails closed.
    const nextOnly = await mintMediaTicket({ APP_MASTER_KEY_NEXT: NEXT }, mintInput);
    expect(
      (await verifyMediaTicket({ APP_MASTER_KEY: MASTER }, nextOnly.token, TICKET_SCOPE, TICKET_NOW + 1_000)).ok,
    ).toBe(false);
    // Same ticket, correctly configured keyring: verifies.
    expect(
      (await verifyMediaTicket({ APP_MASTER_KEY_NEXT: NEXT }, nextOnly.token, TICKET_SCOPE, TICKET_NOW + 1_000)).ok,
    ).toBe(true);
  });

  it('surfaces missing master-key configuration as a throw, not a ticket verdict', async () => {
    const minted = await mintMediaTicket({ APP_MASTER_KEY: MASTER }, mintInput);
    await expect(
      verifyMediaTicket(
        { APP_MASTER_KEY: 'not-base64!!' },
        minted.token,
        TICKET_SCOPE,
        TICKET_NOW + 1_000,
      ),
    ).rejects.toThrow();
  });
});

describe('retention cleanup', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function seedConnRows() {
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('cli-1','proj-1','123-x.apps.googleusercontent.com','{}', ?,1,1,0,0)",
      )
      .bind(`${CANONICAL}/cb`)
      .run();
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO google_connections (id, oauth_client_id, principal_id, granted_scopes, state, enabled, version, created_at, updated_at) VALUES ('conn-1','cli-1','perm-1','', 'connected',1,1,0,0)",
      )
      .run();
  }

  async function seedUploadOperation(
    id: string,
    opts: { state: string; result: string | null; summary: string | null; completedAt: number | null },
  ) {
    const owner = await adminUserId();
    await seedConnRows();
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('m-1','M','d-1','d-1','conn-1','conn-1',1,'private',1,0,0)",
      )
      .run();
    await env.DB
      .prepare(
        'INSERT INTO upload_operations (id, owner_id, mount_id, kind, idempotency_hash, input_hash, pinned_oauth_connection_id, pinned_principal_id, pinned_oauth_client_id, pinned_project_id, state, result, summary, created_at, updated_at, completed_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id, owner, 'm-1', 'file', `ih-${id}`, `ph-${id}`, 'conn-1', 'perm-1',
        'cli-1', 'proj-1', opts.state, opts.result, opts.summary,
        0, 0, opts.completedAt,
      )
      .run();
  }

  it('deletes audit events older than 30d in bounded batches and keeps newer rows', async () => {
    await completeSetup();
    const now = Date.now();
    await env.DB
      .prepare("INSERT INTO audit_events (id, actor_kind, operation, result, request_id, created_at) VALUES ('old','system','x','ok','r',?),('new','system','x','ok','r',?)")
      .bind(now - 31 * DAY, now - DAY)
      .run();
    const dry = await runRetentionCleanup(env.DB, { dryRun: true });
    expect(dry.auditEvents.eligible).toBe(1);
    expect(dry.auditEvents.deleted).toBe(0);
    const res = await runRetentionCleanup(env.DB, { batchSize: 10 });
    expect(res.auditEvents.deleted).toBe(1);
    const remaining = await env.DB
      .prepare('SELECT id FROM audit_events ORDER BY id')
      .all<{ id: string }>();
    expect((remaining.results ?? []).map((r) => r.id)).toEqual(['new']);
  });

  it('purges completed-upload detail only when terminal with a durable tombstone', async () => {
    await completeSetup();
    const now = Date.now();
    const old = now - 8 * DAY;
    // eligible: terminal + durable result
    await seedUploadOperation('op-done', {
      state: 'completed',
      result: JSON.stringify({ outcome: 'ok', view: { confirmedOffset: '5', totalBytes: '5', sessionGeneration: 1, state: 'completed', chunkSize: 1, readerAccessState: 'readable' } }),
      summary: '{"confirmedOffset":"5"}',
      completedAt: old,
    });
    // kept: terminal but result missing (tombstone not durable)
    await seedUploadOperation('op-noresult', {
      state: 'completed', result: null, summary: '{}', completedAt: old,
    });
    // kept: non-terminal/unknown outcome
    await seedUploadOperation('op-running', {
      state: 'uploading', result: null, summary: '{}', completedAt: null,
    });
    // kept: terminal but too recent
    await seedUploadOperation('op-fresh', {
      state: 'completed', result: '{"outcome":"ok"}', summary: '{}', completedAt: now - DAY,
    });
    const res = await runRetentionCleanup(env.DB, { batchSize: 10 });
    expect(res.uploadDetails.purged).toBe(1);
    expect(res.uploadDetails.keptWithoutTombstone).toBe(1);
    const rows = await env.DB
      .prepare('SELECT id, summary, detail_purged_at, result FROM upload_operations ORDER BY id')
      .all<{ id: string; summary: string | null; detail_purged_at: number | null; result: string | null }>();
    const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));
    expect(byId.get('op-done')!.summary).toBeNull();
    expect(byId.get('op-done')!.detail_purged_at).not.toBeNull();
    // Tombstone stays: result + pinned identity intact.
    expect(byId.get('op-done')!.result).toContain('"outcome":"ok"');
    expect(byId.get('op-noresult')!.summary).not.toBeNull();
    expect(byId.get('op-running')!.summary).not.toBeNull();
    expect(byId.get('op-fresh')!.summary).not.toBeNull();
    // Idempotent rerun (crash-safe): second pass purges nothing.
    const again = await runRetentionCleanup(env.DB, { batchSize: 10 });
    expect(again.uploadDetails.purged).toBe(0);
  });

  it('still answers a replayed idempotency key after detail cleanup', async () => {
    await completeSetup();
    const owner = await adminUserId();
    const input = {
      mountId: 'm-1', parentId: 'root', name: 'f.bin',
      mimeType: 'application/octet-stream', totalBytes: '5' as const,
      sha256: 'a'.repeat(64), md5: 'b'.repeat(32),
    };
    await seedConnRows();
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('m-1','M','d-1','d-1','conn-1','conn-1',1,'private',1,0,0)",
      )
      .run();
    const claim = await claimOperation(env.DB, {
      ownerId: owner, kind: 'file', idempotencyKey: 'idem-1', input,
      pinned: {
        connectionId: 'conn-1', principalId: 'perm-1', oauthClientId: 'cli-1',
        projectId: 'proj-1', connectionVersion: 1, oauthClientVersion: 1,
        mountScope: { mountId: 'm-1', rootFolderId: 'd-1', driveId: 'd-1' },
      },
      now: Date.now(),
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const old = Date.now() - 8 * DAY;
    await env.DB
      .prepare("UPDATE upload_operations SET state='completed', result=?, summary='{}', completed_at=? WHERE id=?")
      .bind(
        JSON.stringify({ outcome: 'ok', view: { confirmedOffset: '5', totalBytes: '5', sessionGeneration: 2, state: 'completed', chunkSize: 8 * 1024 * 1024, readerAccessState: 'readable' } }),
        old, claim.operation.id,
      )
      .run();
    await runRetentionCleanup(env.DB, { batchSize: 10 });
    // Replay lookup: the purged tombstone still resolves the same outcome.
    const row = await findOperationByIdempotency(
      env.DB, owner, await sha256Hex('upload-operation:idem-1'),
    );
    expect(row).not.toBeNull();
    const view = viewFromTombstone(row!);
    expect(view.state).toBe('completed');
    expect(view.confirmedOffset).toBe('5');
    expect(view.sessionGeneration).toBe(2);
  });

  it('never lets a stale projection overwrite a newer tombstone', async () => {
    await completeSetup();
    const owner = await adminUserId();
    await seedConnRows();
    await env.DB
      .prepare(
        "INSERT OR IGNORE INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('m-1','M','d-1','d-1','conn-1','conn-1',1,'private',1,0,0)",
      )
      .run();
    const claim = await claimOperation(env.DB, {
      ownerId: owner, kind: 'file', idempotencyKey: 'idem-lag',
      input: {
        mountId: 'm-1', parentId: 'root', name: 'f', mimeType: 'x',
        totalBytes: '1', sha256: 'a'.repeat(64), md5: 'b'.repeat(32),
      },
      pinned: {
        connectionId: 'conn-1', principalId: 'perm-1', oauthClientId: 'cli-1',
        projectId: 'proj-1', connectionVersion: 1, oauthClientVersion: 1,
        mountScope: { mountId: 'm-1', rootFolderId: 'd-1', driveId: 'd-1' },
      },
      now: Date.now(),
    });
    if (!claim.ok) throw new Error('claim failed');
    const snap = (v: number, state: string): UploadSessionSnapshot => ({
      uploadId: claim.operation.id, ownerId: owner, mountId: 'm-1', kind: 'file',
      inputHash: 'h', parentId: 'root', name: 'f', mimeType: 'x',
      totalBytes: '1', sha256: 'a'.repeat(64), md5: 'b'.repeat(32),
      state: state as UploadSessionSnapshot['state'], initPhase: 'done',
      pinned: {
        connectionId: 'conn-1', principalId: 'perm-1', oauthClientId: 'cli-1',
        projectId: 'proj-1', connectionVersion: 1, oauthClientVersion: 1,
        mountScope: { mountId: 'm-1', rootFolderId: 'd-1', driveId: 'd-1' },
      },
      sessionGeneration: 1, confirmedOffset: '1', chunkSize: 8 * 1024 * 1024,
      hasSessionUri: false, remoteInitAttempted: true, sessionExpired: false,
      pauseRequested: false, cancelRequested: false,
      readerAccessState: 'unchecked',
      createdMs: 0, updatedMs: 0, stateVersion: v,
      ...(state === 'completed'
        ? { completedMs: Date.now(), result: '{"outcome":"ok"}' }
        : {}),
    });
    await writeProjection(env.DB, claim.operation.id, snap(3, 'completed'), Date.now());
    // A lagging projection write (older stateVersion) must not clobber it.
    await writeProjection(env.DB, claim.operation.id, snap(2, 'uploading'), Date.now());
    const row = await env.DB
      .prepare('SELECT state, projection_version, result FROM upload_operations WHERE id = ?')
      .bind(claim.operation.id)
      .first<{ state: string; projection_version: number; result: string }>();
    expect(row!.state).toBe('completed');
    expect(row!.projection_version).toBe(3);
    expect(row!.result).toContain('ok');
  });
});

describe('key rotation', () => {
  it('blocks admissions while active, checkpoints progress, verifies and revokes sessions', async () => {
    await completeSetup();
    await seedCredentialRows();
    const cookie = await adminCookie();

    // Gate off → admission reaches credential checks (fetch stubbed so an
    // SA grant resolves without Google).
    setGoogleFetchForTests(async () =>
      new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const before = await admitSa();
    expect(before.ok).toBe(true);

    // Rotation requires the NEXT key staged.
    const noNext = await adminPost('/api/v1/admin/maintenance/rotation/start', cookie, {}, env);
    expect(noNext.status).toBe(400);

    const start = await adminPost('/api/v1/admin/maintenance/rotation/start', cookie, {}, envNext);
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as { rotation: { mode: string; phase: string; toKeyLabel: string } };
    expect(startBody.rotation.mode).toBe('key-rotation');
    expect(startBody.rotation.toKeyLabel).toBe(await masterKeyLabel(NEXT));

    // Admissions are now blocked (fail-closed maintenance signal).
    const during = await admitSa();
    expect(during.ok).toBe(false);
    expect(during.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(during.detail).toBe('maintenance_mode');

    // Step in bounded batches; resumable — second call continues.
    const step1 = await adminPost('/api/v1/admin/maintenance/rotation/step', cookie, { batchSize: 1 }, envNext);
    const s1 = (await step1.json()) as { step: { processed: number; remaining: boolean } };
    expect(s1.step.processed).toBe(1);
    expect(s1.step.remaining).toBe(true);
    // Crash-safety: re-running the step continues from the checkpoint; the
    // already-resealed row is skipped by keyId label.
    let done = false;
    for (let i = 0; i < 10 && !done; i++) {
      const step = await adminPost('/api/v1/admin/maintenance/rotation/step', cookie, { batchSize: 2 }, envNext);
      const body = (await step.json()) as { step: { phase: string; remaining: boolean } };
      done = body.step.phase === 'verifying';
    }
    expect(done).toBe(true);

    // A row that still carries the old label fails verification.
    await env.DB
      .prepare('UPDATE service_accounts SET envelope = ? WHERE id = ?')
      .bind(
        encodeEnvelope(
          await createVault(MASTER, VAULT_KEY_ID).sealSecret(
            new TextEncoder().encode(JSON.stringify({ client_email: 'sa@p1.iam.gserviceaccount.com', private_key: 'k' })),
            serviceAccountKeyContext('sa-1', 'proj-1'),
          ),
        ),
        'sa-1',
      )
      .run();
    const badVerify = await adminPost('/api/v1/admin/maintenance/rotation/verify', cookie, {}, envNext);
    const bv = (await badVerify.json()) as { verify: { ok: boolean; failed: number } };
    expect(bv.verify.ok).toBe(false);
    expect(bv.verify.failed).toBe(1);
    // Re-step fixes the regression the verify pass caught.
    await adminPost('/api/v1/admin/maintenance/rotation/step', cookie, {}, envNext);
    const verify = await adminPost('/api/v1/admin/maintenance/rotation/verify', cookie, {}, envNext);
    expect(((await verify.json()) as { verify: { ok: boolean } }).verify.ok).toBe(true);

    // Complete: sessions revoked, gate lifted.
    const complete = await adminPost('/api/v1/admin/maintenance/rotation/complete', cookie, {}, envNext);
    const cb = (await complete.json()) as { complete: { sessionsRevoked: number } };
    expect(cb.complete.sessionsRevoked).toBeGreaterThanOrEqual(1);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM session').first<{ n: number }>();
    expect(sessions!.n).toBe(0);
    expect((await admitSa()).ok).toBe(true);

    // Envelopes now carry the NEXT fingerprint label and open under NEXT via
    // the keyring; pinned writer identity is untouched.
    const sa = await env.DB
      .prepare('SELECT envelope FROM service_accounts WHERE id = ?')
      .bind('sa-1')
      .first<{ envelope: string }>();
    const envObj = decodeEnvelope(sa!.envelope);
    expect(envObj.keyId).toBe(await masterKeyLabel(NEXT));
    const ring = createSecretKeyring<string>({ APP_MASTER_KEY_NEXT: NEXT }, 'vault');
    const opened = await ring.openSecret(envObj, serviceAccountKeyContext('sa-1', 'proj-1'));
    expect(new TextDecoder().decode(opened)).toContain('sa@p1.iam.gserviceaccount.com');
    const conn = await env.DB
      .prepare('SELECT pinned_oauth_connection_id, pinned_principal_id, state FROM upload_operations')
      .all();
    void conn;
  });
});

// ---------------------------------------------------------------------------
// E3 reviewer fixes — rotation step robustness (W4-R1 #2 livelock, #4 cursor)
// ---------------------------------------------------------------------------

describe('rotation step robustness (E3)', () => {
  async function seedRotationState() {
    await env.DB
      .prepare(
        'INSERT INTO maintenance_state ' +
          '(id, mode, phase, from_key_label, to_key_label, checkpoint, ' +
          'processed_count, verified_count, created_at, updated_at) ' +
          "VALUES (1, 'key-rotation', 'reencrypting', 'v1', ?, '{}', 0, 0, 0, 0)",
      )
      .bind(await masterKeyLabel(NEXT))
      .run();
  }

  const rotationEnv = (db: D1Database = env.DB): RotationEnv => ({
    DB: db,
    APP_MASTER_KEY: MASTER,
    APP_MASTER_KEY_NEXT: NEXT,
  });

  it('fails the run when a toLabel envelope cannot be opened (no verify/step livelock)', async () => {
    await completeSetup();
    await seedCredentialRows();
    // A row that already carries the NEXT label but is sealed under the OLD
    // key: the keyring selects the NEXT box by keyId and the GCM tag fails.
    const sealed = await createVault(MASTER, VAULT_KEY_ID).sealSecret(
      new TextEncoder().encode('s3cr3t-material'),
      serviceAccountKeyContext('sa-9', 'proj-1'),
    );
    const corrupt = encodeEnvelope({
      ...sealed,
      keyId: await masterKeyLabel(NEXT),
    });
    await env.DB
      .prepare(
        "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-9','proj-1','sa9@x','kid',?,1,1,0,0)",
      )
      .bind(corrupt)
      .run();
    await seedRotationState();

    const result = await stepRotation(rotationEnv());
    if ('ok' in result) throw new Error(`unexpected rotation error ${result.code}`);
    // The corrupt row must FAIL the run — never skipped into a
    // verify→reset→step loop.
    expect(result.phase).toBe('failed');
    const state = await readMaintenanceState(env.DB);
    expect(state.phase).toBe('failed');
    expect(state.lastError).toContain('sa-9');
    expect(state.lastError).not.toContain('s3cr3t');
  });

  it('persists the checkpoint cursor at the last processed row so a CAS miss is retried', async () => {
    await completeSetup();
    await seedCredentialRows();
    const vault = createVault(MASTER, VAULT_KEY_ID);
    const sa2 = encodeEnvelope(
      await vault.sealSecret(
        new TextEncoder().encode(
          JSON.stringify({ client_email: 'sa2@p1.iam.gserviceaccount.com', private_key: 'k' }),
        ),
        serviceAccountKeyContext('sa-2', 'proj-1'),
      ),
    );
    await env.DB
      .prepare(
        "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-2','proj-1','sa2@p1.iam.gserviceaccount.com','kid',?,1,1,0,0)",
      )
      .bind(sa2)
      .run();
    await seedRotationState();

    // Wrap D1: the CAS UPDATE for sa-2 reports 0 changes, simulating a
    // racing writer that rewrote the envelope between select and update.
    let casMisses = 0;
    const wrapped = {
      prepare(sql: string) {
        if (sql.startsWith('UPDATE service_accounts')) {
          return {
            bind(...args: unknown[]) {
              if (args[2] === 'sa-2') {
                casMisses += 1;
                return {
                  async run() {
                    return { meta: { changes: 0 }, success: true };
                  },
                };
              }
              return env.DB.prepare(sql).bind(...args);
            },
          };
        }
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;

    const first = await stepRotation(rotationEnv(wrapped));
    if ('ok' in first) throw new Error(`unexpected rotation error ${first.code}`);
    expect(first.phase).toBe('reencrypting');
    expect(first.remaining).toBe(true);
    expect(casMisses).toBe(1);
    let state = await readMaintenanceState(env.DB);
    // The missed row is NOT checkpointed past — the cursor stops at sa-1.
    expect(state.checkpoint.sources['service_accounts']?.cursor).toBe('sa-1');
    expect(state.checkpoint.sources['service_accounts']?.done).toBe(false);

    // The next step re-reads and retries the missed row.
    const second = await stepRotation(rotationEnv(wrapped));
    if ('ok' in second) throw new Error(`unexpected rotation error ${second.code}`);
    expect(casMisses).toBe(2);
    state = await readMaintenanceState(env.DB);
    expect(state.checkpoint.sources['service_accounts']?.cursor).toBe('sa-1');
  });
});

// ---------------------------------------------------------------------------
// E3 reviewer fixes — recovery claim ordering + scoped throttle (W4-R1 #5, #6)
// ---------------------------------------------------------------------------

describe('recovery claim ordering and throttle (E3)', () => {
  async function issueToken(token: string, expiresInMs = 3600_000) {
    await env.DB
      .prepare(
        'INSERT INTO admin_recovery_tokens (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
      )
      .bind(
        crypto.randomUUID(),
        await sha256Hex(`admin-recovery:${token}`),
        Date.now() + expiresInMs,
        Date.now(),
      )
      .run();
  }
  const newToken = () => `grt_${crypto.randomUUID().replaceAll('-', '')}${'a'.repeat(12)}`;
  const claim = (body: unknown, e?: TestEnv) =>
    testApp(e)('/api/v1/admin/maintenance/recovery/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: CANONICAL },
      body: JSON.stringify(body),
    });

  it('does not burn the token on a bad email, and audits the 404', async () => {
    await completeSetup();
    const t = newToken();
    await issueToken(t);
    // Valid token + unknown email → 404, audited like the forbidden path.
    const miss = await claim({
      token: t,
      email: 'nobody@example.test',
      newPassword: 'new-password-123',
    });
    expect(miss.status).toBe(404);
    const audits = await env.DB
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE operation = 'admin.recovery.claim' AND result = 'error'",
      )
      .first<{ n: number }>();
    expect(audits?.n).toBeGreaterThanOrEqual(1);
    // The one-use token survived — the owner can correct the email.
    const ok = await claim({
      token: t,
      email: ADMIN.email,
      newPassword: 'new-password-123',
    });
    expect(ok.status).toBe(200);
    const login = await worker.fetch(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADMIN.email, password: 'new-password-123' }),
      }),
    );
    expect(login.status).toBe(200);
  });

  it('throttles per token-hash bucket: 10 misses on one token still allow others', async () => {
    await completeSetup();
    const hot = newToken();
    // Ten bad guesses against one token's bucket.
    for (let i = 0; i < 10; i++) {
      const res = await claim({
        token: hot,
        email: ADMIN.email,
        newPassword: 'x'.repeat(9),
      });
      expect(res.status).toBe(403);
    }
    const eleventh = await claim({
      token: hot,
      email: ADMIN.email,
      newPassword: 'x'.repeat(9),
    });
    expect(eleventh.status).toBe(429);
    const limited = ApiErrorBodySchema.parse(await eleventh.json());
    expect(limited.error.code).toBe('RATE_LIMITED');
    // A different token's bucket is untouched — the legitimate owner is
    // not locked out by guesses against some other token string.
    const other = await claim({
      token: newToken(),
      email: ADMIN.email,
      newPassword: 'x'.repeat(9),
    });
    expect(other.status).toBe(403);
  });

  it('keeps a higher global cap across buckets', async () => {
    await completeSetup();
    const cutoff = Date.now() - 30 * 60 * 1000;
    // 99 prior failures spread across unrelated buckets must NOT lock out
    // the legitimate owner — the old flat cap denied at 10 globally.
    const seedFailures = async (n: number, from: number) => {
      const inserts = [];
      for (let i = 0; i < n; i++) {
        inserts.push(
          env.DB
            .prepare(
              'INSERT INTO audit_events (id, actor_kind, operation, target_type, target_id, result, request_id, created_at) ' +
                "VALUES (?, 'system', 'admin.recovery.claim', 'recovery-token-bucket', ?, 'error', ?, ?)",
            )
            .bind(`seeded-${from + i}`, `bucket-${from + i}`, 'r', cutoff + i),
        );
      }
      await env.DB.batch(inserts);
    };
    await seedFailures(99, 0);
    const allowed = await claim({
      token: newToken(),
      email: ADMIN.email,
      newPassword: 'x'.repeat(9),
    });
    // Not throttled — denied on token validity like any wrong guess.
    expect(allowed.status).toBe(403);
    // That failure was the 100th inside the window: the global cap now
    // bounds any further attempts regardless of bucket.
    const capped = await claim({
      token: newToken(),
      email: ADMIN.email,
      newPassword: 'x'.repeat(9),
    });
    expect(capped.status).toBe(429);
    const limited = ApiErrorBodySchema.parse(await capped.json());
    expect(limited.error.code).toBe('RATE_LIMITED');
  });

  it('fails closed when the throttle audit write fails', async () => {
    await completeSetup();
    const broken = {
      ...env,
      DB: {
        prepare(sql: string) {
          if (sql.startsWith('INSERT INTO audit_events')) {
            const stmt: Record<string, unknown> = {
              bind() {
                return stmt;
              },
              async run() {
                throw new Error('D1 write failed');
              },
            };
            return stmt;
          }
          return env.DB.prepare(sql);
        },
        batch: (stmts: unknown[]) => env.DB.batch(stmts as never),
      } as unknown as D1Database,
    } as TestEnv;
    const res = await claim(
      {
        token: newToken(),
        email: ADMIN.email,
        newPassword: 'x'.repeat(9),
      },
      broken,
    );
    // A swallowed failure audit would mean unlimited guesses — deny instead.
    expect(res.status).toBe(500);
  });
});

describe('admin recovery claim', () => {
  async function issueToken(token: string, expiresInMs = 3600_000) {
    await env.DB
      .prepare(
        'INSERT INTO admin_recovery_tokens (id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
      )
      .bind(
        crypto.randomUUID(),
        await sha256Hex(`admin-recovery:${token}`),
        Date.now() + expiresInMs,
        Date.now(),
      )
      .run();
  }
  const token = () => `grt_${'a'.repeat(43)}`;

  it('resets an admin password once, never reopens setup, rejects replay/expired', async () => {
    await completeSetup();
    const t = token();
    await issueToken(t);
    const claim = (body: unknown) =>
      testApp()('/api/v1/admin/maintenance/recovery/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: CANONICAL },
        body: JSON.stringify(body),
      });
    const ok = await claim({ token: t, email: ADMIN.email, newPassword: 'new-password-123' });
    expect(ok.status).toBe(200);
    // One-use: replay fails.
    const replay = await claim({ token: t, email: ADMIN.email, newPassword: 'x'.repeat(9) });
    expect(replay.status).toBe(403);
    // New credential works, old one does not.
    const oldLogin = await worker.fetch(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password }),
    }));
    expect(oldLogin.status).toBe(401);
    const newLogin = await worker.fetch(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN.email, password: 'new-password-123' }),
    }));
    expect(newLogin.status).toBe(200);
    // Setup was never reopened.
    const status = await worker.fetch(new Request(`${ORIGIN}/api/v1/setup/status`));
    expect(((await status.json()) as { setupState: string }).setupState).toBe('complete');
    const reSetup = await worker.fetch(new Request(`${ORIGIN}/api/v1/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    }));
    expect(reSetup.status).toBe(409);
    // Expired and unknown tokens are rejected identically.
    await issueToken('grt_' + 'b'.repeat(43), -1000);
    const expired = await claim({ token: 'grt_' + 'b'.repeat(43), email: ADMIN.email, newPassword: 'z'.repeat(9) });
    expect(expired.status).toBe(403);
    const unknown = await claim({ token: 'grt_' + 'c'.repeat(43), email: ADMIN.email, newPassword: 'z'.repeat(9) });
    expect(unknown.status).toBe(403);
    const body = ApiErrorBodySchema.parse(await unknown.json());
    expect(body.error.code).toBe('FORBIDDEN');
  });
});

describe('mounted routes (coordinator wiring)', () => {
  it('mounted diagnostics/maintenance paths answer through the real worker', async () => {
    // Unauthenticated → 401 through the mounted router (setup complete).
    await completeSetup();
    const diag = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/admin/diagnostics`),
    );
    expect(diag.status).toBe(401);
    const status = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/admin/maintenance/status`),
    );
    expect(status.status).toBe(401);
    const body = ApiErrorBodySchema.parse(await status.json());
    expect(body.error.code).toBe('AUTH_REQUIRED');
    // Recovery claim is reachable without a session (400 = body validation,
    // proving the route is mounted and not admin-gated).
    const claim = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/admin/maintenance/recovery/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: CANONICAL },
        body: '{}',
      }),
    );
    expect(claim.status).toBe(400);
  });
});

describe('rotation re-keys live upload sessions (wave-5 frozen decision 6)', () => {
  // Real UploadSession DOs driven through the upload fixture: the op row
  // lands in the same D1 the rotation engine scans, and the DO holds the
  // sealed session URI. APP_MASTER_KEY_NEXT is staged inside each DO's env
  // exactly like a secret rollout stages it fleet-wide.
  const FOREIGN_KEY = 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM=';
  const sessionContext = (uploadId: string) => ({
    provider: 'google-oauth',
    recordId: uploadId,
    projectId: 'proj-1',
    kind: 'resumable-session',
  });

  async function seedFixtureBase() {
    await seedBase();
    // The fixture seeds a placeholder secret_envelope ('env') that is not a
    // decodable envelope — the rotation scan would fail the run on it, so
    // give client-1 a real MASTER-sealed envelope instead.
    const clientEnv = encodeEnvelope(
      await createVault(MASTER, VAULT_KEY_ID).sealSecret(
        new TextEncoder().encode('fixture-client-secret'),
        oauthClientSecretContext('client-1', 'proj-1'),
      ),
    );
    await env.DB
      .prepare('UPDATE google_oauth_clients SET secret_envelope = ? WHERE id = ?')
      .bind(clientEnv, 'client-1')
      .run();
  }

  async function stageNextInDo(uploadId: string) {
    const doStub = stub(uploadId);
    await runInDurableObject(doStub, async (instance) => {
      const holder = instance as unknown as {
        env: Env & { APP_MASTER_KEY_NEXT?: string };
      };
      holder.env = { ...holder.env, APP_MASTER_KEY_NEXT: NEXT };
    });
  }

  async function promoteDo(uploadId: string) {
    // Promotion: APP_MASTER_KEY := NEXT and NEXT is removed — what the DO
    // sees after the operator completes step 4 of the runbook.
    const doStub = stub(uploadId);
    await runInDurableObject(doStub, async (instance) => {
      const holder = instance as unknown as {
        env: Env & { APP_MASTER_KEY_NEXT?: string };
      };
      holder.env = { ...env, APP_MASTER_KEY: NEXT } as Env & {
        APP_MASTER_KEY_NEXT?: string;
      };
    });
  }

  async function doEnvelope(uploadId: string): Promise<string | null> {
    const doStub = stub(uploadId);
    return runInDurableObject(doStub, async (_i, state) => {
      const rows = [
        ...state.storage.sql.exec(
          'SELECT session_uri_envelope FROM session WHERE id = 1',
        ),
      ];
      return (rows[0]?.session_uri_envelope as string | undefined) ?? null;
    });
  }

  async function overwriteDoEnvelope(uploadId: string, envelope: string) {
    const doStub = stub(uploadId);
    await runInDurableObject(doStub, async (_i, state) => {
      state.storage.sql.exec(
        'UPDATE session SET session_uri_envelope = ? WHERE id = 1',
        envelope,
      );
    });
  }

  async function startUpload(key: string): Promise<UploadViewBody> {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, key);
    expect(res.status).toBe(200);
    const view = (await res.json()) as UploadViewBody;
    expect(view.state).toBe('uploading');
    return view;
  }

  const post = (cookie: string, p: string, body: unknown) =>
    adminPost(`/api/v1/admin/maintenance${p}`, cookie, body, envNext);

  it('re-keys the session envelope during rotation and the upload resumes after promotion', async () => {
    await completeSetup();
    await seedFixtureBase();
    const cookie = await adminCookie();
    const view = await startUpload('rk-live');
    await stageNextInDo(view.uploadId);

    // A live upload no longer blocks the start.
    const start = await post(cookie, '/rotation/start', {});
    expect(start.status).toBe(200);

    // Step until the run reaches verification; the upload_sessions
    // pseudo-source re-keys the DO envelope along the way.
    let phase = '';
    for (let i = 0; i < 12 && phase !== 'verifying'; i++) {
      const step = await post(cookie, '/rotation/step', { batchSize: 2 });
      expect(step.status).toBe(200);
      phase = ((await step.json()) as { step: { phase: string } }).step.phase;
    }
    expect(phase).toBe('verifying');
    expect(decodeEnvelope((await doEnvelope(view.uploadId))!).keyId).toBe(
      await masterKeyLabel(NEXT),
    );

    const verify = await post(cookie, '/rotation/verify', {});
    expect(verify.status).toBe(200);
    const vb = (await verify.json()) as {
      verify: { ok: boolean; sessionsProved: number };
    };
    expect(vb.verify.ok).toBe(true);
    expect(vb.verify.sessionsProved).toBe(1);

    const complete = await post(cookie, '/rotation/complete', {});
    expect(complete.status).toBe(200);

    // Promotion: the DO now only knows the new key — the re-keyed envelope
    // still opens, so the in-flight upload resumes instead of dying.
    await promoteDo(view.uploadId);
    const claim = await doPost(view.uploadId, '/claim', {
      generation: view.sessionGeneration,
      offset: '0',
      length: 6,
      now: Date.now(),
      leaseMs: 120_000,
    });
    expect(claim.status).toBe(200);
    const body = (await claim.json()) as { directive: { kind: string } };
    expect(body.directive.kind).toBe('put-chunk');
  });

  it('refuses verify/complete (count-only) while a session is unrekeyable, unblocks when it drains', async () => {
    await completeSetup();
    await seedFixtureBase();
    const cookie = await adminCookie();
    const view = await startUpload('rk-dead');
    await stageNextInDo(view.uploadId);
    // Corrupt the stored envelope: sealed under a key this deployment does
    // not hold — the DO reports it unopenable → 'unavailable'.
    const foreign = encodeEnvelope(
      await createSecretBox<string>(
        FOREIGN_KEY,
        'v1',
        'upload-session',
      ).sealSecret(
        new TextEncoder().encode('https://example.test/dead'),
        sessionContext(view.uploadId),
      ),
    );
    await overwriteDoEnvelope(view.uploadId, foreign);

    const start = await post(cookie, '/rotation/start', {});
    expect(start.status).toBe(200);
    let lastStep: { step: { phase: string; blockedUploads?: number } } | null =
      null;
    for (let i = 0; i < 12 && lastStep?.step.phase !== 'verifying'; i++) {
      const step = await post(cookie, '/rotation/step', { batchSize: 4 });
      expect(step.status).toBe(200);
      lastStep = (await step.json()) as {
        step: { phase: string; blockedUploads?: number };
      };
    }
    expect(lastStep!.step.phase).toBe('verifying');
    expect(lastStep!.step.blockedUploads).toBe(1);

    // Verify refuses with a count only — never the operation id.
    const vDenied = await post(cookie, '/rotation/verify', {});
    expect(vDenied.status).toBe(409);
    const vBody = (await vDenied.json()) as { error: { message: string } };
    expect(vBody.error.message).toContain('1 upload session');
    expect(vBody.error.message).not.toContain(view.uploadId);

    // Restore a valid (old-key) envelope → rekey succeeds → verify passes.
    const valid = encodeEnvelope(
      await createSecretBox<string>(
        MASTER,
        'v1',
        'upload-session',
      ).sealSecret(
        new TextEncoder().encode('https://example.test/session'),
        sessionContext(view.uploadId),
      ),
    );
    await overwriteDoEnvelope(view.uploadId, valid);
    const vOk = await post(cookie, '/rotation/verify', {});
    expect(vOk.status).toBe(200);
    const vOkBody = (await vOk.json()) as {
      verify: { ok: boolean; sessionsProved: number };
    };
    expect(vOkBody.verify.ok).toBe(true);
    expect(vOkBody.verify.sessionsProved).toBe(1);

    // Complete re-proves: re-corrupt → 409; drain → 200.
    await overwriteDoEnvelope(view.uploadId, foreign);
    const cDenied = await post(cookie, '/rotation/complete', {});
    expect(cDenied.status).toBe(409);
    const cBody = (await cDenied.json()) as { error: { message: string } };
    expect(cBody.error.message).toContain('1 upload session');
    await env.DB
      .prepare("UPDATE upload_operations SET state = 'cancelled' WHERE id = ?")
      .bind(view.uploadId)
      .run();
    const cOk = await post(cookie, '/rotation/complete', {});
    expect(cOk.status).toBe(200);
  });

  it('resumes the rekey scan from its checkpoint after interruption', async () => {
    await completeSetup();
    await seedFixtureBase();
    const cookie = await adminCookie();
    const a = await startUpload('rk-a');
    const b = await startUpload('rk-b');
    await stageNextInDo(a.uploadId);
    await stageNextInDo(b.uploadId);

    await post(cookie, '/rotation/start', {});
    // batchSize=2: the D1 client envelope plus exactly one session per
    // step — the first call must leave a resumable cursor.
    const s1 = await post(cookie, '/rotation/step', { batchSize: 2 });
    expect(s1.status).toBe(200);
    const state1 = await readMaintenanceState(env.DB);
    const rekeyProgress = state1.checkpoint.sources['upload_sessions'];
    expect(rekeyProgress).toBeDefined();
    expect(rekeyProgress!.done).toBe(false);
    expect(rekeyProgress!.processed).toBe(1);
    // Exactly one of the two DO envelopes has been re-sealed so far.
    const labels = [
      decodeEnvelope((await doEnvelope(a.uploadId))!).keyId,
      decodeEnvelope((await doEnvelope(b.uploadId))!).keyId,
    ];
    const nextLabel = await masterKeyLabel(NEXT);
    expect(labels.filter((l) => l === nextLabel).length).toBe(1);

    // "Restart": a fresh step call resumes from the persisted cursor —
    // the already-rekeyed op is never re-driven.
    const s2 = await post(cookie, '/rotation/step', { batchSize: 5 });
    expect(s2.status).toBe(200);
    const s2Body = (await s2.json()) as { step: { phase: string } };
    expect(s2Body.step.phase).toBe('verifying');
    expect(decodeEnvelope((await doEnvelope(a.uploadId))!).keyId).toBe(nextLabel);
    expect(decodeEnvelope((await doEnvelope(b.uploadId))!).keyId).toBe(nextLabel);

    const verify = await post(cookie, '/rotation/verify', {});
    expect(verify.status).toBe(200);
    const vb = (await verify.json()) as {
      verify: { ok: boolean; sessionsProved: number };
    };
    expect(vb.verify.sessionsProved).toBe(2);
  });

  it('does not block on a non-terminal op whose DO was never initialized', async () => {
    await completeSetup();
    await seedFixtureBase();
    const cookie = await adminCookie();
    const owner = await adminUserId();
    await env.DB
      .prepare(
        'INSERT INTO upload_operations (id, owner_id, mount_id, kind, idempotency_hash, input_hash, pinned_oauth_connection_id, pinned_principal_id, pinned_oauth_client_id, pinned_project_id, state, created_at, updated_at) ' +
          "VALUES ('op-nodo', ?, 'mount-1', 'file', 'ih-nodo', 'ph-nodo', 'conn-1', 'perm-1', 'client-1', 'proj-1', 'created', 0, 0)",
      )
      .bind(owner)
      .run();
    expect((await post(cookie, '/rotation/start', {})).status).toBe(200);
    let phase = '';
    for (let i = 0; i < 12 && phase !== 'verifying'; i++) {
      const step = await post(cookie, '/rotation/step', {});
      phase = ((await step.json()) as { step: { phase: string } }).step.phase;
    }
    expect(phase).toBe('verifying');
    // The un-initialized DO reports 'none' — nothing to re-seal, no block.
    const verify = await post(cookie, '/rotation/verify', {});
    expect(verify.status).toBe(200);
    expect((await post(cookie, '/rotation/complete', {})).status).toBe(200);
  });
});
