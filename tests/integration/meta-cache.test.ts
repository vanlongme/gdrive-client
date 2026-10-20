/**
 * Wave-10 file metadata cache (worker M). Covers: hit skips the SA
 * metadata call, miss/stale/ineligible rows take the live path, reader
 * restriction verdicts, cached denials, media-authority invalidation,
 * mutation invalidation, D1-error degradation, listing fills and Range.
 */
import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import { DriveError } from '../../src/worker/drive/errors';
import { getMount } from '../../src/worker/drive/mounts';
import {
  createFileMetadataCache,
  FILE_META_FILL_MAX,
  FILE_META_PRUNE_MAX,
  readerVerdictFromEntry,
  rowFromCatalogEntry,
  rowFromDriveMeta,
  rowsFromCatalogEntries,
} from '../../src/worker/drive/metadata-cache';
import { createServiceAccountReadProvider } from '../../src/worker/drive/providers/service-account-read';
import { createDriveTransport } from '../../src/worker/drive/transport';
import type {
  CatalogEntry,
  CoordinatorTokenSource,
  DriveFileMeta,
  OpenThumbnailInput,
  ServiceAccountContentReadProvider,
  UpstreamContent,
} from '../../src/worker/drive/types';
import { resetContainmentCacheForTests } from '../../src/worker/drive/containment';
import { RequestTiming, setRequestTiming } from '../../src/worker/timing';
import type { Actor } from '../../src/worker/auth/grants';
import type { AuthUser } from '../../src/worker/auth/session';
import { createContentRouter } from '../../src/worker/transfers/download';
import { CatalogCache, createCatalogRouter } from '../../src/worker/drive/catalog';
import { createPublicLinkRouter } from '../../src/worker/public-links/public-routes';
import type { ContentRouteDeps } from '../../src/worker/transfers/content-access';
import { runTrash } from '../../src/worker/transfers/cancel';
import type { OAuthCatalogWriteProvider, ResolvedWriter } from '../../src/worker/drive/types';
import {
  actorFor,
  fixtureProvider,
  makeApp as makeUploadApp,
  metaFile,
  postInit,
  putChunk,
  seedBase as uploadSeedBase,
  USER,
} from './upload-fixture';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const NOW = Date.now();
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
const adminActor: Actor = { kind: 'user', user: adminUser, sessionId: 'sess-1' };

async function resetState() {
  for (const t of [
    'mount_drive_permissions', 'audit_events', 'file_readiness',
    'file_metadata_cache', 'file_metadata_tombstones', 'share_links',
    'mount_grants', 'mount_read_credentials', 'service_accounts',
    'containment_verdicts', 'public_folder_links', 'mounts',
    'google_connections', 'google_oauth_clients', 'session', 'account',
    'user', 'app_settings', 'upload_operations', 'upload_batches',
    'upload_batch_nodes',
  ]) {
    await env.DB.prepare(`DELETE FROM "${t}"`).run();
  }
}

async function seedBase() {
  await resetState();
  await env.DB.prepare(
    "INSERT INTO app_settings (id, installation_id, setup_state, canonical_origin, policies, version, created_at, updated_at) " +
      "VALUES (1, 'install-1', 'complete', ?, '{}', 1, ?, ?)",
  ).bind(ORIGIN, NOW, NOW).run();
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES (?, ?, ?, 1, ?, ?, ?, 0)',
  ).bind(adminUser.id, adminUser.name, adminUser.email, NOW, NOW, 'admin').run();
  await env.DB.prepare(
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, created_at, updated_at) VALUES ('oc-1', 'proj-1', 'client-1', 'env', 'https://x/cb', ?, ?)",
  ).bind(NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, granted_scopes, state, enabled, version, created_at, updated_at) VALUES ('conn-1', 'oc-1', 'p-1', 'drive', 'connected', 1, 1, ?, ?)",
  ).bind(NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, visibility, created_at, updated_at) VALUES ('m-1', 'Mount', 'drive-1', 'drive-1', 'conn-1', 'conn-1', 'private', ?, ?)",
  ).bind(NOW, NOW).run();
  for (const sa of [{ id: 'sa-1', p: 10 }, { id: 'sa-2', p: 5 }]) {
    await env.DB.prepare(
      "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES (?, 'proj-1', ?, 'k', 'env', 1, 1, ?, ?)",
    ).bind(sa.id, `${sa.id}@p.iam.gserviceaccount.com`, NOW, NOW).run();
    await env.DB.prepare(
      'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES (?, ?, ?, 1, ?)',
    ).bind('m-1', sa.id, sa.p, NOW).run();
  }
}

const FRESH = NOW + 60_000;
const STALE = NOW - 1;

