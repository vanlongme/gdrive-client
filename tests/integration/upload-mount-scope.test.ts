/**
 * Wave 7 (spec 2026-10-18 §4.3): the pinned mountScope and the scope-aware
 * upload helpers (destination/root proofs, verify, cancel, reader access,
 * quota mapping) for both mount kinds. Only the Google boundary is faked;
 * D1 is the real (shared) test database.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DriveError } from '../../src/worker/drive/errors';
import { resetContainmentCacheForTests, type MountScope } from '../../src/worker/drive/containment';
import type { MountRecord } from '../../src/worker/drive/mounts';
import type {
  DriveFileMeta,
  GetMetadataInput,
  OAuthCatalogWriteProvider,
  ResolvedWriter,
  ServiceAccountContentReadProvider,
} from '../../src/worker/drive/types';
import {
  driveMatchesScope,
  isMountScope,
  pinnedWriterFromJson,
  UPLOAD_QUOTA_EXCEEDED,
} from '../../src/worker/transfers/upload-internal';
import { proveDriveAccess, proveWritableDestination } from '../../src/worker/transfers/reconcile';
import { checkReaderAccess, runVerify } from '../../src/worker/transfers/verify';
import { runTrash } from '../../src/worker/transfers/cancel';
import { eventForDriveError, remoteInitOutcomeForError } from '../../src/worker/transfers/upload-stream';
import { resetState, seedBase } from './upload-fixture';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const SHA = 'a'.repeat(64);
const MD5 = 'b'.repeat(32);
const SHARED: MountScope = { mountId: 'm-sd', rootFolderId: 'drive-1', driveId: 'drive-1' };
const MY: MountScope = { mountId: 'm-my', rootFolderId: 'my-root', driveId: null };
const WRITER: ResolvedWriter = {
  connectionId: 'conn-1', principalId: 'perm-1', oauthClientId: 'client-1',
  projectId: 'proj-1', connectionVersion: 1, oauthClientVersion: 1,
};
const OUTSIDE = 'destination parent is outside the pinned drive';

function file(id: string, over: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id, name: 'f', mimeType: 'application/octet-stream', size: '6', trashed: false,
    parents: ['parent-1'], sha256Checksum: SHA, md5Checksum: MD5, hasThumbnail: false,
    capabilities: { canTrash: true, canDownload: true }, ...over,
  };
}

function folder(id: string, parents: string[], over: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return file(id, {
    mimeType: 'application/vnd.google-apps.folder', parents, ownedByMe: true,
    capabilities: { canAddChildren: true, canTrash: true }, ...over,
  });
}

/** A folder outside MY whose chain ends at the account root. */
const ELSEWHERE = {
  elsewhere: folder('elsewhere', ['account-root']),
  'account-root': folder('account-root', []),
};

/** OAuth fake: getMetadata/verifyFile from a map; records every call. */
function oauth(metas: Record<string, DriveFileMeta | DriveError>) {
  const calls: string[] = [];
  const read = (op: string) => async (input: GetMetadataInput): Promise<DriveFileMeta> => {
    calls.push(`${op}:${input.ref.id}`);
    const found = metas[input.ref.id];
    if (found === undefined) throw new DriveError('not-found', input.ref.id, { status: 404 });
    if (found instanceof DriveError) throw found;
    return found;
  };
  const unused = (): never => {
    throw new Error('unexpected provider call');
  };
  const provider: OAuthCatalogWriteProvider = {
    listChildren: unused, search: unused, generateId: unused, createFolder: unused,
    startUpload: unused, putChunk: unused, probeUpload: unused,
    getMetadata: read('getMetadata'),
    verifyFile: read('verifyFile'),
    trashFile: async (input) => {
      calls.push(`trashFile:${input.ref.id}`);
    },
  };
  return { provider, calls };
}

function destination(fake: ReturnType<typeof oauth>, parentId: string, mountScope: MountScope) {
  return proveWritableDestination({ provider: fake.provider, writer: WRITER, parentId, mountScope });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});

beforeEach(() => {
  resetContainmentCacheForTests();
});

