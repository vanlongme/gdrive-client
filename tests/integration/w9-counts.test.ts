/**
 * Wave-9 measurement harness (worker P). Runs real route code with REAL
 * provider implementations against a counting fake-Google fetch and a
 * counting token source, so per-request upstream counts (D1 queries, DO
 * /admit fetches, Google calls) can be compared before/after the latency
 * changes. The "after" run wraps the same counting token source in the
 * production per-request memo; the "before" run hits it for every call —
 * identical code except the memo, which is exactly what step 1b changed.
 */
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContentRouter } from '../../src/worker/transfers/download';
import type { ContentRouteDeps } from '../../src/worker/transfers/content-access';
import { createServiceAccountReadProvider } from '../../src/worker/drive/providers/service-account-read';
import { createGoogleOAuthProvider } from '../../src/worker/drive/providers/google-oauth';
import { createDriveTransport } from '../../src/worker/drive/transport';
import { requestTokenMemo } from '../../src/worker/timing';
import type {
  CoordinatorTokenSource,
  GetTokenOptions,
  TokenIdentity,
  TokenResult,
} from '../../src/worker/drive/types';
import type { Actor } from '../../src/worker/auth/grants';
import { getMount } from '../../src/worker/drive/mounts';
import { resetContainmentCacheForTests } from '../../src/worker/drive/containment';
const collected: string[] = [];
const report = (line: string) => {
  // workerd blocks fs and console; surface counts through the final
  // assertion's diff output instead.
  collected.push(line);
};

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];
const ORIGIN = 'http://worker.test';
const NOW = Date.now();

const adminActor: Actor = {
  kind: 'user',
  user: { id: 'u-admin', role: 'admin', name: 'A', email: 'a@x', disabled: false, createdAt: '2026-01-01T00:00:00Z' },
  sessionId: 'sess-1',
};

// ---------------------------------------------------------------------------
// Counting D1 proxy — every prepared-statement call / batch is one query.
// ---------------------------------------------------------------------------
function countingD1(db: D1Database): { db: D1Database; count: () => number } {
  let n = 0;
  const inners = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrapStmt = (inner: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...v: unknown[]) => wrapStmt(inner.bind(...v)),
      first: <T = unknown>(c?: string) => { n++; return inner.first<T>(c as string); },
      run: () => { n++; return inner.run(); },
      all: <T = unknown>() => { n++; return inner.all<T>(); },
      raw: <T = unknown[]>(o?: { columnNames?: boolean }) => { n++; return inner.raw<T>(o as never); },
    } as D1PreparedStatement;
    inners.set(wrapped, inner);
    return wrapped;
  };
  return {
    db: {
      prepare: (q: string) => wrapStmt(db.prepare(q)),
      batch: (st: D1PreparedStatement[]) => {
        n += st.length;
        return db.batch(st.map((x) => inners.get(x) ?? x));
      },
      exec: (q: string) => { n++; return db.exec(q); },
      dump: () => db.dump(),
      withSession: (() => db.withSession()) as D1Database['withSession'],
    },
    count: () => n,
  };
}

// ---------------------------------------------------------------------------
// Counting token source. With memoize=true every getToken is forwarded
// through the production per-request memo keyed by the live Request object.
// ---------------------------------------------------------------------------
function countingSource(memoize: boolean, currentReq: () => Request) {
  const calls: { identity: string; fileId?: string }[] = [];
  const base: CoordinatorTokenSource = {
    getToken: (identity: TokenIdentity, options?: GetTokenOptions): Promise<TokenResult> => {
      calls.push({ identity: JSON.stringify(identity), fileId: options?.fileId });
      return Promise.resolve({ ok: true, accessToken: 'fake-token', expiresAtMs: Date.now() + 3600e3 });
    },
    reportFailure: () => Promise.resolve(),
  };
  const source: CoordinatorTokenSource = {
    getToken: (identity, options) =>
      memoize
        ? requestTokenMemo(currentReq()).wrap(base).getToken(identity, options)
        : base.getToken(identity, options),
    reportFailure: (identity, report) =>
      memoize
        ? requestTokenMemo(currentReq()).wrap(base).reportFailure(identity, report)
        : base.reportFailure(identity, report),
  };
  return { source, calls };
}

// ---------------------------------------------------------------------------
// Fake Google fetch: counts every call and answers files.get / alt=media /
// thumbnail fetches with plausible payloads.
// ---------------------------------------------------------------------------
function fakeGoogle() {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'lh3.googleusercontent.com') {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (u.searchParams.get('alt') === 'media') {
      return new Response(new Uint8Array([9, 8, 7, 6, 5]), { status: 200 });
    }
    // files.get metadata
    const id = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    const meta: Record<string, unknown> = {
      id,
      name: `file-${id}`,
      mimeType: 'text/plain',
      size: '5',
      modifiedTime: '2026-10-01T00:00:00Z',
      trashed: false,
      thumbnailLink: 'https://lh3.googleusercontent.com/fake-thumb',
      capabilities: { canDownload: true, canReadRevisions: true },
    };
    if (id === 'f-1') meta.parents = ['dirA'];
    if (id === 'dirA') meta.parents = ['root-1'];
    if (id === 'f-2') meta.driveId = 'drive-1';
    return Response.json(meta);
  };
  return { fetchImpl, calls };
}