async function seedCacheRow(overrides: {
  fileId?: string; reader?: number; trashed?: number; expires?: number;
  driveId?: string | null; parentId?: string | null; size?: string | null;
  source?: string; mimeType?: string;
} = {}) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO file_metadata_cache (mount_id, file_id, name, ' +
      'mime_type, size, md5, modified_time, trashed, drive_id, parent_id, ' +
      'reader_can_download, head_revision_id, source, cached_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    'm-1',
    overrides.fileId ?? 'f-1',
    'notes.txt',
    overrides.mimeType ?? 'text/plain',
    overrides.size === undefined ? '26' : overrides.size,
    'md5x',
    '2026-10-01T12:00:00.000Z',
    overrides.trashed ?? 0,
    overrides.driveId === undefined ? 'drive-1' : overrides.driveId,
    overrides.parentId === undefined ? 'parent-1' : overrides.parentId,
    overrides.reader ?? 1,
    'rev-1',
    overrides.source ?? 'sa_meta',
    NOW,
    overrides.expires ?? FRESH,
  ).run();
}

async function cacheRow(fileId: string, mountId = 'm-1') {
  return env.DB.prepare(
    'SELECT * FROM file_metadata_cache WHERE mount_id = ? AND file_id = ?',
  ).bind(mountId, fileId).first<Record<string, unknown>>();
}

async function cacheRowSoon(fileId: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const row = await cacheRow(fileId);
    if (row !== null) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

async function cacheRowGoneSoon(fileId: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if ((await cacheRow(fileId)) === null) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`cache row for ${fileId} never went away`);
}

async function tombstoneRow(fileId: string) {
  return env.DB.prepare(
    'SELECT * FROM file_metadata_tombstones WHERE file_id = ?',
  ).bind(fileId).first<Record<string, unknown>>();
}

async function tombstoneSoon(fileId: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const row = await tombstoneRow(fileId);
    if (row !== null) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

// Fixture SA provider: counts getReadMetadata calls; handlers per op.
class FakeReadProvider implements ServiceAccountContentReadProvider {
  readonly calls: { op: string; identityId: string; range?: { start: bigint; end: bigint }; thumbnailLink?: string | null }[] = [];
  metaHandler?: (input: { identity: { serviceAccountId: string }; ref: { id: string } }) => DriveFileMeta | Promise<DriveFileMeta>;
  contentHandler?: (input: { range?: { start: bigint; end: bigint } }) => UpstreamContent | Promise<UpstreamContent>;
  thumbnailHandler?: (input: OpenThumbnailInput) => UpstreamContent | Promise<UpstreamContent>;
  exportHandler?: () => UpstreamContent | Promise<UpstreamContent>;
  async getReadMetadata(input: { identity: { serviceAccountId: string }; ref: { id: string } }): Promise<DriveFileMeta> {
    this.calls.push({ op: 'meta', identityId: input.identity.serviceAccountId });
    if (this.metaHandler === undefined) throw new Error('metaHandler missing');
    return this.metaHandler(input);
  }
  async getRevision(): Promise<never> {
    throw new Error('getRevision unused');
  }
  async openContent(input: { identity: { serviceAccountId: string }; ref: { id: string }; range?: { start: bigint; end: bigint } }): Promise<UpstreamContent> {
    this.calls.push({
      op: 'content', identityId: input.identity.serviceAccountId,
      ...(input.range === undefined ? {} : { range: input.range }),
    });
    if (this.contentHandler === undefined) throw new Error('contentHandler missing');
    return this.contentHandler(input);
  }
  async openThumbnail(input: OpenThumbnailInput): Promise<UpstreamContent> {
    this.calls.push({
      op: 'thumbnail', identityId: input.identity.serviceAccountId,
      thumbnailLink: input.thumbnailLink,
    });
    if (this.thumbnailHandler === undefined) throw new Error('thumbnailHandler missing');
    return this.thumbnailHandler(input);
  }
  async exportDocument(): Promise<UpstreamContent> {
    this.calls.push({ op: 'export', identityId: '' });
    if (this.exportHandler === undefined) throw new Error('exportHandler missing');
    return this.exportHandler();
  }
}

// Real SA provider over a scripted fetch + a token source that records
// reportFailure calls — needed because cooldown reporting lives inside the
// provider, below the route layer.
function realProvider(
  handler: (url: URL) => Response | Promise<Response>,
): {
  provider: ServiceAccountContentReadProvider;
  googleCalls: string[];
  failures: { kind: string; fileId?: string }[];
} {
  const googleCalls: string[] = [];
  const failures: { kind: string; fileId?: string }[] = [];
  const tokenSource: CoordinatorTokenSource = {
    getToken: () =>
      Promise.resolve({
        ok: true,
        accessToken: 'tok',
        expiresAtMs: Date.now() + 3_600_000,
      }),
    reportFailure: (_identity, info) => {
      failures.push({
        kind: info.kind,
        ...(info.fileId === undefined ? {} : { fileId: info.fileId }),
      });
      return Promise.resolve();
    },
  };
  const fetchImpl: typeof fetch = (input, _init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    googleCalls.push(url.toString());
    return Promise.resolve(handler(url));
  };
  return {
    provider: createServiceAccountReadProvider({
      tokenSource,
      transport: createDriveTransport('service_account', { fetchImpl }),
    }),
    googleCalls,
    failures,
  };
}

function googleError(
  status: number,
  reason: string,
): Response {
  return Response.json(
    {
      error: {
        code: status,
        message: 'upstream message',
        errors: [{ reason }],
      },
    },
    { status },
  );
}

function saMetaJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: '26',
    modifiedTime: '2026-10-01T12:00:00.000Z',
    trashed: false,
    driveId: 'drive-1',
    capabilities: { canDownload: true, canReadRevisions: true },
    ...overrides,
  };
}

