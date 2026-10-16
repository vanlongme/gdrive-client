/**
 * T10 integration tests: upload-batch create/get/nodes/seal, metadata-only
 * folder create and the durable nodeId → Drive ID mapping (spec §6.6,
 * wave-4 contract B). Provider outcomes are deterministic fixtures; the
 * UploadSession DO and D1 index are real.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DriveError } from '../../src/worker/drive/errors';
import { FOLDER_MIME_TYPE } from '../../src/worker/drive/providers/common';
import type { DriveFileMeta } from '../../src/worker/drive/types';
import { createBatchRouter } from '../../src/worker/transfers/batches';
import { createFolderRouter } from '../../src/worker/transfers/folders';
import { createUploadRouter } from '../../src/worker/transfers/upload-routes';
import { canonicalPlanDigest } from '../../src/shared/contracts/uploads';
import {
  actorFor,
  api,
  defaultInput,
  defaultMeta,
  fakeNow,
  ORIGIN,
  fixtureProvider,
  metaFile,
  resetState,
  seedBase,
  setNow,
  TEST_MIGRATIONS,
  USER,
  type Handler,
} from './upload-fixture';
import type { Actor } from '../../src/worker/auth/grants';

beforeEach(async () => {
  setNow(1_700_000_000_000);
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  // FK-safe cleanup order for batch leftovers: nodes reference ops and
  // batches, ops reference batches — delete children before parents so the
  // shared resetState order (nodes → batches → ops) can finish cleanly.
  await env.DB.prepare('DELETE FROM upload_batch_nodes').run();
  await env.DB.prepare('DELETE FROM upload_operations').run();
  // The creation gate must never leak between tests.
  await env.DB.prepare('DELETE FROM maintenance_state').run();
  await resetState();
  await seedBase();
});

afterAll(async () => {
  await env.DB.prepare('DELETE FROM upload_batch_nodes').run();
  await env.DB.prepare('DELETE FROM upload_operations').run();
  await env.DB.prepare('DELETE FROM upload_batches').run();
});

const BATCH_INPUT = { mountId: 'mount-1', rootParentId: 'parent-1' };

/**
 * Deterministic provider for folder trees: each generateId mints a fresh
 * ID, created folders/files are tracked so parent proofs, verify and
 * lookups see consistent metadata.
 */
function treeProvider(extra: Partial<Record<string, Handler>> = {}) {
  let gen = 0;
  const folders = new Map<string, DriveFileMeta>();
  const files = new Map<string, { parent: string; size: string }>();
  const { provider, calls } = fixtureProvider({
    generateId: () => `gen-${++gen}`,
    getMetadata: (input) => {
      const id = (input.ref as { id: string }).id;
      const folder = folders.get(id);
      if (folder !== undefined) return folder;
      const f = files.get(id);
      if (f !== undefined) {
        return metaFile(id, { parents: [f.parent], size: f.size });
      }
      // Generated IDs that never landed upstream read as absent — a real
      // Drive answers 404, never an invented file.
      if (id.startsWith('gen-')) {
        throw new DriveError('not-found', 'absent', {});
      }
      return defaultMeta(id);
    },
    createFolder: (input) => {
      const meta = metaFile(input.generatedId as string, {
        name: input.name as string,
        mimeType: FOLDER_MIME_TYPE,
        parents: [input.parentFolderId as string],
        size: '0',
        capabilities: { canAddChildren: true, canTrash: true },
      });
      folders.set(meta.id, meta);
      return meta;
    },
    startUpload: (input) => {
      const id = input.generatedFileId as string;
      files.set(id, {
        parent: input.parentFolderId as string,
        size: (input.totalBytes as bigint).toString(10),
      });
      return {
        kind: 'resumable',
        sessionUri: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s-${id}`,
        generatedFileId: id,
      };
    },
    putChunk: (input) => {
      const uri = input.sessionUri as string;
      const id = uri.split('upload_id=s-')[1] ?? 'unknown';
      const end = (input.offset as bigint) + BigInt(input.chunkBytes as number);
      if (end >= (input.totalBytes as bigint)) {
        const f = files.get(id);
        return {
          kind: 'completed',
          file: metaFile(id, {
            parents: f === undefined ? ['parent-1'] : [f.parent],
            size: f?.size ?? '6',
          }),
        };
      }
      return { kind: 'incomplete', confirmedOffset: end };
    },
    verifyFile: (input) => {
      const id = (input.ref as { id: string }).id;
      const f = files.get(id);
      return metaFile(id, {
        parents: f === undefined ? ['parent-1'] : [f.parent],
        size: f?.size ?? '6',
      });
    },
    ...extra,
  });
  return { provider, calls, folders, files };
}

function makeApp(provider: ReturnType<typeof treeProvider>['provider'], actor: Actor = actorFor(USER)) {
  const app = new Hono<{ Bindings: Env }>();
  const deps = {
    providerFor: () => provider,
    resolveActorFn: () => Promise.resolve(actor),
    now: () => fakeNow,
    leaseMs: 120_000,
  };
  app.route('/api/v1/uploads', createUploadRouter(deps));
  app.route('/api/v1/upload-batches', createBatchRouter(deps));
  app.route('/api/v1/folders', createFolderRouter(deps));
  return app;
}

interface BatchViewBody {
  batchId: string;
  state: string;
  planVersion: number;
  sealedAt?: string;
  planHash?: string;
  nodes: Array<{
    nodeId: string;
    parentNodeId: string | null;
    kind: string;
    displayName: string;
    mimeType?: string;
    totalBytes?: string;
    state: string;
    driveFileId?: string;
    uploadId?: string;
  }>;
  nextCursor?: string;
}

function postBatch(app: Hono<{ Bindings: Env }>, key = 'b1') {
  return api(app, '/api/v1/upload-batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(BATCH_INPUT),
  });
}

function getBatch(app: Hono<{ Bindings: Env }>, id: string, query = '') {
  return api(app, `/api/v1/upload-batches/${id}${query}`);
}

function postNodes(
  app: Hono<{ Bindings: Env }>,
  id: string,
  planVersion: number,
  nodes: Record<string, unknown>[],
) {
  return api(app, `/api/v1/upload-batches/${id}/nodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planVersion, nodes }),
  });
}

