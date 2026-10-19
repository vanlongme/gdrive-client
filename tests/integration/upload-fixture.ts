/**
 * Shared harness for upload integration tests (T07/T08): deterministic
 * clock, scriptable OAuth provider fixture, app router wiring, D1 seeding
 * and DO stub helpers. The UploadSession Durable Object under test is the
 * real miniflare binding; only the Google boundary is faked.
 */

import { env } from 'cloudflare:workers';
import { type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import type {
  CatalogPage,
  CreateFolderInput,
  DriveFileMeta,
  GenerateIdInput,
  GetMetadataInput,
  ListChildrenInput,
  OAuthCatalogWriteProvider,
  ProbeUploadInput,
  PutChunkInput,
  ResolvedWriter,
  SearchFilesInput,
  StartUploadInput,
  TrashFileInput,
  UploadProgressResult,
  UploadStart,
  VerifyFileInput,
} from '../../src/worker/drive/types';
import {
  createUploadRouter,
  type UploadRouterDeps,
} from '../../src/worker/transfers/upload-routes';
import { DO_ORIGIN } from '../../src/worker/transfers/upload-internal';
import type { Actor } from '../../src/worker/auth/grants';
import type { UploadSessionSnapshot } from '../../src/worker/transfers/upload-internal';

export const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

export const ORIGIN = 'http://worker.test';
export const SHA256 = 'a'.repeat(64);
export const MD5 = 'b'.repeat(32);

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

export let fakeNow = 1_700_000_000_000;
export function setNow(ms: number): void {
  fakeNow = ms;
}

// ---------------------------------------------------------------------------
// Fixture provider
// ---------------------------------------------------------------------------

export interface ProviderCall {
  method: string;
  writerConnectionId: string;
  detail?: string;
}

export type Handler = (input: Record<string, unknown>) => unknown;

export function metaFile(
  id: string,
  overrides: Partial<DriveFileMeta> = {},
): DriveFileMeta {
  return {
    id,
    name: 'file.bin',
    mimeType: 'application/octet-stream',
    size: '6' as DriveFileMeta['size'],
    trashed: false,
    parents: ['parent-1'],
    driveId: 'drive-1',
    sha256Checksum: SHA256,
    md5Checksum: MD5,
    hasThumbnail: false,
    capabilities: { canTrash: true },
    ...overrides,
  };
}

/**
 * Default metadata shape: the pinned parent and drive are proven-writable
 * folders so plain inits pass the R9 destination check. Overrides that
 * replace getMetadata should delegate to this for parent/drive IDs.
 */
export function defaultMeta(id: string): DriveFileMeta {
  if (id === 'parent-1' || id === 'drive-1') {
    return metaFile(id, {
      mimeType: 'application/vnd.google-apps.folder',
      driveId: 'drive-1',
      capabilities: { canAddChildren: true, canTrash: true },
    });
  }
  return metaFile(id);
}

export function fixtureProvider(
  handlers: Partial<Record<string, Handler>> = {},
): { provider: OAuthCatalogWriteProvider; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const record =
    <I, O>(method: string, fn: (input: I) => O | Promise<O>) =>
    async (input: I): Promise<O> => {
      const writer = (input as { writer?: ResolvedWriter }).writer;
      calls.push({
        method,
        writerConnectionId: writer?.connectionId ?? 'none',
        detail: JSON.stringify(input, (_k, v: unknown) =>
          typeof v === 'bigint' ? `${v}n` : v,
        ).slice(0, 400),
      });
      const handler = handlers[method];
      if (handler !== undefined) {
        return (await handler(
          input as unknown as Record<string, unknown>,
        )) as O;
      }
      return fn(input);
    };

  const provider: OAuthCatalogWriteProvider = {
    listChildren: record<ListChildrenInput, CatalogPage>(
      'listChildren',
      () => ({ entries: [] }),
    ),
    search: record<SearchFilesInput, CatalogPage>('search', () => ({
      entries: [],
    })),
    getMetadata: record<GetMetadataInput, DriveFileMeta>(
      'getMetadata',
      (input) => defaultMeta(input.ref.id),
    ),
    generateId: record<GenerateIdInput, string>('generateId', () =>
      'gen-file-1',
    ),
    createFolder: record<CreateFolderInput, DriveFileMeta>(
      'createFolder',
      () => metaFile('folder-1'),
    ),
    startUpload: record<StartUploadInput, UploadStart>('startUpload', () => ({
      kind: 'resumable',
      sessionUri:
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1',
      generatedFileId: 'gen-file-1',
    })),
    putChunk: record<PutChunkInput, UploadProgressResult>('putChunk', () => ({
      kind: 'incomplete',
      confirmedOffset: 0n,
    })),
    probeUpload: record<ProbeUploadInput, UploadProgressResult>(
      'probeUpload',
      () => ({ kind: 'incomplete', confirmedOffset: 0n }),
    ),
    verifyFile: record<VerifyFileInput, DriveFileMeta>(
      'verifyFile',
      (input) => metaFile(input.ref.id),
    ),
    trashFile: record<TrashFileInput, void>('trashFile', () => undefined),
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// App + D1 harness
// ---------------------------------------------------------------------------

export const USER = { id: 'user-1', role: 'user' as const };
export const ADMIN = { id: 'admin-1', role: 'admin' as const };

export function actorFor(user: typeof USER | typeof ADMIN): Actor {
  return {
    kind: 'user',
    user: {
      id: user.id,
      name: user.id,
      email: `${user.id}@test`,
      role: user.role,
      disabled: false,
      createdAt: new Date(0).toISOString(),
    },
    sessionId: `sess-${user.id}`,
  };
}

export function makeApp(
  provider: OAuthCatalogWriteProvider,
  actor: Actor = actorFor(USER),
  opts: {
    chunkSizeBytes?: number;
    readProviderFor?: (env: Env) => unknown;
  } = {},
) {
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    '/api/v1/uploads',
    createUploadRouter({
      providerFor: () => provider,
      resolveActorFn: () => Promise.resolve(actor),
      now: () => fakeNow,
      leaseMs: 120_000,
      ...(opts.chunkSizeBytes === undefined
        ? {}
        : { chunkSizeBytes: opts.chunkSizeBytes }),
      ...(opts.readProviderFor === undefined
        ? {}
        : {
            readProviderFor:
              opts.readProviderFor as UploadRouterDeps['readProviderFor'],
          }),
    }),
  );
  return app;
}

export function api(
  app: Hono<{ Bindings: Env }>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`${ORIGIN}${path}`, init), env as unknown as Env),
  );
}