const FILE_META: DriveFileMeta = {
  id: 'f-1', name: 'notes.txt', mimeType: 'text/plain', size: '26',
  modifiedTime: '2026-10-01T12:00:00.000Z', trashed: false,
  driveId: 'drive-1', hasThumbnail: false,
  capabilities: { canDownload: true, canReadRevisions: true },
};

function bytes(body: string, opts: { status?: 200 | 206; contentRange?: string } = {}): UpstreamContent {
  return {
    status: opts.status ?? 200,
    contentType: 'text/plain',
    contentLength: BigInt(encoder.encode(body).byteLength),
    ...(opts.contentRange === undefined ? {} : { contentRange: opts.contentRange }),
    body: new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder.encode(body)); c.close(); },
    }),
  };
}

function makeHarness(provider: ServiceAccountContentReadProvider, options: { db?: D1Database; actor?: Actor } = {}) {
  const deps: ContentRouteDeps = {
    getMount,
    resolveSessionActor: () => Promise.resolve(options.actor ?? adminActor),
    readProvider: provider,
    now: () => NOW,
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => { c.set('requestId', 'r'); await next(); });
  app.route('/api/v1/mounts', createContentRouter(deps));
  const envProxy = { ...(env as unknown as Env), ...(options.db === undefined ? {} : { DB: options.db }) };
  return {
    api: (path: string, init?: RequestInit) =>
      Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, init), envProxy)),
    provider,
  };
}

const CONTENT = '/api/v1/mounts/m-1/files/f-1/content';
const metaCalls = (p: FakeReadProvider) => p.calls.filter((c) => c.op === 'meta');

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  resetContainmentCacheForTests();
  await resetState();
});

