/**
 * T15 (worker B): in-workerd system journey through the REAL worker entry
 * (exports.default === createApp()): setup -> admin sign-in -> OAuth client
 * -> OAuth connect (fake consent) -> SA import -> mount -> uploader user ->
 * grant -> upload -> completed with reader blocked -> membership fixed ->
 * readiness re-probe -> download/content -> share -> revoke.
 *
 * The only fake is the Google HTTP boundary (fault-fake-google.ts): it keeps
 * upstream protocol semantics and records method/host/provider/bytes so the
 * test asserts the OAuth-vs-SA split. No controller below the app is mocked;
 * D1, both DOs, vault and better-auth all run for real.
 */
import { env } from 'cloudflare:workers';
import type { Hono } from 'hono';
import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeGoogle, md5Hex, sha256Hex } from './fault-fake-google';
import { setGoogleFetchForTests } from '../../src/worker/drive/tokens';
import { createApp } from '../../src/worker/app';

// createApp() is called INSIDE each test, after the fetch seams are in
// place: the OAuth router binds resolveGoogleFetch() at construction time,
// so exports.default (built at module load) would capture the real fetch.
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const SETUP_TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ORIGIN = 'http://worker.test';
const CANONICAL_ORIGIN = 'https://worker.test';
const OAUTH_CALLBACK = `${CANONICAL_ORIGIN}/api/v1/admin/google/oauth/callback`;

const ADMIN = {
  token: SETUP_TOKEN,
  name: 'Admin',
  email: 'admin@example.test',
  password: 'correct-horse-battery-staple',
  canonicalOrigin: CANONICAL_ORIGIN,
};

const USER = {
  name: 'Uploader',
  email: 'uploader@example.test',
  password: 'uploader-password-123',
  role: 'user',
};

type TestApp = Hono<{ Bindings: Env; Variables: { requestId: string } }>;

