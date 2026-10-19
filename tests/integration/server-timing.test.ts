/**
 * Wave-9 step 0: Server-Timing gating. The header is emitted only on
 * authenticated routes for an admin actor — never on /api/v1/p, /api/v1/site,
 * or for non-admin/anonymous callers. No ids or secrets may appear in it.
 */
import { env, exports } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAuthInstance } from '../../src/worker/auth/session';

const worker = exports.default;
const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const SETUP_TOKEN = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const ORIGIN = 'http://worker.test';
const CANONICAL_ORIGIN = 'https://worker.test';

const ADMIN = {
  token: SETUP_TOKEN,
  name: 'Admin',
  email: 'admin-timing@example.test',
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

async function signIn(email: string, password: string): Promise<string> {
  const res = await api('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.includes('session_token='));
  expect(session, 'sign-in sets a session cookie').toBeTruthy();
  return (session as string).split(';')[0]!;
}

async function resetState() {
  for (const table of [
    'mount_drive_permissions',
    'app_settings',
    'setup_throttle',
    'user',
    'session',
    'account',
    'verification',
    'rateLimit',
    'containment_verdicts',
    'mounts',
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
  await completeSetup();
});

describe('Server-Timing gating (wave 9 step 0)', () => {
  it('emits Server-Timing for an admin session on an authenticated route', async () => {
    const cookie = await signIn(ADMIN.email, ADMIN.password);
    const res = await api('/api/v1/mounts', { headers: { cookie } });
    const header = res.headers.get('server-timing');
    expect(header, 'admin request carries Server-Timing').toBeTruthy();
    // Buckets only — no ids, emails, tokens or secrets in the value.
    expect(header).not.toContain('admin-timing');
    expect(header).not.toContain('session_token');
    expect(header).toMatch(/d1;dur=[0-9.]+;cnt=[0-9]+/);
  });

  it('omits Server-Timing for an anonymous caller on the same route', async () => {
    const res = await api('/api/v1/mounts');
    expect(res.headers.get('server-timing')).toBeNull();
  });

  it('never emits Server-Timing on the anonymous public-link surface', async () => {
    const res = await api('/api/v1/p/anything');
    expect(res.headers.get('server-timing')).toBeNull();
  });

  it('never emits Server-Timing on /api/v1/site', async () => {
    const res = await api('/api/v1/site');
    expect(res.headers.get('server-timing')).toBeNull();
  });

  it('omits Server-Timing for a non-admin session', async () => {
    // Create a non-admin user through the auth instance API directly.
    const auth = await getAuthInstance(env as unknown as Parameters<typeof getAuthInstance>[0]);
    await auth.api.createUser({
      body: {
        email: 'viewer-timing@example.test',
        password: 'correct-horse-battery-staple',
        name: 'Viewer',
        role: 'user',
      },
    });
    const cookie = await signIn(
      'viewer-timing@example.test',
      'correct-horse-battery-staple',
    );
    const mountsRes = await api('/api/v1/mounts', { headers: { cookie } });
    expect(mountsRes.headers.get('server-timing')).toBeNull();
  });
});