describe('pinned mount scope', () => {
  it('accepts well-formed scopes for the same mount only', () => {
    expect(isMountScope(MY, 'm-my')).toBe(true);
    expect(isMountScope(SHARED, 'm-sd')).toBe(true);
    expect(isMountScope(MY, 'm-other')).toBe(false);
    expect(isMountScope({ ...SHARED, driveId: 'drive-2' }, 'm-sd')).toBe(false);
    expect(isMountScope({ ...MY, rootFolderId: '' }, 'm-my')).toBe(false);
    expect(isMountScope(undefined, 'm-my')).toBe(false);
  });

  it('derives the scope of a pre-wave-7 pin (driveId only) exactly', () => {
    expect(pinnedWriterFromJson(JSON.stringify({ ...WRITER, driveId: 'drive-1' }), 'm-sd')).toEqual({
      ...WRITER,
      mountScope: { mountId: 'm-sd', rootFolderId: 'drive-1', driveId: 'drive-1' },
    });
    expect(pinnedWriterFromJson(JSON.stringify({ ...WRITER, mountScope: MY }), 'm-my').mountScope).toEqual(MY);
    expect(() => pinnedWriterFromJson(JSON.stringify(WRITER), 'm-my')).toThrow();
  });

  it('matches the drive id by scope', () => {
    expect(driveMatchesScope('drive-1', SHARED)).toBe(true);
    expect(driveMatchesScope(undefined, SHARED)).toBe(false);
    expect(driveMatchesScope(undefined, MY)).toBe(true);
    expect(driveMatchesScope('drive-1', MY)).toBe(false);
  });
});

describe('proveWritableDestination', () => {
  it('keeps the Shared Drive rule', async () => {
    const ok = oauth({ 'parent-1': folder('parent-1', ['drive-1'], { driveId: 'drive-1' }) });
    expect(await destination(ok, 'parent-1', SHARED)).toEqual({ ok: true });
    const other = oauth({ 'parent-1': folder('parent-1', ['x'], { driveId: 'drive-2' }) });
    expect(await destination(other, 'parent-1', SHARED)).toEqual({ ok: false, reason: OUTSIDE });
  });

  it('walks to the My Drive root and still requires canAddChildren', async () => {
    const deep = oauth({ 'p-2': folder('p-2', ['p-1']), 'p-1': folder('p-1', ['my-root']) });
    expect(await destination(deep, 'p-2', MY)).toEqual({ ok: true });
    expect(deep.calls).toEqual(['getMetadata:p-2', 'getMetadata:p-1']);
    const readOnly = oauth({ 'p-1': folder('p-1', ['my-root'], { capabilities: {} }) });
    expect(await destination(readOnly, 'p-1', MY)).toEqual({
      ok: false,
      reason: 'writer cannot add children to the destination parent',
    });
  });

  it('rejects a My Drive folder outside the mount tree', async () => {
    expect(await destination(oauth(ELSEWHERE), 'elsewhere', MY)).toEqual({ ok: false, reason: OUTSIDE });
  });

  it('turns a transient ancestor failure into a retry, never a pass', async () => {
    const flaky = oauth({
      'p-2': folder('p-2', ['p-1']),
      'p-1': new DriveError('upstream-unavailable', 'boom', { status: 503 }),
    });
    expect(await destination(flaky, 'p-2', MY)).toEqual({
      ok: false,
      retry: true,
      reason: 'destination:upstream-unavailable',
    });
  });
});

describe('proveDriveAccess', () => {
  it('keeps the Shared Drive root rule', async () => {
    const ok = oauth({ 'drive-1': folder('drive-1', [], { driveId: 'drive-1' }) });
    expect(await proveDriveAccess({ provider: ok.provider, writer: WRITER, mountScope: SHARED })).toEqual({ ok: true });
    expect(ok.calls).toEqual(['getMetadata:drive-1']);
  });

  it('probes the My Drive root: folder, not trashed, ownedByMe, canAddChildren', async () => {
    const root = folder('my-root', ['account-root']);
    const cases: [DriveFileMeta, string | null][] = [
      [root, null],
      [{ ...root, trashed: true }, 'pinned root folder is trashed'],
      [{ ...root, mimeType: 'application/pdf' }, 'root folder identity mismatch'],
      [{ ...root, driveId: 'drive-1' }, 'root folder identity mismatch'],
      [{ ...root, ownedByMe: false }, 'pinned root folder is not owned by the writer'],
      [{ ...root, capabilities: {} }, 'writer lacks add-children on the pinned root folder'],
    ];
    for (const [meta, reason] of cases) {
      const fake = oauth({ 'my-root': meta });
      const proof = await proveDriveAccess({ provider: fake.provider, writer: WRITER, mountScope: MY });
      expect(proof, reason ?? 'ok').toEqual(reason === null ? { ok: true } : { ok: false, reason });
      expect(fake.calls).toEqual(['getMetadata:my-root']);
    }
  });
});

describe('runVerify driveId by scope', () => {
  const verify = (meta: DriveFileMeta, mountScope: MountScope) =>
    runVerify({
      provider: oauth({ 'file-1': meta }).provider,
      directive: {
        kind: 'verify', attemptId: 'att-1', generation: 1, writer: WRITER, fileId: 'file-1',
        expected: { parentId: 'parent-1', mountScope, totalBytes: '6', sha256: SHA, md5: MD5 },
      },
    });
  const WRONG_DRIVE = { outcome: 'failed', reason: 'file is on a different drive' };

  it('requires no driveId on a My Drive mount', async () => {
    expect(await verify(file('file-1'), MY)).toMatchObject({ type: 'verify-result', outcome: 'ok' });
    expect(await verify(file('file-1', { driveId: 'drive-1' }), MY)).toMatchObject(WRONG_DRIVE);
  });

  it('still requires the exact driveId on a Shared Drive mount', async () => {
    expect(await verify(file('file-1'), SHARED)).toMatchObject(WRONG_DRIVE);
  });
});

