/**
 * T06 content streaming routes — real Response-semantics coverage in
 * workerd (wave-3 track B). The SA provider is a deterministic fixture; the
 * D1 mount/read-pool/share state is real (real getMount + real SQL), and
 * every assertion is on the produced Response (status, headers, body,
 * provider calls, cancellation propagation).
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { DriveError } from '../../src/worker/drive/errors';
import { getMount } from '../../src/worker/drive/mounts';
import type {
  DriveFileMeta,
  DriveRevisionMeta,
  ExportDocumentInput,
  GetRevisionInput,
  OpenContentInput,
  OpenThumbnailInput,
  ReadMetadataInput,
  ServiceAccountContentReadProvider,
  UpstreamContent,
} from '../../src/worker/drive/types';
import type { Actor } from '../../src/worker/auth/grants';
import type { AuthUser } from '../../src/worker/auth/session';
import { createContentRouter } from '../../src/worker/transfers/download';
import { createShareRouter } from '../../src/worker/security/shares';
import type { ContentRouteDeps } from '../../src/worker/transfers/content-access';
import type { ShareRouterDeps } from '../../src/worker/security/shares';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const NOW = 1_700_000_000_000;
const ORIGIN = 'https://app.test';
const encoder = new TextEncoder();

const adminUser: AuthUser = {
  id: 'u-admin',
  name: 'Admin',
  email: 'admin@example.test',
  role: 'admin',
  disabled: false,
  createdAt: new Date(NOW).toISOString(),
};

const viewerUser: AuthUser = {
  id: 'u-viewer',
  name: 'Viewer',
  email: 'viewer@example.test',
  role: 'user',
  disabled: false,
  createdAt: new Date(NOW).toISOString(),
};

const userActor = (user: AuthUser): Actor => ({
  kind: 'user',
  user,
  sessionId: 'sess-1',
});
const publicActor: Actor = { kind: 'public' };

// ---------------------------------------------------------------------------
// D1 state
// ---------------------------------------------------------------------------

async function resetState() {
  for (const table of [
    'audit_events',
    'file_readiness',
    'share_links',
    'mount_grants',
    'mount_read_credentials',
    'service_accounts',
    'mounts',
    'google_connections',
    'google_oauth_clients',
    'session',
    'account',
    'user',
    'app_settings',
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

async function seedBase(
  options: { visibility?: 'private' | 'public_read'; pool?: Array<{ id: string; priority?: number; weight?: number; enabled?: number }> } = {},
) {
  await resetState();
  const visibility = options.visibility ?? 'private';
  await env.DB.prepare(
    "INSERT INTO app_settings (id, installation_id, setup_state, canonical_origin, policies, version, created_at, updated_at) " +
      "VALUES (1, 'install-1', 'complete', ?, '{}', 1, ?, ?)",
  )
    .bind(ORIGIN, NOW, NOW)
    .run();
  for (const u of [adminUser, viewerUser]) {
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, 0)',
    )
      .bind(u.id, u.name, u.email, NOW, NOW, u.role)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at) VALUES ('oc-1', 'proj-1', 'client-1', 'env', 'https://x/cb', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, granted_scopes, created_at, updated_at) VALUES ('conn-1', 'oc-1', 'p-1', 'drive', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id, visibility, created_at, updated_at) VALUES ('m-1', 'Mount', 'drive-1', 'conn-1', 'conn-1', ?, ?, ?)",
  )
    .bind(visibility, NOW, NOW)
    .run();
  const pool = options.pool ?? [
    { id: 'sa-1', priority: 10, weight: 1, enabled: 1 },
    { id: 'sa-2', priority: 5, weight: 1, enabled: 1 },
  ];
  for (const sa of pool) {
    await env.DB.prepare(
      "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) " +
        'VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    )
      .bind(
        sa.id,
        'proj-1',
        `${sa.id}@proj-1.iam.gserviceaccount.com`,
        `key-${sa.id}`,
        'env',
        sa.enabled ?? 1,
        NOW,
        NOW,
      )
      .run();
    await env.DB.prepare(
      'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('m-1', sa.id, sa.priority ?? 0, sa.weight ?? 1, NOW)
      .run();
  }
}

async function grantViewer(userId: string, operations = '["read"]') {
  await env.DB.prepare(
    "INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES (?, 'm-1', 'viewer', ?, ?, ?, ?)",
  )
    .bind(userId, operations, adminUser.id, NOW, NOW)
    .run();
}

// ---------------------------------------------------------------------------
// Fixture SA provider
// ---------------------------------------------------------------------------

interface ProviderCall {
  op: 'meta' | 'revision' | 'content' | 'thumbnail' | 'export';
  identityId: string;
  refId: string;
  range?: { start: bigint; end: bigint };
  revisionId?: string;
  format?: string;
  signal?: AbortSignal;
}

class FakeReadProvider implements ServiceAccountContentReadProvider {
  readonly calls: ProviderCall[] = [];
  metaHandler?: (input: ReadMetadataInput) => DriveFileMeta | Promise<DriveFileMeta>;
  revisionHandler?: (input: GetRevisionInput) => DriveRevisionMeta | Promise<DriveRevisionMeta>;
  contentHandler?: (input: OpenContentInput) => UpstreamContent | Promise<UpstreamContent>;
  thumbnailHandler?: (input: OpenThumbnailInput) => UpstreamContent | Promise<UpstreamContent>;
  exportHandler?: (input: ExportDocumentInput) => UpstreamContent | Promise<UpstreamContent>;

  async getReadMetadata(input: ReadMetadataInput): Promise<DriveFileMeta> {
    this.calls.push({
      op: 'meta',
      identityId: input.identity.serviceAccountId,
      refId: input.ref.id,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (this.metaHandler === undefined) {
      throw new Error('metaHandler not configured');
    }
    return this.metaHandler(input);
  }

  async getRevision(input: GetRevisionInput): Promise<DriveRevisionMeta> {
    this.calls.push({
      op: 'revision',
      identityId: input.identity.serviceAccountId,
      refId: input.ref.id,
      revisionId: input.revisionId,
    });
    if (this.revisionHandler === undefined) {
      throw new Error('revisionHandler not configured');
    }
    return this.revisionHandler(input);
  }

  async openContent(input: OpenContentInput): Promise<UpstreamContent> {
    this.calls.push({
      op: 'content',
      identityId: input.identity.serviceAccountId,
      refId: input.ref.id,
      ...(input.range === undefined ? {} : { range: input.range }),
      ...(input.revisionId === undefined ? {} : { revisionId: input.revisionId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (this.contentHandler === undefined) {
      throw new Error('contentHandler not configured');
    }
    return this.contentHandler(input);
  }

  async openThumbnail(input: OpenThumbnailInput): Promise<UpstreamContent> {
    this.calls.push({
      op: 'thumbnail',
      identityId: input.identity.serviceAccountId,
      refId: input.ref.id,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (this.thumbnailHandler === undefined) {
      throw new Error('thumbnailHandler not configured');
    }
    return this.thumbnailHandler(input);
  }

  async exportDocument(input: ExportDocumentInput): Promise<UpstreamContent> {
    this.calls.push({
      op: 'export',
      identityId: input.identity.serviceAccountId,
      refId: input.ref.id,
      format: input.format,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (this.exportHandler === undefined) {
      throw new Error('exportHandler not configured');
    }
    return this.exportHandler(input);
  }
}

const FILE_META: DriveFileMeta = {
  id: 'f-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: '26',
  modifiedTime: '2026-10-01T12:00:00.000Z',
  trashed: false,
  driveId: 'drive-1',
  hasThumbnail: true,
  capabilities: { canDownload: true, canReadRevisions: true },
};

function defaultMeta(overrides: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return { ...FILE_META, ...overrides };
}

function bytesUpstream(
  body: string,
  options: {
    status?: 200 | 206;
    contentType?: string;
    contentRange?: string;
    contentLength?: bigint;
  } = {},
): UpstreamContent {
  return {
    status: options.status ?? 200,
    contentType: options.contentType ?? 'text/plain',
    contentLength: options.contentLength ?? BigInt(encoder.encode(body).byteLength),
    ...(options.contentRange === undefined
      ? {}
      : { contentRange: options.contentRange }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  app: Hono<{ Bindings: Env; Variables: { requestId?: string } }>;
  provider: FakeReadProvider;
}

function makeHarness(
  actor: Actor,
  options: { provider?: FakeReadProvider; now?: () => number } = {},
): Harness {
  const provider = options.provider ?? new FakeReadProvider();
  const deps: ContentRouteDeps = {
    getMount,
    resolveSessionActor: () => Promise.resolve(actor),
    readProvider: provider,
    ...(options.now === undefined ? { now: () => NOW } : { now: options.now }),
  };
  const shareDeps: ShareRouterDeps = {
    requireAdmin: () =>
      Promise.resolve({ userId: adminUser.id, sessionId: 'sess-1' }),
    getMount,
    ...(options.now === undefined ? { now: () => NOW } : { now: options.now }),
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/api/v1/mounts', createContentRouter(deps));
  app.route('/api/v1/shares', createShareRouter(shareDeps));
  return { app, provider };
}

function api(
  app: Hono<{ Bindings: Env; Variables: { requestId?: string } }>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env),
  );
}

const CONTENT = '/api/v1/mounts/m-1/files/f-1/content';

function contentCalls(provider: FakeReadProvider): ProviderCall[] {
  return provider.calls.filter((c) => c.op === 'content');
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
});

// ---------------------------------------------------------------------------
// GET content — basic streaming + headers
// ---------------------------------------------------------------------------

describe('GET content', () => {
  it('streams the full body with safe download headers and no strong ETag', async () => {
    await seedBase();
    await grantViewer(viewerUser.id);
    const { app, provider } = makeHarness(userActor(viewerUser));
    provider.metaHandler = () => defaultMeta();
    provider.contentHandler = () => bytesUpstream('hello world, this is body!');

    const res = await api(app, CONTENT);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello world, this is body!');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-length')).toBe('26');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('etag')).toBeNull();
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('inline');
    expect(disposition).toContain('filename="notes.txt"');
    // Metadata and body came from the same SA identity.
    expect(provider.calls[0]?.op).toBe('meta');
    expect(provider.calls[1]?.op).toBe('content');
    expect(provider.calls[1]?.identityId).toBe(provider.calls[0]?.identityId);
  });

  it('emits UTF-8 filename* with a safe ASCII fallback', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () =>
      defaultMeta({ name: 'báo cáo "final".txt' });
    provider.contentHandler = () => bytesUpstream('x');
    const res = await api(app, CONTENT);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('filename="b_o c_o _final_.txt"');
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent('báo cáo "final".txt').replace(/'/g, '%27')}`,
    );
  });

  it('forces attachment for active content types even when inline is requested', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () =>
      defaultMeta({ mimeType: 'image/svg+xml', name: 'icon.svg' });
    provider.contentHandler = () =>
      bytesUpstream('<svg/>', { contentType: 'image/svg+xml' });
    const res = await api(app, `${CONTENT}?disposition=inline`);
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('honours disposition=attachment for binary downloads', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    provider.contentHandler = () => bytesUpstream('x');
    const res = await api(app, `${CONTENT}?disposition=attachment`);
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('computes disposition from the DELIVERED type, not metadata (F3)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () =>
      defaultMeta({ mimeType: 'text/plain', name: 'innocent.txt' });
    provider.contentHandler = () =>
      bytesUpstream('<html>not plain text</html>', {
        contentType: 'text/html',
      });
    const res = await api(app, CONTENT);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });
});

// ---------------------------------------------------------------------------
// Range / If-Range / HEAD semantics
// ---------------------------------------------------------------------------

describe('Range and HEAD semantics', () => {
  async function seedContentHarness(
    handler?: (input: { range?: { start: bigint; end: bigint } }) => UpstreamContent,
  ) {
    await seedBase();
    const provider = new FakeReadProvider();
    provider.metaHandler = () => defaultMeta();
    provider.contentHandler =
      handler ??
      ((input) => {
        if (input.range !== undefined) {
          const { start, end } = input.range;
          return bytesUpstream('0123456789', {
            status: 206,
            contentRange: `bytes ${start.toString(10)}-${end.toString(10)}/26`,
            contentLength: end - start + 1n,
          });
        }
        return bytesUpstream('abcdefghijklmnopqrstuvwxyz');
      });
    return makeHarness(userActor(adminUser), { provider });
  }

  it('serves a closed range as a relayed 206', async () => {
    const { app, provider } = await seedContentHarness();
    const res = await api(app, CONTENT, {
      headers: { range: 'bytes=0-9' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/26');
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('0123456789');
    expect(contentCalls(provider)[0]?.range).toEqual({ start: 0n, end: 9n });
  });

  it('serves a suffix range', async () => {
    const { app, provider } = await seedContentHarness();
    const res = await api(app, CONTENT, {
      headers: { range: 'bytes=-5' },
    });
    expect(contentCalls(provider)[0]?.range).toEqual({ start: 21n, end: 25n });
    expect(res.status).toBe(206);
  });

  it('serves an open-ended range clamped to the size', async () => {
    const { app, provider } = await seedContentHarness();
    const res = await api(app, CONTENT, {
      headers: { range: 'bytes=20-' },
    });
    expect(contentCalls(provider)[0]?.range).toEqual({ start: 20n, end: 25n });
    expect(res.status).toBe(206);
  });

  it('answers 416 with Content-Range for an unsatisfiable range without an upstream call', async () => {
    const { app, provider } = await seedContentHarness();
    const res = await api(app, CONTENT, {
      headers: { range: 'bytes=100-200' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */26');
    expect(contentCalls(provider)).toHaveLength(0);
  });

  it('ignores malformed and multi-range headers and serves 200', async () => {
    for (const range of ['bytes=0-1,3-4', 'items=0-9', 'bytes=-', 'garbage']) {
      const { app, provider } = await seedContentHarness();
      const res = await api(app, CONTENT, { headers: { range } });
      expect(res.status).toBe(200);
      expect(contentCalls(provider)[0]?.range).toBeUndefined();
    }
  });

  it('relays an upstream 200 even when a range was requested', async () => {
    const { app, provider } = await seedContentHarness(() =>
      bytesUpstream('abcdefghijklmnopqrstuvwxyz'),
    );
    const res = await api(app, CONTENT, {
      headers: { range: 'bytes=0-9' },
    });
    // Upstream answered the whole representation; we relay it — never a
    // fabricated 206.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(provider.calls.at(-1)?.op).toBe('content');
  });

  it('drops the Range for any current-content If-Range (R5 decision)', async () => {
    for (const ifRange of [
      'Wed, 01 Oct 2026 12:00:00 GMT',
      '"some-etag"',
      'W/"weak"',
      '   ',
    ]) {
      const { app, provider } = await seedContentHarness();
      const res = await api(app, CONTENT, {
        headers: { range: 'bytes=0-9', 'if-range': ifRange },
      });
      expect(res.status).toBe(200);
      expect(contentCalls(provider)[0]?.range).toBeUndefined();
    }
  });

  it('HEAD ignores Range/If-Range, returns full metadata and never opens a body', async () => {
    const { app, provider } = await seedContentHarness();
    const res = await api(app, CONTENT, {
      method: 'HEAD',
      headers: { range: 'bytes=0-9', 'if-range': 'Wed, 01 Oct 2026 12:00:00 GMT' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('26');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-range')).toBeNull();
    expect(contentCalls(provider)).toHaveLength(0);
    expect(provider.calls.every((c) => c.op === 'meta')).toBe(true);
  });

  it('HEAD in revision mode validates the revision without a body fetch', async () => {
    await seedBase();
    const provider = new FakeReadProvider();
    provider.metaHandler = () => defaultMeta();
    provider.revisionHandler = () => ({
      id: 'rev-1',
      size: '26',
      modifiedTime: '2026-09-01T00:00:00.000Z',
      keepForever: true,
    });
    const { app } = makeHarness(userActor(adminUser), { provider });
    const res = await api(app, `${CONTENT}?mode=revision&revision=rev-1`, {
      method: 'HEAD',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"gdrev-f-1-rev-1"');
    expect(contentCalls(provider)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pinned revisions
// ---------------------------------------------------------------------------

describe('pinned revision mode', () => {
  async function seedRevisionHarness(revision: Partial<DriveRevisionMeta> = {}) {
    await seedBase();
    const provider = new FakeReadProvider();
    provider.metaHandler = () => defaultMeta();
    provider.revisionHandler = () => ({
      id: 'rev-1',
      size: '26',
      modifiedTime: '2026-09-01T00:00:00.000Z',
      keepForever: true,
      ...revision,
    });
    provider.contentHandler = () =>
      bytesUpstream('revision-bytes-here-123456');
    return makeHarness(userActor(adminUser), { provider });
  }

  it('serves the pinned revision with a strong ETag and SA body', async () => {
    const { app, provider } = await seedRevisionHarness();
    const res = await api(app, `${CONTENT}?mode=revision&revision=rev-1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"gdrev-f-1-rev-1"');
    expect(contentCalls(provider)[0]?.revisionId).toBe('rev-1');
    expect(await res.text()).toBe('revision-bytes-here-123456');
  });

  it('honours If-Range only for the exact pinned ETag', async () => {
    const good = await seedRevisionHarness();
    good.provider.contentHandler = () =>
      bytesUpstream('0123456789', {
        status: 206,
        contentRange: 'bytes 0-9/26',
        contentLength: 10n,
      });
    const resOk = await api(good.app, `${CONTENT}?mode=revision&revision=rev-1`, {
      headers: { range: 'bytes=0-9', 'if-range': '"gdrev-f-1-rev-1"' },
    });
    expect(resOk.status).toBe(206);

    const bad = await seedRevisionHarness();
    const resBad = await api(bad.app, `${CONTENT}?mode=revision&revision=rev-1`, {
      headers: { range: 'bytes=0-9', 'if-range': '"gdrev-f-1-rev-OTHER"' },
    });
    expect(resBad.status).toBe(200);
    expect(contentCalls(bad.provider)[0]?.range).toBeUndefined();
  });

  it('rejects a non-kept revision as SNAPSHOT_UNAVAILABLE', async () => {
    const { app, provider } = await seedRevisionHarness({ keepForever: false });
    const res = await api(app, `${CONTENT}?mode=revision&revision=rev-1`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SNAPSHOT_UNAVAILABLE');
    expect(contentCalls(provider)).toHaveLength(0);
  });

  it('rejects a vanished revision instead of falling back to head', async () => {
    const { app, provider } = await seedRevisionHarness();
    provider.revisionHandler = () => {
      throw new DriveError('not-found', 'gone', { status: 404 });
    };
    const res = await api(app, `${CONTENT}?mode=revision&revision=rev-1`);
    expect(res.status).toBe(409);
    expect(contentCalls(provider)).toHaveLength(0);
  });

  it('rejects malformed mode/query combinations', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    provider.contentHandler = () => bytesUpstream('x');
    for (const path of [
      `${CONTENT}?mode=bogus`,
      `${CONTENT}?mode=revision`,
      `${CONTENT}?revision=rev-1`,
      `${CONTENT}?mode=revision&revision=`,
      `${CONTENT}?url=https://evil.example/x`,
      `${CONTENT}?other=1`,
    ]) {
      const res = await api(app, path);
      expect(res.status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// Admission and SA-side verification
// ---------------------------------------------------------------------------

describe('admission and SA verification', () => {
  it('denies a session user without a read grant', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(viewerUser));
    provider.metaHandler = () => defaultMeta();
    const res = await api(app, CONTENT);
    expect(res.status).toBe(403);
    expect(provider.calls).toHaveLength(0);
  });

  it('denies anonymous access on a private mount but allows public_read', async () => {
    await seedBase();
    const denied = await api(
      makeHarness(publicActor).app,
      CONTENT,
    );
    expect(denied.status).toBe(401);

    await resetState();
    await seedBase({ visibility: 'public_read' });
    const { app, provider } = makeHarness(publicActor);
    provider.metaHandler = () => defaultMeta();
    provider.contentHandler = () => bytesUpstream('pub');
    const res = await api(app, CONTENT);
    expect(res.status).toBe(200);
  });

  it('rejects files outside the mount drive, trashed files and canDownload=false', async () => {
    for (const [meta, expected] of [
      [defaultMeta({ driveId: 'drive-OTHER' }), 404],
      [defaultMeta({ trashed: true }), 404],
      [
        defaultMeta({
          capabilities: { canDownload: false, canReadRevisions: true },
        }),
        502,
      ],
    ] as const) {
      await resetState();
      await seedBase();
      const { app, provider } = makeHarness(userActor(adminUser));
      provider.metaHandler = () => meta;
      provider.contentHandler = () => bytesUpstream('x');
      const res = await api(app, CONTENT);
      expect(res.status).toBe(expected);
      expect(contentCalls(provider)).toHaveLength(0);
    }
  });

  it('fails closed when the read pool is empty', async () => {
    await seedBase({ pool: [] });
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    const res = await api(app, CONTENT);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('READ_PROVIDER_UNAVAILABLE');
  });

  it('fails over to the next pool SA on a permission failure', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = (input) => {
      if (input.identity.serviceAccountId === 'sa-1') {
        throw new DriveError('permission-denied', 'denied', { status: 403 });
      }
      return defaultMeta();
    };
    provider.contentHandler = () => bytesUpstream('from-sa-2-here------');
    const res = await api(app, CONTENT);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from-sa-2-here------');
    expect(contentCalls(provider)[0]?.identityId).toBe('sa-2');
  });

  it('never rotates SAs on a file-level download restriction', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = (input) => {
      if (input.identity.serviceAccountId === 'sa-1') {
        throw new DriveError('download-restricted', 'file limited', {
          status: 403,
        });
      }
      return defaultMeta();
    };
    provider.contentHandler = () => bytesUpstream('x');
    const res = await api(app, CONTENT);
    expect(res.status).not.toBe(200);
    expect(provider.calls.every((c) => c.identityId === 'sa-1')).toBe(true);
  });

  it('never rotates SAs on a collapsed cooldown/rate-limit (R5)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = (input) => {
      if (input.identity.serviceAccountId === 'sa-1') {
        throw new DriveError('rate-limited', 'cooldown', {
          status: 429,
          retryAfterMs: 5000,
        });
      }
      return defaultMeta();
    };
    provider.contentHandler = () => bytesUpstream('x');
    const res = await api(app, CONTENT);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; retryAfterSeconds?: number } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfterSeconds).toBe(5);
    expect(provider.calls.every((c) => c.identityId === 'sa-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('downstream cancellation', () => {
  it('aborts the upstream body when the client cancels the response', async () => {
    await seedBase();
    const provider = new FakeReadProvider();
    provider.metaHandler = () => defaultMeta();
    let upstreamCancelled = false;
    provider.contentHandler = () => ({
      status: 200,
      contentType: 'text/plain',
      contentLength: 3n,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(encoder.encode('abc'));
        },
        cancel() {
          upstreamCancelled = true;
        },
      }),
    });
    const { app } = makeHarness(userActor(adminUser), { provider });
    const res = await api(app, CONTENT);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(upstreamCancelled).toBe(true);
    // The abort also propagated to the provider's bound signal.
    const contentCall = contentCalls(provider)[0];
    expect(contentCall?.signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Readiness, thumbnail, export
// ---------------------------------------------------------------------------

describe('readiness probe', () => {
  it('records a readable result into file_readiness', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/readiness', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readerAccessState: string };
    expect(body.readerAccessState).toBe('readable');
    const row = await env.DB
      .prepare('SELECT reader_access_state FROM file_readiness WHERE mount_id = ? AND file_id = ?')
      .bind('m-1', 'f-1')
      .first<{ reader_access_state: string }>();
    expect(row?.reader_access_state).toBe('readable');
  });

  it('records a blocked result with reason when the SA cannot read', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => {
      throw new DriveError('permission-denied', 'no', { status: 403 });
    };
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/readiness', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readerAccessState: string; reason?: string };
    expect(body.readerAccessState).toBe('blocked');
    expect(body.reason).toContain('permission-denied');
  });

  it('records pending (not blocked) for transient upstream failures', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => {
      throw new DriveError('upstream-unavailable', '503', { status: 503 });
    };
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/readiness', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readerAccessState: string; reason?: string };
    expect(body.readerAccessState).toBe('pending');
    const row = await env.DB
      .prepare('SELECT reader_access_state FROM file_readiness WHERE mount_id = ? AND file_id = ?')
      .bind('m-1', 'f-1')
      .first<{ reader_access_state: string }>();
    expect(row?.reader_access_state).toBe('pending');
  });

  it('persists nothing when the probe aborts locally (F2)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => {
      throw new DriveError('aborted', 'cancelled');
    };
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/readiness', {
      method: 'POST',
    });
    expect(res.status).not.toBe(200);
    const row = await env.DB
      .prepare('SELECT reader_access_state FROM file_readiness WHERE mount_id = ? AND file_id = ?')
      .bind('m-1', 'f-1')
      .first<{ reader_access_state: string }>();
    expect(row).toBeNull();
  });

  it('rejects share actors and non-session principals', async () => {
    await seedBase();
    const { app, provider } = makeHarness(publicActor);
    provider.metaHandler = () => defaultMeta();
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/readiness', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });
});

describe('thumbnail and export parity', () => {
  it('serves a thumbnail through the SA with the same admission checks', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    provider.thumbnailHandler = () =>
      bytesUpstream('PNG-DATA', { contentType: 'image/png' });
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/thumbnail');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    // Reviewer F11: no per-route private cache override — the production
    // middleware stamps `no-store` on every /api response (the test harness
    // does not mount that middleware, so the header is simply absent here).
    expect(res.headers.get('cache-control')).toBeNull();
    expect(await res.text()).toBe('PNG-DATA');
    expect(provider.calls.at(-1)?.op).toBe('thumbnail');
  });

  it('forces attachment when the thumbnail upstream delivers active content (F3)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    provider.thumbnailHandler = () =>
      bytesUpstream('<svg onload="x"/>', { contentType: 'image/svg+xml' });
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/thumbnail');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('denies thumbnails to unauthorized actors the same way as content', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(viewerUser));
    provider.metaHandler = () => defaultMeta();
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/thumbnail');
    expect(res.status).toBe(403);
    expect(provider.calls).toHaveLength(0);
  });

  it('exports a Google-native document as PDF', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () =>
      defaultMeta({ mimeType: 'application/vnd.google-apps.document', name: 'report' });
    provider.exportHandler = () =>
      bytesUpstream('%PDF-1.4', { contentType: 'application/pdf' });
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/export?format=pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('report.pdf');
    expect(provider.calls.at(-1)?.format).toBe('pdf');
  });

  it('rejects export on non-native files and unknown formats', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    provider.exportHandler = () => bytesUpstream('x');
    expect(
      (await api(app, '/api/v1/mounts/m-1/files/f-1/export?format=pdf')).status,
    ).toBe(415);
    expect(
      (
        await api(
          app,
          '/api/v1/mounts/m-1/files/f-1/export?format=docx',
        )
      ).status,
    ).toBe(400);
    expect(provider.calls.every((c) => c.op !== 'export')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reviewer fixes: route-boundary id validation (F5), shortcut rejection (F8),
// unknown-size Range handling (F10), dual credentials (F12).
// ---------------------------------------------------------------------------

describe('reviewer fixes', () => {
  it('rejects malformed file ids with 400 and zero provider calls (F5)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    const badId = 'bad!!id';
    for (const path of [
      `/api/v1/mounts/m-1/files/${badId}/content`,
      `/api/v1/mounts/m-1/files/${badId}/thumbnail`,
      `/api/v1/mounts/m-1/files/${badId}/export?format=pdf`,
    ]) {
      const res = await api(app, path);
      expect(res.status, path).toBe(400);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe('VALIDATION_FAILED');
    }
    for (const path of [
      `/api/v1/mounts/m-1/files/${badId}/readiness`,
      `/api/v1/mounts/m-1/files/${badId}/tickets`,
    ]) {
      const res = await api(app, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, path).toBe(400);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe('VALIDATION_FAILED');
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects simultaneous share and ticket credentials with 400 (F12)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta();
    const res = await api(app, `${CONTENT}?share=abc&ticket=def`);
    expect(res.status).toBe(400);
    expect(
      ((await res.json()) as { error: { code: string } }).error.code,
    ).toBe('VALIDATION_FAILED');
    expect(provider.calls).toHaveLength(0);
  });

  it('rejects shortcut metadata before any body open; never traverses (F8)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () =>
      defaultMeta({
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutTargetId: 'target-1',
      });
    provider.contentHandler = () => bytesUpstream('x');
    const res = await api(app, CONTENT);
    expect(res.status).toBe(404);
    expect(
      ((await res.json()) as { error: { code: string } }).error.code,
    ).toBe('FILE_NOT_ACCESSIBLE');
    expect(contentCalls(provider)).toHaveLength(0);
  });

  it('records blocked, not readable, when the probed id is a shortcut (F8)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () =>
      defaultMeta({ mimeType: 'application/vnd.google-apps.shortcut' });
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/readiness', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readerAccessState: string;
      reason?: string;
    };
    expect(body.readerAccessState).toBe('blocked');
    expect(contentCalls(provider)).toHaveLength(0);
    const row = await env.DB
      .prepare(
        'SELECT reader_access_state FROM file_readiness WHERE mount_id = ? AND file_id = ?',
      )
      .bind('m-1', 'f-1')
      .first<{ reader_access_state: string }>();
    expect(row?.reader_access_state).toBe('blocked');
  });

  it('ignores all Range headers when the representation size is unknown (F10)', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta({ size: undefined });
    provider.contentHandler = () => bytesUpstream('abcdef');
    for (const range of ['bytes=2-', 'bytes=-2', 'bytes=2-4']) {
      provider.calls.length = 0;
      const res = await api(app, CONTENT, { headers: { Range: range } });
      expect(res.status, range).toBe(200);
      expect(res.headers.get('Content-Range')).toBeNull();
      const call = contentCalls(provider)[0]!;
      expect(call.range).toBeUndefined();
    }
  });

  it('treats a missing canDownload capability as inconclusive — never opens bytes', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta({ capabilities: undefined });
    provider.contentHandler = () => bytesUpstream('x');
    const res = await api(app, CONTENT);
    // Every enabled SA reports the same unproven metadata; the answer is an
    // upstream-unclear 502, and no body read is ever attempted.
    expect(res.status).toBe(502);
    expect(
      ((await res.json()) as { error: { code: string } }).error.code,
    ).toBe('READ_PROVIDER_UNAVAILABLE');
    expect(contentCalls(provider)).toHaveLength(0);
  });

  it('readiness stays pending (not readable/blocked) when canDownload is missing', async () => {
    await seedBase();
    const { app, provider } = makeHarness(userActor(adminUser));
    provider.metaHandler = () => defaultMeta({ capabilities: undefined });
    const res = await api(app, '/api/v1/mounts/m-1/files/f-1/readiness', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      readerAccessState: string;
      reason?: string;
    };
    expect(body.readerAccessState).toBe('pending');
    expect(contentCalls(provider)).toHaveLength(0);
    const row = await env.DB
      .prepare(
        'SELECT reader_access_state FROM file_readiness WHERE mount_id = ? AND file_id = ?',
      )
      .bind('m-1', 'f-1')
      .first<{ reader_access_state: string }>();
    expect(row?.reader_access_state).toBe('pending');
  });
});
