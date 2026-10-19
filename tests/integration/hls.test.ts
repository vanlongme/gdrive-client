/**
 * T13 media-package routes — real D1 in workerd, fixture providers.
 * OAuth provider fakes only catalog calls (metadata, children listings);
 * the SA provider fakes metadata + byte reads. No path serves bytes via
 * OAuth — the fixture OAuth provider has no content method at all.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import masterFixture from '../fixtures/hls/master.m3u8?raw';
import mediaTsFixture from '../fixtures/hls/media-ts.m3u8?raw';
import mediaFmp4Fixture from '../fixtures/hls/media-fmp4.m3u8?raw';
import audioFixture from '../fixtures/hls/audio/audio.m3u8?raw';
import subsFixture from '../fixtures/hls/subs/subs.m3u8?raw';
import encryptedFixture from '../fixtures/hls/encrypted.m3u8?raw';
import externalFixture from '../fixtures/hls/external-uri.m3u8?raw';
import escapeFixture from '../fixtures/hls/escape.m3u8?raw';
import liveFixture from '../fixtures/hls/live.m3u8?raw';
import cycleMasterFixture from '../fixtures/hls/cycle-master.m3u8?raw';

import type { Actor } from '../../src/worker/auth/grants';
import type { AuthUser } from '../../src/worker/auth/session';
import { DriveError } from '../../src/worker/drive/errors';
import { resetContainmentCacheForTests } from '../../src/worker/drive/containment';
import type {
  CatalogEntry,
  CatalogPage,
  DriveFileMeta,
  GetMetadataInput,
  ListChildrenInput,
  OAuthCatalogWriteProvider,
  OpenContentInput,
  ReadMetadataInput,
  ServiceAccountContentReadProvider,
  UpstreamContent,
} from '../../src/worker/drive/types';
import {
  createPackageRouter,
  type PackageRouterDeps,
} from '../../src/worker/media/package-routes';
import { createApp } from '../../src/worker/app';
import { hashShareToken } from '../../src/worker/security/shares';
import { mintMediaTicket } from '../../src/worker/security/tickets';
import { MEDIA_TICKET_TOKEN_PREFIX } from '../../src/worker/security/tickets';
import type { KeyringEnv } from '../../src/worker/security/vault';

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

// ---------------------------------------------------------------------------
// D1 seeding (mirrors content.test.ts conventions)
// ---------------------------------------------------------------------------

async function resetState() {
  for (const table of [
    'mount_drive_permissions',
    'media_package_resources',
    'media_packages',
    'audit_events',
    'file_readiness',
    'share_links',
    'mount_grants',
    'mount_read_credentials',
    'service_accounts',
    'containment_verdicts',
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

async function seedBase() {
  await resetState();
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
    'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
      "VALUES ('oc-1', 'proj-1', 'client-1', 'env', 'https://x/cb', 1, 3, ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) ' +
      "VALUES ('conn-1', 'oc-1', 'perm-1', 'op@x', NULL, 'drive', 'connected', 1, 5, 'u-admin', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    'INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
      "VALUES ('m-1', 'Mount', 'drive-1', 'drive-1', 'conn-1', 'conn-1', 1, 'private', 1, ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) " +
      "VALUES ('sa-1', 'proj-1', 'sa-1@proj-1.iam.gserviceaccount.com', 'key-sa-1', 'env', 1, 1, ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
  await env.DB.prepare(
    "INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('m-1', 'sa-1', 10, 1, ?)",
  )
    .bind(NOW)
    .run();
  await env.DB.prepare(
    'INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) ' +
      "VALUES ('u-viewer', 'm-1', 'viewer', '[\"read\"]', 'u-admin', ?, ?)",
  )
    .bind(NOW, NOW)
    .run();
}

// ---------------------------------------------------------------------------
// Fixture Drive: a folder tree + file contents. IDs are stable per path.
// ---------------------------------------------------------------------------

interface FixtureDrive {
  /** folderId -> children */
  folders: Map<string, CatalogEntry[]>;
  /** fileId -> meta + content */
  files: Map<string, { meta: DriveFileMeta; bytes: string }>;
}

const MTIME = '2026-10-01T00:00:00.000Z';

function fileEntry(id: string, name: string, size = '16'): CatalogEntry {
  return {
    id,
    kind: 'file',
    name,
    mimeType: 'application/octet-stream',
    size,
    modifiedTime: MTIME,
    hasThumbnail: false,
  };
}

function folderEntry(id: string, name: string): CatalogEntry {
  return {
    id,
    kind: 'folder',
    name,
    mimeType: 'application/vnd.google-apps.folder',
    size: '0',
    modifiedTime: MTIME,
    hasThumbnail: false,
  };
}

function fileMeta(
  id: string,
  name: string,
  options: { size?: string; revision?: string; parents?: string[] } = {},
): DriveFileMeta {
  return {
    id,
    name,
    mimeType: 'application/octet-stream',
    size: options.size ?? '16',
    modifiedTime: MTIME,
    trashed: false,
    driveId: 'drive-1',
    headRevisionId: options.revision ?? `rev-${id}`,
    parents: options.parents ?? ['root-1'],
    hasThumbnail: false,
    capabilities: { canDownload: true },
  };
}

/**
 * The canonical test package: root-1/ holds master.m3u8 plus the two
 * variant playlists, init/frag files, seg0.ts, the 'My Clip' folder, and
 * audio/ + subs/ folders with their own playlists and media.
 */
