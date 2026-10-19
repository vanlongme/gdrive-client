/**
 * Wave 7 (spec 2026-10-18 §4.3): uploads, folder creates and batches into
 * a My Drive folder mount, plus the storageQuotaExceeded mapping on both
 * mount kinds. The UploadSession DO and D1 are real; only the Google
 * boundary is the scriptable upload fixture.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { DriveError } from '../../src/worker/drive/errors';
import {
  isInMount,
  resetContainmentCacheForTests,
  type MountScope,
  type ParentLookup,
} from '../../src/worker/drive/containment';
import type { DriveFileMeta, OAuthCatalogWriteProvider } from '../../src/worker/drive/types';
import { createUploadRouter } from '../../src/worker/transfers/upload-routes';
import { createFolderRouter } from '../../src/worker/transfers/folders';
import { createBatchRouter } from '../../src/worker/transfers/batches';
import {
  actorFor,
  api,
  defaultInput,
  fakeNow,
  fixtureProvider,
  metaFile,
  postAction,
  postInit,
  putChunk,
  resetState,
  seedBase,
  setNow,
  snapshot,
  TEST_MIGRATIONS,
  USER,
  type Handler,
  type UploadViewBody,
} from './upload-fixture';

const FOLDER = 'application/vnd.google-apps.folder';
const MY_MOUNT = 'mount-my';
const MY_ROOT = 'my-root';
const MY_PARENT = 'my-parent';
const OUTSIDE = 'outside-folder';
const ACCOUNT_ROOT = '0AMyDriveRoot';
const MY_SCOPE: MountScope = { mountId: MY_MOUNT, rootFolderId: MY_ROOT, driveId: null };
const MY_INPUT = { ...defaultInput, mountId: MY_MOUNT, parentId: MY_PARENT };

function myFolder(id: string, parents: string[], over: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return metaFile(id, {
    mimeType: FOLDER, driveId: undefined, parents, ownedByMe: true,
    capabilities: { canAddChildren: true, canTrash: true }, ...over,
  });
}

/** My Drive tree: ACCOUNT_ROOT > MY_ROOT (mount) > MY_PARENT; OUTSIDE is a sibling of MY_ROOT. */
function myMeta(id: string): DriveFileMeta {
  if (id === ACCOUNT_ROOT) return myFolder(id, []);
  if (id === MY_ROOT || id === OUTSIDE) return myFolder(id, [ACCOUNT_ROOT]);
  if (id === MY_PARENT) return myFolder(id, [MY_ROOT]);
  return metaFile(id, { driveId: undefined, parents: [MY_PARENT] });
}

const idOf = (input: Parameters<Handler>[0]): string => (input.ref as { id: string }).id;
const getMyMeta: Handler = (input) => myMeta(idOf(input));
/** getMetadata where the not-yet-created generated file is absent. */
const getMyMetaNoFile: Handler = (input) => {
  if (idOf(input) === 'gen-file-1') throw new DriveError('not-found', 'absent', {});
  return getMyMeta(input);
};
const sessionGone = (): never => {
  throw new DriveError('not-found', 'session gone', {});
};
const quotaError = (): never => {
  throw new DriveError('storage-full', 'quota', { status: 403, googleReasons: ['storageQuotaExceeded'] });
};

type Calls = ReturnType<typeof fixtureProvider>['calls'];
const metadataIds = (calls: Calls): string[] =>
  calls.filter((c) => c.method === 'getMetadata').map((c) => JSON.parse(c.detail ?? '{}').ref.id);

async function seedMyDriveMount(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
        "VALUES (?, 'Mine', NULL, ?, 'conn-1', 'conn-1', 1, 'private', 1, 0, 0)",
    ).bind(MY_MOUNT, MY_ROOT),
    env.DB.prepare(
      'INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) ' +
        "VALUES ('user-1', ?, 'uploader', '[\"read\",\"upload\"]', 'admin-1', 0, 0)",
    ).bind(MY_MOUNT),
  ]);
}