export const defaultInput = {
  mountId: 'mount-1',
  parentId: 'parent-1',
  name: 'file.bin',
  mimeType: 'application/octet-stream',
  totalBytes: '6',
  sha256: SHA256,
  md5: MD5,
};

export function postInit(
  app: Hono<{ Bindings: Env }>,
  key: string,
  input: Record<string, unknown> = defaultInput,
) {
  return api(app, '/api/v1/uploads', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(input),
  });
}

export function putChunk(
  app: Hono<{ Bindings: Env }>,
  uploadId: string,
  generation: number,
  offset: string,
  bytes: Uint8Array,
) {
  return api(app, `/api/v1/uploads/${uploadId}/chunks?generation=${generation}&offset=${offset}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.byteLength),
    },
    body: bytes as unknown as BodyInit,
  });
}

export function postAction(
  app: Hono<{ Bindings: Env }>,
  uploadId: string,
  action: 'reconcile' | 'pause' | 'resume' | 'cancel',
) {
  return api(app, `/api/v1/uploads/${uploadId}/${action}`, { method: 'POST' });
}

export async function seedBase() {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) VALUES (1, 'install-1', 'complete', 'https://app.test', 1, 0, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', 'U', 'u@test', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('admin-1', 'A', 'a@test', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('client-1', 'proj-1', 'cid', 'env', 'https://app.test/cb', 1, 1, 0, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-1', 'client-1', 'perm-1', 'w@test', NULL, '', 'connected', 1, 1, 'admin-1', 0, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('mount-1', 'M', 'drive-1', 'drive-1', 'conn-1', 'conn-1', 1, 'private', 1, 0, 0)",
  ).run();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES ('user-1', 'mount-1', 'uploader', '[\"read\",\"upload\"]', 'admin-1', 0, 0)",
  ).run();
}

export async function resetState() {
  // Children before parents — FK order. `user`/`app_settings` are seeded
  // via INSERT OR REPLACE and left alone (auth tables reference user).
  for (const table of [
    'mount_drive_permissions',
    'upload_batch_nodes',
    'upload_batches',
    'upload_operations',
    'file_readiness',
    'mount_read_credentials',
    'mount_grants',
    'containment_verdicts',
    'mounts',
    'google_connections',
    'oauth_transactions',
    'google_oauth_clients',
    'service_accounts',
  ]) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
}

export function stub(uploadId: string) {
  return env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName(uploadId));
}

export async function snapshot(uploadId: string) {
  const res = await stub(uploadId).fetch(`${DO_ORIGIN}/snapshot`);
  return (await res.json()) as {
    ok: boolean;
    snapshot: UploadSessionSnapshot;
    directive: { kind: string };
  };
}

export async function doPost(
  uploadId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return stub(uploadId).fetch(`${DO_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface UploadViewBody {
  uploadId: string;
  state: string;
  sessionGeneration: number;
  confirmedOffset: string;
  totalBytes: string;
  chunkSize: number;
  readerAccessState: string;
}
