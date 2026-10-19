/**
 * W3-J review regressions for the D1 upload projection helpers (R7) and
 * pinned-writer re-resolution (R2), complementing C's DO/protocol race
 * coverage. The real claimOperation / writeProjection / readOperation /
 * parseSummary / viewFromTombstone / refreshPinnedWriter run against real
 * D1 inside workerd; only row fixtures are seeded. Every test uses fresh
 * unique IDs so no shared-table cleanup is needed.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claimOperation,
  parseSummary,
  readOperation,
  refreshPinnedWriter,
  viewFromTombstone,
  writeProjection,
} from '../../src/worker/transfers/operations';
import type {
  PinnedUploadWriter,
  UploadSessionSnapshot,
} from '../../src/worker/transfers/upload-internal';

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

beforeAll(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
});

const SHA = 'a'.repeat(64);
const MD5 = 'b'.repeat(32);
const CHUNK_SIZE = 8 * 1024 * 1024;

function uid(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Row fixtures — a fresh user/client/connection/mount bundle per test.
// ---------------------------------------------------------------------------

interface WriterSeed {
  readonly userId: string;
  readonly clientId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly mountId: string;
  readonly pinned: PinnedUploadWriter;
}

async function seedWriter(
  opts: {
    connectionVersion?: number;
    clientVersion?: number;
    connectionState?: 'connected' | 'degraded' | 'needs_reauth' | 'disabled';
    connectionEnabled?: boolean;
    clientEnabled?: boolean;
  } = {},
): Promise<WriterSeed> {
  const id = uid();
  const userId = `user-${id}`;
  const clientId = `client-${id}`;
  const connectionId = `conn-${id}`;
  const principalId = `perm-${id}`;
  const projectId = `proj-${id}`;
  const mountId = `mount-${id}`;
  const connectionVersion = opts.connectionVersion ?? 1;
  const clientVersion = opts.clientVersion ?? 1;
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) " +
      "VALUES (?, ?, ?, 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
  )
    .bind(userId, `U-${id}`, `${userId}@test`)
    .run();
  await env.DB.prepare(
    'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(
      clientId,
      projectId,
      `cid-${id}`,
      'env',
      'https://app.test/cb',
      opts.clientEnabled === false ? 0 : 1,
      clientVersion,
    )
    .run();
  await env.DB.prepare(
    'INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0)',
  )
    .bind(
      connectionId,
      clientId,
      principalId,
      `${userId}@test`,
      '',
      opts.connectionState ?? 'connected',
      opts.connectionEnabled === false ? 0 : 1,
      connectionVersion,
      userId,
    )
    .run();
  await env.DB.prepare(
    'INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, 1, 'private', 1, 0, 0)",
  )
    .bind(mountId, `M-${id}`, `drive-${id}`, `drive-${id}`, connectionId, connectionId)
    .run();
  return {
    userId,
    clientId,
    connectionId,
    principalId,
    projectId,
    mountId,
    pinned: {
      connectionId,
      principalId,
      oauthClientId: clientId,
      projectId,
      connectionVersion,
      oauthClientVersion: clientVersion,
      mountScope: { mountId, rootFolderId: `drive-${id}`, driveId: `drive-${id}` },
    },
  };
}

async function claimUpload(seed: WriterSeed): Promise<string> {
  const claimed = await claimOperation(env.DB, {
    ownerId: seed.userId,
    kind: 'file',
    idempotencyKey: `k-${uid()}`,
    input: {
      mountId: seed.mountId,
      parentId: 'parent-1',
      name: 'file.bin',
      mimeType: 'application/octet-stream',
      totalBytes: '6',
      sha256: SHA,
      md5: MD5,
    },
    pinned: seed.pinned,
    now: 1_000,
  });
  if (!claimed.ok) throw new Error('claimOperation failed for fresh key');
  return claimed.operation.id;
}

function snapshotFor(
  seed: WriterSeed,
  uploadId: string,
  overrides: Partial<UploadSessionSnapshot>,
): UploadSessionSnapshot {
  return {
    uploadId,
    ownerId: seed.userId,
    mountId: seed.mountId,
    kind: 'file',
    inputHash: 'input-hash',
    parentId: 'parent-1',
    name: 'file.bin',
    mimeType: 'application/octet-stream',
    totalBytes: '6',
    sha256: SHA,
    md5: MD5,
    state: 'uploading',
    initPhase: 'done',
    pinned: seed.pinned,
    sessionGeneration: 1,
    confirmedOffset: '0',
    chunkSize: CHUNK_SIZE,
    hasSessionUri: true,
    remoteInitAttempted: true,
    sessionExpired: false,
    pauseRequested: false,
    cancelRequested: false,
    readerAccessState: 'unchecked',
    createdMs: 0,
    updatedMs: 0,
    stateVersion: 1,
    ...overrides,
  };
}

/** Terminal result JSON in the exact shape the DO persists (compact view). */
function terminalResult(view: {
  state: string;
  sessionGeneration: number;
  confirmedOffset: string;
  totalBytes: string;
  chunkSize: number;
  readerAccessState: string;
}): string {
  return JSON.stringify({ outcome: 'completed', verification: 'sha256', view });
}

