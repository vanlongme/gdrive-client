/**
 * T08 integration tests: streamed chunks through the ordinary Worker,
 * probe/reconcile recovery, pause/resume, cancel cleanup and zero-byte
 * uploads. Provider outcomes are deterministic fixtures; the UploadSession
 * DO and D1 index are real. Includes the coordinator's R4 fixture (held
 * final PUT + probe-308 + late create) and R8/R9 regressions.
 */

import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DriveError } from '../../src/worker/drive/errors';
import {
  actorFor,
  api,
  defaultInput,
  defaultMeta,
  fakeNow,
  fixtureProvider,
  makeApp,
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
  type UploadViewBody,
} from './upload-fixture';

const CHUNK = 4 * 1024 * 1024;

beforeEach(async () => {
  setNow(1_700_000_000_000);
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await resetState();
  await seedBase();
});

async function initUpload(
  app: ReturnType<typeof makeApp>,
  key: string,
  input: Record<string, unknown> = defaultInput,
): Promise<UploadViewBody> {
  const res = await postInit(app, key, input);
  expect(res.status).toBe(200);
  return (await res.json()) as UploadViewBody;
}

// ---------------------------------------------------------------------------
// Chunk protocol
// ---------------------------------------------------------------------------

describe('chunk protocol', () => {
  it('streams a single-chunk upload to verified completion', async () => {
    const { provider } = fixtureProvider({
      putChunk: () => ({ kind: 'completed', file: metaFile('gen-file-1') }),
      verifyFile: () => metaFile('gen-file-1'),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p1');
    expect(view.state).toBe('uploading');

    const put = await putChunk(
      app,
      view.uploadId,
      view.sessionGeneration,
      '0',
      new Uint8Array(6),
    );
    expect(put.status).toBe(200);
    const done = (await put.json()) as UploadViewBody;
    expect(done.state).toBe('completed');
    expect(done.confirmedOffset).toBe('6');
  });

  it('advances through multi-chunk upload (full chunk then final short chunk)', async () => {
    const total = CHUNK + 5;
    const { provider } = fixtureProvider({
      putChunk: (input) => {
        const off = input.offset as bigint;
        const len = input.chunkBytes as number;
        if (off + BigInt(len) < BigInt(total)) {
          return { kind: 'incomplete', confirmedOffset: off + BigInt(len) };
        }
        return {
          kind: 'completed',
          file: metaFile('gen-file-1', {
            size: String(total) as ReturnType<typeof metaFile>['size'],
          }),
        };
      },
      verifyFile: () =>
        metaFile('gen-file-1', {
          size: String(total) as ReturnType<typeof metaFile>['size'],
        }),
    });
    const app = makeApp(provider, undefined, { chunkSizeBytes: CHUNK });
    const view = await initUpload(app, 'p2', {
      ...defaultInput,
      totalBytes: String(total),
    });

    const first = await putChunk(
      app,
      view.uploadId,
      1,
      '0',
      new Uint8Array(CHUNK),
    );
    expect(first.status).toBe(200);
    const v1 = (await first.json()) as UploadViewBody;
    expect(v1.state).toBe('uploading');
    expect(v1.confirmedOffset).toBe(String(CHUNK));

    const second = await putChunk(
      app,
      view.uploadId,
      1,
      String(CHUNK),
      new Uint8Array(5),
    );
    expect(second.status).toBe(200);
    const v2 = (await second.json()) as UploadViewBody;
    expect(v2.state).toBe('completed');
    expect(v2.confirmedOffset).toBe(String(total));
  });

  it('handles a 308 without Range on the first chunk (offset stays 0, retryable)', async () => {
    const { provider } = fixtureProvider({
      putChunk: () => ({ kind: 'incomplete', confirmedOffset: 0n }),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p3');
    const put = await putChunk(
      app,
      view.uploadId,
      1,
      '0',
      new Uint8Array(6),
    );
    expect(put.status).toBe(200);
    const v = (await put.json()) as UploadViewBody;
    expect(v.state).toBe('uploading');
    expect(v.confirmedOffset).toBe('0');
  });

  it('commits a partial 308 confirmation before the declared chunk end', async () => {
    const { provider } = fixtureProvider({
      putChunk: () => ({ kind: 'incomplete', confirmedOffset: 2n }),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p4');
    const put = await putChunk(
      app,
      view.uploadId,
      1,
      '0',
      new Uint8Array(6),
    );
    expect(put.status).toBe(200);
    const v = (await put.json()) as UploadViewBody;
    expect(v.state).toBe('uploading');
    expect(v.confirmedOffset).toBe('2');
    // The next claim resumes at the confirmed position.
    const stale = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    expect(stale.status).toBe(409);
  });

  it('rejects bad chunk addresses and missing/mismatched lengths', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const view = await initUpload(app, 'p5');
    // offset regression / parseInt-prefix attacks are rejected up front.
    const badGen = await api(
      app,
      `/api/v1/uploads/${view.uploadId}/chunks?generation=1x&offset=0`,
      { method: 'PUT', headers: { 'content-length': '6' }, body: '123456' },
    );
    expect(badGen.status).toBe(400);
    const badOff = await api(
      app,
      `/api/v1/uploads/${view.uploadId}/chunks?generation=1&offset=0x`,
      { method: 'PUT', headers: { 'content-length': '6' }, body: '123456' },
    );
    expect(badOff.status).toBe(400);
    // A streamed body carries no Content-Length → rejected up front.
    const noLen = await api(
      app,
      `/api/v1/uploads/${view.uploadId}/chunks?generation=1&offset=0`,
      {
        method: 'PUT',
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(6));
            c.close();
          },
        }),
        duplex: 'half',
      } as RequestInit,
    );
    expect(noLen.status).toBe(400);
    const wrongLen = await api(
      app,
      `/api/v1/uploads/${view.uploadId}/chunks?generation=1&offset=0`,
      { method: 'PUT', headers: { 'content-length': '4' }, body: '1234' },
    );
    expect(wrongLen.status).toBe(409);
    const staleGen = await api(
      app,
      `/api/v1/uploads/${view.uploadId}/chunks?generation=99&offset=0`,
      { method: 'PUT', headers: { 'content-length': '6' }, body: '123456' },
    );
    expect(staleGen.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Reconcile paths
// ---------------------------------------------------------------------------

describe('probe and reconcile', () => {
  it('recovers from a mid-upload timeout via probe (unknown → 308 → resume)', async () => {
    let puts = 0;
    const { provider } = fixtureProvider({
      putChunk: () => {
        puts += 1;
        if (puts === 1) {
          throw new DriveError('timeout', 'lost', {});
        }
        return { kind: 'completed', file: metaFile('gen-file-1') };
      },
      probeUpload: () => ({ kind: 'incomplete', confirmedOffset: 3n }),
      verifyFile: () => metaFile('gen-file-1'),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p6');
    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    expect(put.status).toBe(200);
    const v = (await put.json()) as UploadViewBody;
    // The lost response auto-reconciles: probe reports 3 confirmed bytes.
    expect(v.state).toBe('uploading');
    expect(v.confirmedOffset).toBe('3');
  });

  it('recovers a lost final chunk by probing to completion', async () => {
    const { provider } = fixtureProvider({
      putChunk: () => {
        throw new DriveError('timeout', 'response lost after final put', {});
      },
      probeUpload: () => ({ kind: 'completed', file: metaFile('gen-file-1') }),
      verifyFile: () => metaFile('gen-file-1'),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p7');
    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    expect(put.status).toBe(200);
    const v = (await put.json()) as UploadViewBody;
    expect(v.state).toBe('completed');
  });

  it('renews a provably-expired session into a fresh generation at offset 0', async () => {
    let sessions = 0;
    const { provider } = fixtureProvider({
      putChunk: () => {
        throw new DriveError('not-found', 'session gone', {});
      },
      startUpload: () => {
        sessions += 1;
        return {
          kind: 'resumable',
          sessionUri: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s${sessions}`,
          generatedFileId: 'gen-file-1',
        };
      },
      getMetadata: (input) => {
        const id = (input.ref as { id: string }).id;
        if (id === 'gen-file-1') {
          throw new DriveError('not-found', 'no file yet', {});
        }
        // Drive root / parent proofs.
        return metaFile(id, {
          driveId: 'drive-1',
          mimeType:
            id === 'drive-1' || id === 'parent-1'
              ? 'application/vnd.google-apps.folder'
              : 'application/octet-stream',
          capabilities: { canAddChildren: true, canTrash: true },
        });
      },
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p8');
    expect(view.sessionGeneration).toBe(1);
    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    const v = (await put.json()) as UploadViewBody;
    expect(v.state).toBe('uploading');
    expect(v.sessionGeneration).toBe(2);
    expect(v.confirmedOffset).toBe('0');
    const s = await snapshot(view.uploadId);
    expect(s.snapshot.sessionGeneration).toBe(2);
  });

  it('blocks (not absent) when the lookup proves the writer lost permission', async () => {
    const { provider } = fixtureProvider({
      putChunk: () => {
        throw new DriveError('not-found', 'session gone', {});
      },
      getMetadata: (input) => {
        const id = (input.ref as { id: string }).id;
        if (id === 'parent-1') return defaultMeta(id);
        if (id === 'gen-file-1') {
          throw new DriveError('not-found', 'inaccessible', {});
        }
        throw new DriveError('permission-denied', 'no access', {});
      },
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p9');
    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    const v = (await put.json()) as UploadViewBody;
    // 404 on file + denied on drive ≠ absent → blocked, never renews.
    expect(v.state).toBe('blocked');
    expect(v.sessionGeneration).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pause / resume
// ---------------------------------------------------------------------------

describe('pause and resume', () => {
  it('pause prevents chunk claims; resume restores uploading', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const view = await initUpload(app, 'p10');

    const pause = await postAction(app, view.uploadId, 'pause');
    expect((await pause.json()) as UploadViewBody).toBeDefined();

    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    expect(put.status).toBe(409);

    const resume = await postAction(app, view.uploadId, 'resume');
    const v = (await resume.json()) as UploadViewBody;
    expect(v.state).toBe('uploading');

    const ok = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Cancel — including the R4 held-PUT fixture
// ---------------------------------------------------------------------------

describe('cancel semantics', () => {
  it('cancel probes, finds nothing under proven access and lands cancelled', async () => {
    const { provider, calls } = fixtureProvider({
      getMetadata: (input) => {
        const id = (input.ref as { id: string }).id;
        if (id === 'gen-file-1') {
          throw new DriveError('not-found', 'absent', {});
        }
        return defaultMeta(id);
      },
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p11');
    const cancel = await postAction(app, view.uploadId, 'cancel');
    expect(cancel.status).toBe(200);
    const v = (await cancel.json()) as UploadViewBody;
    expect(v.state).toBe('cancelled');
    // Probe hit the session; lookup proved drive access then 404 → absent.
    expect(calls.some((c) => c.method === 'probeUpload')).toBe(true);
    // A new chunk claim must never be granted after cancellation.
    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    expect(put.status).toBe(409);
  });

  it('R4: held final PUT + cancel + probe-308 + late create → reconcile trashes exact pinned ID', async () => {
    let rejectPut!: (reason?: unknown) => void;
    const gate = new Promise((_resolve, reject) => {
      void _resolve;
      rejectPut = reject;
    });
    // The late create is gated on the held PUT actually finishing — not on
    // a call count — so probes anywhere in time stay deterministic.
    let putResolved = false;
    const { provider, calls } = fixtureProvider({
      putChunk: () => gate,
      probeUpload: () => ({ kind: 'incomplete', confirmedOffset: 0n }),
      getMetadata: (input) => {
        const id = (input.ref as { id: string }).id;
        if (id === 'gen-file-1') {
          // While the PUT is held the file does not exist; once the fenced
          // PUT lands upstream it exists — under the exact pinned ID.
          if (!putResolved) {
            throw new DriveError('not-found', 'not yet', {});
          }
          return metaFile('gen-file-1');
        }
        return metaFile(id, {
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'drive-1',
          capabilities: { canAddChildren: true, canTrash: true },
        });
      },
      trashFile: () => undefined,
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p12');

    // Final PUT is claimed then held — its response is dropped upstream.
    const putPromise = putChunk(
      app,
      view.uploadId,
      1,
      '0',
      new Uint8Array(6),
    );
    // Deterministic: wait until the DO reports a live attempt.
    for (let i = 0; i < 200; i += 1) {
      const s = await snapshot(view.uploadId);
      if (s.snapshot.activeAttempt !== undefined) break;
      await new Promise((r) => setTimeout(r, 5));
      if (i === 199) throw new Error('chunk attempt never became active');
    }

    // The remote call outlives its lease (120s) while the response is
    // still held: lease expiry never means the write stopped upstream.
    setNow(fakeNow + 200_000);
    const cancel = await postAction(app, view.uploadId, 'cancel');
    expect(cancel.status).toBe(200);
    const cv = (await cancel.json()) as UploadViewBody;
    // Probe 308 then lookup 404 is NOT settlement: the fenced PUT is still
    // in flight and may create the file — the operation must hold
    // recoverable cleanup_pending, never a false terminal 'cancelled'.
    expect(cv.state).toBe('cleanup_pending');
    expect(cv.state).not.toBe('cancelled');
    // No competing PUT may be granted while the write is unresolved.
    const racing = await putChunk(
      app,
      view.uploadId,
      1,
      '0',
      new Uint8Array(6),
    );
    expect(racing.status).toBe(409);

    // Well past the old (rejected) five-minute grace boundary the marker
    // still holds: no clock ever settles an unresolved write — only
    // positive remote evidence can.
    setNow(fakeNow + 800_000);
    const lateRacing = await putChunk(
      app,
      view.uploadId,
      1,
      '0',
      new Uint8Array(6),
    );
    expect(lateRacing.status).toBe(409);
    const pendingRecon = await postAction(app, view.uploadId, 'reconcile');
    expect(
      ((await pendingRecon.json()) as UploadViewBody).state,
    ).toBe('cleanup_pending');

    // The held PUT created the file upstream while its response was
    // dropped entirely — a transport drop is not a remote verdict, so the
    // stale commit settles nothing.
    putResolved = true;
    rejectPut(new DriveError('transport-error', 'response dropped', {}));
    const putRes = await putPromise;
    expect(putRes.status).toBe(200);
    const pv = (await putRes.json()) as UploadViewBody;
    expect(pv.state).toBe('cleanup_pending');

    // Subsequent reconcile re-checks the exact pinned generated ID, finds
    // the late-created file and trashes ONLY that ID — never an arbitrary
    // event-provided one.
    const recon = await postAction(app, view.uploadId, 'reconcile');
    expect(recon.status).toBe(200);
    const rv = (await recon.json()) as UploadViewBody;
    expect(rv.state).toBe('cancelled');
    const trashCalls = calls.filter((c) => c.method === 'trashFile');
    expect(trashCalls.length).toBe(1);
    expect(trashCalls[0]?.detail).toContain('gen-file-1');
    // And the operation stays cancelled — never completed.
    const s = await snapshot(view.uploadId);
    expect(s.snapshot.state).toBe('cancelled');
  });

  it('writer without canTrash lands on cleanup_pending, never on a fake delete', async () => {
    const { provider } = fixtureProvider({
      getMetadata: (input) => {
        const id = (input.ref as { id: string }).id;
        if (id === 'parent-1' || id === 'drive-1') return defaultMeta(id);
        return metaFile(id, {
          driveId: 'drive-1',
          capabilities: { canTrash: false },
        });
      },
      probeUpload: () => ({ kind: 'incomplete', confirmedOffset: 0n }),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p13');
    const cancel = await postAction(app, view.uploadId, 'cancel');
    const v = (await cancel.json()) as UploadViewBody;
    expect(v.state).toBe('cleanup_pending');
  });
});

// ---------------------------------------------------------------------------
// Zero-byte + reader axis
// ---------------------------------------------------------------------------

describe('zero-byte and reader access', () => {
  it('zero-byte create never issues a resumable PUT and completes via verify', async () => {
    const { provider, calls } = fixtureProvider({
      startUpload: () => ({ kind: 'created-empty', file: metaFile('gen-file-1', { size: '0' }) }),
      verifyFile: () => metaFile('gen-file-1', { size: '0' }),
    });
    const app = makeApp(provider);
    const view = await initUpload(app, 'p14', { ...defaultInput, totalBytes: '0' });
    expect(view.state).toBe('completed');
    expect(calls.some((c) => c.method === 'putChunk')).toBe(false);
    // A PUT against a completed upload is refused.
    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(1));
    expect(put.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// R9: write-scope enforcement
// ---------------------------------------------------------------------------

describe('mount write scope', () => {
  it('refuses writes after the uploader grant is revoked — zero provider calls', async () => {
    const { provider, calls } = fixtureProvider();
    const app = makeApp(provider);
    const view = await initUpload(app, 'p15');
    const before = calls.length;

    await env.DB.prepare(
      "DELETE FROM mount_grants WHERE user_id = 'user-1'",
    ).run();

    const put = await putChunk(app, view.uploadId, 1, '0', new Uint8Array(6));
    expect(put.status).toBe(403);
    const recon = await postAction(app, view.uploadId, 'reconcile');
    expect(recon.status).toBe(403);
    const resume = await postAction(app, view.uploadId, 'resume');
    expect(resume.status).toBe(403);
    // No remote work happened after revocation.
    expect(calls.length).toBe(before);
  });

  it('refuses a destination parent outside the pinned drive', async () => {
    const { provider, calls } = fixtureProvider({
      getMetadata: (input) => {
        const id = (input.ref as { id: string }).id;
        // Parent sits on a different drive — never writable here.
        return metaFile(id, {
          driveId: 'drive-OTHER',
          capabilities: { canAddChildren: true },
        });
      },
    });
    const app = makeApp(provider);
    const res = await postInit(app, 'p16');
    const v = (await res.json()) as UploadViewBody;
    expect(v.state).toBe('blocked');
    // No generate/startUpload happened — the write was refused up front.
    expect(calls.some((c) => c.method === 'startUpload')).toBe(false);
  });

  it('GET stays owner-readable but performs no remote work', async () => {
    const { provider, calls } = fixtureProvider();
    const app = makeApp(provider);
    const view = await initUpload(app, 'p17');
    const before = calls.length;
    const res = await api(app, `/api/v1/uploads/${view.uploadId}`, {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(before);
    // Outsider gets a 404, not existence leakage.
    const other = makeApp(provider, actorFor({ id: 'user-2', role: 'user' }));
    const denied = await api(other, `/api/v1/uploads/${view.uploadId}`, {
      method: 'GET',
    });
    expect(denied.status).toBe(404);
  });

  it('R12: completion response and tombstone view carry the finalized reader state', async () => {
    // Seed an enabled SA read pool entry so the post-completion probe runs.
    await env.DB.prepare(
      "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-1', 'proj-1', 'sa@test', 'k1', 'env', 1, 1, 0, 0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('mount-1', 'sa-1', 1, 1, 0)",
    ).run();
    const { provider, calls } = fixtureProvider({
      startUpload: () => ({
        kind: 'created-empty' as const,
        file: metaFile('gen-file-1', { size: '0' }),
      }),
      verifyFile: (input) =>
        metaFile((input.ref as { id: string }).id, { size: '0' }),
    });
    const readProvider = {
      getReadMetadata: () =>
        Promise.resolve(
          metaFile('gen-file-1', {
            driveId: 'drive-1',
            capabilities: { canDownload: true },
          }),
        ),
    };
    const app = makeApp(provider, actorFor(USER), {
      readProviderFor: () => readProvider,
    });
    const res = await postInit(app, 'r12', {
      ...defaultInput,
      totalBytes: '0',
    });
    expect(res.status).toBe(200);
    const v = (await res.json()) as UploadViewBody;
    expect(v.state).toBe('completed');
    // The fresh response shows the finalized reader state, never the
    // pre-finalize 'unchecked' snapshot (R12).
    expect(v.readerAccessState).toBe('readable');
    // Tombstone replay preserves the finalized reader state and performs
    // no remote re-work (R7 + R12).
    const remoteCount = calls.length;
    const replay = await postInit(app, 'r12', {
      ...defaultInput,
      totalBytes: '0',
    });
    const rv = (await replay.json()) as UploadViewBody;
    expect(rv.state).toBe('completed');
    expect(rv.readerAccessState).toBe('readable');
    expect(calls.length).toBe(remoteCount);
  });
});