function makeApp(provider: OAuthCatalogWriteProvider) {
  const app = new Hono<{ Bindings: Env }>();
  const deps = {
    providerFor: () => provider,
    resolveActorFn: () => Promise.resolve(actorFor(USER)),
    now: () => fakeNow,
    leaseMs: 120_000,
  };
  app.route('/api/v1/uploads', createUploadRouter(deps));
  app.route('/api/v1/upload-batches', createBatchRouter(deps));
  app.route('/api/v1/folders', createFolderRouter(deps));
  return app;
}

type App = ReturnType<typeof makeApp>;

async function initUpload(app: App, key: string, input: Record<string, unknown> = MY_INPUT): Promise<UploadViewBody> {
  const res = await postInit(app, key, input);
  expect(res.status).toBe(200);
  return (await res.json()) as UploadViewBody;
}

async function sendChunk(app: App, view: UploadViewBody, generation = view.sessionGeneration): Promise<UploadViewBody> {
  const put = await putChunk(app, view.uploadId, generation, '0', new Uint8Array(6));
  return (await put.json()) as UploadViewBody;
}

function postJson(app: App, path: string, key: string, body: Record<string, unknown>): Promise<Response> {
  return api(app, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  setNow(1_700_000_000_000);
  resetContainmentCacheForTests();
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
  await seedBase();
  await seedMyDriveMount();
});