function postSeal(app: Hono<{ Bindings: Env }>, id: string, body?: unknown) {
  return api(app, `/api/v1/upload-batches/${id}/seal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}

function postFolder(
  app: Hono<{ Bindings: Env }>,
  input: Record<string, unknown>,
  key?: string,
) {
  return api(app, '/api/v1/folders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(input),
  });
}

function postUpload(
  app: Hono<{ Bindings: Env }>,
  input: Record<string, unknown>,
  key?: string,
) {
  return api(app, '/api/v1/uploads', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(input),
  });
}

function putChunk(
  app: Hono<{ Bindings: Env }>,
  uploadId: string,
  generation: number,
  offset: string,
  bytes: Uint8Array,
) {
  return api(
    app,
    `/api/v1/uploads/${uploadId}/chunks?generation=${generation}&offset=${offset}`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      },
      body: bytes as unknown as BodyInit,
    },
  );
}

const fnode = (
  nodeId: string,
  parentNodeId: string | null,
  displayName: string,
) => ({ nodeId, parentNodeId, kind: 'folder', displayName });

const filenode = (
  nodeId: string,
  parentNodeId: string | null,
  displayName: string,
  totalBytes = '6',
) => ({
  nodeId,
  parentNodeId,
  kind: 'file',
  displayName,
  mimeType: 'application/octet-stream',
  totalBytes,
});

const fileInput = (parentId: string, batchId: string, nodeId: string) => ({
  ...defaultInput,
  parentId,
  batchId,
  nodeId,
});

function nodeOf(view: BatchViewBody, nodeId: string) {
  const node = view.nodes.find((n) => n.nodeId === nodeId);
  expect(node, `node ${nodeId} missing`).toBeDefined();
  return node!;
}

async function createSealedBatch(
  app: Hono<{ Bindings: Env }>,
  nodes: Record<string, unknown>[],
): Promise<BatchViewBody> {
  const create = await postBatch(app);
  expect(create.status).toBe(200);
  const batch = (await create.json()) as BatchViewBody;
  const appended = await postNodes(app, batch.batchId, 0, nodes);
  expect(appended.status).toBe(200);
  const sealed = await postSeal(app, batch.batchId);
  expect(sealed.status).toBe(200);
  return (await sealed.json()) as BatchViewBody;
}

// ---------------------------------------------------------------------------
// Batch create + idempotency
// ---------------------------------------------------------------------------

describe('POST /upload-batches', () => {
  it('creates a draft batch and replays idempotently', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const first = await postBatch(app, 'k1');
    expect(first.status).toBe(200);
    const a = (await first.json()) as BatchViewBody;
    expect(a.state).toBe('draft');
    expect(a.planVersion).toBe(0);
    expect(a.nodes).toEqual([]);

    const replay = await postBatch(app, 'k1');
    expect(replay.status).toBe(200);
    const b = (await replay.json()) as BatchViewBody;
    expect(b.batchId).toBe(a.batchId);

    const other = await postBatch(app, 'k2');
    expect(other.status).toBe(200);
    expect(((await other.json()) as BatchViewBody).batchId).not.toBe(a.batchId);
  });

  it('rejects the same key with a different input and missing keys', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    await postBatch(app, 'k1');
    const conflict = await api(app, '/api/v1/upload-batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      body: JSON.stringify({ mountId: 'mount-1', rootParentId: 'other' }),
    });
    expect(conflict.status).toBe(409);
    const noKey = await api(app, '/api/v1/upload-batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BATCH_INPUT),
    });
    expect(noKey.status).toBe(400);
  });

  it('refuses an unwritable destination before admitting a batch', async () => {
    const { provider } = treeProvider({
      getMetadata: () => {
        throw new DriveError('not-found', 'absent', {});
      },
    });
    const app = makeApp(provider);
    const res = await postBatch(app);
    expect(res.status).toBe(404);
  });

  it('is invisible to a non-owner', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = (await (await postBatch(app)).json()) as BatchViewBody;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-2', 'V', 'v@test', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES ('user-2', 'mount-1', 'uploader', '[\"read\",\"upload\"]', 'admin-1', 0, 0)",
    ).run();
    const foreign = makeApp(provider, actorFor({
      id: 'user-2',
      role: 'user' as const,
    }));
    expect((await getBatch(foreign, batch.batchId)).status).toBe(404);
    const op = await postFolder(foreign, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'x',
      batchId: batch.batchId,
      nodeId: 'n1',
    });
    expect(op.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Node append: bounded pages, version CAS, idempotent merge
// ---------------------------------------------------------------------------

describe('POST /upload-batches/:b/nodes', () => {
  async function draftApp() {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = (await (await postBatch(app)).json()) as BatchViewBody;
    return { app, batch, provider };
  }

  it('appends bounded pages with planVersion CAS', async () => {
    const { app, batch } = await draftApp();
    const p0 = await postNodes(app, batch.batchId, 0, [
      fnode('nA', null, 'a'),
      filenode('f1', 'nA', 'one.bin'),
    ]);
    expect(p0.status).toBe(200);
    const p1 = await postNodes(app, batch.batchId, 1, [
      filenode('f2', 'nA', 'two.bin'),
    ]);
    expect(p1.status).toBe(200);
    const view = (await p1.json()) as BatchViewBody;
    expect(view.planVersion).toBe(2);
    expect(view.nodes).toHaveLength(3);
    expect(view.state).toBe('draft');
  });

  it('rejects a stale planVersion but replays a committed page', async () => {
    const { app, batch } = await draftApp();
    await postNodes(app, batch.batchId, 0, [fnode('nA', null, 'a')]);
    const stale = await postNodes(app, batch.batchId, 0, [
      filenode('f1', 'nA', 'one.bin'),
    ]);
    expect(stale.status).toBe(409);
    // Exact replay of the committed page answers 200 (idempotent).
    const replay = await postNodes(app, batch.batchId, 0, [
      fnode('nA', null, 'a'),
    ]);
    expect(replay.status).toBe(200);
  });

  it('merges repeated nodes idempotently and conflicts on changed content', async () => {
    const { app, batch } = await draftApp();
    await postNodes(app, batch.batchId, 0, [fnode('nA', null, 'a')]);
    // Same nodeId + identical content in a later page is a no-op merge.
    const merged = await postNodes(app, batch.batchId, 1, [
      fnode('nA', null, 'a'),
      filenode('f1', 'nA', 'one.bin'),
    ]);
    expect(merged.status).toBe(200);
    const changed = await postNodes(app, batch.batchId, 2, [
      fnode('nA', null, 'renamed'),
    ]);
    expect(changed.status).toBe(409);
    const dupInPage = await postNodes(app, batch.batchId, 2, [
      filenode('f9', 'nA', 'x.bin'),
      filenode('f9', 'nA', 'y.bin'),
    ]);
    expect(dupInPage.status).toBe(400);
  });

  it('rejects missing, foreign, cyclic and non-folder parents', async () => {
    const { app, batch } = await draftApp();
    const ghost = await postNodes(app, batch.batchId, 0, [
      filenode('f1', 'ghost', 'one.bin'),
    ]);
    expect(ghost.status).toBe(400);
    const selfParent = await postNodes(app, batch.batchId, 0, [
      fnode('nS', 'nS', 'self'),
    ]);
    expect(selfParent.status).toBe(400);
    const forwardRef = await postNodes(app, batch.batchId, 0, [
      filenode('f1', 'nB', 'one.bin'),
      fnode('nB', null, 'b'),
    ]);
    expect(forwardRef.status).toBe(400);
    const fileParent = await postNodes(app, batch.batchId, 0, [
      filenode('f1', null, 'one.bin'),
      filenode('f2', 'f1', 'two.bin'),
    ]);
    expect(fileParent.status).toBe(400);

    // A parent in a DIFFERENT batch is foreign — never reachable.
    const other = (await (await postBatch(app, 'b2')).json()) as BatchViewBody;
    await postNodes(app, other.batchId, 0, [fnode('ext', null, 'ext')]);
    const foreign = await postNodes(app, batch.batchId, 0, [
      filenode('f1', 'ext', 'one.bin'),
    ]);
    expect(foreign.status).toBe(400);
  });

  it('requires mimeType/totalBytes on file nodes and bounded page size', async () => {
    const { app, batch } = await draftApp();
    const badFile = await postNodes(app, batch.batchId, 0, [
      { nodeId: 'f1', parentNodeId: null, kind: 'file', displayName: 'x' },
    ]);
    expect(badFile.status).toBe(400);
    const tooBig = await postNodes(
      app,
      batch.batchId,
      0,
      Array.from({ length: 501 }, (_, i) => fnode(`n${i}`, null, `f${i}`)),
    );
    expect(tooBig.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

describe('POST /upload-batches/:b/seal', () => {
  it('rejects sealing an empty plan and sealing is idempotent', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = (await (await postBatch(app)).json()) as BatchViewBody;
    expect((await postSeal(app, batch.batchId)).status).toBe(400);
    await postNodes(app, batch.batchId, 0, [fnode('nA', null, 'a')]);
    const sealed = await postSeal(app, batch.batchId);
    expect(sealed.status).toBe(200);
    const view = (await sealed.json()) as BatchViewBody;
    expect(view.state).toBe('sealed');
    expect(view.sealedAt).toBeDefined();
    expect(view.planHash).toMatch(/^[0-9a-f]{64}$/);
    // Replay answers the same sealed view.
    const again = await postSeal(app, batch.batchId);
    expect(again.status).toBe(200);
    expect(((await again.json()) as BatchViewBody).planHash).toBe(view.planHash);
  });

  it('rejects a changed plan digest or version at seal', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = (await (await postBatch(app)).json()) as BatchViewBody;
    await postNodes(app, batch.batchId, 0, [
      fnode('nA', null, 'a'),
      filenode('f1', 'nA', 'one.bin'),
    ]);
    const wrongHash = await postSeal(app, batch.batchId, {
      planHash: '0'.repeat(64),
    });
    expect(wrongHash.status).toBe(409);
    const wrongVersion = await postSeal(app, batch.batchId, { planVersion: 5 });
    expect(wrongVersion.status).toBe(409);
    // The matching digest (client planner's) seals cleanly.
    const digest = await canonicalPlanDigest([
      fnode('nA', null, 'a') as never,
      filenode('f1', 'nA', 'one.bin') as never,
    ]);
    const ok = await postSeal(app, batch.batchId, { planHash: digest });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as BatchViewBody).planHash).toBe(digest);
  });

  it('refuses node appends and node operations once sealed', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = await createSealedBatch(app, [fnode('nA', null, 'a')]);
    const append = await postNodes(app, batch.batchId, 1, [
      filenode('f2', 'nA', 'two.bin'),
    ]);
    expect(append.status).toBe(409);
    // And a draft batch never admits operations before seal.
    const draft = (await (await postBatch(app, 'b2')).json()) as BatchViewBody;
    await postNodes(app, draft.batchId, 0, [fnode('nD', null, 'd')]);
    const op = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'd',
      batchId: draft.batchId,
      nodeId: 'nD',
    });
    expect(op.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Node paging
// ---------------------------------------------------------------------------

describe('GET /upload-batches/:b', () => {
  it('pages nodes with a bounded cursor', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = (await (await postBatch(app)).json()) as BatchViewBody;
    await postNodes(app, batch.batchId, 0, [
      fnode('nA', null, 'a'),
      fnode('nB', 'nA', 'b'),
      filenode('f1', 'nB', 'x.bin'),
    ]);
    const first = (await (
      await getBatch(app, batch.batchId, '?limit=2')
    ).json()) as BatchViewBody;
    expect(first.nodes).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const rest = (await (
      await getBatch(
        app,
        batch.batchId,
        `?limit=2&cursor=${first.nextCursor}`,
      )
    ).json()) as BatchViewBody;
    expect(rest.nodes).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    expect((await getBatch(app, batch.batchId, '?limit=0')).status).toBe(400);
    expect((await getBatch(app, batch.batchId, '?limit=501')).status).toBe(400);
    expect(
      (await getBatch(app, batch.batchId, '?cursor=abc')).status,
    ).toBe(400);
    expect((await getBatch(app, 'missing-batch')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Folder create — metadata only, generated ID, OAuth writer
// ---------------------------------------------------------------------------

describe('POST /folders', () => {
  it('creates a folder metadata-only via the pinned OAuth writer', async () => {
    const { provider, calls } = treeProvider();
    const app = makeApp(provider);
    const res = await postFolder(
      app,
      { mountId: 'mount-1', parentId: 'parent-1', name: 'New Folder' },
      'fkey-1',
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      uploadId: string;
      state: string;
      confirmedOffset: string;
      totalBytes: string;
      driveFileId?: string;
    };
    expect(view.state).toBe('completed');
    expect(view.confirmedOffset).toBe('0');
    expect(view.totalBytes).toBe('0');
    expect(view.driveFileId).toBe('gen-1');

    const methods = calls.map((c) => c.method);
    // Metadata-only: generate ID → destination proof → create. No session.
    expect(methods).toContain('generateId');
    expect(methods).toContain('createFolder');
    expect(methods).not.toContain('startUpload');
    expect(methods).not.toContain('putChunk');
    expect(methods).not.toContain('probeUpload');
    // Every remote call used the pinned mount write connection.
    for (const c of calls) expect(c.writerConnectionId).toBe('conn-1');
  });

  it('replays idempotently and conflicts on changed input', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const first = await postFolder(
      app,
      { mountId: 'mount-1', parentId: 'parent-1', name: 'A' },
      'fkey-1',
    );
    const a = (await first.json()) as { uploadId: string; driveFileId?: string };
    const replay = await postFolder(
      app,
      { mountId: 'mount-1', parentId: 'parent-1', name: 'A' },
      'fkey-1',
    );
    const b = (await replay.json()) as { uploadId: string; driveFileId?: string };
    expect(replay.status).toBe(200);
    expect(b.uploadId).toBe(a.uploadId);
    expect(b.driveFileId).toBe(a.driveFileId);
    const conflict = await postFolder(
      app,
      { mountId: 'mount-1', parentId: 'parent-1', name: 'B' },
      'fkey-1',
    );
    expect(conflict.status).toBe(409);
    const noKey = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'C',
    });
    expect(noKey.status).toBe(400);
  });

  it('reconciles a dropped create response by generated ID, never by name', async () => {
    // Every create "lands" upstream but its response is lost — the app
    // must recover by looking up the pinned generated ID, never by
    // searching for a same-named folder.
    const { provider, calls, folders } = treeProvider({
      createFolder: (input) => {
        const meta = metaFile(input.generatedId as string, {
          name: input.name as string,
          mimeType: FOLDER_MIME_TYPE,
          parents: [input.parentFolderId as string],
          size: '0',
          capabilities: { canAddChildren: true, canTrash: true },
        });
        folders.set(meta.id, meta);
        throw new DriveError('unexpected-response', 'lost response', {});
      },
    });
    const app = makeApp(provider);
    const res = await postFolder(
      app,
      { mountId: 'mount-1', parentId: 'parent-1', name: 'Lost' },
      'fkey-9',
    );
    const view = (await res.json()) as {
      state: string;
      driveFileId?: string;
    };
    expect(view.state).toBe('completed');
    expect(view.driveFileId).toBe('gen-1');
    // Recovery happened via a generated-ID read, never a name search.
    expect(
      calls.some(
        (c) => c.method === 'getMetadata' && c.detail?.includes('gen-1'),
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.method === 'search' || c.method === 'listChildren'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batch execution: mapping, scheduling, partial failure
// ---------------------------------------------------------------------------

describe('batch execution', () => {
  const PLAN = [
    fnode('nRoot', null, 'root'),
    fnode('nSub', 'nRoot', 'sub'),
    filenode('fSub', 'nSub', 'in-sub.bin'),
    filenode('fRoot', 'nRoot', 'top.bin'),
  ];

  it('confirms the parent mapping before any child operation', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = await createSealedBatch(app, PLAN);

    // Child of an unconfirmed parent cannot be scheduled.
    const early = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'gen-1',
      name: 'sub',
      batchId: batch.batchId,
      nodeId: 'nSub',
    });
    expect(early.status).toBe(409);

    const root = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'root',
      batchId: batch.batchId,
      nodeId: 'nRoot',
    });
    expect(root.status).toBe(200);
    const rootView = (await root.json()) as { driveFileId?: string };
    expect(rootView.driveFileId).toBe('gen-1');

    const after = (await (
      await getBatch(app, batch.batchId)
    ).json()) as BatchViewBody;
    expect(after.state).toBe('executing');
    expect(nodeOf(after, 'nRoot').state).toBe('completed');
    expect(nodeOf(after, 'nRoot').driveFileId).toBe('gen-1');
    expect(nodeOf(after, 'nSub').state).toBe('pending');

    // Wrong parent claim is refused — only the confirmed mapping is legal.
    const wrongParent = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'sub',
      batchId: batch.batchId,
      nodeId: 'nSub',
    });
    expect(wrongParent.status).toBe(400);

    const sub = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'gen-1',
      name: 'sub',
      batchId: batch.batchId,
      nodeId: 'nSub',
    });
    expect(sub.status).toBe(200);
    const subView = (await sub.json()) as { driveFileId?: string };
    expect(subView.driveFileId).toBe('gen-2');

    // A file under the confirmed nested folder uploads normally.
    const fileInit = await postUpload(
      app,
      fileInput('gen-2', batch.batchId, 'fSub'),
    );
    expect(fileInit.status).toBe(200);
    const fileView = (await fileInit.json()) as {
      uploadId: string;
      state: string;
      sessionGeneration: number;
    };
    const put = await putChunk(
      app,
      fileView.uploadId,
      fileView.sessionGeneration,
      '0',
      new Uint8Array(6),
    );
    expect(put.status).toBe(200);

    const done = (await (
      await getBatch(app, batch.batchId)
    ).json()) as BatchViewBody;
    expect(nodeOf(done, 'nSub').driveFileId).toBe('gen-2');
    expect(nodeOf(done, 'fSub').state).toBe('completed');
    expect(nodeOf(done, 'fSub').driveFileId).toBeDefined();
    expect(nodeOf(done, 'fSub').uploadId).toBe(fileView.uploadId);
    expect(nodeOf(done, 'fRoot').state).toBe('pending');
    expect(done.state).toBe('executing');
  });

  it('keeps two same-named folders distinct by nodeId', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = await createSealedBatch(app, [
      fnode('a1', null, 'a'),
      fnode('a2', null, 'b'),
      fnode('dup1', 'a1', 'dup'),
      fnode('dup2', 'a2', 'dup'),
      filenode('x', 'dup1', 'x.bin'),
      filenode('y', 'dup2', 'y.bin'),
    ]);
    for (const [nodeId, parentId, name] of [
      ['a1', 'parent-1', 'a'],
      ['a2', 'parent-1', 'b'],
      ['dup1', 'gen-1', 'dup'],
      ['dup2', 'gen-2', 'dup'],
    ] as const) {
      const res = await postFolder(app, {
        mountId: 'mount-1',
        parentId,
        name,
        batchId: batch.batchId,
        nodeId,
      });
      expect(res.status).toBe(200);
    }
    const view = (await (
      await getBatch(app, batch.batchId)
    ).json()) as BatchViewBody;
    const d1 = nodeOf(view, 'dup1');
    const d2 = nodeOf(view, 'dup2');
    expect(d1.driveFileId).toBe('gen-3');
    expect(d2.driveFileId).toBe('gen-4');
    expect(d1.driveFileId).not.toBe(d2.driveFileId);
  });

  it('repairs a mapping lost between remote create and the projection write', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const batch = await createSealedBatch(app, [
      fnode('nRoot', null, 'root'),
      filenode('f1', 'nRoot', 'one.bin'),
    ]);
    const res = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'root',
      batchId: batch.batchId,
      nodeId: 'nRoot',
    });
    expect(res.status).toBe(200);

    // Simulated crash: the remote create completed but the durable mapping
    // row never landed — the node looks claimed with no confirmed ID.
    await env.DB.prepare(
      "UPDATE upload_batch_nodes SET drive_file_id = NULL, state = 'in_progress' " +
        "WHERE batch_id = ? AND node_id = 'nRoot'",
    )
      .bind(batch.batchId)
      .run();
    const child = await postUpload(
      app,
      fileInput('gen-1', batch.batchId, 'f1'),
    );
    expect(child.status).toBe(409);

    // Replaying the folder op restores the confirmed mapping — after which
    // the child schedules normally (reload recovery).
    const replay = await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'root',
      batchId: batch.batchId,
      nodeId: 'nRoot',
    });
    expect(replay.status).toBe(200);
    const repaired = (await (
      await getBatch(app, batch.batchId)
    ).json()) as BatchViewBody;
    expect(nodeOf(repaired, 'nRoot').state).toBe('completed');
    expect(nodeOf(repaired, 'nRoot').driveFileId).toBe('gen-1');

    const retry = await postUpload(app, fileInput('gen-1', batch.batchId, 'f1'));
    expect(retry.status).toBe(200);
  });

  it('keeps completed siblings when a sibling fails, and retries the failed node', async () => {
    const { provider, files } = treeProvider({
      verifyFile: (input) => {
        const id = (input.ref as { id: string }).id;
        const f = files.get(id);
        const base = {
          parents: f === undefined ? ['parent-1'] : [f.parent],
          size: f?.size ?? '6',
        };
        if (id === 'gen-2') {
          return metaFile(id, { ...base, sha256Checksum: 'c'.repeat(64) });
        }
        return metaFile(id, base);
      },
    });
    const app = makeApp(provider);
    const batch = await createSealedBatch(app, [
      fnode('nRoot', null, 'root'),
      filenode('fBad', 'nRoot', 'bad.bin'),
      filenode('fGood', 'nRoot', 'good.bin'),
    ]);
    await postFolder(app, {
      mountId: 'mount-1',
      parentId: 'parent-1',
      name: 'root',
      batchId: batch.batchId,
      nodeId: 'nRoot',
    });
    // fBad: verify mismatch → terminal conflict → node failed.
    const bad = await postUpload(
      app,
      fileInput('gen-1', batch.batchId, 'fBad'),
    );
    const badView = (await bad.json()) as { uploadId: string; sessionGeneration: number };
    await putChunk(app, badView.uploadId, 1, '0', new Uint8Array(6));
    // fGood completes normally.
    const good = await postUpload(
      app,
      fileInput('gen-1', batch.batchId, 'fGood'),
    );
    const goodView = (await good.json()) as {
      uploadId: string;
      sessionGeneration: number;
    };
    await putChunk(app, goodView.uploadId, 1, '0', new Uint8Array(6));

    const view = (await (
      await getBatch(app, batch.batchId)
    ).json()) as BatchViewBody;
    expect(nodeOf(view, 'fBad').state).toBe('failed');
    expect(nodeOf(view, 'fGood').state).toBe('completed');
    expect(nodeOf(view, 'fGood').driveFileId).toBe('gen-3');
    // Nothing was auto-deleted: the batch records the partial failure.
    expect(view.state).toBe('failed');

    // Retry the failed node under a NEW idempotency key — a new operation
    // is claimed while the completed sibling is untouched.
    const retry = await postUpload(
      app,
      fileInput('gen-1', batch.batchId, 'fBad'),
      'retry-fBad',
    );
    expect(retry.status).toBe(200);
    const retryView = (await retry.json()) as { uploadId: string };
    expect(retryView.uploadId).not.toBe(badView.uploadId);
  });
});

// ---------------------------------------------------------------------------
// Maintenance creation gate (W4-R1 #1, E3): while the maintenance_state
// singleton is active, NEW upload/folder/batch operations are refused with a
// retryable envelope — a rotation re-seals the envelopes new work would
// mint, and requireNoActiveUploads can never drain otherwise. In-flight
// operations and idempotent replays keep working.
// ---------------------------------------------------------------------------

describe('maintenance creation gate', () => {
  async function setMaintenance(mode: 'drain' | 'off') {
    if (mode === 'off') {
      await env.DB.prepare('DELETE FROM maintenance_state').run();
      return;
    }
    await env.DB
      .prepare(
        'INSERT INTO maintenance_state ' +
          '(id, mode, phase, checkpoint, processed_count, verified_count, created_at, updated_at) ' +
          'VALUES (1, ?, \'idle\', \'{}\', 0, 0, 0, 0) ' +
          'ON CONFLICT(id) DO UPDATE SET mode = excluded.mode',
      )
      .bind(mode)
      .run();
  }

  it('rejects new upload/folder/batch creates while maintenance is active', async () => {
    const { provider, calls } = treeProvider();
    const app = makeApp(provider);
    await setMaintenance('drain');
    try {
      const upload = await postUpload(app, defaultInput, 'mg-u1');
      expect(upload.status).toBe(503);
      const uploadBody = (await upload.json()) as {
        error: { code: string; message: string };
      };
      expect(uploadBody.error.code).toBe('DRIVE_UNAVAILABLE');
      // No internal detail leaks through the shared envelope.
      expect(uploadBody.error.message).not.toContain('maintenance');
      expect(uploadBody.error.message).not.toContain('rotation');

      const folder = await postFolder(
        app,
        { mountId: 'mount-1', parentId: 'parent-1', name: 'gated' },
        'mg-f1',
      );
      expect(folder.status).toBe(503);

      const batch = await postBatch(app, 'mg-b1');
      expect(batch.status).toBe(503);

      // Gate runs before any remote work or op creation.
      const remoteCalls = calls.filter((c) =>
        ['generateId', 'startUpload', 'createFolder'].includes(c.method),
      );
      expect(remoteCalls).toHaveLength(0);
      const ops = await env.DB
        .prepare('SELECT COUNT(*) AS n FROM upload_operations')
        .first<{ n: number }>();
      expect(ops?.n).toBe(0);
    } finally {
      await setMaintenance('off');
    }

    // Once the gate lifts, the same requests are admitted again.
    const upload = await postUpload(app, defaultInput, 'mg-u1');
    expect(upload.status).toBe(200);
    const folder = await postFolder(
      app,
      { mountId: 'mount-1', parentId: 'parent-1', name: 'gated' },
      'mg-f1',
    );
    expect(folder.status).toBe(200);
    const batch = await postBatch(app, 'mg-b1');
    expect(batch.status).toBe(200);
  });

  it('lets an in-flight operation keep being driven during maintenance', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    const first = await postUpload(app, defaultInput, 'mg-live');
    expect(first.status).toBe(200);
    await setMaintenance('drain');
    try {
      // An idempotent replay of the existing op is NOT a creation — it
      // must continue so in-flight work can finish/cancel/expire.
      const replay = await postUpload(app, defaultInput, 'mg-live');
      expect(replay.status).toBe(200);
      const view = (await replay.json()) as { state: string };
      expect(view.state).toBe('uploading');
      // Chunks and cancel are not creation routes either.
      const put = await putChunk(
        app,
        'unused',
        1,
        '0',
        new Uint8Array(6),
      );
      expect(put.status).toBe(404); // unknown id, but NOT gated
      const { uploadId } = (await first.json()) as { uploadId: string };
      const cancel = await postActionFor(app, uploadId, 'cancel');
      expect(cancel.status).toBe(200);
    } finally {
      await setMaintenance('off');
    }
  });

  it('fails closed when the maintenance read itself fails', async () => {
    const { provider } = treeProvider();
    const app = makeApp(provider);
    // A D1 that answers every statement except maintenance_state reads,
    // mirroring the coordinator admission gate's fail-closed posture.
    const broken = {
      ...env,
      DB: {
        prepare(sql: string) {
          if (sql.includes('maintenance_state')) {
            const stmt: Record<string, unknown> = {
              bind() {
                return stmt;
              },
              async first() {
                throw new Error('D1 read failed');
              },
              async all() {
                throw new Error('D1 read failed');
              },
              async run() {
                throw new Error('D1 read failed');
              },
            };
            return stmt;
          }
          return env.DB.prepare(sql);
        },
        batch: (stmts: unknown[]) => env.DB.batch(stmts as never),
        dump: () => env.DB.dump(),
        exec: (sql: string) => env.DB.exec(sql),
      } as unknown as D1Database,
    } as Env;
    const res = await app.fetch(
      new Request(`${ORIGIN}/api/v1/uploads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'mg-closed',
        },
        body: JSON.stringify(defaultInput),
      }),
      broken,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('DRIVE_UNAVAILABLE');
  });
});

async function postActionFor(
  app: Hono<{ Bindings: Env }>,
  uploadId: string,
  action: 'reconcile' | 'pause' | 'resume' | 'cancel',
) {
  return api(app, `/api/v1/uploads/${uploadId}/${action}`, { method: 'POST' });
}
