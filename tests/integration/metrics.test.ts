/**
 * Wave-5 timing metrics (T14 remainder): bounded in-isolate aggregation
 * plus the redacted diagnostics DTO. Real routes drive the hooks — the
 * catalog and upload fixtures are shared, the content route runs against
 * a fixture SA read provider, and every assertion is on counters,
 * durations and the absence of anything secret-shaped.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { DriveError } from '../../src/worker/drive/errors';
import type { Actor } from '../../src/worker/auth/grants';
import { createCatalogRouter, CatalogCache } from '../../src/worker/drive/catalog';
import { createContentRouter } from '../../src/worker/transfers/download';
import { getMount } from '../../src/worker/drive/mounts';
import type {
  DriveFileMeta,
  OpenContentInput,
  ReadMetadataInput,
  ServiceAccountContentReadProvider,
  UpstreamContent,
} from '../../src/worker/drive/types';
import type { ContentRouteDeps } from '../../src/worker/transfers/content-access';
import { createDiagnosticsRouter } from '../../src/worker/admin/diagnostics';
import {
  countedDownloadBody,
  metricsSnapshot,
  recordContentRequest,
  recordUploadChunk,
  resetMetrics,
  type MetricsView,
} from '../../src/worker/admin/metrics';
import {
  actorFor,
  fakeNow,
  fixtureProvider,
  makeApp,
  metaFile,
  postInit,
  putChunk,
  resetState,
  seedBase,
  setNow,
  TEST_MIGRATIONS,
  USER,
  type UploadViewBody,
} from './upload-fixture';

const ORIGIN = 'http://worker.test';
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Minimal SA read provider for the content route.
// ---------------------------------------------------------------------------

class FakeReadProvider implements ServiceAccountContentReadProvider {
  metaHandler?: (input: ReadMetadataInput) => DriveFileMeta | Promise<DriveFileMeta>;
  contentHandler?: (input: OpenContentInput) => UpstreamContent | Promise<UpstreamContent>;

  async getReadMetadata(input: ReadMetadataInput): Promise<DriveFileMeta> {
    if (this.metaHandler === undefined) throw new Error('metaHandler unset');
    return this.metaHandler(input);
  }
  async getRevision(): Promise<never> {
    throw new Error('getRevision unused in metrics tests');
  }
  async openContent(input: OpenContentInput): Promise<UpstreamContent> {
    if (this.contentHandler === undefined) throw new Error('contentHandler unset');
    return this.contentHandler(input);
  }
  async openThumbnail(): Promise<never> {
    throw new Error('openThumbnail unused in metrics tests');
  }
  async exportDocument(): Promise<never> {
    throw new Error('exportDocument unused in metrics tests');
  }
}

const FILE_META: DriveFileMeta = {
  id: 'f-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  size: '11',
  trashed: false,
  driveId: 'drive-1',
  hasThumbnail: false,
  capabilities: { canDownload: true },
};

function streamOf(text: string): UpstreamContent {
  return {
    status: 200,
    contentType: 'text/plain',
    contentLength: BigInt(encoder.encode(text).byteLength),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Seeding: upload-fixture base + SA read pool for the content surface.
// ---------------------------------------------------------------------------

async function seedAll() {
  await resetState();
  await seedBase();
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-1','proj-1','sa-1@proj-1.iam.gserviceaccount.com','kid-1','env',1,1,0,0)",
    )
    .run();
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('mount-1','sa-1',1,1,0)",
    )
    .run();
  await env.DB
    .prepare('DELETE FROM maintenance_state')
    .run();
}

function contentApp(provider: FakeReadProvider, actor: Actor = actorFor(USER)) {
  const deps: ContentRouteDeps = {
    getMount,
    resolveSessionActor: () => Promise.resolve(actor),
    readProvider: provider,
    now: () => fakeNow,
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/api/v1/mounts', createContentRouter(deps));
  return app;
}

type TestApp = Hono<{
  Bindings: Env;
  Variables: { requestId?: string };
}>;

function api(app: TestApp, path: string, init?: RequestInit) {
  return app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env);
}

beforeEach(async () => {
  setNow(1_700_000_000_000);
  resetMetrics();
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await seedAll();
});

describe('metrics aggregation', () => {
  it('records catalog list/search latency through the real route', async () => {
    const { provider, calls } = fixtureProvider();
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => {
      c.set('requestId', 'req-test');
      await next();
    });
    app.route(
      '/api/v1/mounts',
      createCatalogRouter({
        resolveActor: () => Promise.resolve(actorFor(USER)),
        oauthProvider: provider,
        cache: new CatalogCache(),
      }),
    );

    const list = await api(app, '/api/v1/mounts/mount-1/folders/drive-1/children');
    expect(list.status).toBe(200);
    const search = await api(
      app,
      '/api/v1/mounts/mount-1/search?q=notes&scope=drive',
    );
    expect(search.status).toBe(200);
    expect(calls.some((c) => c.method === 'listChildren')).toBe(true);
    expect(calls.some((c) => c.method === 'search')).toBe(true);

    const m = metricsSnapshot();
    expect(m.catalog.list.count).toBe(1);
    expect(m.catalog.search.count).toBe(1);
    expect(m.catalog.list.totalMs).toBeGreaterThanOrEqual(0);
    // Every recorded sample lands in exactly one bucket.
    expect(
      Object.values(m.catalog.list.buckets).reduce((a, b) => a + b, 0),
    ).toBe(1);

    // Cache-hit pages never reach the provider — nothing is recorded.
    const again = await api(
      app,
      '/api/v1/mounts/mount-1/folders/drive-1/children',
    );
    expect(again.status).toBe(200);
    expect(metricsSnapshot().catalog.list.count).toBe(1);
  });

  it('records download first-byte latency and streamed bytes', async () => {
    const provider = new FakeReadProvider();
    provider.metaHandler = () => FILE_META;
    provider.contentHandler = () => streamOf('hello world');
    const app = contentApp(provider);

    const res = await api(
      app,
      '/api/v1/mounts/mount-1/files/f-1/content',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello world');

    const m = metricsSnapshot();
    expect(m.content.requests).toBe(1);
    expect(m.content.bytes).toBe('11');
    expect(m.content.firstByte.count).toBe(1);
    expect(m.content.firstByte.maxMs).toBeGreaterThanOrEqual(0);
  });

  it('records upload chunk latency, confirmed bytes, retries and reauth', async () => {
    const completed = fixtureProvider({
      putChunk: () => ({ kind: 'completed', file: metaFile('gen-file-1') }),
    });
    const app = makeApp(completed.provider);
    const res = await postInit(app, 'mx-ok');
    const view = (await res.json()) as UploadViewBody;
    const put = await putChunk(
      app,
      view.uploadId,
      view.sessionGeneration,
      '0',
      new Uint8Array(6),
    );
    expect(put.status).toBe(200);

    let m = metricsSnapshot();
    expect(m.uploads.chunks).toBe(1);
    expect(m.uploads.chunk.count).toBe(1);
    expect(m.uploads.confirmedBytes).toBe('6');
    expect(m.uploads.retries).toBe(0);

    // Outcome-unknown chunk verdicts count as retries.
    const flaky = fixtureProvider({
      putChunk: () => {
        throw new DriveError('upstream-unavailable', 'lost', {});
      },
    });
    const app2 = makeApp(flaky.provider);
    const res2 = await postInit(app2, 'mx-retry');
    const view2 = (await res2.json()) as UploadViewBody;
    const put2 = await putChunk(
      app2,
      view2.uploadId,
      view2.sessionGeneration,
      '0',
      new Uint8Array(6),
    );
    expect(put2.status).toBe(200);
    m = metricsSnapshot();
    expect(m.uploads.retries).toBe(1);
    expect(m.uploads.confirmedBytes).toBe('6');

    // A pinned connection that needs re-auth blocks before any remote
    // call — counted on the reauth counter. The op must exist BEFORE the
    // connection degrades: claim-time writer resolution would otherwise
    // refuse the init outright.
    const app3 = makeApp(fixtureProvider().provider);
    const res3 = await postInit(app3, 'mx-reauth');
    const view3 = (await res3.json()) as UploadViewBody;
    expect(view3.state).toBe('uploading');
    await env.DB
      .prepare(
        "UPDATE google_connections SET state = 'needs_reauth' WHERE id = 'conn-1'",
      )
      .run();
    await putChunk(
      app3,
      view3.uploadId,
      view3.sessionGeneration,
      '0',
      new Uint8Array(6),
    );
    expect(metricsSnapshot().uploads.reauthBlocked).toBeGreaterThanOrEqual(1);
  });

  it('counts blocked-reader verdicts from the readiness probe', async () => {
    const provider = new FakeReadProvider();
    provider.metaHandler = () => {
      throw new DriveError('permission-denied', 'no read', { status: 403 });
    };
    const app = contentApp(provider);
    const res = await api(
      app,
      '/api/v1/mounts/mount-1/files/f-1/readiness',
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { readerAccessState: string };
    expect(body.readerAccessState).toBe('blocked');
    expect(metricsSnapshot().content.readerBlocked).toBe(1);
  });

  it('aggregates durations and byte deltas inside one registry', () => {
    recordUploadChunk({ durationMs: 40, outcome: 'confirmed', confirmedBytes: 5n });
    recordUploadChunk({ durationMs: 700, outcome: 'retry' });
    recordUploadChunk({ durationMs: 700, outcome: 'reauth' });
    const m = metricsSnapshot();
    expect(m.uploads.chunks).toBe(3);
    expect(m.uploads.chunk.count).toBe(3);
    expect(m.uploads.chunk.buckets['<=50']).toBe(1);
    expect(m.uploads.chunk.buckets['<=1000']).toBe(2);
    expect(m.uploads.confirmedBytes).toBe('5');
    expect(m.uploads.retries).toBe(1);
    expect(m.uploads.blocked).toBe(1);
    expect(m.uploads.reauthBlocked).toBe(1);
    expect(m.uploads.chunk.avgMs).toBe(Math.round((40 + 700 + 700) / 3));
  });

  it('countedDownloadBody marks first byte once and counts streamed bytes', async () => {
    const start = Date.now();
    recordContentRequest();
    const body = countedDownloadBody(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('abc'));
          controller.enqueue(encoder.encode('defg'));
          controller.close();
        },
      }),
      start,
    );
    const text = await new Response(body).text();
    expect(text).toBe('abcdefg');
    const m = metricsSnapshot();
    expect(m.content.requests).toBe(1);
    expect(m.content.bytes).toBe('7');
    expect(m.content.firstByte.count).toBe(1);
  });
});

describe('metrics in the admin diagnostics DTO', () => {
  it('exposes redacted counters/durations only', async () => {
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.route(
      '/api/v1/admin/diagnostics',
      createDiagnosticsRouter({
        requireAdmin: () =>
          Promise.resolve({ userId: 'admin-1', sessionId: 'sess-1' }),
      }),
    );
    const res = await api(app, '/api/v1/admin/diagnostics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: MetricsView };
    expect(body.metrics.scope).toBe('isolate');
    expect(body.metrics.catalog.list.count).toBe(0);
    expect(body.metrics.uploads.chunks).toBe(0);
    // Redaction contract: nothing secret-shaped ever appears.
    const text = JSON.stringify(body);
    for (const forbidden of [
      'envelope',
      'ciphertext',
      'nonce',
      'upload_id=',
      'session-1',
      'googleapis.com',
      'secret',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