function buildDrive(): FixtureDrive {
  const folders = new Map<string, CatalogEntry[]>();
  const files = new Map<string, { meta: DriveFileMeta; bytes: string }>();
  const put = (
    folderId: string,
    id: string,
    name: string,
    bytes: string,
    mime = 'application/octet-stream',
  ) => {
    const list = folders.get(folderId) ?? [];
    list.push({ ...fileEntry(id, name, String(encoder.encode(bytes).byteLength)), mimeType: mime });
    folders.set(folderId, list);
    files.set(id, {
      meta: { ...fileMeta(id, name, { size: String(encoder.encode(bytes).byteLength) }), mimeType: mime, parents: [folderId] },
      bytes,
    });
  };
  put('root-1', 'f-entry', 'master.m3u8', masterFixture, 'application/vnd.apple.mpegurl');
  put('root-1', 'f-ts', 'media-ts.m3u8', mediaTsFixture, 'application/vnd.apple.mpegurl');
  put('root-1', 'f-fmp4', 'media-fmp4.m3u8', mediaFmp4Fixture, 'application/vnd.apple.mpegurl');
  put('root-1', 'f-init', 'init.mp4', 'INIT-BYTES', 'video/mp4');
  put('root-1', 'f-frag0', 'frag0.m4s', 'FRAG0');
  put('root-1', 'f-frag1', 'frag1.m4s', 'FRAG1');
  put('root-1', 'f-seg0', 'seg0.ts', 'SEG0-VIDEO', 'video/mp2t');
  folders.get('root-1')!.push(folderEntry('dir-clip', 'My Clip'));
  folders.get('root-1')!.push(folderEntry('dir-audio', 'audio'));
  folders.get('root-1')!.push(folderEntry('dir-subs', 'subs'));
  put('dir-clip', 'f-clip1', 'seg 1.ts', 'CLIP1', 'video/mp2t');
  put('dir-audio', 'f-audio-m3u8', 'audio.m3u8', audioFixture, 'application/vnd.apple.mpegurl');
  put('dir-audio', 'f-aac0', 'seg0.aac', 'AAC0');
  put('dir-audio', 'f-aac1', 'seg1.aac', 'AAC1');
  put('dir-subs', 'f-subs-m3u8', 'subs.m3u8', subsFixture, 'application/vnd.apple.mpegurl');
  put('dir-subs', 'f-vtt0', 'sub0.vtt', 'WEBVTT');
  return { folders, files };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

class FakeOAuthProvider implements OAuthCatalogWriteProvider {
  readonly drive: FixtureDrive;
  readonly childrenCalls: ListChildrenInput[] = [];
  readonly metadataCalls: GetMetadataInput[] = [];
  metaOverrides = new Map<string, DriveFileMeta>();

  constructor(drive: FixtureDrive) {
    this.drive = drive;
  }

  async listChildren(input: ListChildrenInput): Promise<CatalogPage> {
    this.childrenCalls.push(input);
    const entries = this.drive.folders.get(input.parentFolderId);
    if (entries === undefined) {
      throw new DriveError('not-found', `no fixture folder ${input.parentFolderId}`);
    }
    return { entries };
  }

  async getMetadata(input: GetMetadataInput): Promise<DriveFileMeta> {
    this.metadataCalls.push(input);
    const override = this.metaOverrides.get(input.ref.id);
    if (override !== undefined) return override;
    const found = this.drive.files.get(input.ref.id);
    if (found === undefined) {
      throw new DriveError('not-found', `${input.ref.id} not found`, { status: 404 });
    }
    return found.meta;
  }

  search(): Promise<CatalogPage> {
    return Promise.reject(new DriveError('operation-not-allowed', 'fixture'));
  }
  generateId(): Promise<string> {
    return Promise.reject(new DriveError('operation-not-allowed', 'fixture'));
  }
  createFolder(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
  startUpload(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
  putChunk(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
  probeUpload(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
  verifyFile(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
  trashFile(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
}

class FakeReadProvider implements ServiceAccountContentReadProvider {
  readonly drive: FixtureDrive;
  readonly calls: Array<{ op: string; refId: string }> = [];
  metaOverrides = new Map<string, DriveFileMeta>();
  contentOverrides = new Map<string, string>();
  failMeta = new Set<string>();

  constructor(drive: FixtureDrive) {
    this.drive = drive;
  }

  async getReadMetadata(input: ReadMetadataInput): Promise<DriveFileMeta> {
    this.calls.push({ op: 'meta', refId: input.ref.id });
    if (this.failMeta.has(input.ref.id)) {
      throw new DriveError('permission-denied', 'fixture denied');
    }
    const override = this.metaOverrides.get(input.ref.id);
    if (override !== undefined) return override;
    const found = this.drive.files.get(input.ref.id);
    if (found === undefined) {
      throw new DriveError('not-found', `${input.ref.id} not found`, { status: 404 });
    }
    return found.meta;
  }

  async openContent(input: OpenContentInput): Promise<UpstreamContent> {
    this.calls.push({ op: 'content', refId: input.ref.id });
    const bytes = this.contentOverrides.get(input.ref.id) ?? this.drive.files.get(input.ref.id)?.bytes;
    if (bytes === undefined) {
      throw new DriveError('not-found', `${input.ref.id} no content`, { status: 404 });
    }
    const encoded = encoder.encode(bytes);
    if (input.range !== undefined) {
      const { start, end } = input.range;
      const slice = encoded.subarray(Number(start), Number(end) + 1);
      return {
        status: 206,
        contentType: 'application/octet-stream',
        contentLength: BigInt(slice.byteLength),
        contentRange: `bytes ${start}-${end}/${encoded.byteLength}`,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(slice);
            c.close();
          },
        }),
      };
    }
    return {
      status: 200,
      contentType: 'application/octet-stream',
      contentLength: BigInt(encoded.byteLength),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoded);
          c.close();
        },
      }),
    };
  }

  getRevision(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
  openThumbnail(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
  exportDocument(): never {
    throw new DriveError('operation-not-allowed', 'fixture');
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type TestApp = Hono<{ Bindings: Env; Variables: { requestId?: string } }>;

let currentActor: Actor = userActor(viewerUser);

function makeApp(options: { oauth: FakeOAuthProvider; read: FakeReadProvider; budget?: number }) {
  const deps: PackageRouterDeps = {
    resolveSessionActor: () => Promise.resolve(currentActor),
    oauthProvider: options.oauth,
    readProvider: options.read,
    now: () => NOW,
    ...(options.budget === undefined ? {} : { workBudget: options.budget }),
  };
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => {
    c.set('requestId', 'req-test');
    await next();
  });
  app.route('/api/v1/media-packages', createPackageRouter(deps));
  return app;
}

function api(app: TestApp, path: string, init?: RequestInit) {
  return Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env));
}

const postJson = { method: 'POST', headers: { 'content-type': 'application/json' } } as const;

async function createPackage(app: TestApp, entryFileId = 'f-entry') {
  const res = await api(app, '/api/v1/media-packages', {
    ...postJson,
    body: JSON.stringify({ mountId: 'm-1', entryFileId }),
  });
  return res;
}

interface AdvanceReply {
  status: number;
  body: {
    state: string;
    complete: boolean;
    indexGeneration: number;
    processedResources: number;
  } | { error: { code: string } };
}

async function advanceUntilDone(
  app: TestApp,
  packageId: string,
  maxCalls = 40,
): Promise<AdvanceReply> {
  let last: AdvanceReply | undefined;
  for (let i = 0; i < maxCalls; i++) {
    const res = await api(app, `/api/v1/media-packages/${packageId}/advance`, {
      ...postJson,
      body: '{}',
    });
    last = { status: res.status, body: (await res.json()) as AdvanceReply['body'] };
    if (last.status !== 200) return last;
    if ('complete' in last.body && last.body.complete) return last;
  }
  if (last === undefined) throw new Error('advanceUntilDone: no calls made');
  return last;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  resetContainmentCacheForTests();
  await seedBase();
  currentActor = userActor(viewerUser);
});