async function projectionVersion(uploadId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT projection_version FROM upload_operations WHERE id = ?',
  )
    .bind(uploadId)
    .first<{ projection_version: number }>();
  if (row === null) throw new Error('operation row missing');
  return row.projection_version;
}

// ---------------------------------------------------------------------------
// R7: writeProjection orders by canonical stateVersion, never wall clock.
// ---------------------------------------------------------------------------

describe('writeProjection ordering (R7)', () => {
  it('never regresses a terminal row to an older in-flight snapshot, even with a larger wall clock', async () => {
    const seed = await seedWriter();
    const uploadId = await claimUpload(seed);

    // The newer terminal projection lands first.
    const result = terminalResult({
      state: 'completed',
      sessionGeneration: 3,
      confirmedOffset: '6',
      totalBytes: '6',
      chunkSize: CHUNK_SIZE,
      readerAccessState: 'readable',
    });
    const terminal = snapshotFor(seed, uploadId, {
      state: 'completed',
      stateVersion: 9,
      sessionGeneration: 3,
      confirmedOffset: '6',
      generatedFileId: 'gen-file-1',
      result,
      readerAccessState: 'readable',
      updatedMs: 5_000,
      completedMs: 5_000,
    });
    await writeProjection(env.DB, uploadId, terminal, 5_000);

    // A delayed write from an older in-flight request arrives LAST with a
    // much larger wall clock. stateVersion fencing must still reject it.
    const stale = snapshotFor(seed, uploadId, {
      state: 'uploading',
      stateVersion: 4,
      confirmedOffset: '3',
      updatedMs: 9_999_999,
    });
    await writeProjection(env.DB, uploadId, stale, 9_999_999);

    const row = await readOperation(env.DB, uploadId);
    expect(row?.state).toBe('completed');
    expect(row?.generated_file_id).toBe('gen-file-1');
    expect(row?.result).toBe(result);
    expect(row?.completed_at).toBe(5_000);
    expect(row?.updated_at).toBe(5_000);
    const summary = parseSummary(row?.summary ?? null);
    expect(summary?.confirmedOffset).toBe('6');
    expect(summary?.sessionGeneration).toBe(3);
    expect(summary?.readerAccessState).toBe('readable');
    expect(await projectionVersion(uploadId)).toBe(9);
  });

  it('refuses an equal stateVersion while still accepting the next one', async () => {
    const seed = await seedWriter();
    const uploadId = await claimUpload(seed);

    const first = snapshotFor(seed, uploadId, {
      state: 'uploading',
      stateVersion: 7,
      confirmedOffset: '4',
      updatedMs: 100,
    });
    await writeProjection(env.DB, uploadId, first, 100);

    // Equal version with a different state and a larger wall clock cannot
    // overwrite: projection_version < ? is strict.
    const equal = snapshotFor(seed, uploadId, {
      state: 'paused',
      stateVersion: 7,
      confirmedOffset: '5',
      pauseRequested: true,
      updatedMs: 200,
    });
    await writeProjection(env.DB, uploadId, equal, 200);

    let row = await readOperation(env.DB, uploadId);
    expect(row?.state).toBe('uploading');
    expect(row?.updated_at).toBe(100);
    expect(parseSummary(row?.summary ?? null)?.confirmedOffset).toBe('4');
    expect(await projectionVersion(uploadId)).toBe(7);

    // Positive control: a strictly newer version does apply.
    const newer = snapshotFor(seed, uploadId, {
      state: 'paused',
      stateVersion: 8,
      confirmedOffset: '5',
      pauseRequested: true,
      updatedMs: 300,
    });
    await writeProjection(env.DB, uploadId, newer, 300);
    row = await readOperation(env.DB, uploadId);
    expect(row?.state).toBe('paused');
    expect(row?.updated_at).toBe(300);
    expect(await projectionVersion(uploadId)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// R7: the compact terminal tombstone view outlives detail cleanup.
// ---------------------------------------------------------------------------

describe('compact tombstone view (R7)', () => {
  it('answers totals, generation and reader state from the result view after detail purge', async () => {
    const seed = await seedWriter();
    const uploadId = await claimUpload(seed);

    const terminal = snapshotFor(seed, uploadId, {
      state: 'completed',
      stateVersion: 12,
      sessionGeneration: 4,
      confirmedOffset: '6',
      generatedFileId: 'gen-file-9',
      result: terminalResult({
        state: 'completed',
        sessionGeneration: 4,
        confirmedOffset: '6',
        totalBytes: '6',
        chunkSize: CHUNK_SIZE,
        readerAccessState: 'readable',
      }),
      readerAccessState: 'readable',
      updatedMs: 7_000,
      completedMs: 7_000,
    });
    await writeProjection(env.DB, uploadId, terminal, 7_000);
    expect((await readOperation(env.DB, uploadId))?.summary).not.toBeNull();

    // Maintenance purge like the detail-cleanup job: transient progress is
    // gone, the tombstone columns stay.
    await env.DB.prepare(
      'UPDATE upload_operations SET summary = NULL, detail_purged_at = ? WHERE id = ?',
    )
      .bind(8_000, uploadId)
      .run();

    // A delayed older in-flight projection must not resurrect summary or
    // regress the purged tombstone either.
    const stale = snapshotFor(seed, uploadId, {
      state: 'uploading',
      stateVersion: 6,
      confirmedOffset: '2',
      updatedMs: 9_999_999,
    });
    await writeProjection(env.DB, uploadId, stale, 9_999_999);

    const row = await readOperation(env.DB, uploadId);
    if (row === null) throw new Error('operation row missing');
    expect(row.summary).toBeNull();
    expect(row.detail_purged_at).toBe(8_000);
    expect(row.state).toBe('completed');
    expect(row.generated_file_id).toBe('gen-file-9');
    expect(row.completed_at).toBe(7_000);
    expect(row.pinned_oauth_connection_id).toBe(seed.connectionId);
    expect(row.pinned_principal_id).toBe(seed.principalId);
    expect(row.pinned_oauth_client_id).toBe(seed.clientId);
    expect(row.pinned_project_id).toBe(seed.projectId);

    expect(viewFromTombstone(row)).toEqual({
      uploadId,
      state: 'completed',
      sessionGeneration: 4,
      confirmedOffset: '6',
      totalBytes: '6',
      chunkSize: CHUNK_SIZE,
      readerAccessState: 'readable',
    });
  });
});

// ---------------------------------------------------------------------------
// R2: refreshPinnedWriter re-resolves current versions under the exact
// pinned identity — never a substitute writer.
// ---------------------------------------------------------------------------

describe('refreshPinnedWriter (R2)', () => {
  it('returns the CURRENT connection/client versions after a same-identity reconnect', async () => {
    const seed = await seedWriter({ connectionVersion: 1, clientVersion: 1 });
    // Same-identity reconnect bumps both row versions.
    await env.DB.prepare(
      'UPDATE google_connections SET version = 5, updated_at = 10 WHERE id = ?',
    )
      .bind(seed.connectionId)
      .run();
    await env.DB.prepare(
      'UPDATE google_oauth_clients SET version = 8 WHERE id = ?',
    )
      .bind(seed.clientId)
      .run();

    const status = await refreshPinnedWriter(env.DB, seed.pinned);
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(`unexpected rejection: ${status.reason}`);
    expect(status.writer).toEqual({
      connectionId: seed.connectionId,
      principalId: seed.principalId,
      oauthClientId: seed.clientId,
      projectId: seed.projectId,
      connectionVersion: 5,
      oauthClientVersion: 8,
    });
  });

  it('rejects when the pinned connection row no longer exists', async () => {
    const pinned: PinnedUploadWriter = {
      connectionId: `conn-${uid()}`,
      principalId: 'perm-x',
      oauthClientId: 'client-x',
      projectId: 'proj-x',
      connectionVersion: 1,
      oauthClientVersion: 1,
      mountScope: { mountId: 'mount-x', rootFolderId: 'drive-x', driveId: 'drive-x' },
    };
    const status = await refreshPinnedWriter(env.DB, pinned);
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error('missing connection must not resolve');
    expect(status.reason).toContain('no longer exists');
  });

  it('rejects a same-id connection re-principaled to a different identity', async () => {
    const seed = await seedWriter();
    await env.DB.prepare(
      'UPDATE google_connections SET principal_id = ? WHERE id = ?',
    )
      .bind(`perm-${uid()}`, seed.connectionId)
      .run();
    const status = await refreshPinnedWriter(env.DB, seed.pinned);
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error('identity change must not resolve');
    expect(status.reason).toContain('identity changed');
  });

  it('rejects a connection repointed at a different OAuth client and project', async () => {
    const seed = await seedWriter();
    const otherClient = `client-${uid()}`;
    await env.DB.prepare(
      'INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, 1, 1, 0, 0)',
    )
      .bind(otherClient, `proj-${uid()}`, `cid-${uid()}`, 'env', 'https://app.test/cb')
      .run();
    await env.DB.prepare(
      'UPDATE google_connections SET oauth_client_id = ? WHERE id = ?',
    )
      .bind(otherClient, seed.connectionId)
      .run();
    const status = await refreshPinnedWriter(env.DB, seed.pinned);
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error('client change must not resolve');
    expect(status.reason).toContain('identity changed');
  });

  it('rejects an in-place project change on the pinned client', async () => {
    const seed = await seedWriter();
    await env.DB.prepare(
      'UPDATE google_oauth_clients SET project_id = ? WHERE id = ?',
    )
      .bind(`proj-${uid()}`, seed.clientId)
      .run();
    const status = await refreshPinnedWriter(env.DB, seed.pinned);
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error('project change must not resolve');
    expect(status.reason).toContain('identity changed');
  });

  it('rejects a disabled pinned connection (flag or state)', async () => {
    const flagOff = await seedWriter({ connectionEnabled: false });
    const flagStatus = await refreshPinnedWriter(env.DB, flagOff.pinned);
    expect(flagStatus.ok).toBe(false);
    if (flagStatus.ok) throw new Error('disabled flag must not resolve');
    expect(flagStatus.reason).toContain('disabled');

    const stateOff = await seedWriter({ connectionState: 'disabled' });
    const stateStatus = await refreshPinnedWriter(env.DB, stateOff.pinned);
    expect(stateStatus.ok).toBe(false);
    if (stateStatus.ok) throw new Error('disabled state must not resolve');
    expect(stateStatus.reason).toContain('disabled');
  });

  it('rejects a pinned connection that needs re-authentication', async () => {
    const seed = await seedWriter({ connectionState: 'needs_reauth' });
    const status = await refreshPinnedWriter(env.DB, seed.pinned);
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error('needs_reauth must not resolve');
    expect(status.reason).toContain('re-authentication');
  });

  it('rejects a disabled pinned OAuth client', async () => {
    const seed = await seedWriter({ clientEnabled: false });
    const status = await refreshPinnedWriter(env.DB, seed.pinned);
    expect(status.ok).toBe(false);
    if (status.ok) throw new Error('disabled client must not resolve');
    expect(status.reason).toContain('client is disabled');
  });
});