async function resetState() {
  for (const t of [
    'mount_drive_permissions', 'mount_read_credentials', 'mount_grants',
    'service_accounts', 'mounts', 'google_connections', 'google_oauth_clients',
    'containment_verdicts', 'app_settings', 'session', 'account', 'user',
  ]) {
    await env.DB.prepare(`DELETE FROM "${t}"`).run();
  }
}

async function seed(driveId: string | null) {
  await env.DB.prepare(
    "INSERT INTO app_settings (id, installation_id, setup_state, canonical_origin, policies, version, created_at, updated_at) " +
      "VALUES (1, 'install-1', 'complete', ?, '{}', 1, ?, ?)",
  ).bind(ORIGIN, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at) VALUES ('oc-1', 'proj-1', 'client-1', 'env', 'https://x/cb', ?, ?)",
  ).bind(NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, granted_scopes, state, enabled, version, created_at, updated_at) VALUES ('conn-1', 'oc-1', 'p-1', 'drive', 'connected', 1, 1, ?, ?)",
  ).bind(NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, visibility, created_at, updated_at) VALUES ('m-1', 'Mount', ?, ?, 'conn-1', 'conn-1', 'private', ?, ?)",
  ).bind(driveId, driveId === null ? 'root-1' : 'drive-1', NOW, NOW).run();
  for (const sa of [{ id: 'sa-1', p: 10 }, { id: 'sa-2', p: 5 }]) {
    await env.DB.prepare(
      "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES (?, 'proj-1', ?, 'k', 'env', 1, 1, ?, ?)",
    ).bind(sa.id, `${sa.id}@proj-1.iam.gserviceaccount.com`, NOW, NOW).run();
    await env.DB.prepare(
      'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES (?, ?, ?, 1, ?)',
    ).bind('m-1', sa.id, sa.p, NOW).run();
  }
}

function harness(memoize: boolean) {
  let curReq: Request = new Request('http://x/');
  const d1 = countingD1(env.DB);
  const envProxy = { ...(env as unknown as Env), DB: d1.db };
  const ts = countingSource(memoize, () => curReq);
  const g = fakeGoogle();
  const readProvider = createServiceAccountReadProvider({
    tokenSource: ts.source,
    transport: createDriveTransport('service_account', { fetchImpl: g.fetchImpl }),
  });
  const oauthProvider = createGoogleOAuthProvider({
    tokenSource: ts.source,
    transport: createDriveTransport('google_oauth', { fetchImpl: g.fetchImpl }),
  });
  const deps: ContentRouteDeps = {
    getMount,
    resolveSessionActor: () => Promise.resolve(adminActor),
    readProvider,
    oauthProvider,
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    curReq = c.req.raw;
    c.set('requestId', 'req');
    await next();
  });
  app.route('/api/v1/mounts', createContentRouter(deps));
  return {
    api: (path: string, init?: RequestInit) =>
      Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, init), envProxy)),
    d1,
    ts,
    g,
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  resetContainmentCacheForTests();
  await resetState();
});

describe('wave-9 upstream call counts', () => {
  it('GET /content (shared drive): before vs after', async () => {
    for (const memoize of [false, true]) {
      await resetState();
      resetContainmentCacheForTests();
      await seed('drive-1');
      const h = harness(memoize);
      const res = await h.api('/api/v1/mounts/m-1/files/f-2/content');
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      // One DO admission per SA (meta+media share one admit in the memo).
      expect(h.ts.calls.length).toBe(memoize ? 1 : 2);
      expect(h.g.calls.length).toBe(2);
      report(
        `shared-drive /content memoize=${memoize} ` +
          `d1=${h.d1.count()} admits=${h.ts.calls.length} google=${h.g.calls.length}`,
      );
    }
  });

  it('GET /content (My Drive): before vs after', async () => {
    for (const memoize of [false, true]) {
      await resetState();
      resetContainmentCacheForTests();
      await seed(null);
      const h = harness(memoize);
      const res = await h.api('/api/v1/mounts/m-1/files/f-1/content');
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      // SA meta+media share one admit; the OAuth ancestor walk shares one.
      expect(h.ts.calls.length).toBe(memoize ? 2 : 3);
      expect(h.g.calls.length).toBe(3);
      report(
        `my-drive /content memoize=${memoize} ` +
          `d1=${h.d1.count()} admits=${h.ts.calls.length} google=${h.g.calls.length}`,
      );
    }
  });

  it('GET /thumbnail (shared drive): after', async () => {
    await seed('drive-1');
    const h = harness(true);
    const res = await h.api('/api/v1/mounts/m-1/files/f-2/thumbnail');
    expect(res.status).toBe(200);
    // thumbnailLink comes from the admission metadata: meta + thumbnail
    // fetch, no second files.get (step 2c).
    expect(h.g.calls.length).toBe(2);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    report(
      `/thumbnail status=${res.status} ` +
        `d1=${h.d1.count()} admits=${h.ts.calls.length} google=${h.g.calls.length} cc=${res.headers.get('cache-control')}`,
    );
  });

  it('reports measured counts', () => {
    // Worker-P evidence: counts captured into `collected` per scenario.
    expect(collected.length).toBeGreaterThanOrEqual(5);
    report('done');
  });

});