describe('My Drive folder mount uploads', () => {
  it('pins the mount scope and streams to verified completion', async () => {
    const { provider } = fixtureProvider({
      getMetadata: getMyMeta,
      putChunk: () => ({ kind: 'completed', file: myMeta('gen-file-1') }),
      verifyFile: () => myMeta('gen-file-1'),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'my-1');
    expect(view.state).toBe('uploading');
    expect((await snapshot(view.uploadId)).snapshot.pinned.mountScope).toEqual(MY_SCOPE);
    expect((await sendChunk(app, view)).state).toBe('completed');
  });

  it('blocks a destination outside the mount folder before any create', async () => {
    const { provider, calls } = fixtureProvider({ getMetadata: getMyMeta });
    const view = await initUpload(makeApp(provider), 'my-2', { ...MY_INPUT, parentId: OUTSIDE });
    expect(view.state).toBe('blocked');
    expect(calls.some((c) => c.method === 'startUpload')).toBe(false);
    // The walk went OUTSIDE -> ACCOUNT_ROOT (no parents) and stopped.
    expect(metadataIds(calls)).toEqual([OUTSIDE, ACCOUNT_ROOT]);
  });

  it('blocks a Shared Drive folder offered as the parent of a My Drive mount', async () => {
    const { provider, calls } = fixtureProvider({
      getMetadata: (input) =>
        idOf(input) === MY_PARENT ? myFolder(MY_PARENT, [MY_ROOT], { driveId: 'drive-1' }) : getMyMeta(input),
    });
    expect((await initUpload(makeApp(provider), 'my-3')).state).toBe('blocked');
    expect(calls.some((c) => c.method === 'startUpload')).toBe(false);
  });

  it('fails verification when the uploaded file reports a Shared Drive id', async () => {
    const { provider } = fixtureProvider({
      getMetadata: getMyMeta,
      putChunk: () => ({ kind: 'completed', file: myMeta('gen-file-1') }),
      verifyFile: () => metaFile('gen-file-1', { parents: [MY_PARENT], driveId: 'drive-1' }),
    });
    const app = makeApp(provider);
    expect((await sendChunk(app, await initUpload(app, 'my-4'))).state).toBe('conflict');
  });

  it('renews an expired session after probing the My Drive root folder', async () => {
    let sessions = 0;
    const { provider, calls } = fixtureProvider({
      putChunk: sessionGone,
      startUpload: () => {
        sessions += 1;
        return {
          kind: 'resumable',
          sessionUri: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=my${sessions}`,
          generatedFileId: 'gen-file-1',
        };
      },
      getMetadata: getMyMetaNoFile,
    });
    const app = makeApp(provider);
    const v = await sendChunk(app, await initUpload(app, 'my-5'), 1);
    expect(v.state).toBe('uploading');
    expect(v.sessionGeneration).toBe(2);
    expect(metadataIds(calls)).toContain(MY_ROOT);
  });

  it('blocks (never "absent") when the writer no longer owns the root folder', async () => {
    const { provider } = fixtureProvider({
      putChunk: sessionGone,
      getMetadata: (input) =>
        idOf(input) === MY_ROOT ? myFolder(MY_ROOT, [ACCOUNT_ROOT], { ownedByMe: false }) : getMyMetaNoFile(input),
    });
    const app = makeApp(provider);
    const v = await sendChunk(app, await initUpload(app, 'my-6'), 1);
    expect(v.state).toBe('blocked');
    expect(v.sessionGeneration).toBe(1);
  });

  it('cancel proves root access, finds nothing and lands cancelled', async () => {
    const { provider, calls } = fixtureProvider({ getMetadata: getMyMetaNoFile });
    const app = makeApp(provider);
    const cancel = await postAction(app, (await initUpload(app, 'my-7')).uploadId, 'cancel');
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as UploadViewBody).state).toBe('cancelled');
    expect(metadataIds(calls)).toContain(MY_ROOT);
  });

  it('creates a folder in the mount and drops any cached verdict for its id', async () => {
    // An earlier request for the not-yet-created id cached it as "outside".
    const missing: ParentLookup = async (id) => {
      throw new DriveError('not-found', id, { status: 404 });
    };
    const child = { id: 'child', parents: ['gen-file-1'] };
    expect(await isInMount(MY_SCOPE, child, missing)).toBe(false);

    const created = myFolder('gen-file-1', [MY_PARENT]);
    const metaOf = (id: string) => (id === 'gen-file-1' ? created : myMeta(id));
    const { provider } = fixtureProvider({
      getMetadata: (input) => metaOf(idOf(input)),
      createFolder: () => created,
      verifyFile: () => created,
    });
    const res = await postJson(makeApp(provider), '/api/v1/folders', 'my-folder-1', {
      mountId: MY_MOUNT,
      parentId: MY_PARENT,
      name: 'Album',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { driveFileId?: string }).driveFileId).toBe('gen-file-1');

    const lookups: string[] = [];
    const live: ParentLookup = async (id) => {
      lookups.push(id);
      return { id, parents: metaOf(id).parents ?? [] };
    };
    expect(await isInMount(MY_SCOPE, child, live)).toBe(true);
    expect(lookups[0]).toBe('gen-file-1');
  });

  it('admits a batch rooted inside the folder and rejects one rooted outside', async () => {
    const app = makeApp(fixtureProvider({ getMetadata: getMyMeta }).provider);
    const batch = (key: string, rootParentId: string) =>
      postJson(app, '/api/v1/upload-batches', key, { mountId: MY_MOUNT, rootParentId });
    expect((await batch('my-b1', MY_PARENT)).status).toBe(200);
    expect((await batch('my-b2', OUTSIDE)).status).toBe(400);
  });
});

describe('storageQuotaExceeded maps to upload:quota_exceeded', () => {
  it.each([
    ['My Drive folder mount', MY_INPUT, getMyMeta],
    ['Shared Drive mount', defaultInput, undefined],
  ] as const)('on a %s chunk', async (_label, input, getMetadata) => {
    const { provider } = fixtureProvider({
      ...(getMetadata === undefined ? {} : { getMetadata }),
      putChunk: quotaError,
    });
    const app = makeApp(provider);
    const view = await initUpload(app, `quota-${input.mountId}`, input);
    expect((await sendChunk(app, view)).state).toBe('blocked');
    expect((await snapshot(view.uploadId)).snapshot.blockReason).toBe('upload:quota_exceeded');
    const row = await env.DB.prepare('SELECT summary FROM upload_operations WHERE id = ?')
      .bind(view.uploadId)
      .first<{ summary: string }>();
    expect(JSON.parse(row?.summary ?? '{}').blockReason).toBe('upload:quota_exceeded');
  });

  it('on a My Drive session start', async () => {
    const { provider } = fixtureProvider({ getMetadata: getMyMeta, startUpload: quotaError });
    const view = await initUpload(makeApp(provider), 'quota-start');
    expect(view.state).toBe('blocked');
    expect((await snapshot(view.uploadId)).snapshot.blockReason).toBe('upload:quota_exceeded');
  });
});
