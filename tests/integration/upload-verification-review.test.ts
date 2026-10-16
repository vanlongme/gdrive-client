/**
 * R8 review regressions for the upload verify/cancel helpers and the
 * independent reader-access axis (wave-3 worker E, spec §6.5). The real
 * runVerify / runTrash / checkReaderAccess functions run under workerd;
 * only the Google provider boundary is faked. D1 fixtures use unique
 * IDs per test so no shared-table cleanup is needed.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DriveError,
  type DriveFailureReason,
} from '../../src/worker/drive/errors';
import type { MountRecord } from '../../src/worker/drive/mounts';
import type {
  DriveFileMeta,
  GetMetadataInput,
  OAuthCatalogWriteProvider,
  ReadMetadataInput,
  ResolvedWriter,
  ServiceAccountContentReadProvider,
  TrashFileInput,
  VerifyFileInput,
} from '../../src/worker/drive/types';
import {
  checkReaderAccess,
  runVerify,
  type VerifyDirective,
} from '../../src/worker/transfers/verify';
import {
  runTrash,
  type TrashDirective,
} from '../../src/worker/transfers/cancel';
import type { D1Migration } from 'cloudflare:test';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});

const SHA = 'a'.repeat(64);
const MD5 = 'b'.repeat(32);

function uid(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

const WRITER: ResolvedWriter = {
  connectionId: 'conn-1',
  principalId: 'perm-1',
  oauthClientId: 'client-1',
  projectId: 'proj-1',
  connectionVersion: 1,
  oauthClientVersion: 1,
};

function meta(id: string, overrides: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id,
    name: 'file.bin',
    mimeType: 'application/octet-stream',
    size: '6',
    trashed: false,
    parents: ['parent-1'],
    driveId: 'drive-1',
    sha256Checksum: SHA,
    md5Checksum: MD5,
    hasThumbnail: false,
    capabilities: { canTrash: true, canDownload: true },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Provider fakes — the only mocked surface is the Google boundary.
// ---------------------------------------------------------------------------

type OAuthHandlers = {
  verifyFile?: (
    input: VerifyFileInput,
  ) => DriveFileMeta | Promise<DriveFileMeta>;
  getMetadata?: (
    input: GetMetadataInput,
  ) => DriveFileMeta | Promise<DriveFileMeta>;
  trashFile?: (input: TrashFileInput) => void | Promise<void>;
};

function fakeOAuth(handlers: OAuthHandlers) {
  const calls: string[] = [];
  const unused =
    (name: string) =>
    (): never => {
      throw new Error(`unexpected OAuth provider call: ${name}`);
    };
  const provider: OAuthCatalogWriteProvider = {
    listChildren: unused('listChildren'),
    search: unused('search'),
    createFolder: unused('createFolder'),
    generateId: unused('generateId'),
    startUpload: unused('startUpload'),
    putChunk: unused('putChunk'),
    probeUpload: unused('probeUpload'),
    verifyFile: async (input) => {
      calls.push(`verifyFile:${input.ref.id}`);
      if (handlers.verifyFile === undefined) {
        throw new Error('verifyFile not stubbed');
      }
      return handlers.verifyFile(input);
    },
    getMetadata: async (input) => {
      calls.push(`getMetadata:${input.ref.id}`);
      if (handlers.getMetadata === undefined) {
        throw new Error('getMetadata not stubbed');
      }
      return handlers.getMetadata(input);
    },
    trashFile: async (input) => {
      calls.push(`trashFile:${input.ref.id}`);
      if (handlers.trashFile === undefined) {
        throw new Error('trashFile not stubbed');
      }
      return handlers.trashFile(input);
    },
  };
  return { provider, calls };
}

function fakeReader(
  bySa: Readonly<Record<string, () => DriveFileMeta | Promise<DriveFileMeta>>>,
) {
  const calls: string[] = [];
  const unused =
    (name: string) =>
    (): never => {
      throw new Error(`unexpected SA provider call: ${name}`);
    };
  const provider: ServiceAccountContentReadProvider = {
    getReadMetadata: async (input: ReadMetadataInput) => {
      calls.push(input.identity.serviceAccountId);
      const handler = bySa[input.identity.serviceAccountId];
      if (handler === undefined) {
        throw new Error(`no stub for ${input.identity.serviceAccountId}`);
      }
      return handler();
    },
    getRevision: unused('getRevision'),
    openContent: unused('openContent'),
    openThumbnail: unused('openThumbnail'),
    exportDocument: unused('exportDocument'),
  };
  return { provider, calls };
}

function driveError(reason: DriveFailureReason): DriveError {
  return new DriveError(reason, `stub ${reason}`, {});
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

function verifyDirective(
  overrides: Partial<VerifyDirective> = {},
): VerifyDirective {
  return {
    kind: 'verify',
    attemptId: 'att-1',
    generation: 1,
    writer: WRITER,
    fileId: 'file-1',
    expected: {
      parentId: 'parent-1',
      driveId: 'drive-1',
      totalBytes: '6',
      sha256: SHA,
      md5: MD5,
    },
    ...overrides,
  };
}

function trashDirective(
  file: DriveFileMeta = meta('file-1'),
): TrashDirective {
  return {
    kind: 'trash',
    attemptId: 'att-1',
    generation: 1,
    writer: WRITER,
    driveId: 'drive-1',
    file,
  };
}

// ---------------------------------------------------------------------------
// Unique-ID D1 fixtures: mount + read pool, never deleted.
// ---------------------------------------------------------------------------

interface PoolSeed {
  readonly id: string;
  readonly enabled: boolean;
  readonly priority?: number;
}

async function seedMountPool(sas: readonly PoolSeed[]): Promise<MountRecord> {
  const u = uid();
  const clientId = `client-${u}`;
  const connId = `conn-${u}`;
  const mountId = `mount-${u}`;
  const driveId = `drive-${u}`;
  await env.DB
    .prepare(
      'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0)',
    )
    .bind(clientId, `proj-${u}`, `cid-${u}`, 'env', 'https://app.test/cb')
    .run();
  await env.DB
    .prepare(
      'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 1, NULL, 0, 0)',
    )
    .bind(connId, clientId, `perm-${u}`, 'w@test', '', 'connected')
    .run();
  await env.DB
    .prepare(
      'INSERT INTO mounts (id, label, drive_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
    )
    .bind(mountId, 'M', driveId, connId, connId, 7, 'private', 3)
    .run();
  for (const sa of sas) {
    await env.DB
      .prepare(
        'INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0)',
      )
      .bind(
        sa.id,
        `proj-${u}`,
        `${sa.id}@sa.test`,
        `key-${sa.id}`,
        'env',
        sa.enabled ? 1 : 0,
      )
      .run();
    await env.DB
      .prepare(
        'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES (?, ?, ?, 1, 0)',
      )
      .bind(mountId, sa.id, sa.priority ?? 0)
      .run();
  }
  return {
    id: mountId,
    label: 'M',
    driveId,
    catalogConnectionId: connId,
    writeConnectionId: connId,
    readPoolVersion: 7,
    visibility: 'private',
    policyVersion: 3,
    createdAt: 0,
    updatedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// runVerify: every comparable fact must match; missing metadata fails.
// ---------------------------------------------------------------------------

describe('runVerify', () => {
  it('passes with sha256 when every fact matches', async () => {
    const { provider } = fakeOAuth({
      verifyFile: (input) => meta(input.ref.id),
    });
    const event = await runVerify({ provider, directive: verifyDirective() });
    expect(event).toMatchObject({
      type: 'verify-result',
      outcome: 'ok',
      verification: 'sha256',
    });
  });

  it('falls back to md5 when sha256 is absent, and reports none without checksums', async () => {
    const { provider: md5Provider } = fakeOAuth({
      verifyFile: (input) => meta(input.ref.id, { sha256Checksum: undefined }),
    });
    const md5Event = await runVerify({
      provider: md5Provider,
      directive: verifyDirective(),
    });
    expect(md5Event).toMatchObject({ outcome: 'ok', verification: 'md5' });

    const { provider: noneProvider } = fakeOAuth({
      verifyFile: (input) =>
        meta(input.ref.id, {
          sha256Checksum: undefined,
          md5Checksum: undefined,
        }),
    });
    const noneEvent = await runVerify({
      provider: noneProvider,
      directive: verifyDirective(),
    });
    expect(noneEvent).toMatchObject({ outcome: 'ok', verification: 'none' });
  });

  it('fails on a different returned file id', async () => {
    const { provider } = fakeOAuth({
      verifyFile: () => meta('different-id'),
    });
    const event = await runVerify({ provider, directive: verifyDirective() });
    expect(event).toMatchObject({
      outcome: 'failed',
      reason: 'file id mismatch',
    });
  });

  it('fails when driveId is missing or different', async () => {
    const { provider: missing } = fakeOAuth({
      verifyFile: (input) => meta(input.ref.id, { driveId: undefined }),
    });
    const e1 = await runVerify({
      provider: missing,
      directive: verifyDirective(),
    });
    expect(e1).toMatchObject({ outcome: 'failed' });

    const { provider: wrong } = fakeOAuth({
      verifyFile: (input) => meta(input.ref.id, { driveId: 'drive-2' }),
    });
    const e2 = await runVerify({
      provider: wrong,
      directive: verifyDirective(),
    });
    expect(e2).toMatchObject({ outcome: 'failed' });
  });

  it('fails when parents are missing, empty or wrong', async () => {
    for (const parents of [undefined, [], ['other-parent']] as const) {
      const { provider } = fakeOAuth({
        verifyFile: (input) => meta(input.ref.id, { parents }),
      });
      const event = await runVerify({ provider, directive: verifyDirective() });
      expect(event).toMatchObject({ outcome: 'failed' });
    }
  });

  it('fails when the file is trashed', async () => {
    const { provider } = fakeOAuth({
      verifyFile: (input) => meta(input.ref.id, { trashed: true }),
    });
    const event = await runVerify({ provider, directive: verifyDirective() });
    expect(event).toMatchObject({
      outcome: 'failed',
      reason: 'file is trashed',
    });
  });

  it('fails when size is missing or differs', async () => {
    const { provider: missing } = fakeOAuth({
      verifyFile: (input) => meta(input.ref.id, { size: undefined }),
    });
    const e1 = await runVerify({
      provider: missing,
      directive: verifyDirective(),
    });
    expect(e1).toMatchObject({ outcome: 'failed' });

    const { provider: wrong } = fakeOAuth({
      verifyFile: (input) => meta(input.ref.id, { size: '7' }),
    });
    const e2 = await runVerify({
      provider: wrong,
      directive: verifyDirective(),
    });
    expect(e2).toMatchObject({ outcome: 'failed' });
  });

  it('fails on checksum mismatches', async () => {
    const { provider: badSha } = fakeOAuth({
      verifyFile: (input) =>
        meta(input.ref.id, { sha256Checksum: 'c'.repeat(64) }),
    });
    const e1 = await runVerify({
      provider: badSha,
      directive: verifyDirective(),
    });
    expect(e1).toMatchObject({
      outcome: 'failed',
      reason: 'sha256 checksum mismatch',
    });

    const { provider: badMd5 } = fakeOAuth({
      verifyFile: (input) =>
        meta(input.ref.id, {
          sha256Checksum: undefined,
          md5Checksum: 'd'.repeat(32),
        }),
    });
    const e2 = await runVerify({
      provider: badMd5,
      directive: verifyDirective(),
    });
    expect(e2).toMatchObject({
      outcome: 'failed',
      reason: 'md5 checksum mismatch',
    });
  });

  it('retries on transient and access read failures instead of failing', async () => {
    for (const reason of [
      'rate-limited',
      'upstream-unavailable',
      'permission-denied',
      'unauthorized',
    ] as const) {
      const { provider } = fakeOAuth({
        verifyFile: () => {
          throw driveError(reason);
        },
      });
      const event = await runVerify({ provider, directive: verifyDirective() });
      expect(event).toMatchObject({
        outcome: 'retry',
        reason: `verify-read:${reason}`,
      });
    }
    const { provider } = fakeOAuth({
      verifyFile: () => {
        throw new Error('socket reset');
      },
    });
    const event = await runVerify({ provider, directive: verifyDirective() });
    expect(event).toMatchObject({
      outcome: 'retry',
      reason: 'verify-read:transport-error',
    });
  });
});

// ---------------------------------------------------------------------------
// checkReaderAccess: enabled-pool bounded failover, affirmative readability.
// ---------------------------------------------------------------------------

describe('checkReaderAccess', () => {
  it('reports unchecked when the mount has no read pool', async () => {
    const mount = await seedMountPool([]);
    const { provider, calls } = fakeReader({});
    const check = await checkReaderAccess({
      db: env.DB,
      mount,
      fileId: 'file-1',
      readProvider: provider,
    });
    expect(check.state).toBe('unchecked');
    expect(check.readPoolVersion).toBe(7);
    expect(check.policyVersion).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it('never probes a disabled pool entry', async () => {
    const mount = await seedMountPool([{ id: `sa-${uid()}`, enabled: false }]);
    const { provider, calls } = fakeReader({});
    const check = await checkReaderAccess({
      db: env.DB,
      mount,
      fileId: 'file-1',
      readProvider: provider,
    });
    expect(check.state).toBe('pending');
    expect(calls).toHaveLength(0);
  });

  it('skips disabled entries and probes the enabled SA', async () => {
    const off = `sa-${uid()}`;
    const on = `sa-${uid()}`;
    const mount = await seedMountPool([
      { id: off, enabled: false, priority: 9 },
      { id: on, enabled: true, priority: 1 },
    ]);
    const { provider, calls } = fakeReader({
      [on]: () => meta('file-1', { driveId: mount.driveId }),
    });
    const check = await checkReaderAccess({
      db: env.DB,
      mount,
      fileId: 'file-1',
      readProvider: provider,
    });
    expect(check.state).toBe('readable');
    expect(calls).toEqual([on]);
  });

  it('is not readable when the SA metadata names a different file or drive', async () => {
    const sa1 = `sa-${uid()}`;
    const wrongId = await seedMountPool([{ id: sa1, enabled: true }]);
    const r1 = fakeReader({
      [sa1]: () => meta('other-file', { driveId: wrongId.driveId }),
    });
    const c1 = await checkReaderAccess({
      db: env.DB,
      mount: wrongId,
      fileId: 'file-1',
      readProvider: r1.provider,
    });
    expect(c1.state).not.toBe('readable');

    const sa2 = `sa-${uid()}`;
    const wrongDrive = await seedMountPool([{ id: sa2, enabled: true }]);
    const r2 = fakeReader({
      [sa2]: () => meta('file-1', { driveId: 'elsewhere' }),
    });
    const c2 = await checkReaderAccess({
      db: env.DB,
      mount: wrongDrive,
      fileId: 'file-1',
      readProvider: r2.provider,
    });
    expect(c2.state).toBe('blocked');

    const sa3 = `sa-${uid()}`;
    const missingDrive = await seedMountPool([{ id: sa3, enabled: true }]);
    const r3 = fakeReader({
      [sa3]: () => meta('file-1', { driveId: undefined }),
    });
    const c3 = await checkReaderAccess({
      db: env.DB,
      mount: missingDrive,
      fileId: 'file-1',
      readProvider: r3.provider,
    });
    expect(c3.state).toBe('blocked');
  });

  it('requires affirmative canDownload for readability', async () => {
    const sa1 = `sa-${uid()}`;
    const denied = await seedMountPool([{ id: sa1, enabled: true }]);
    const r1 = fakeReader({
      [sa1]: () =>
        meta('file-1', {
          capabilities: { canDownload: false },
          driveId: denied.driveId,
        }),
    });
    const c1 = await checkReaderAccess({
      db: env.DB,
      mount: denied,
      fileId: 'file-1',
      readProvider: r1.provider,
    });
    expect(c1.state).toBe('blocked');

    const sa2 = `sa-${uid()}`;
    const absent = await seedMountPool([{ id: sa2, enabled: true }]);
    const r2 = fakeReader({
      [sa2]: () => meta('file-1', { capabilities: {}, driveId: absent.driveId }),
    });
    const c2 = await checkReaderAccess({
      db: env.DB,
      mount: absent,
      fileId: 'file-1',
      readProvider: r2.provider,
    });
    expect(c2.state).toBe('pending');
    expect(c2.state).not.toBe('readable');
  });

  it('blocks on definitive denials and pends on transient failures', async () => {
    const sa1 = `sa-${uid()}`;
    const denied = await seedMountPool([{ id: sa1, enabled: true }]);
    const r1 = fakeReader({
      [sa1]: () => {
        throw driveError('permission-denied');
      },
    });
    const c1 = await checkReaderAccess({
      db: env.DB,
      mount: denied,
      fileId: 'file-1',
      readProvider: r1.provider,
    });
    expect(c1.state).toBe('blocked');
    expect(c1.reason).toBe('permission-denied');

    const sa2 = `sa-${uid()}`;
    const gone = await seedMountPool([{ id: sa2, enabled: true }]);
    const r2 = fakeReader({
      [sa2]: () => {
        throw driveError('not-found');
      },
    });
    const c2 = await checkReaderAccess({
      db: env.DB,
      mount: gone,
      fileId: 'file-1',
      readProvider: r2.provider,
    });
    expect(c2.state).toBe('blocked');

    const sa3 = `sa-${uid()}`;
    const transient = await seedMountPool([{ id: sa3, enabled: true }]);
    const r3 = fakeReader({
      [sa3]: () => {
        throw driveError('upstream-unavailable');
      },
    });
    const c3 = await checkReaderAccess({
      db: env.DB,
      mount: transient,
      fileId: 'file-1',
      readProvider: r3.provider,
    });
    expect(c3.state).toBe('pending');
    expect(c3.reason).toBe('upstream-unavailable');
  });

  it('never rotates on rate limits, quotas or file download limits', async () => {
    for (const [reason, expected] of [
      ['rate-limited', 'pending'],
      ['quota-exceeded', 'pending'],
      ['download-restricted', 'blocked'],
    ] as const) {
      const sa1 = `sa-${uid()}`;
      const sa2 = `sa-${uid()}`;
      const mount = await seedMountPool([
        { id: sa1, enabled: true, priority: 2 },
        { id: sa2, enabled: true, priority: 1 },
      ]);
      const { provider, calls } = fakeReader({
        [sa1]: () => {
          throw driveError(reason);
        },
        [sa2]: () => meta('file-1', { driveId: mount.driveId }),
      });
      const check = await checkReaderAccess({
        db: env.DB,
        mount,
        fileId: 'file-1',
        readProvider: provider,
      });
      expect(check.state).toBe(expected);
      // The second enabled identity must not be probed — rotation on these
      // classes would be a cooldown-evasion channel.
      expect(calls).toEqual([sa1]);
    }
  });

  it('fails over to the next enabled SA on identity/access faults', async () => {
    const bad = `sa-${uid()}`;
    const good = `sa-${uid()}`;
    const mount = await seedMountPool([
      { id: bad, enabled: true, priority: 2 },
      { id: good, enabled: true, priority: 1 },
    ]);
    const { provider, calls } = fakeReader({
      [bad]: () => {
        throw driveError('credential-disabled');
      },
      [good]: () => meta('file-1', { driveId: mount.driveId }),
    });
    const check = await checkReaderAccess({
      db: env.DB,
      mount,
      fileId: 'file-1',
      readProvider: provider,
    });
    expect(check.state).toBe('readable');
    expect(calls).toEqual([bad, good]);
  });

  it('pends (not blocks) when denial mixes with an inconclusive fault', async () => {
    const sa1 = `sa-${uid()}`;
    const sa2 = `sa-${uid()}`;
    const mount = await seedMountPool([
      { id: sa1, enabled: true, priority: 2 },
      { id: sa2, enabled: true, priority: 1 },
    ]);
    const { provider } = fakeReader({
      [sa1]: () => {
        throw driveError('permission-denied');
      },
      [sa2]: () => {
        throw driveError('upstream-unavailable');
      },
    });
    const check = await checkReaderAccess({
      db: env.DB,
      mount,
      fileId: 'file-1',
      readProvider: provider,
    });
    expect(check.state).toBe('pending');
  });

  it('marks trashed and foreign-drive files blocked without rotation', async () => {
    const sa1 = `sa-${uid()}`;
    const mount = await seedMountPool([{ id: sa1, enabled: true }]);
    const { provider, calls } = fakeReader({
      [sa1]: () => meta('file-1', { trashed: true, driveId: mount.driveId }),
    });
    const check = await checkReaderAccess({
      db: env.DB,
      mount,
      fileId: 'file-1',
      readProvider: provider,
    });
    expect(check.state).toBe('blocked');
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// runTrash: fresh metadata precheck, affirmative canTrash, 404 ambiguity.
// ---------------------------------------------------------------------------

describe('runTrash', () => {
  it('trashes after the fresh read proves scope and canTrash', async () => {
    const { provider, calls } = fakeOAuth({
      getMetadata: (input) => meta(input.ref.id),
      trashFile: () => undefined,
    });
    const event = await runTrash({ provider, directive: trashDirective() });
    expect(event).toMatchObject({ type: 'trash-result', outcome: 'done' });
    expect(calls).toEqual(['getMetadata:file-1', 'trashFile:file-1']);
  });

  it('is done without a mutation when the fresh read proves already trashed', async () => {
    const { provider, calls } = fakeOAuth({
      getMetadata: (input) => meta(input.ref.id, { trashed: true }),
      trashFile: () => undefined,
    });
    const event = await runTrash({ provider, directive: trashDirective() });
    expect(event).toMatchObject({ outcome: 'done' });
    expect(calls).toEqual(['getMetadata:file-1']);
  });

  it('fails without mutation when canTrash is false or absent', async () => {
    for (const capabilities of [{ canTrash: false }, {}] as const) {
      const { provider, calls } = fakeOAuth({
        getMetadata: (input) => meta(input.ref.id, { capabilities }),
        trashFile: () => undefined,
      });
      const event = await runTrash({ provider, directive: trashDirective() });
      expect(event).toMatchObject({ outcome: 'failed' });
      expect(calls).toEqual(['getMetadata:file-1']);
    }
  });

  it('fails without mutation on id or drive mismatch in the fresh read', async () => {
    const { provider: wrongId, calls: c1 } = fakeOAuth({
      getMetadata: () => meta('other-file'),
      trashFile: () => undefined,
    });
    const e1 = await runTrash({ provider: wrongId, directive: trashDirective() });
    expect(e1).toMatchObject({ outcome: 'failed' });
    expect(c1).toHaveLength(1);

    const { provider: wrongDrive, calls: c2 } = fakeOAuth({
      getMetadata: (input) => meta(input.ref.id, { driveId: 'elsewhere' }),
      trashFile: () => undefined,
    });
    const e2 = await runTrash({
      provider: wrongDrive,
      directive: trashDirective(),
    });
    expect(e2).toMatchObject({ outcome: 'failed' });
    expect(c2).toHaveLength(1);
  });

  it('fails on any precheck read failure — a 404 cannot prove trash', async () => {
    for (const reason of [
      'not-found',
      'gone',
      'permission-denied',
      'unauthorized',
      'rate-limited',
    ] as const) {
      const { provider, calls } = fakeOAuth({
        getMetadata: () => {
          throw driveError(reason);
        },
        trashFile: () => undefined,
      });
      const event = await runTrash({ provider, directive: trashDirective() });
      expect(event).toMatchObject({ outcome: 'failed' });
      expect(calls).toEqual(['getMetadata:file-1']);
    }
  });

  it('confirms a 404 from the trash call with affirmative trashed evidence', async () => {
    let reads = 0;
    const { provider, calls } = fakeOAuth({
      getMetadata: (input) => {
        reads += 1;
        return reads === 1
          ? meta(input.ref.id)
          : meta(input.ref.id, { trashed: true });
      },
      trashFile: () => {
        throw driveError('not-found');
      },
    });
    const event = await runTrash({ provider, directive: trashDirective() });
    expect(event).toMatchObject({ outcome: 'done' });
    expect(calls).toEqual([
      'getMetadata:file-1',
      'trashFile:file-1',
      'getMetadata:file-1',
    ]);
  });

  it('fails when a 404 trash cannot be confirmed trashed', async () => {
    // File still live after the 404: ambiguous, park for cleanup.
    const { provider: stillLive } = fakeOAuth({
      getMetadata: (input) => meta(input.ref.id),
      trashFile: () => {
        throw driveError('not-found');
      },
    });
    const e1 = await runTrash({
      provider: stillLive,
      directive: trashDirective(),
    });
    expect(e1).toMatchObject({ outcome: 'failed' });

    // Confirmation read also 404s: lost permission can mask the file.
    let reads = 0;
    const { provider: alsoGone } = fakeOAuth({
      getMetadata: (input) => {
        reads += 1;
        if (reads === 1) return meta(input.ref.id);
        throw driveError('not-found');
      },
      trashFile: () => {
        throw driveError('not-found');
      },
    });
    const e2 = await runTrash({
      provider: alsoGone,
      directive: trashDirective(),
    });
    expect(e2).toMatchObject({ outcome: 'failed' });
  });

  it('fails on permission and transport trash errors', async () => {
    const { provider: denied } = fakeOAuth({
      getMetadata: (input) => meta(input.ref.id),
      trashFile: () => {
        throw driveError('permission-denied');
      },
    });
    const e1 = await runTrash({ provider: denied, directive: trashDirective() });
    expect(e1).toMatchObject({
      outcome: 'failed',
      reason: 'permission-denied',
    });

    const { provider: transport } = fakeOAuth({
      getMetadata: (input) => meta(input.ref.id),
      trashFile: () => {
        throw new Error('socket reset');
      },
    });
    const e2 = await runTrash({
      provider: transport,
      directive: trashDirective(),
    });
    expect(e2).toMatchObject({ outcome: 'failed', reason: 'transport-error' });
  });

  it('never mutates an unpinned empty file id', async () => {
    const { provider, calls } = fakeOAuth({});
    const event = await runTrash({
      provider,
      directive: trashDirective(meta('')),
    });
    expect(event).toMatchObject({ outcome: 'failed' });
    expect(calls).toHaveLength(0);
  });
});