describe('read path', () => {
  it('hit skips the SA metadata call entirely', async () => {
    await seedBase();
    await seedCacheRow();
    const provider = new FakeReadProvider();
    provider.contentHandler = () => bytes('hello');
    provider.metaHandler = () => FILE_META; // must NOT be called
    const res = await makeHarness(provider).api(CONTENT);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(metaCalls(provider).length).toBe(0);
    expect(provider.calls.map((c) => c.op)).toEqual(['content']);
  });

  it('miss takes the live path and backfills via sa_meta', async () => {
    await seedBase();
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () => bytes('hello');
    const h = makeHarness(provider);
    const res1 = await h.api(CONTENT);
    expect(res1.status).toBe(200);
    expect(metaCalls(provider).length).toBe(1);
    const row = await cacheRowSoon('f-1');
    expect(row).not.toBeNull();
    expect(row!.reader_can_download).toBe(1);
    expect(row!.source).toBe('sa_meta');
    // Second open hits the row: no further metadata call.
    const res2 = await h.api(CONTENT);
    expect(res2.status).toBe(200);
    expect(metaCalls(provider).length).toBe(1);
  });

  it('a stale row takes the live path', async () => {
    await seedBase();
    await seedCacheRow({ expires: STALE });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () => bytes('x');
    const res = await makeHarness(provider).api(CONTENT);
    expect(res.status).toBe(200);
    expect(metaCalls(provider).length).toBe(1);
  });

  it('a reader_can_download=0 row takes the live path', async () => {
    await seedBase();
    await seedCacheRow({ reader: 0 });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () => bytes('x');
    const res = await makeHarness(provider).api(CONTENT);
    expect(res.status).toBe(200);
    expect(metaCalls(provider).length).toBe(1);
  });

  it('a cached trashed row is denied without an SA call', async () => {
    await seedBase();
    await seedCacheRow({ trashed: 1 });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () => bytes('x');
    const res = await makeHarness(provider).api(CONTENT);
    expect(res.status).toBe(404);
    expect(provider.calls.length).toBe(0);
  });

  it('Range on a hit uses the cached size', async () => {
    await seedBase();
    await seedCacheRow({ size: '26' });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = (input) =>
      bytes('hello', {
        status: 206,
        contentRange: `bytes ${input.range!.start}-${input.range!.end}/26`,
      });
    const res = await makeHarness(provider).api(CONTENT, {
      headers: { range: 'bytes=0-4' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-4/26');
    expect(metaCalls(provider).length).toBe(0);
    expect(provider.calls[0]?.range).toEqual({ start: 0n, end: 4n });
  });

  it('HEAD never answers from an oauth_list row — the live SA meta runs', async () => {
    await seedBase();
    await seedCacheRow({ source: 'oauth_list' });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    const res = await makeHarness(provider).api(CONTENT, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(metaCalls(provider).length).toBe(1);
    expect(provider.calls.map((c) => c.op)).toEqual(['meta']);
    expect(res.headers.get('content-length')).toBe('26');
  });

  it('HEAD may still answer from a sa_meta row', async () => {
    await seedBase();
    await seedCacheRow({ source: 'sa_meta' });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META; // must NOT be called
    const res = await makeHarness(provider).api(CONTENT, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(provider.calls.length).toBe(0);
    expect(res.headers.get('content-length')).toBe('26');
  });

  it('a media denial on a hit invalidates the row and returns the live-path error', async () => {
    await seedBase();
    await seedCacheRow();
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () =>
      Promise.reject(new DriveError('permission-denied', 'denied'));
    const res = await makeHarness(provider).api(CONTENT);
    // Same answer the live path gives for a permission-denied media open:
    // the failover loop legitimately re-verifies meta for the second pool
    // identity before giving up, and the stale-verdict recheck reads meta
    // live once more — exactly what a live read produces.
    expect(res.status).toBe(502);
    expect(metaCalls(provider).length).toBe(2);
    // The row was invalidated (deferred): the tombstone lands and any
    // surviving/refilled row is sa_meta, never the stale verdict.
    expect(await tombstoneSoon('f-1')).not.toBeNull();
  });

  it('a stale download verdict on a hit returns the live 502 and records no file cooldown', async () => {
    await seedBase();
    await seedCacheRow({ source: 'oauth_list' });
    // The SA media call denies the open the cached verdict promised; the
    // live re-check then reports canDownload=false — the live path's
    // answer is checkFileMeta's 502, and nothing ever reached the media
    // call on that path, so no file_limited cooldown may be recorded.
    const real = realProvider((url) => {
      if (url.searchParams.get('alt') === 'media') {
        return googleError(403, 'cannotDownloadFile');
      }
      return Response.json(saMetaJson({ capabilities: { canDownload: false } }));
    });
    const h = makeHarness(real.provider);
    const res = await h.api(CONTENT);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_NOT_READABLE_BY_POOL');
    expect(real.failures.filter((f) => f.kind === 'file_limited')).toHaveLength(0);
    // One denied media open (cache-hit) + one live files.get recheck.
    expect(real.googleCalls.filter((u) => u.includes('alt=media'))).toHaveLength(1);
    expect(real.googleCalls.filter((u) => !u.includes('alt=media'))).toHaveLength(1);
    await cacheRowGoneSoon('f-1');
    // The stale verdict is gone for good: the next open pays the live path
    // and denies identically instead of re-serving the cached row.
    const res2 = await h.api(CONTENT);
    expect(res2.status).toBe(502);
    expect(real.googleCalls.filter((u) => !u.includes('alt=media'))).toHaveLength(2);
  });

  it('a real per-file cap on a cache-hit open still reports file_limited (round-2 review)', async () => {
    await seedBase();
    await seedCacheRow({ source: 'oauth_list' });
    // downloadQuotaExceeded is a REAL per-file cap, not a verdict mismatch:
    // only cannotDownloadFile may be suppressed on a cache-metadata open.
    const real = realProvider((url) => {
      if (url.searchParams.get('alt') === 'media') {
        return googleError(403, 'downloadQuotaExceeded');
      }
      return Response.json(saMetaJson({ capabilities: { canDownload: false } }));
    });
    const res = await makeHarness(real.provider).api(CONTENT);
    expect(res.status).toBe(502);
    expect(real.failures).toEqual([
      { kind: 'file_limited', fileId: 'f-1' },
    ]);
  });

  it('the stale-verdict recheck adds no second meta-cache Server-Timing mark (round-2 review)', async () => {
    await seedBase();
    await seedCacheRow({ source: 'oauth_list' });
    const real = realProvider((url) => {
      if (url.searchParams.get('alt') === 'media') {
        return googleError(403, 'cannotDownloadFile');
      }
      return Response.json(saMetaJson({ capabilities: { canDownload: false } }));
    });
    const deps: ContentRouteDeps = {
      getMount,
      resolveSessionActor: () => Promise.resolve(adminActor),
      readProvider: real.provider,
      now: () => NOW,
    };
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => { c.set('requestId', 'r'); await next(); });
    app.route('/api/v1/mounts', createContentRouter(deps));
    const timing = new RequestTiming();
    const request = new Request(`${ORIGIN}${CONTENT}`);
    setRequestTiming(request, timing);
    const res = await app.fetch(request, env as unknown as Env);
    expect(res.status).toBe(502);
    // One mark, for the original hit — the live re-check performs no cache
    // lookup and must not append a misleading 'miss'.
    expect(timing.render()).toContain('meta-cache;desc="hit"');
  });

  it('a real rate limit on a cache-hit open still reports to the coordinator', async () => {
    await seedBase();
    await seedCacheRow({ source: 'oauth_list' });
    const real = realProvider((url) => {
      if (url.searchParams.get('alt') === 'media') {
        return googleError(429, 'rateLimitExceeded');
      }
      return Response.json(saMetaJson());
    });
    const res = await makeHarness(real.provider).api(CONTENT);
    expect(res.status).toBe(429);
    expect(real.failures).toEqual([
      { kind: 'rate_limit', fileId: 'f-1' },
    ]);
    // Not a denial class: the row is not invalidated.
    expect(await cacheRow('f-1')).not.toBeNull();
  });

  it('a hit whose upstream omits Content-Length streams without one (no cached-size fallback)', async () => {
    await seedBase();
    await seedCacheRow({ size: '26' });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () => ({
      status: 200,
      contentType: 'text/plain',
      // No contentLength: the cached size must NOT be substituted.
      body: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(encoder.encode('hello')); c.close(); },
      }),
    });
    const res = await makeHarness(provider).api(CONTENT);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBeNull();
    expect(await res.text()).toBe('hello');
  });

  it('a thumbnail denial on a hit invalidates the row and answers like the live path', async () => {
    await seedBase();
    await seedCacheRow({ source: 'oauth_list' });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.thumbnailHandler = () =>
      Promise.reject(new DriveError('download-restricted', 'cannotDownloadFile'));
    const res = await makeHarness(provider).api(
      '/api/v1/mounts/m-1/files/f-1/thumbnail',
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_NOT_READABLE_BY_POOL');
    // The hit carried no thumbnailLink: the provider's legacy files.get
    // branch ran (thumbnailLink === undefined), and the denial invalidated
    // the row + re-ran the live SA check.
    expect(provider.calls[0]?.thumbnailLink).toBeUndefined();
    expect(metaCalls(provider).length).toBe(1);
    expect(await tombstoneSoon('f-1')).not.toBeNull();
  });

  it('an export denial on a hit invalidates the row and answers like the live path', async () => {
    await seedBase();
    await seedCacheRow({
      source: 'oauth_list',
      mimeType: 'application/vnd.google-apps.document',
    });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.exportHandler = () =>
      Promise.reject(new DriveError('download-restricted', 'cannotDownloadFile'));
    const res = await makeHarness(provider).api(
      '/api/v1/mounts/m-1/files/f-1/export?format=pdf',
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FILE_NOT_READABLE_BY_POOL');
    expect(metaCalls(provider).length).toBe(1);
    expect(await tombstoneSoon('f-1')).not.toBeNull();
  });

  it('a D1 lookup error degrades to a miss, never a request failure', async () => {
    await seedBase();
    const broken: D1Database = {
      prepare: (q: string) => {
        if (q.includes('file_metadata_cache') || q.includes('file_metadata_tombstones')) {
          return {
            bind: () => ({
              first: () => Promise.reject(new Error('d1 down')),
              run: () => Promise.reject(new Error('d1 down')),
              all: () => Promise.reject(new Error('d1 down')),
            }),
            first: () => Promise.reject(new Error('d1 down')),
            run: () => Promise.reject(new Error('d1 down')),
          };
        }
        return env.DB.prepare(q);
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
      exec: (q: string) => env.DB.exec(q),
      dump: () => env.DB.dump(),
      withSession: (() => env.DB.withSession()) as D1Database['withSession'],
    } as D1Database;
    await seedCacheRow();
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () => bytes('x');
    const res = await makeHarness(provider, { db: broken }).api(CONTENT);
    expect(res.status).toBe(200);
    expect(metaCalls(provider).length).toBe(1);
  });
});

describe('reader verdict and row builders', () => {
  const baseEntry: CatalogEntry = {
    id: 'f-9', kind: 'file', name: 'n', mimeType: 'text/plain', size: '1',
    hasThumbnail: false,
  };

  it('never treats a reader restriction as cacheable', () => {
    expect(readerVerdictFromEntry({ ...baseEntry, copyRequiresWriterPermission: true })).toBe(false);
    expect(
      readerVerdictFromEntry({
        ...baseEntry,
        downloadRestrictions: { restrictedForReaders: true },
      }),
    ).toBe(false);
    expect(
      readerVerdictFromEntry({
        ...baseEntry,
        downloadRestrictions: { restrictedForWriters: true },
      }),
    ).toBe(false);
    // Missing restriction fields entirely: unverifiable -> not cacheable.
    expect(readerVerdictFromEntry(baseEntry)).toBe(false);
    // Review M2: ANY missing verdict field means false — a bare
    // copyRequiresWriterPermission without downloadRestrictions is not a
    // verdict, and a downloadRestrictions object missing either flag is
    // not either.
    expect(readerVerdictFromEntry({ ...baseEntry, copyRequiresWriterPermission: false })).toBe(false);
    expect(
      readerVerdictFromEntry({
        ...baseEntry,
        copyRequiresWriterPermission: false,
        downloadRestrictions: { restrictedForReaders: false },
      }),
    ).toBe(false);
    expect(
      readerVerdictFromEntry({
        ...baseEntry,
        copyRequiresWriterPermission: false,
        downloadRestrictions: { restrictedForWriters: false },
      }),
    ).toBe(false);
    // Every verdict field present and clear: cacheable.
    expect(
      readerVerdictFromEntry({
        ...baseEntry,
        copyRequiresWriterPermission: false,
        downloadRestrictions: { restrictedForReaders: false, restrictedForWriters: false },
      }),
    ).toBe(true);
  });

  it('never caches folders, shortcuts or resource-keyed files', () => {
    const t = NOW;
    const folder: CatalogEntry = { ...baseEntry, kind: 'folder', mimeType: 'application/vnd.google-apps.folder' };
    const shortcut: CatalogEntry = { ...baseEntry, kind: 'shortcut', mimeType: 'application/vnd.google-apps.shortcut' };
    const keyed: CatalogEntry = { ...baseEntry, resourceKey: 'rk', copyRequiresWriterPermission: false };
    expect(rowFromCatalogEntry('m-1', folder, t)).toBeUndefined();
    expect(rowFromCatalogEntry('m-1', shortcut, t)).toBeUndefined();
    expect(rowFromCatalogEntry('m-1', keyed, t)).toBeUndefined();
    expect(
      rowFromDriveMeta('m-1', { ...FILE_META, resourceKey: 'rk' }, t),
    ).toBeUndefined();
    expect(
      rowFromDriveMeta('m-1', { ...FILE_META, mimeType: 'application/vnd.google-apps.folder' }, t),
    ).toBeUndefined();
  });
});

describe('listing fills (waitUntil, off the critical path)', () => {
  function oauthList(entries: CatalogEntry[]): OAuthCatalogWriteProvider {
    return {
      listChildren: () => Promise.resolve({ entries }),
      search: () => Promise.resolve({ entries }),
      getMetadata: () => Promise.reject(new Error('unused')),
      generateId: () => Promise.reject(new Error('unused')),
      createFolder: () => Promise.reject(new Error('unused')),
      startUpload: () => Promise.reject(new Error('unused')),
      putChunk: () => Promise.reject(new Error('unused')),
      probeUpload: () => Promise.reject(new Error('unused')),
      verifyFile: () => Promise.reject(new Error('unused')),
      trashFile: () => Promise.reject(new Error('unused')),
    };
  }

  it('the OAuth children listing fills rows', async () => {
    await seedBase();
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => { c.set('requestId', 'r'); await next(); });
    app.route('/api/v1/mounts', createCatalogRouter({
      resolveActor: () => Promise.resolve(adminActor),
      oauthProvider: oauthList([
        {
          id: 'f-1', kind: 'file', name: 'notes.txt', mimeType: 'text/plain',
          size: '26', modifiedTime: '2026-10-01T00:00:00Z', trashed: false,
          driveId: 'drive-1', parents: ['drive-1'], hasThumbnail: false,
          copyRequiresWriterPermission: false,
          downloadRestrictions: {
            restrictedForReaders: false,
            restrictedForWriters: false,
          },
        },
      ]),
    }));
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/v1/mounts/m-1/folders/drive-1/children`),
      env as unknown as Env,
    );
    expect(res.status).toBe(200);
    const row = await cacheRowSoon('f-1');
    expect(row).not.toBeNull();
    expect(row!.source).toBe('oauth_list');
    expect(row!.reader_can_download).toBe(1);
  });

  it('the public-link children listing writes no cache rows (review M5)', async () => {
    await seedBase();
    await env.DB.prepare(
      'INSERT INTO public_folder_links (id, slug, mount_id, folder_id, folder_name, credential_version, allow_zip, policy_version, created_by, created_at, updated_at, view_count, download_count) ' +
        "VALUES ('pl-1', 'slug-1', 'm-1', 'dir-1', 'Link', 1, 0, 1, 'u-admin', ?, ?, 0, 0)",
    ).bind(NOW, NOW).run();
    const metas: Record<string, DriveFileMeta> = {
      'dir-1': { ...FILE_META, id: 'dir-1', mimeType: 'application/vnd.google-apps.folder' },
      'f-out': { ...FILE_META, id: 'f-out', parents: ['other-dir'] },
      'other-dir': { ...FILE_META, id: 'other-dir', parents: ['drive-1'] },
      'drive-1': { ...FILE_META, id: 'drive-1', mimeType: 'application/vnd.google-apps.folder' },
    };
    const oauth: OAuthCatalogWriteProvider = {
      listChildren: () =>
        Promise.resolve({
          entries: [{
            id: 'f-in', kind: 'file', name: 'in.txt', mimeType: 'text/plain',
            size: '5', trashed: false, driveId: 'drive-1', parents: ['dir-1'],
            hasThumbnail: false, copyRequiresWriterPermission: false,
          }],
        }),
      search: () => Promise.reject(new Error('unused')),
      getMetadata: (input: { ref: { id: string } }) =>
        Promise.resolve(metas[input.ref.id] ?? { ...FILE_META, id: input.ref.id }),
      generateId: () => Promise.reject(new Error('unused')),
      createFolder: () => Promise.reject(new Error('unused')),
      startUpload: () => Promise.reject(new Error('unused')),
      putChunk: () => Promise.reject(new Error('unused')),
      probeUpload: () => Promise.reject(new Error('unused')),
      verifyFile: () => Promise.reject(new Error('unused')),
      trashFile: () => Promise.reject(new Error('unused')),
    };
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => { c.set('requestId', 'r'); await next(); });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => ({ ...FILE_META, id: 'f-out', parents: ['other-dir'] });
    provider.contentHandler = () => bytes('x');
    app.route('/api/v1/p', createPublicLinkRouter({ oauthProvider: oauth, readProvider: provider }));

    const list = await app.fetch(
      new Request(`${ORIGIN}/api/v1/p/slug-1/children`), env as unknown as Env);
    expect(list.status).toBe(200);
    // Anonymous traffic never reads the cache, so it must never write it:
    // give any would-be deferred fill time to land, then assert nothing did.
    await new Promise((r) => setTimeout(r, 200));
    expect(await cacheRow('f-in')).toBeNull();
    // A file outside the link's subtree is still denied: link containment
    // runs on every open regardless of cache state.
    const denied = await app.fetch(
      new Request(`${ORIGIN}/api/v1/p/slug-1/files/f-out/content`), env as unknown as Env);
    expect(denied.status).toBe(404);
  });

  it('a listing fill whose fetch predates an invalidation cannot resurrect the row (review L2)', async () => {
    const cache = createFileMetadataCache(env.DB);
    const entry: CatalogEntry = {
      id: 'f-late', kind: 'file', name: 'late.txt', mimeType: 'text/plain',
      size: '5', trashed: false, driveId: 'drive-1', parents: ['dir-1'],
      hasThumbnail: false, copyRequiresWriterPermission: false,
      downloadRestrictions: {
        restrictedForReaders: false,
        restrictedForWriters: false,
      },
    };
    const mount = { id: 'm-1', driveId: 'drive-1' };
    // The page was fetched at T0; the invalidation lands after that fetch
    // started, so the deferred fill must skip the row.
    const staleFill = rowsFromCatalogEntries('m-1', [entry], NOW, NOW - 5000);
    await cache.invalidateFile('f-late');
    await cache.put(staleFill);
    expect(await cache.get(mount, 'f-late')).toBeUndefined();
    // A fetch that started after the invalidation is fresh evidence and
    // fills normally.
    const freshFill = rowsFromCatalogEntries('m-1', [entry], NOW, Date.now());
    await cache.put(freshFill);
    expect(await cache.get(mount, 'f-late')).toBeDefined();
  });

  it('an in-flight children fill racing an invalidation is dropped, other rows still land', async () => {
    await seedBase();
    let releaseList: () => void = () => undefined;
    let listedResolve: () => void = () => undefined;
    const gate = new Promise<void>((r) => { releaseList = r; });
    const listed = new Promise<void>((r) => { listedResolve = r; });
    const entry = (id: string): CatalogEntry => ({
      id, kind: 'file', name: `${id}.txt`, mimeType: 'text/plain',
      size: '5', trashed: false, driveId: 'drive-1', parents: ['drive-1'],
      hasThumbnail: false, copyRequiresWriterPermission: false,
      downloadRestrictions: {
        restrictedForReaders: false,
        restrictedForWriters: false,
      },
    });
    const oauth: OAuthCatalogWriteProvider = {
      listChildren: () => {
        listedResolve();
        return gate.then(() => ({ entries: [entry('f-late'), entry('f-ok')] }));
      },
      search: () => Promise.reject(new Error('unused')),
      getMetadata: () => Promise.reject(new Error('unused')),
      generateId: () => Promise.reject(new Error('unused')),
      createFolder: () => Promise.reject(new Error('unused')),
      startUpload: () => Promise.reject(new Error('unused')),
      putChunk: () => Promise.reject(new Error('unused')),
      probeUpload: () => Promise.reject(new Error('unused')),
      verifyFile: () => Promise.reject(new Error('unused')),
      trashFile: () => Promise.reject(new Error('unused')),
    };
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => { c.set('requestId', 'r'); await next(); });
    app.route('/api/v1/mounts', createCatalogRouter({
      resolveActor: () => Promise.resolve(adminActor),
      oauthProvider: oauth,
      cache: new CatalogCache(),
    }));
    const resP = app.fetch(
      new Request(`${ORIGIN}/api/v1/mounts/m-1/folders/drive-1/children`),
      env as unknown as Env,
    );
    await listed; // the fetch is in flight upstream
    await createFileMetadataCache(env.DB).invalidateFile('f-late');
    releaseList();
    const res = await resP;
    expect(res.status).toBe(200);
    // The deferred fill ran (the control row landed) but the tombstoned
    // file's stale row never did.
    expect(await cacheRowSoon('f-ok')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(await cacheRow('f-late')).toBeNull();
  });

  it('an in-flight sa_meta fill racing an invalidation writes no row (round-2 review)', async () => {
    await seedBase();
    let releaseMeta: () => void = () => undefined;
    let metaStarted: () => void = () => undefined;
    const gate = new Promise<void>((r) => { releaseMeta = r; });
    const started = new Promise<void>((r) => { metaStarted = r; });
    const provider = new FakeReadProvider();
    provider.metaHandler = () => {
      metaStarted();
      return gate.then(() => FILE_META);
    };
    provider.contentHandler = () => bytes('hello');
    const resP = makeHarness(provider).api(CONTENT);
    await started; // the SA files.get is in flight upstream
    await createFileMetadataCache(env.DB).invalidateFile('f-1');
    releaseMeta();
    const res = await resP;
    expect(res.status).toBe(200);
    // The fetch started BEFORE the invalidation, so the deferred fill must
    // be tombstone-skipped — give it time to land, then assert it never did.
    await new Promise((r) => setTimeout(r, 200));
    expect(await cacheRow('f-1')).toBeNull();
  });

  it('file_id invalidations are served by an index (review M4)', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='file_metadata_cache'",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toContain('idx_file_metadata_cache_file');
  });

  it('bounds a fill batch inside the Workers Free per-invocation budget (review L6/M4)', async () => {
    await seedBase();
    // Count every prepared-statement call and each statement inside a
    // batch — the strict reading of D1's per-invocation query limit.
    const d1 = (() => {
      let n = 0;
      const inners = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
      const wrap = (inner: D1PreparedStatement): D1PreparedStatement => {
        const w = {
          bind: (...v: unknown[]) => wrap(inner.bind(...v)),
          first: <T = unknown>(c?: string) => { n++; return inner.first<T>(c as string); },
          run: () => { n++; return inner.run(); },
          all: <T = unknown>() => { n++; return inner.all<T>(); },
          raw: <T = unknown[]>(o?: unknown) => { n++; return inner.raw<T>(o as never); },
        } as D1PreparedStatement;
        inners.set(w, inner);
        return w;
      };
      return {
        db: {
          prepare: (q: string) => wrap(env.DB.prepare(q)),
          batch: (st: D1PreparedStatement[]) => {
            n += st.length;
            return env.DB.batch(st.map((s) => inners.get(s) ?? s));
          },
          exec: (q: string) => { n++; return env.DB.exec(q); },
          dump: () => env.DB.dump(),
          withSession: (() => env.DB.withSession()) as D1Database['withSession'],
        } as D1Database,
        count: () => n,
      };
    })();
    const entries: CatalogEntry[] = Array.from(
      { length: FILE_META_FILL_MAX + 25 },
      (_, i) => ({
        id: `f-${i}`, kind: 'file' as const, name: `f${i}.txt`,
        mimeType: 'text/plain', size: '5', trashed: false,
        driveId: 'drive-1', parents: ['drive-1'], hasThumbnail: false,
        copyRequiresWriterPermission: false,
        downloadRestrictions: {
          restrictedForReaders: false,
          restrictedForWriters: false,
        },
      }),
    );
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => { c.set('requestId', 'r'); await next(); });
    app.route('/api/v1/mounts', createCatalogRouter({
      resolveActor: () => Promise.resolve(adminActor),
      oauthProvider: oauthList(entries),
      cache: new CatalogCache(),
    }));
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/v1/mounts/m-1/folders/drive-1/children`),
      { ...(env as unknown as Env), DB: d1.db },
    );
    expect(res.status).toBe(200);
    expect(await cacheRowSoon('f-0')).not.toBeNull();
    // Workers Free: at most 50 queries per invocation; each statement in
    // db.batch counts individually (the strict reading). The route's own
    // queries plus the whole fill batch must stay under it.
    expect(d1.count()).toBeLessThanOrEqual(50);
    // And the prune bound is never smaller than a fill (review M4).
    expect(FILE_META_PRUNE_MAX).toBeGreaterThanOrEqual(FILE_META_FILL_MAX);
  });
});

describe('mutation invalidation', () => {
  const writer: ResolvedWriter = {
    connectionId: 'conn-1', principalId: 'p-1', oauthClientId: 'oc-1',
    projectId: 'proj-1', connectionVersion: 1, oauthClientVersion: 1,
  };

  it('upload-cancel trash deletes the file row across mounts', async () => {
    await seedBase();
    await seedCacheRow({ fileId: 'gen-1' });
    const { provider } = fixtureProvider({
      getMetadata: () => metaFile('gen-1', { trashed: true }),
    });
    const event = await runTrash({
      provider,
      db: env.DB,
      directive: {
        kind: 'trash', attemptId: 'a1', generation: 1, writer,
        mountScope: { mountId: 'm-1', rootFolderId: 'drive-1', driveId: 'drive-1' },
        file: metaFile('gen-1'),
      },
    });
    expect(event).toEqual({ type: 'trash-result', outcome: 'done' });
    expect(await cacheRow('gen-1')).toBeNull();
  });

  it('upload finalize deletes the generated file row', async () => {
    await uploadSeedBase();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES ('user-1', 'mount-1', 'uploader', '[\"read\",\"upload\"]', 'admin-1', 0, 0)",
    ).run();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO file_metadata_cache (mount_id, file_id, name, mime_type, trashed, drive_id, parent_id, reader_can_download, source, cached_at, expires_at) ' +
        "VALUES ('mount-1', 'gen-file-1', 'old', 'text/plain', 0, 'drive-1', 'parent-1', 1, 'oauth_list', ?, ?)",
    ).bind(NOW, FRESH).run();
    const { provider } = fixtureProvider({
      putChunk: () => ({ kind: 'completed', file: metaFile('gen-file-1') }),
    });
    const app = makeUploadApp(provider, actorFor(USER));
    const init = await postInit(app, 'idem-1');
    expect(init.status).toBe(200);
    const view = (await init.json()) as { uploadId: string };
    const put = await putChunk(app, view.uploadId, 1, '0', encoder.encode('123456'));
    expect(put.status).toBe(200);
    // The finalize invalidation runs off the critical path (waitUntil):
    // the row must still go away.
    await cacheRowGoneSoon('gen-file-1');
    expect(await tombstoneSoon('gen-file-1')).not.toBeNull();
  });
});