describe('runTrash on a My Drive mount', () => {
  const trash = (fake: ReturnType<typeof oauth>, meta: DriveFileMeta) =>
    runTrash({
      provider: fake.provider,
      directive: { kind: 'trash', attemptId: 'att-1', generation: 1, writer: WRITER, mountScope: MY, file: meta },
    });

  it('trashes the pinned file after proving it is inside the folder', async () => {
    const target = file('gen-1', { parents: ['p-1'] });
    const fake = oauth({ 'gen-1': target, 'p-1': folder('p-1', ['my-root']) });
    expect(await trash(fake, target)).toEqual({ type: 'trash-result', outcome: 'done' });
    expect(fake.calls).toEqual(['getMetadata:gen-1', 'getMetadata:p-1', 'trashFile:gen-1']);
  });

  it('refuses to trash a file that is no longer inside the folder', async () => {
    const moved = file('gen-1', { parents: ['elsewhere'] });
    const fake = oauth({ 'gen-1': moved, ...ELSEWHERE });
    expect(await trash(fake, moved)).toEqual({
      type: 'trash-result',
      outcome: 'failed',
      reason: 'precheck:outside-mount',
    });
    expect(fake.calls.some((c) => c.startsWith('trashFile'))).toBe(false);
  });

  it('refuses a file that reports a Shared Drive id', async () => {
    const shared = file('gen-1', { driveId: 'drive-1' });
    expect(await trash(oauth({ 'gen-1': shared }), shared)).toEqual({
      type: 'trash-result',
      outcome: 'failed',
      reason: 'precheck:drive-mismatch',
    });
  });
});

describe('checkReaderAccess driveId by scope', () => {
  /** A My Drive mount over upload-fixture's conn-1 with a one-SA read pool. */
  async function seedMyDrivePool(): Promise<MountRecord> {
    await resetState();
    await seedBase();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('m-my', 'M', NULL, 'my-root', 'conn-1', 'conn-1', 1, 'private', 1, 0, 0)",
      ),
      env.DB.prepare(
        "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-1', 'proj', 'sa-1@sa.test', 'k', 'env', 1, 1, 0, 0)",
      ),
      env.DB.prepare(
        "INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('m-my', 'sa-1', 0, 1, 0)",
      ),
    ]);
    return {
      id: 'm-my', label: 'M', driveId: null, rootFolderId: 'my-root', catalogConnectionId: 'conn-1',
      writeConnectionId: 'conn-1', readPoolVersion: 1, visibility: 'private', policyVersion: 1,
      createdAt: 0, updatedAt: 0,
    };
  }

  function reader(meta: DriveFileMeta): ServiceAccountContentReadProvider {
    const unused = (): never => {
      throw new Error('unexpected SA call');
    };
    return {
      getReadMetadata: async () => meta,
      getRevision: unused, openContent: unused, openThumbnail: unused, exportDocument: unused,
    };
  }

  it('reads a My Drive file (no driveId) as readable and a Shared Drive one as blocked', async () => {
    const mount = await seedMyDrivePool();
    const access = (meta: DriveFileMeta) =>
      checkReaderAccess({ db: env.DB, mount, fileId: 'file-1', readProvider: reader(meta) });
    expect((await access(file('file-1'))).state).toBe('readable');
    expect(await access(file('file-1', { driveId: 'drive-1' }))).toMatchObject({
      state: 'blocked',
      reason: 'file is outside the mount drive',
    });
  });
});

describe('quota mapping', () => {
  it('maps storage-full to upload:quota_exceeded for chunks and session starts', () => {
    const err = new DriveError('storage-full', 'quota', { status: 403, googleReasons: ['storageQuotaExceeded'] });
    expect(UPLOAD_QUOTA_EXCEEDED).toBe('upload:quota_exceeded');
    expect(eventForDriveError(err)).toEqual({ type: 'chunk-blocked', reason: 'upload:quota_exceeded' });
    expect(remoteInitOutcomeForError(err)).toEqual({ kind: 'blocked', reason: 'upload:quota_exceeded' });
    // Other blocked classes keep their reason.
    const denied = new DriveError('permission-denied', 'no', { status: 403 });
    expect(eventForDriveError(denied)).toEqual({ type: 'chunk-blocked', reason: 'permission-denied' });
  });
});