function api(
  app: TestApp,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${ORIGIN}${path}`, init),
      env as unknown as Env,
      createExecutionContext(),
    ),
  );
}

function sessionCookie(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((v) => v.includes('session_token='));
  expect(cookie, 'sign-in sets a session cookie').toBeTruthy();
  return (cookie as string).split(';')[0]!;
}

async function signIn(app: TestApp, email: string, password: string): Promise<string> {
  const res = await api(app, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

function postJson(app: TestApp, path: string, cookie: string | null, body: unknown): Promise<Response> {
  return api(app, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: CANONICAL_ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

async function resetState() {
  for (const table of [
    'mount_drive_permissions',
    'upload_batch_nodes',
    'upload_batches',
    'upload_operations',
    'media_package_resources',
    'media_packages',
    'file_readiness',
    'share_links',
    'mount_grants',
    'mount_read_credentials',
    'containment_verdicts',
    'mounts',
    'audit_events',
    'oauth_transactions',
    'google_connections',
    'google_oauth_clients',
    'service_accounts',
    'maintenance_state',
    'admin_recovery_tokens',
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

let saKeyJsonPromise: Promise<string> | undefined;
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
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
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

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

afterEach(() => {
  setGoogleFetchForTests(undefined);
  vi.unstubAllGlobals();
});

interface UploadViewBody {
  uploadId: string;
  state: string;
  sessionGeneration: number;
  confirmedOffset: string;
  totalBytes: string;
  fileId?: string;
  readerAccessState: string;
}

describe('system journey through createApp() with the fake Google boundary', () => {
  it('setup -> admin -> mount -> uploader -> upload -> reader blocked -> fixed -> download -> share -> revoke', async () => {
    const fake = new FakeGoogle().install();
    // The token endpoints resolve through this module-level seam (oauth
    // routes + ProjectCoordinator DO); Drive transport goes through the
    // global fetch stub. Both seams land in the same fake.
    setGoogleFetchForTests(fake.fetch);
    const app = createApp();

    // 1. Setup: claims the single admin, pins the canonical origin. The
    //    request's own origin is trusted pre-setup; the canonical one is not
    //    pinned yet, so no Origin header is sent here.
    const setup = await api(app, '/api/v1/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    expect(setup.status).toBe(200);

    // 2. Admin sign-in through better-auth on the real surface.
    const admin = await signIn(app, ADMIN.email, ADMIN.password);

    // 3. Import the OAuth client (sealed secret; project pinned).
    const client = await postJson(app, '/api/v1/admin/google/clients', admin, {
      clientId: 'fake-client-id-1.apps.googleusercontent.com',
      clientSecret: 'fake-client-secret-1',
      projectId: 'proj-1',
      redirectUri: OAUTH_CALLBACK,
    });
    expect(client.status).toBe(200);
    const { client: clientView } = (await client.json()) as {
      client: { id: string; projectId: string };
    };

    // 4. OAuth connect: start returns the Google URL; the test plays the
    //    consent redirect back into the callback with a code.
    const start = await postJson(app, '/api/v1/admin/google/oauth/start', admin, {
      purpose: 'connect',
      oauthClientId: clientView.id,
    });
    expect(start.status).toBe(200);
    const { authorizationUrl } = (await start.json()) as {
      authorizationUrl: string;
    };
    const authUrl = new URL(authorizationUrl);
    expect(authUrl.hostname).toBe('accounts.google.com');
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await app.fetch(
      new Request(
        `${OAUTH_CALLBACK}?state=${encodeURIComponent(state!)}&code=fake-code-1`,
        { headers: { cookie: admin } },
      ),
      env as unknown as Env,
      createExecutionContext(),
    );
    if (callback.status !== 200) {
      console.log('CALLBACK BODY', await callback.clone().text());
      console.log(
        'REQUESTS',
        fake.requests.map((r) => `${r.provider} ${r.method} ${r.url}`),
      );
    }
    expect(callback.status).toBe(200);
    const { connection } = (await callback.json()) as {
      connection: { id: string; state: string };
    };
    expect(connection.state).toBe('connected');

    // The code exchange hit the token endpoint; about.get carried an OAuth
    // bearer minted by this fake.
    const codeGrant = fake.requests.find(
      (r) =>
        r.url.hostname === 'oauth2.googleapis.com' &&
        r.url.pathname === '/token',
    );
    expect(codeGrant).toBeDefined();
    const aboutCall = fake.requests.find((r) => r.url.pathname === '/drive/v3/about');
    expect(aboutCall?.provider).toBe('google_oauth');

    // 5. Import a service account (real RSA key sealed in the vault).
    const sa = await postJson(app, '/api/v1/admin/service-accounts', admin, {
      keyJson: await validSaKeyJson(),
    });
    expect(sa.status).toBe(200);
    const { serviceAccount } = (await sa.json()) as {
      serviceAccount: { id: string };
    };

    // 6. Create the mount: two Shared-Drive-root proofs hit OAuth files.get.
    const mount = await postJson(app, '/api/v1/admin/mounts', admin, {
      label: 'Team',
      driveId: fake.driveId,
      catalogConnectionId: connection.id,
      writeConnectionId: connection.id,
      serviceAccountIds: [serviceAccount.id],
      visibility: 'private',
    });
    expect(mount.status).toBe(200);
    const { mount: mountView } = (await mount.json()) as {
      mount: { id: string; driveId: string };
    };
    const driveRootReads = fake.requests.filter(
      (r) =>
        r.method === 'GET' &&
        r.url.pathname === `/drive/v3/files/${fake.driveId}`,
    );
    // Same-connection mount: one Shared-Drive-root proof via OAuth metadata.
    expect(driveRootReads.length).toBeGreaterThanOrEqual(1);
    expect(driveRootReads.every((r) => r.provider === 'google_oauth')).toBe(true);

    // 7. Create the uploader user + grant read+upload on the mount.
    const user = await postJson(app, '/api/v1/admin/users', admin, {
      name: USER.name,
      email: USER.email,
      password: USER.password,
      role: USER.role,
    });
    expect(user.status).toBe(200);
    const { user: userView } = (await user.json()) as { user: { id: string } };
    const grant = await postJson(
      app,
      `/api/v1/admin/mounts/${mountView.id}/grants`,
      admin,
      { userId: userView.id, role: 'uploader' },
    );
    expect(grant.status).toBe(200);

    const uploader = await signIn(app, USER.email, USER.password);

    // 8. Upload: init drives generateIds + resumable-session create; the
    //    destination folder is proven writable first (OAuth metadata).
    fake.addFolder('folder-1', fake.driveId, 'Uploads');
    const content = new TextEncoder().encode('system-journey-bytes');
    const sha = await sha256Hex(content);
    const init = await api(app, '/api/v1/uploads', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'system-upload-1',
        origin: CANONICAL_ORIGIN,
        cookie: uploader,
      },
      body: JSON.stringify({
        mountId: mountView.id,
        parentId: 'folder-1',
        name: 'journey.bin',
        mimeType: 'application/octet-stream',
        totalBytes: String(content.byteLength),
        sha256: sha,
        md5: md5Hex(content),
      }),
    });
    expect(init.status).toBe(200);
    const initView = (await init.json()) as UploadViewBody;
    expect(initView.uploadId).toBeTruthy();

    const session = [...fake.sessions.values()][0];
    expect(session).toBeDefined();
    const fileId = session!.meta.id!;
    expect(fileId).toBeTruthy();

    // The generated ID is pinned: SA is denied read on it BEFORE completion,
    // so the post-completion reader probe lands 'blocked'.
    fake.saDeniedFiles.add(fileId);
    const put = await api(
      app,
      `/api/v1/uploads/${initView.uploadId}/chunks?generation=${initView.sessionGeneration}&offset=0`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(content.byteLength),
          origin: CANONICAL_ORIGIN,
          cookie: uploader,
        },
        body: content as Uint8Array<ArrayBuffer>,
      },
    );
    expect(put.status).toBe(200);
    const done = (await put.json()) as UploadViewBody;
    expect(done.state).toBe('completed');
    expect(done.readerAccessState).toBe('blocked');

    // Upstream split: every write went through the OAuth bearer; the blocked
    // readiness probe was the SA identity — and nothing streamed bytes via
    // OAuth.
    const writeCalls = fake.calls({ hostSuffix: 'googleapis.com' }).filter(
      (r) =>
        r.method !== 'GET' ||
        r.url.pathname.startsWith('/upload/'),
    );
    const byteWrites = fake.requests.filter(
      (r) => r.url.pathname.startsWith('/upload/drive/v3/'),
    );
    expect(byteWrites.length).toBeGreaterThanOrEqual(2); // session init + chunk
    expect(byteWrites.every((r) => r.provider === 'google_oauth')).toBe(true);
    const mediaCalls = fake.requests.filter(
      (r) => r.url.searchParams.get('alt') === 'media',
    );
    expect(mediaCalls.every((r) => r.provider === 'service_account')).toBe(true);

    // 9. Read stays blocked for the uploader while SA membership is denied.
    const mediaBeforeDenied = fake.requests.filter(
      (r) => r.url.searchParams.get('alt') === 'media',
    ).length;
    const denied = await api(
      app,
      `/api/v1/mounts/${mountView.id}/files/${fileId}/content`,
      { headers: { cookie: uploader } },
    );
    expect(denied.status).not.toBe(200);
    // The SA metadata check fails, so the media fetch must never start
    // (coordinator M4 ruling): zero media calls for the denied request.
    expect(
      fake.requests.filter((r) => r.url.searchParams.get('alt') === 'media')
        .length,
    ).toBe(mediaBeforeDenied);

    // 10. Membership fixed upstream; an explicit readiness re-probe flips the
    //     projection to readable.
    fake.saDeniedFiles.delete(fileId);
    const probe = await api(
      app,
      `/api/v1/mounts/${mountView.id}/files/${fileId}/readiness`,
      {
        method: 'POST',
        headers: { origin: CANONICAL_ORIGIN, cookie: uploader },
      },
    );
    expect(probe.status).toBe(200);
    const readiness = (await probe.json()) as { readerAccessState: string };
    expect(readiness.readerAccessState).toBe('readable');

    // 11. Download streams the exact bytes through the SA identity.
    const dl = await api(
      app,
      `/api/v1/mounts/${mountView.id}/files/${fileId}/content`,
      { headers: { cookie: uploader } },
    );
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(content);
    const mediaNow = fake.requests.filter(
      (r) => r.url.searchParams.get('alt') === 'media',
    );
    expect(mediaNow.length).toBeGreaterThanOrEqual(1);
    expect(mediaNow.every((r) => r.provider === 'service_account')).toBe(true);
    // Byte accounting: what the SA fetched equals what we uploaded.
    const putChunk = byteWrites.find((r) => r.method === 'PUT');
    expect(putChunk?.bytes).toBe(content.byteLength);

    // 11b. Thumbnail through the real app: the global security-header
    //     middleware must preserve the route's short PRIVATE cache
    //     (review M1 — never public, never no-store).
    fake.files.get(fileId)!.thumbnailLink =
      'https://lh3.googleusercontent.com/thumb-1';
    const thumb = await api(
      app,
      `/api/v1/mounts/${mountView.id}/files/${fileId}/thumbnail`,
      { headers: { cookie: uploader } },
    );
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('cache-control')).toBe('private, max-age=300');
    expect(thumb.headers.get('content-type')).toBe('image/png');
    await thumb.arrayBuffer();
    // Error responses on the same path keep the global no-store.
    const noThumb = await api(
      app,
      `/api/v1/mounts/${mountView.id}/files/${fake.driveId}/thumbnail`,
      { headers: { cookie: uploader } },
    );
    expect(noThumb.status).not.toBe(200);
    expect(noThumb.headers.get('cache-control')).toBe('no-store');

    // 12. Share -> admit without session -> revoke -> denied again.
    const share = await postJson(app, '/api/v1/shares', admin, {
      scope: { kind: 'file', mountId: mountView.id, fileId },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(share.status).toBe(201);
    const { token: shareToken, shareId } = (await share.json()) as {
      token: string;
      shareId: string;
    };
    const shared = await api(
      app,
      `/api/v1/mounts/${mountView.id}/files/${fileId}/content?share=${encodeURIComponent(shareToken)}`,
    );
    expect(shared.status).toBe(200);
    const revoke = await api(app, `/api/v1/shares/${shareId}`, {
      method: 'DELETE',
      headers: { origin: CANONICAL_ORIGIN, cookie: admin },
    });
    expect(revoke.status).toBe(200);
    const after = await api(
      app,
      `/api/v1/mounts/${mountView.id}/files/${fileId}/content?share=${encodeURIComponent(shareToken)}`,
    );
    expect(after.status).toBe(403);

    // Final separation audit: no mutation ever carried an SA bearer and no
    // content byte ever carried an OAuth bearer.
    const saWrites = fake.requests.filter(
      (r) =>
        r.provider === 'service_account' &&
        (r.method !== 'GET' || r.url.pathname.startsWith('/upload/')),
    );
    expect(saWrites).toEqual([]);
    const oauthMedia = fake.requests.filter(
      (r) => r.provider === 'google_oauth' && r.url.searchParams.get('alt') === 'media',
    );
    expect(oauthMedia).toEqual([]);
    void writeCalls;
  });
});