// ---------------------------------------------------------------------------
// Happy path: create -> advance -> ready -> rewritten playlist -> bytes
// ---------------------------------------------------------------------------

describe('media package lifecycle', () => {
  it('creates, advances to ready and serves rewritten playlists + segments', async () => {
    const oauth = new FakeOAuthProvider(buildDrive());
    const read = new FakeReadProvider(buildDrive());
    const app = makeApp({ oauth, read });

    const created = await createPackage(app);
    expect(created.status).toBe(201);
    const view = (await created.json()) as {
      packageId: string;
      state: string;
      playerUrl?: string;
    };
    expect(view.state).toBe('preparing');
    expect(view.playerUrl).toBeUndefined();
    const packageId = view.packageId;

    const done = await advanceUntilDone(app, packageId);
    expect(done.status).toBe(200);
    if (!('state' in done.body)) throw new Error('unexpected error body');
    expect(done.body.state).toBe('ready');
    expect(done.body.complete).toBe(true);

    const readyView = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      playerUrl?: string;
      readyGeneration?: number;
    };
    expect(readyView.state).toBe('ready');
    expect(readyView.readyGeneration).toBe(1);
    expect(readyView.playerUrl).toBe(
      `/api/v1/media-packages/${packageId}/resources/r1`,
    );

    // The rewritten master playlist points at resource routes only.
    const masterRes = await api(
      app,
      `/api/v1/media-packages/${packageId}/resources/r1`,
    );
    expect(masterRes.status).toBe(200);
    expect(masterRes.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const masterText = await masterRes.text();
    expect(masterText).not.toContain('media-ts.m3u8');
    expect(masterText).not.toContain('audio/audio.m3u8');
    expect(masterText).toContain('URI="r');
    const variantLine = masterText
      .split('\n')
      .find((l) => /^r\d+$/.test(l));
    expect(variantLine).toBeDefined();

    // Follow the rewritten variant to its rewritten media playlist, then a
    // segment resource streams bytes through the SA provider.
    const tsRes = await api(
      app,
      `/api/v1/media-packages/${packageId}/resources/${variantLine}`,
    );
    expect(tsRes.status).toBe(200);
    const tsText = await tsRes.text();
    expect(tsText).not.toContain('seg0.ts');
    const segRef = tsText
      .split('\n')
      .find((l) => /^r\d+$/.test(l));
    expect(segRef).toBeDefined();
    const segRes = await api(
      app,
      `/api/v1/media-packages/${packageId}/resources/${segRef}`,
    );
    expect(segRes.status).toBe(200);
    expect(await segRes.text()).toBe('SEG0-VIDEO');
    // Every byte read went through the SA provider; OAuth never read content.
    expect(read.calls.filter((c) => c.op === 'content').length).toBeGreaterThan(0);
  });

  it('idempotent create returns the existing package', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    const first = await createPackage(app);
    const second = await createPackage(app);
    const a = (await first.json()) as { packageId: string };
    const b = (await second.json()) as { packageId: string };
    expect(second.status).toBe(200);
    expect(b.packageId).toBe(a.packageId);
  });

  it('serves Range requests on segment resources', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);
    // Find a segment resource id by reading the TS playlist rewrite.
    const ts = await api(app, `/api/v1/media-packages/${packageId}/resources/r1`);
    const masterText = await ts.text();
    const tsId = masterText.split('\n').find((l) => /^r\d+$/.test(l));
    const tsText2 = await (await api(app, `/api/v1/media-packages/${packageId}/resources/${tsId}`)).text();
    const segId = tsText2.split('\n').find((l) => /^r\d+$/.test(l));
    const res = await api(app, `/api/v1/media-packages/${packageId}/resources/${segId}`, {
      headers: { range: 'bytes=0-3' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(await res.text()).toBe('SEG0');
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('package authorization', () => {
  it('rejects viewers without mount grants and advances', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    currentActor = userActor({ ...viewerUser, id: 'u-stranger' });
    const created = await createPackage(app);
    expect(created.status).toBe(403);
  });

  it('requires auth: public actor cannot reach private mount packages', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    currentActor = { kind: 'public' };
    const res = await api(app, `/api/v1/media-packages/${packageId}`);
    expect(res.status).toBe(401);
    const resSeg = await api(app, `/api/v1/media-packages/${packageId}/resources/r1`);
    expect(resSeg.status).toBe(401);
  });

  it('serves package-scoped share tokens and rejects pinned-generation mismatch', async () => {
    const oauth = new FakeOAuthProvider(buildDrive());
    const read = new FakeReadProvider(buildDrive());
    const app = makeApp({ oauth, read });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);

    const token = 'shr_pkg';
    await env.DB.prepare(
      'INSERT INTO share_links (id, token_hash, created_by, scope_kind, mount_id, file_id, package_id, revision_id, index_generation, expires_at, revoked_at, policy_version, created_at) ' +
        "VALUES ('share-1', ?, 'u-admin', 'package', 'm-1', NULL, ?, NULL, 1, ?, NULL, 1, ?)",
    )
      .bind(await hashShareToken(token), packageId, NOW + 3_600_000, NOW)
      .run();

    const shared = await api(
      app,
      `/api/v1/media-packages/${packageId}/resources/r1?share=${token}`,
    );
    expect(shared.status).toBe(200);
    const text = await shared.text();
    // Rewritten URIs propagate the share credential.
    expect(text).toContain(`?share=${encodeURIComponent(token)}`);

    // A share pinned to generation 99 sees nothing of generation 1.
    const badToken = 'shr_pkg_old';
    await env.DB.prepare(
      'INSERT INTO share_links (id, token_hash, created_by, scope_kind, mount_id, file_id, package_id, revision_id, index_generation, expires_at, revoked_at, policy_version, created_at) ' +
        "VALUES ('share-2', ?, 'u-admin', 'package', 'm-1', NULL, ?, NULL, 99, ?, NULL, 1, ?)",
    )
      .bind(await hashShareToken(badToken), packageId, NOW + 3_600_000, NOW)
      .run();
    const denied = await api(
      app,
      `/api/v1/media-packages/${packageId}/resources/r1?share=${badToken}`,
    );
    expect(denied.status).toBe(403);
  });

  it('admits package-scoped media tickets on GET only', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);
    const minted = await mintMediaTicket(env as unknown as KeyringEnv, {
      scope: { kind: 'package', mountId: 'm-1', packageId, indexGeneration: 1 },
      principal: { kind: 'user', userId: viewerUser.id },
      ttlSeconds: 300,
      now: NOW,
    });
    expect(minted.token.startsWith(MEDIA_TICKET_TOKEN_PREFIX)).toBe(true);
    const res = await api(
      app,
      `/api/v1/media-packages/${packageId}/resources/r1?ticket=${minted.token}`,
    );
    expect(res.status).toBe(200);
    // Tickets cannot advance or create.
    const adv = await api(
      app,
      `/api/v1/media-packages/${packageId}/advance?ticket=${minted.token}`,
      { ...postJson, body: '{}' },
    );
    expect(adv.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Hostile graphs and package failures
// ---------------------------------------------------------------------------

async function hostilePackage(
  playlistName: string,
  playlistText: string,
): Promise<{ app: TestApp; packageId: string; res: AdvanceReply }> {
  const drive = buildDrive();
  drive.folders.get('root-1')!.push(fileEntry('f-evil', playlistName, '200'));
  drive.files.set('f-evil', {
    meta: fileMeta('f-evil', playlistName, { size: '200' }),
    bytes: playlistText,
  });
  const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
  const created = await createPackage(app, 'f-evil');
  const { packageId } = (await created.json()) as { packageId: string };
  const res = await advanceUntilDone(app, packageId, 10);
  return { app, packageId, res };
}

describe('hostile playlists fail the generation', () => {
  it('encrypted playlist -> failed + PREVIEW_UNSUPPORTED', async () => {
    const { res, packageId, app } = await hostilePackage('evil.m3u8', encryptedFixture);
    expect(res.status).toBe(415);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('PREVIEW_UNSUPPORTED');
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      failureReason?: string;
    };
    expect(view.state).toBe('failed');
    // W6-F finding 3: failure_reason is a stable code, never playlist text.
    expect(view.failureReason).toBe('hls:unsupported');
    expect(view.failureReason).not.toContain('EXT-X-KEY');
  });

  it('external URI -> failed + VALIDATION_FAILED', async () => {
    const { res } = await hostilePackage('evil.m3u8', externalFixture);
    expect(res.status).toBe(400);
  });

  it('path escape -> failed', async () => {
    const { res } = await hostilePackage('evil.m3u8', escapeFixture);
    expect(res.status).toBe(400);
  });

  it('live playlist -> failed + PREVIEW_UNSUPPORTED', async () => {
    const { res } = await hostilePackage('evil.m3u8', liveFixture);
    expect(res.status).toBe(415);
  });

  it('cyclic playlist graph -> failed', async () => {
    const { res, packageId, app } = await hostilePackage('cycle-master.m3u8', cycleMasterFixture);
    expect(res.status).toBe(400);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      failureReason?: string;
    };
    expect(view.state).toBe('failed');
    expect(view.failureReason).toBe('hls-index:cycle');
  });

  it('ambiguous duplicate names -> failed + FILE_CONFLICT', async () => {
    const drive = buildDrive();
    // Two files named seg0.ts in root: resolution must refuse, not pick.
    drive.folders.get('root-1')!.push(fileEntry('f-dup2', 'seg0.ts', '10'));
    drive.files.set('f-dup2', {
      meta: fileMeta('f-dup2', 'seg0.ts', { size: '10' }),
      bytes: 'DUP-DUP',
    });
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const res = await advanceUntilDone(app, packageId, 40);
    expect(res.status).toBe(409);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      failureReason?: string;
    };
    expect(view.state).toBe('failed');
    // W6-F finding 3: the upstream-controlled Drive name never reaches the DTO.
    expect(view.failureReason).toBe('hls-index:ambiguous');
    expect(view.failureReason).not.toContain('seg0');
  });

  it('missing referenced file -> failed + FILE_NOT_ACCESSIBLE', async () => {
    const drive = buildDrive();
    drive.files.delete('f-frag0');
    drive.folders.set(
      'root-1',
      drive.folders.get('root-1')!.filter((e) => e.name !== 'frag0.m4s'),
    );
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const res = await advanceUntilDone(app, packageId, 40);
    expect(res.status).toBe(404);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
    };
    expect(view.state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Generations: staleness, invalidation, readiness
// ---------------------------------------------------------------------------

describe('generations', () => {
  it('resources are not served before ready (MEDIA_PACKAGE_NOT_READY)', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const res = await api(app, `/api/v1/media-packages/${packageId}/resources/r1`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MEDIA_PACKAGE_NOT_READY');
  });

  it('a changed dependency invalidates the ready generation and re-indexes', async () => {
    const oauth = new FakeOAuthProvider(buildDrive());
    const read = new FakeReadProvider(buildDrive());
    const app = makeApp({ oauth, read });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);

    // Mutate a child playlist's content AND its revision marker — a
    // duration-only change keeps every URI resolvable on re-index.
    const changed = mediaTsFixture.replace('#EXTINF:4.0,', '#EXTINF:5.0,');
    read.contentOverrides.set('f-ts', changed);
    const tsMeta = { ...oauth.drive.files.get('f-ts')!.meta, headRevisionId: 'rev-NEW' };
    oauth.metaOverrides.set('f-ts', tsMeta);
    read.metaOverrides.set('f-ts', tsMeta);

    // Serving the old-generation playlist now detects drift and stops.
    const tsRow = await env.DB
      .prepare(
        "SELECT resource_id FROM media_package_resources WHERE package_id = ? AND index_generation = 1 AND path = 'media-ts.m3u8'",
      )
      .bind(packageId)
      .first<{ resource_id: string }>();
    const stale = await api(
      app,
      `/api/v1/media-packages/${packageId}/resources/${tsRow!.resource_id}`,
    );
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error: { code: string } };
    expect(staleBody.error.code).toBe('CONTENT_CHANGED');

    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      playerUrl?: string;
    };
    expect(view.state).toBe('preparing');
    expect(view.playerUrl).toBeUndefined();

    // Advance re-indexes a fresh generation to ready.
    const done = await advanceUntilDone(app, packageId);
    expect(done.status).toBe(200);
    expect('state' in done.body && done.body.state).toBe('ready');
    const readyAgain = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      readyGeneration?: number;
      playerUrl?: string;
    };
    expect(readyAgain.state).toBe('ready');
    expect(readyAgain.readyGeneration).toBe(2);
    expect(readyAgain.playerUrl).toBe(`/api/v1/media-packages/${packageId}/resources/r1`);
  });

  it('verify-only advance on a ready package leaves generation intact', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);
    const res = await api(app, `/api/v1/media-packages/${packageId}/advance`, {
      ...postJson,
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; complete: boolean; indexGeneration: number };
    expect(body.state).toBe('ready');
    expect(body.indexGeneration).toBe(1);
  });

  it('failed packages re-index on advance (retry)', async () => {
    const drive = buildDrive();
    drive.folders.get('root-1')!.push(fileEntry('f-evil', 'evil.m3u8', '200'));
    drive.files.set('f-evil', {
      meta: fileMeta('f-evil', 'evil.m3u8', { size: '200' }),
      bytes: externalFixture,
    });
    const read = new FakeReadProvider(drive);
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read });
    const created = await createPackage(app, 'f-evil');
    const { packageId } = (await created.json()) as { packageId: string };
    const failed = await advanceUntilDone(app, packageId, 10);
    expect(failed.status).toBe(400);

    // Fix the upstream bytes; the next advance starts a fresh generation.
    drive.files.set('f-evil', {
      meta: fileMeta('f-evil', 'evil.m3u8', { size: String(mediaTsFixture.length), revision: 'rev-fixed' }),
      bytes: mediaTsFixture,
    });
    const done = await advanceUntilDone(app, packageId, 40);
    expect(done.status).toBe(200);
    expect('state' in done.body && done.body.state).toBe('ready');
    expect('complete' in done.body && done.body.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mounted surface: real createApp() middleware chain (bootstrap gate, origin
// check, setup gate, router mount). Denial paths must not reach Google.
// ---------------------------------------------------------------------------

describe('mounted app surface', () => {
  it('unauthenticated create on a private mount -> 401 without upstream calls', async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/v1/media-packages`, {
        ...postJson,
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
        },
        body: JSON.stringify({ mountId: 'm-1', entryFileId: 'f-entry' }),
      }),
      env as unknown as Env,
    );
    expect(res.status).toBe(401);
  });

  it('foreign-origin mutations are rejected before auth work', async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/v1/media-packages`, {
        ...postJson,
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example.com',
        },
        body: JSON.stringify({ mountId: 'm-1', entryFileId: 'f-entry' }),
      }),
      env as unknown as Env,
    );
    expect(res.status).toBe(403);
  });

  it('unknown package id -> 404 on the mounted path', async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/v1/media-packages/does-not-exist`),
      env as unknown as Env,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// D3 fixes (W4-R2 findings): complete-graph publish, kind conflicts, path
// aliasing, shortcut markers, permanent upstream errors, entry kind,
// stale-marking consistency and advance throttling.
// ---------------------------------------------------------------------------

describe('D3 fixes', () => {
  it('indexes every canonical-fixture resource — no silently dropped rows', async () => {
    const app = makeApp({ oauth: new FakeOAuthProvider(buildDrive()), read: new FakeReadProvider(buildDrive()) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const done = await advanceUntilDone(app, packageId);
    expect('state' in done.body && done.body.state).toBe('ready');
    const rows = await env.DB
      .prepare('SELECT resource_id, kind, path FROM media_package_resources WHERE package_id = ? ORDER BY path')
      .bind(packageId)
      .all<{ resource_id: string; kind: string; path: string }>();
    const paths = (rows.results ?? []).map((r) => r.path);
    // Regression for the resource_id desync: media-ts has a repeated
    // segment ref; the init map row must still exist after that gap.
    expect(paths).toContain('init.mp4');
    expect(paths).toContain('frag0.m4s');
    expect(paths).toContain('frag1.m4s');
    // Serving the fmp4 playlist rewrites init+fragments without error.
    const fmp4 = (rows.results ?? []).find((r) => r.path === 'media-fmp4.m3u8');
    const res = await api(app, `/api/v1/media-packages/${packageId}/resources/${fmp4!.resource_id}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('URI="r');
    const initRow = (rows.results ?? []).find((r) => r.path === 'init.mp4');
    const initRes = await api(app, `/api/v1/media-packages/${packageId}/resources/${initRow!.resource_id}`);
    expect(initRes.status).toBe(200);
    expect(await initRes.text()).toBe('INIT-BYTES');
  });

  it('kind collision: playlist ref onto a segment path -> failed, never raw bytes', async () => {
    const drive: FixtureDrive = { folders: new Map(), files: new Map() };
    const m2 = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nx\n';
    const hostile = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nhttps://evil.example/s.ts\n#EXT-X-ENDLIST\n';
    const a = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nx\n#EXT-X-ENDLIST\n';
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nm2.m3u8\n';
    drive.files.set('f-entry', { meta: fileMeta('f-entry', 'master.m3u8', { size: String(master.length) }), bytes: master });
    drive.files.set('f-a', { meta: fileMeta('f-a', 'a.m3u8', { size: String(a.length) }), bytes: a });
    drive.files.set('f-m2', { meta: fileMeta('f-m2', 'm2.m3u8', { size: String(m2.length) }), bytes: m2 });
    drive.files.set('f-x', { meta: fileMeta('f-x', 'x', { size: String(hostile.length) }), bytes: hostile });
    drive.folders.set('root-1', [
      fileEntry('f-entry', 'master.m3u8', String(master.length)),
      fileEntry('f-a', 'a.m3u8', String(a.length)),
      fileEntry('f-m2', 'm2.m3u8', String(m2.length)),
      fileEntry('f-x', 'x', String(hostile.length)),
    ]);
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const res = await advanceUntilDone(app, packageId);
    expect(res.status).toBe(409);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      failureReason?: string;
    };
    expect(view.state).toBe('failed');
    // The raw playlist file at path x must never have been served, and the
    // reason is a stable code — no playlist-derived path text (W6-F #3).
    expect(view.failureReason).toBe('hls-index:ambiguous');
  });

  it('kind conflict at resolve: one file as both segment and playlist -> failed', async () => {
    const drive: FixtureDrive = { folders: new Map(), files: new Map() };
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nx.ts\n#EXTINF:1,\nalias.m3u8\n#EXT-X-ENDLIST\n';
    const inner = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\ny.ts\n#EXT-X-ENDLIST\n';
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\np.m3u8\n';
    drive.files.set('f-entry', { meta: fileMeta('f-entry', 'master.m3u8', { size: String(master.length) }), bytes: master });
    drive.files.set('f-media', { meta: fileMeta('f-media', 'media.m3u8', { size: String(media.length) }), bytes: media });
    drive.files.set('f-p', { meta: fileMeta('f-p', 'p.m3u8', { size: String(inner.length) }), bytes: inner });
    drive.files.set('f-x', { meta: fileMeta('f-x', 'x.ts'), bytes: 'X' });
    drive.files.set('f-y', { meta: fileMeta('f-y', 'y.ts'), bytes: 'Y' });
    // alias.m3u8 is a shortcut to the playlist file f-p -> segment+playlist kind conflict on fileId.
    drive.folders.set('root-1', [
      fileEntry('f-entry', 'master.m3u8', String(master.length)),
      fileEntry('f-media', 'media.m3u8', String(media.length)),
      fileEntry('f-p', 'p.m3u8', String(inner.length)),
      fileEntry('f-x', 'x.ts'),
      fileEntry('f-y', 'y.ts'),
      { id: 'sc-alias', kind: 'shortcut', name: 'alias.m3u8', mimeType: 'application/vnd.google-apps.shortcut', size: '0', modifiedTime: MTIME, hasThumbnail: false, shortcutTargetId: 'f-p', shortcutTargetMimeType: 'application/vnd.apple.mpegurl' } as unknown as CatalogEntry,
    ]);
    drive.files.set('sc-alias', {
      meta: { ...{ ...fileMeta('sc-alias', 'alias.m3u8'), mimeType: 'application/vnd.google-apps.shortcut' }, shortcutTargetId: 'f-p', shortcutTargetMimeType: 'application/vnd.apple.mpegurl' } as unknown as DriveFileMeta,
      bytes: '',
    });
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const res = await advanceUntilDone(app, packageId);
    expect(res.status).toBe(409);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as { state: string };
    expect(view.state).toBe('failed');
  });

  it('same playlist file at two canonical paths (shortcut alias) -> deterministic failure', async () => {
    const drive: FixtureDrive = { folders: new Map(), files: new Map() };
    const inner = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\ns.ts\n#EXT-X-ENDLIST\n';
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nalias.m3u8\n';
    drive.files.set('f-entry', { meta: fileMeta('f-entry', 'master.m3u8', { size: String(master.length) }), bytes: master });
    drive.files.set('f-list', { meta: fileMeta('f-list', 'list.m3u8', { size: String(inner.length) }), bytes: inner });
    drive.files.set('f-s', { meta: fileMeta('f-s', 's.ts'), bytes: 'S' });
    drive.folders.set('root-1', [
      fileEntry('f-entry', 'master.m3u8', String(master.length)),
      fileEntry('f-list', 'list.m3u8', String(inner.length)),
      fileEntry('f-s', 's.ts'),
      { id: 'sc-alias', kind: 'shortcut', name: 'alias.m3u8', mimeType: 'application/vnd.google-apps.shortcut', size: '0', modifiedTime: MTIME, hasThumbnail: false, shortcutTargetId: 'f-list', shortcutTargetMimeType: 'application/vnd.apple.mpegurl' } as unknown as CatalogEntry,
    ]);
    drive.files.set('sc-alias', {
      meta: { ...{ ...fileMeta('sc-alias', 'alias.m3u8'), mimeType: 'application/vnd.google-apps.shortcut' }, shortcutTargetId: 'f-list', shortcutTargetMimeType: 'application/vnd.apple.mpegurl' } as unknown as DriveFileMeta,
      bytes: '',
    });
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const res = await advanceUntilDone(app, packageId);
    expect([400, 409]).toContain(res.status);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as { state: string };
    expect(view.state).toBe('failed');
  });

  it('shortcut-resolved leaf resources serve with the target version marker', async () => {
    const drive: FixtureDrive = { folders: new Map(), files: new Map() };
    const m3u8 = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n';
    drive.files.set('f-entry', { meta: fileMeta('f-entry', 'list.m3u8', { size: String(m3u8.length) }), bytes: m3u8 });
    drive.files.set('f-target', { meta: fileMeta('f-target', 'seg.ts', { parents: ['other-dir'] }), bytes: 'BYTES' });
    drive.folders.set('root-1', [
      fileEntry('f-entry', 'list.m3u8', String(m3u8.length)),
      { id: 'sc-1', kind: 'shortcut', name: 'seg.ts', mimeType: 'application/vnd.google-apps.shortcut', size: '0', modifiedTime: '2026-09-01T00:00:00.000Z', hasThumbnail: false, shortcutTargetId: 'f-target', shortcutTargetMimeType: 'application/octet-stream' } as unknown as CatalogEntry,
    ]);
    drive.folders.set('other-dir', [fileEntry('f-target', 'seg.ts')]);
    drive.files.set('sc-1', {
      meta: { ...{ ...fileMeta('sc-1', 'seg.ts'), mimeType: 'application/vnd.google-apps.shortcut' }, shortcutTargetId: 'f-target', shortcutTargetMimeType: 'application/octet-stream', modifiedTime: '2026-09-01T00:00:00.000Z' } as unknown as DriveFileMeta,
      bytes: '',
    });
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const done = await advanceUntilDone(app, packageId);
    expect('state' in done.body && done.body.state).toBe('ready');
    const row = await env.DB
      .prepare("SELECT resource_id, revision_id FROM media_package_resources WHERE package_id = ? AND kind = 'segment'")
      .bind(packageId)
      .first<{ resource_id: string; revision_id: string }>();
    // Marker must come from the TARGET's metadata (rev:), not the shortcut's mtime.
    expect(row!.revision_id).toBe('rev:rev-f-target');
    const res = await api(app, `/api/v1/media-packages/${packageId}/resources/${row!.resource_id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('BYTES');
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as { state: string };
    expect(view.state).toBe('ready');
  });

  it('leading .. inside the package root resolves relative to the playlist dir', async () => {
    const drive: FixtureDrive = { folders: new Map(), files: new Map() };
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\n../seg.ts\n#EXT-X-ENDLIST\n';
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/media.m3u8\n';
    drive.files.set('f-entry', { meta: fileMeta('f-entry', 'master.m3u8', { size: String(master.length) }), bytes: master });
    drive.files.set('f-media', { meta: fileMeta('f-media', 'media.m3u8', { size: String(media.length), parents: ['dir-v'] }), bytes: media });
    drive.files.set('f-seg', { meta: fileMeta('f-seg', 'seg.ts'), bytes: 'BYTES' });
    drive.folders.set('root-1', [
      fileEntry('f-entry', 'master.m3u8', String(master.length)),
      folderEntry('dir-v', 'v'),
      fileEntry('f-seg', 'seg.ts'),
    ]);
    drive.folders.set('dir-v', [fileEntry('f-media', 'media.m3u8', String(media.length))]);
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const done = await advanceUntilDone(app, packageId);
    expect(done.status).toBe(200);
    expect('state' in done.body && done.body.state).toBe('ready');
    const row = await env.DB
      .prepare("SELECT resource_id FROM media_package_resources WHERE package_id = ? AND path = 'seg.ts'")
      .bind(packageId)
      .first<{ resource_id: string }>();
    expect(row).not.toBeNull();
    const res = await api(app, `/api/v1/media-packages/${packageId}/resources/${row!.resource_id}`);
    expect(await res.text()).toBe('BYTES');
  });

  it('permanent SA read failure during indexing -> terminal failed, no wedge', async () => {
    const drive = buildDrive();
    const read = new FakeReadProvider(drive);
    read.failMeta.add('f-ts');
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    const res = await advanceUntilDone(app, packageId, 30);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as {
      state: string;
      failureReason?: string;
    };
    expect(view.state).toBe('failed');
    // SA-side failure taxonomy: not the OAuth catalog codes.
    if (res.status !== 200) {
      const code = (res.body as { error?: { code: string } }).error?.code;
      expect(['FILE_NOT_READABLE_BY_POOL', 'READ_PROVIDER_UNAVAILABLE', 'FILE_NOT_ACCESSIBLE']).toContain(code);
    }
  });

  it('deleted dependency on verify -> re-index -> terminal failed', async () => {
    const drive = buildDrive();
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);
    // Delete a playlist dependency upstream.
    drive.files.delete('f-ts');
    drive.folders.set('root-1', drive.folders.get('root-1')!.filter((e) => e.name !== 'media-ts.m3u8'));
    await api(app, `/api/v1/media-packages/${packageId}/advance`, { ...postJson, body: '{}' });
    await advanceUntilDone(app, packageId, 40);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as { state: string };
    expect(['failed', 'preparing']).toContain(view.state);
    // It must never sit 'ready' with a deleted dependency; a later advance
    // settles it (failed is the steady state here).
    if (view.state === 'preparing') {
      await advanceUntilDone(app, packageId, 40);
      const view2 = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as { state: string };
      expect(view2.state).toBe('failed');
    }
  });

  it('rejects a folder or Google-native entry file at create (415)', async () => {
    const drive = buildDrive();
    drive.folders.get('root-1')!.push(folderEntry('dir-x', 'folder-as-entry'));
    drive.files.set('dir-x', {
      meta: { ...{ ...fileMeta('dir-x', 'folder-as-entry'), mimeType: 'application/vnd.google-apps.folder' } },
      bytes: '',
    });
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read: new FakeReadProvider(drive) });
    const res = await api(app, '/api/v1/media-packages', {
      ...postJson,
      body: JSON.stringify({ mountId: 'm-1', entryFileId: 'dir-x' }),
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PREVIEW_UNSUPPORTED');
  });

  it('serve-time drift marks the generation stale in every branch', async () => {
    const drive = buildDrive();
    const read = new FakeReadProvider(drive);
    const app = makeApp({ oauth: new FakeOAuthProvider(drive), read });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);
    // Playlist bytes changed refs without a marker change (unverifiable
    // mutation): the byPath-miss branch must still mark stale.
    read.contentOverrides.set('f-entry', '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nbrand-new.ts\n#EXT-X-ENDLIST\n');
    const res = await api(app, `/api/v1/media-packages/${packageId}/resources/r1`);
    expect(res.status).toBe(409);
    const view = (await (await api(app, `/api/v1/media-packages/${packageId}`)).json()) as { state: string };
    expect(view.state).toBe('preparing');
  });

  it('anonymous advance on a public mount is throttled per package+actor', async () => {
    let t = NOW;
    const deps: PackageRouterDeps = {
      resolveSessionActor: () => Promise.resolve(currentActor),
      oauthProvider: new FakeOAuthProvider(buildDrive()),
      readProvider: new FakeReadProvider(buildDrive()),
      now: () => t,
    };
    const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
    app.use('/api/*', async (c, next) => { c.set('requestId', 'req-test'); await next(); });
    app.route('/api/v1/media-packages', createPackageRouter(deps));
    await env.DB.prepare("UPDATE mounts SET visibility = 'public_read' WHERE id = 'm-1'").run();

    // Session user creates and indexes the package first (unthrottled).
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    await advanceUntilDone(app, packageId);

    currentActor = { kind: 'public' };
    const first = await api(app, `/api/v1/media-packages/${packageId}/advance`, { ...postJson, body: '{}' });
    expect(first.status).toBe(200);
    const second = await api(app, `/api/v1/media-packages/${packageId}/advance`, { ...postJson, body: '{}' });
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    t += 10_000;
    const third = await api(app, `/api/v1/media-packages/${packageId}/advance`, { ...postJson, body: '{}' });
    expect(third.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// My Drive folder mount (wave 7): the whole package pipeline under containment.
// Tree: my-root-1/root-1/{playlists, dir-clip, dir-audio, dir-subs}.
// ---------------------------------------------------------------------------

const MY_ROOT = 'my-root-1';

/** Drop the Shared Drive id from every file: My Drive files report none. */
function toMyDrive(drive: FixtureDrive): FixtureDrive {
  const files = new Map<string, { meta: DriveFileMeta; bytes: string }>();
  for (const [id, file] of drive.files) {
    const { driveId, ...rest } = file.meta;
    void driveId;
    files.set(id, { bytes: file.bytes, meta: rest });
  }
  return { folders: drive.folders, files };
}

function registerFolderMetas(oauth: FakeOAuthProvider) {
  const folder = (id: string, parent: string): DriveFileMeta => ({
    id,
    name: id,
    mimeType: 'application/vnd.google-apps.folder',
    trashed: false,
    parents: [parent],
    hasThumbnail: false,
  });
  oauth.metaOverrides.set('root-1', folder('root-1', MY_ROOT));
  for (const dir of ['dir-clip', 'dir-audio', 'dir-subs']) {
    oauth.metaOverrides.set(dir, folder(dir, 'root-1'));
  }
}

describe('media package in a My Drive folder mount', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "UPDATE mounts SET drive_id = NULL, root_folder_id = ? WHERE id = 'm-1'",
    )
      .bind(MY_ROOT)
      .run();
  });

  it('indexes, rewrites and serves a package; containment is proven for every resource', async () => {
    const oauth = new FakeOAuthProvider(toMyDrive(buildDrive()));
    registerFolderMetas(oauth);
    const read = new FakeReadProvider(toMyDrive(buildDrive()));
    const app = makeApp({ oauth, read });

    const created = await createPackage(app);
    expect(created.status).toBe(201);
    const { packageId } = (await created.json()) as { packageId: string };
    const done = await advanceUntilDone(app, packageId);
    expect(done.status).toBe(200);
    expect('state' in done.body && done.body.state).toBe('ready');

    // Folder listings carried the My Drive scope.
    expect(oauth.childrenCalls.length).toBeGreaterThan(0);
    for (const call of oauth.childrenCalls) {
      expect(call.scope).toEqual({ mountId: 'm-1', rootFolderId: MY_ROOT, driveId: null });
    }

    const master = await api(app, `/api/v1/media-packages/${packageId}/resources/r1`);
    expect(master.status).toBe(200);
    const masterText = await master.text();
    const variant = masterText.split('\n').find((l) => /^r\d+$/.test(l));
    expect(variant).toBeDefined();
    const media = await api(app, `/api/v1/media-packages/${packageId}/resources/${variant}`);
    expect(media.status).toBe(200);
    const segRef = (await media.text()).split('\n').find((l) => /^r\d+$/.test(l));
    const seg = await api(app, `/api/v1/media-packages/${packageId}/resources/${segRef}`);
    expect(seg.status).toBe(200);
    expect(await seg.text()).toBe('SEG0-VIDEO');
    // Ancestor proofs went through the OAuth fixture, bytes through the SA.
    expect(oauth.metadataCalls.map((c) => c.ref.id)).toContain('root-1');
    expect(read.calls.filter((c) => c.op === 'content').length).toBeGreaterThan(0);
  });

  it('refuses an entry playlist outside the tree at create (404, no package)', async () => {
    const oauth = new FakeOAuthProvider(toMyDrive(buildDrive()));
    registerFolderMetas(oauth);
    const entryMeta = oauth.drive.files.get('f-entry')!.meta;
    oauth.metaOverrides.set('f-entry', { ...entryMeta, parents: ['elsewhere-1'] });
    oauth.metaOverrides.set('elsewhere-1', {
      id: 'elsewhere-1',
      name: 'elsewhere-1',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      hasThumbnail: false,
    });
    const app = makeApp({ oauth, read: new FakeReadProvider(toMyDrive(buildDrive())) });
    const res = await createPackage(app);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FILE_NOT_ACCESSIBLE');
  });

  it('fails a re-index when the entry file has moved out of the tree (freshEntryContext containment)', async () => {
    const oauth = new FakeOAuthProvider(toMyDrive(buildDrive()));
    registerFolderMetas(oauth);
    const read = new FakeReadProvider(toMyDrive(buildDrive()));
    const app = makeApp({ oauth, read });
    const created = await createPackage(app);
    const { packageId } = (await created.json()) as { packageId: string };
    expect((await advanceUntilDone(app, packageId)).status).toBe(200);

    // Drift a dependency so the ready generation goes stale (as in the
    // Shared Drive re-index test), then move the entry out of the tree.
    const tsMeta = { ...oauth.drive.files.get('f-ts')!.meta, headRevisionId: 'rev-NEW' };
    oauth.metaOverrides.set('f-ts', tsMeta);
    read.metaOverrides.set('f-ts', tsMeta);
    const tsRow = await env.DB
      .prepare(
        "SELECT resource_id FROM media_package_resources WHERE package_id = ? AND index_generation = 1 AND path = 'media-ts.m3u8'",
      )
      .bind(packageId)
      .first<{ resource_id: string }>();
    const stale = await api(app, `/api/v1/media-packages/${packageId}/resources/${tsRow!.resource_id}`);
    expect(stale.status).toBe(409);

    const entryMeta = oauth.drive.files.get('f-entry')!.meta;
    oauth.metaOverrides.set('f-entry', { ...entryMeta, parents: ['elsewhere-1'] });
    oauth.metaOverrides.set('elsewhere-1', {
      id: 'elsewhere-1',
      name: 'elsewhere-1',
      mimeType: 'application/vnd.google-apps.folder',
      trashed: false,
      hasThumbnail: false,
    });
    // The containment cache still trusts root-1 for up to 60 s; the entry's
    // new parent was never cached, so the walk is fresh.
    const advanced = await advanceUntilDone(app, packageId, 5);
    expect(advanced.status).toBe(404);
    expect((advanced.body as { error: { code: string } }).error.code).toBe('FILE_NOT_ACCESSIBLE');
  });
});
