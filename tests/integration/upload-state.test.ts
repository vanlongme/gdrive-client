/**
 * T07 integration tests: canonical UploadSession state, D1 idempotency
 * index/tombstones, init crash boundaries, immutable pinned writer and
 * generation/attempt fencing — all deterministic through a fixture OAuth
 * provider and a controllable clock. The UploadSession Durable Object is
 * the real miniflare binding; only the Google boundary is faked.
 */

import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  runInDurableObject,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DriveError } from '../../src/worker/drive/errors';
import {
  createSecretBox,
  createSecretKeyring,
  decodeEnvelope,
  encodeEnvelope,
  masterKeyLabel,
} from '../../src/worker/security/vault';
import {
  api,
  defaultInput,
  defaultMeta,
  doPost,
  fakeNow,
  fixtureProvider,
  postAction,
  makeApp,
  metaFile,
  postInit,
  resetState,
  seedBase,
  setNow,
  snapshot,
  stub,
  TEST_MIGRATIONS,
  type UploadViewBody,
} from './upload-fixture';

beforeEach(async () => {
  setNow(1_700_000_000_000);
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  // The /rekey maintenance gate must never leak between tests.
  await env.DB.prepare('DELETE FROM maintenance_state').run();
  await resetState();
  await seedBase();
});

// ---------------------------------------------------------------------------
// T07: idempotent init + uniqueness
// ---------------------------------------------------------------------------

describe('idempotent init', () => {
  it('returns the same uploadId for concurrent same-key inits with one remote generateIds', async () => {
    const { provider, calls } = fixtureProvider();
    const app = makeApp(provider);
    const [a, b] = await Promise.all([
      postInit(app, 'k1'),
      postInit(app, 'k1'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const va = (await a.json()) as UploadViewBody;
    const vb = (await b.json()) as UploadViewBody;
    expect(va.uploadId).toBe(vb.uploadId);
    const genCalls = calls.filter((c) => c.method === 'generateId');
    expect(genCalls.length).toBe(1);
    const ops = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM upload_operations',
    ).first<{ n: number }>();
    expect(ops?.n).toBe(1);
  });

  it('rejects a replayed key carrying a different input digest', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const first = await postInit(app, 'k2');
    expect(first.status).toBe(200);
    const conflict = await postInit(app, 'k2', {
      ...defaultInput,
      name: 'other.bin',
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('requires an Idempotency-Key and a permitted actor', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const missing = await api(app, '/api/v1/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultInput),
    });
    expect(missing.status).toBe(400);

    const denied = makeApp(provider, { kind: 'public' });
    const res = await postInit(denied, 'k3');
    expect([401, 403, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// T07: crash boundaries
// ---------------------------------------------------------------------------

describe('init crash boundaries', () => {
  it('resumes after a crash between D1 insert and DO init', async () => {
    const { provider, calls } = fixtureProvider();
    const app = makeApp(provider);
    // Simulate the crashed attempt: the operation row exists but the DO
    // was never initialized.
    const { inputHashFor, sha256Hex } = await import(
      '../../src/worker/transfers/operations'
    );
    const inputHash = await inputHashFor(defaultInput, 'file');
    const idemHash = await sha256Hex('upload-operation:k4');
    await env.DB.prepare(
      "INSERT INTO upload_operations (id, owner_id, mount_id, kind, idempotency_hash, input_hash, pinned_oauth_connection_id, pinned_principal_id, pinned_oauth_client_id, pinned_project_id, state, summary, created_at, updated_at) VALUES ('upload-crash-1', 'user-1', 'mount-1', 'file', ?, ?, 'conn-1', 'perm-1', 'client-1', 'proj-1', 'created', '{}', 0, 0)",
    )
      .bind(idemHash, inputHash)
      .run();
    const res = await postInit(app, 'k4');
    expect(res.status).toBe(200);
    const view = (await res.json()) as UploadViewBody;
    expect(view.uploadId).toBe('upload-crash-1');
    expect(calls.some((c) => c.method === 'generateId')).toBe(true);
  });

  it('resumes at generateIds after a remote fault with a fresh attempt', async () => {
    let genCalls = 0;
    let fail = true;
    const { provider } = fixtureProvider({
      generateId: () => {
        genCalls += 1;
        if (fail) {
          throw new DriveError('upstream-unavailable', 'fault', {});
        }
        return 'gen-file-9';
      },
    });
    const app = makeApp(provider);
    const first = await postInit(app, 'k5');
    expect(first.status).toBe(200);
    const v1 = (await first.json()) as UploadViewBody;
    expect(v1.state).toBe('preparing');
    expect(genCalls).toBeGreaterThanOrEqual(2);

    fail = false;
    // The stranded claim is only fenced once its lease elapses — a live
    // lease correctly refuses a competing attempt.
    setNow(1_700_000_200_000);
    const second = await postInit(app, 'k5');
    expect(second.status).toBe(200);
    const v2 = (await second.json()) as UploadViewBody;
    expect(v2.state).toBe('uploading');
  });

  it('looks the generated ID up before re-creating when remote init may have landed', async () => {
    let starts = 0;
    const { provider, calls } = fixtureProvider({
      startUpload: () => {
        starts += 1;
        if (starts === 1) {
          throw new DriveError('transport-error', 'lost', {});
        }
        throw new Error('must not re-create: file already exists upstream');
      },
      getMetadata: (input) =>
        defaultMeta((input.ref as { id: string }).id),
      verifyFile: (input) => metaFile((input.ref as { id: string }).id),
    });
    const app = makeApp(provider);
    const first = await postInit(app, 'k6');
    expect(first.status).toBe(200);
    const v1 = (await first.json()) as UploadViewBody;
    const s1 = await snapshot(v1.uploadId);
    expect(s1.snapshot.remoteInitAttempted).toBe(true);
    const second = await postInit(app, 'k6');
    expect(second.status).toBe(200);
    const v2 = (await second.json()) as UploadViewBody;
    // lookup-first found the file → verifying → completed, never re-created.
    expect(v2.state).toBe('completed');
    expect(starts).toBe(1);
    const metaCalls = calls.filter(
      (c) => c.method === 'getMetadata' && c.detail?.includes('gen-file-1'),
    );
    expect(metaCalls.length).toBeGreaterThan(0);
  });

  it('seals the session URI in DO storage — plaintext never persists', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'k7');
    const view = (await res.json()) as UploadViewBody;
    const doStub = stub(view.uploadId);
    const stored = await runInDurableObject(doStub, async (_i, state) => {
      const rows = [
        ...state.storage.sql.exec(
          'SELECT session_uri_envelope FROM session WHERE id = 1',
        ),
      ];
      return rows[0]?.session_uri_envelope as string;
    });
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('googleapis.com');
    expect(stored).not.toContain('upload_id=session-1');
  });
});

// ---------------------------------------------------------------------------
// T07: fencing + immutable pin + tombstones
// ---------------------------------------------------------------------------

describe('fencing, pinning and tombstones', () => {
  it('fences a second chunk claim while an attempt lease is live, then reconciles on expiry', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'k8');
    const view = (await res.json()) as UploadViewBody;
    const claim = await doPost(view.uploadId, '/claim', {
      generation: view.sessionGeneration,
      offset: '0',
      length: 6,
      now: fakeNow,
      leaseMs: 120_000,
    });
    expect(claim.status).toBe(200);
    // Second claim while attempt is live → no competing PUT.
    const second = await doPost(view.uploadId, '/claim', {
      generation: view.sessionGeneration,
      offset: '0',
      length: 6,
      now: fakeNow + 1_000,
      leaseMs: 120_000,
    });
    expect(second.status).toBe(409);
    // Lease expiry → reconciling, still no PUT issued.
    setNow(fakeNow + 130_000);
    const third = await doPost(view.uploadId, '/claim', {
      generation: view.sessionGeneration,
      offset: '0',
      length: 6,
      now: fakeNow,
      leaseMs: 120_000,
    });
    expect(third.status).toBe(409);
    const body = (await third.json()) as { code: string };
    expect(body.code).toBe('UPLOAD_NEEDS_RECONCILIATION');
  });

  it('rejects remote results missing or mismatched attempt/generation fences', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'k9');
    const view = (await res.json()) as UploadViewBody;
    const missing = await doPost(view.uploadId, '/event', {
      event: { type: 'verify-result', outcome: 'ok' },
      now: fakeNow,
    });
    expect(missing.status).toBe(400);
    const wrong = await doPost(view.uploadId, '/event', {
      attemptId: 'init-99',
      generation: 0,
      event: {
        type: 'remote-init-result',
        outcome: {
          kind: 'resumable',
          sessionUri:
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x',
        },
      },
      now: fakeNow,
    });
    expect(wrong.status).toBe(200);
    const body = (await wrong.json()) as { applied: boolean };
    expect(body.applied).toBe(false);
    const s = await snapshot(view.uploadId);
    expect(s.snapshot.state).toBe('uploading');
  });

  it('R13: a late definitive renew verdict settles its own uncertainty — wrong generation cannot', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'k13');
    const view = (await res.json()) as UploadViewBody;
    expect(view.state).toBe('uploading');

    // A live chunk attempt is fenced by lease expiry → reconciling with
    // the write marked uncertain.
    const claim = await doPost(view.uploadId, '/claim', {
      generation: view.sessionGeneration,
      offset: '0',
      length: 6,
      now: fakeNow,
      leaseMs: 120_000,
    });
    expect(claim.status).toBe(200);
    setNow(fakeNow + 130_000);
    const probeRes = await doPost(view.uploadId, '/probe', {
      now: fakeNow + 130_000,
      leaseMs: 120_000,
    });
    const probeBody = (await probeRes.json()) as {
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    expect(probeBody.directive.kind).toBe('probe');

    // Dead session settles the chunk write, then the generated-ID lookup
    // reports absence → a renewal attempt is claimed.
    const expired = await doPost(view.uploadId, '/event', {
      attemptId: probeBody.directive.attemptId,
      generation: probeBody.directive.generation,
      event: { type: 'probe-session-expired' },
      now: fakeNow + 131_000,
    });
    const expiredBody = (await expired.json()) as {
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    expect(expiredBody.directive.kind).toBe('lookup-file');
    const lookupRes = await doPost(view.uploadId, '/event', {
      attemptId: expiredBody.directive.attemptId,
      generation: expiredBody.directive.generation,
      event: { type: 'lookup-absent' },
      now: fakeNow + 132_000,
    });
    const lookupBody = (await lookupRes.json()) as {
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    expect(lookupBody.directive.kind).toBe('renew');
    const renewAttemptId = lookupBody.directive.attemptId as string;
    const renewGeneration = lookupBody.directive.generation as number;

    // Cancel fences the live renew — the create may still land. The chain
    // re-checks the pinned ID, and absence under an unresolved write parks
    // at recoverable cleanup_pending, never cancelled.
    const cancelRes = await doPost(view.uploadId, '/cancel', {
      now: fakeNow + 133_000,
      leaseMs: 120_000,
    });
    const cancelBody = (await cancelRes.json()) as {
      snapshot: { state: string };
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    expect(cancelBody.snapshot.state).toBe('cancel_requested');
    expect(cancelBody.directive.kind).toBe('lookup-file');
    const cancelLookup = await doPost(view.uploadId, '/event', {
      attemptId: cancelBody.directive.attemptId,
      generation: cancelBody.directive.generation,
      event: { type: 'lookup-absent' },
      now: fakeNow + 134_000,
    });
    expect(
      ((await cancelLookup.json()) as { snapshot: { state: string } })
        .snapshot.state,
    ).toBe('cleanup_pending');

    // A renew verdict for the wrong generation is NOT settlement — the
    // marker stays and cleanup keeps proving absence without completing.
    const wrongGen = await doPost(view.uploadId, '/event', {
      attemptId: renewAttemptId,
      generation: renewGeneration + 1,
      event: {
        type: 'renew-result',
        outcome: {
          kind: 'resumable',
          sessionUri:
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s2',
        },
      },
      now: fakeNow + 134_000,
    });
    expect(((await wrongGen.json()) as { applied: boolean }).applied).toBe(
      false,
    );
    const pendingProbe = await doPost(view.uploadId, '/probe', {
      now: fakeNow + 135_000,
      leaseMs: 120_000,
    });
    const pendingBody = (await pendingProbe.json()) as {
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    expect(pendingBody.directive.kind).toBe('lookup-file');
    const absentAgain = await doPost(view.uploadId, '/event', {
      attemptId: pendingBody.directive.attemptId,
      generation: pendingBody.directive.generation,
      event: { type: 'lookup-absent' },
      now: fakeNow + 136_000,
    });
    expect(
      ((await absentAgain.json()) as { snapshot: { state: string } })
        .snapshot.state,
    ).toBe('cleanup_pending');

    // The exact attempt's definitive verdict proves the remote call
    // ended: bookkeeping settles, and the next lookup completes cancel.
    const rightGen = await doPost(view.uploadId, '/event', {
      attemptId: renewAttemptId,
      generation: renewGeneration,
      event: {
        type: 'renew-result',
        outcome: {
          kind: 'resumable',
          sessionUri:
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s2',
        },
      },
      now: fakeNow + 137_000,
    });
    expect(((await rightGen.json()) as { applied: boolean }).applied).toBe(
      false,
    );
    const finalProbe = await doPost(view.uploadId, '/probe', {
      now: fakeNow + 138_000,
      leaseMs: 120_000,
    });
    const finalBody = (await finalProbe.json()) as {
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    expect(finalBody.directive.kind).toBe('lookup-file');
    const absentFinal = await doPost(view.uploadId, '/event', {
      attemptId: finalBody.directive.attemptId,
      generation: finalBody.directive.generation,
      event: { type: 'lookup-absent' },
      now: fakeNow + 139_000,
    });
    expect(
      ((await absentFinal.json()) as { snapshot: { state: string } })
        .snapshot.state,
    ).toBe('cancelled');
  });

  it('keeps the pinned writer immutable after the mount default changes', async () => {
    const { provider, calls } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'k10');
    expect(res.status).toBe(200);
    // Remap the mount to a different write connection after pinning.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-2', 'client-1', 'perm-2', 'w2@test', NULL, '', 'connected', 1, 1, 'admin-1', 0, 0)",
    ).run();
    await env.DB.prepare(
      "UPDATE mounts SET write_connection_id = 'conn-2' WHERE id = 'mount-1'",
    ).run();
    // Replay the init: remote steps must still use conn-1.
    const replay = await postInit(app, 'k10');
    expect(replay.status).toBe(200);
    const remote = calls.filter((c) =>
      ['generateId', 'startUpload', 'getMetadata', 'verifyFile'].includes(
        c.method,
      ),
    );
    expect(remote.length).toBeGreaterThan(0);
    for (const call of remote) {
      expect(call.writerConnectionId).toBe('conn-1');
    }
  });

  it('answers replays from the tombstone after completion without new remote work', async () => {
    const { provider, calls } = fixtureProvider({
      startUpload: () => ({
        kind: 'created-empty' as const,
        file: metaFile('gen-file-1', { size: '0' }),
      }),
      verifyFile: (input) =>
        metaFile((input.ref as { id: string }).id, { size: '0' }),
    });
    const app = makeApp(provider);
    const first = await postInit(app, 'k11', {
      ...defaultInput,
      totalBytes: '0',
    });
    expect(first.status).toBe(200);
    const v1 = (await first.json()) as UploadViewBody;
    expect(v1.state).toBe('completed');
    const remoteCount = calls.length;
    // Replay same key+input: tombstone answers, no remote calls.
    const replay = await postInit(app, 'k11', {
      ...defaultInput,
      totalBytes: '0',
    });
    const v2 = (await replay.json()) as UploadViewBody;
    expect(v2.uploadId).toBe(v1.uploadId);
    expect(v2.state).toBe('completed');
    expect(calls.length).toBe(remoteCount);
    // Even when the file vanished outside the app, the replay still answers
    // the recorded outcome (compact tombstone, spec §6.2).
    const row = await env.DB.prepare(
      'SELECT state, result, generated_file_id, pinned_oauth_connection_id FROM upload_operations WHERE id = ?',
    )
      .bind(v1.uploadId)
      .first<{
        state: string;
        result: string;
        generated_file_id: string;
        pinned_oauth_connection_id: string;
      }>();
    expect(row?.state).toBe('completed');
    expect(row?.generated_file_id).toBe('gen-file-1');
    expect(row?.pinned_oauth_connection_id).toBe('conn-1');
  });

  it('keeps a cancelled tombstone replayable even after detail cleanup', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'k12');
    const view = (await res.json()) as UploadViewBody;
    // Cancel through the real route so the cleanup chain completes.
    const cancel = await postAction(app, view.uploadId, 'cancel');
    expect(((await cancel.json()) as UploadViewBody).state).toBe('cancelled');
    // The operation is cancelled; purge detail like the maintenance job would.
    await env.DB.prepare(
      "UPDATE upload_operations SET summary = NULL, detail_purged_at = 1 WHERE id = ?",
    )
      .bind(view.uploadId)
      .run();
    const replay = await postInit(app, 'k12');
    expect(replay.status).toBe(200);
    const v2 = (await replay.json()) as UploadViewBody;
    expect(v2.uploadId).toBe(view.uploadId);
    expect(v2.state).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// E3 (W4-R1 #3): session-URI envelopes go through the vault keyring — opens
// select the key by the envelope's stored keyId, seals follow the staged
// NEXT key, and an envelope that opens under NO known key is treated like a
// remote session-expired verdict so the renew path runs.
// ---------------------------------------------------------------------------

describe('session-URI keyring and /rekey (E3)', () => {
  // 32 bytes of 0x11 — a key this deployment does NOT hold.
  const FOREIGN_KEY = 'ERERERERERERERERERERERERERERERERERERERERERE=';

  const sessionContext = (uploadId: string) => ({
    provider: 'google-oauth',
    recordId: uploadId,
    projectId: 'proj-1',
    kind: 'resumable-session',
  });

  it('treats an unopenable session envelope as session_expired so renew recovers', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'kr1');
    const view = (await res.json()) as UploadViewBody;
    expect(view.state).toBe('uploading');
    // Overwrite the stored envelope with a well-formed one sealed under a
    // foreign key — no key in this deployment's keyring can open it.
    const foreign = createSecretBox<string>(
      FOREIGN_KEY,
      'v1',
      'upload-session',
    );
    const corrupt = encodeEnvelope(
      await foreign.sealSecret(
        new TextEncoder().encode('https://example.test/session'),
        sessionContext(view.uploadId),
      ),
    );
    const doStub = stub(view.uploadId);
    await runInDurableObject(doStub, async (_i, state) => {
      state.storage.sql.exec(
        'UPDATE session SET session_uri_envelope = ? WHERE id = 1',
        corrupt,
      );
    });
    const claim = await doPost(view.uploadId, '/claim', {
      generation: view.sessionGeneration,
      offset: '0',
      length: 6,
      now: fakeNow,
      leaseMs: 120_000,
    });
    expect(claim.status).toBe(200);
    const body = (await claim.json()) as {
      snapshot: { sessionExpired: boolean; state: string };
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    // The dead envelope takes the same recovery path as a remote 404:
    // expiry flag → generated-ID lookup → renewal — never a silent no-op.
    expect(body.snapshot.sessionExpired).toBe(true);
    expect(body.directive.kind).toBe('lookup-file');
    const lookup = await doPost(view.uploadId, '/event', {
      attemptId: body.directive.attemptId,
      generation: body.directive.generation,
      event: { type: 'lookup-absent' },
      now: fakeNow + 1_000,
    });
    const lb = (await lookup.json()) as {
      directive: { kind: string; attemptId?: string; generation?: number };
    };
    expect(lb.directive.kind).toBe('renew');
  });

  it('re-seals the stored session envelope under the staged key on /rekey', async () => {
    const { provider } = fixtureProvider();
    const app = makeApp(provider);
    const res = await postInit(app, 'kr2');
    const view = (await res.json()) as UploadViewBody;
    expect(view.state).toBe('uploading');
    const doStub = stub(view.uploadId);

    // Refused while no maintenance mode is active.
    const denied = await doPost(view.uploadId, '/rekey', { now: fakeNow });
    expect(denied.status).toBe(409);

    // Stage the next master key inside the DO's env (what a secret change
    // looks like to a live DO instance during a rotation).
    await runInDurableObject(doStub, async (instance) => {
      const holder = instance as unknown as {
        env: Env & { APP_MASTER_KEY_NEXT?: string };
      };
      holder.env = { ...holder.env, APP_MASTER_KEY_NEXT: FOREIGN_KEY };
    });
    await env.DB
      .prepare(
        "INSERT INTO maintenance_state (id, mode, phase, checkpoint, processed_count, verified_count, created_at, updated_at) VALUES (1, 'key-rotation', 'reencrypting', '{}', 0, 0, 0, 0)",
      )
      .run();
    try {
      const res1 = await doPost(view.uploadId, '/rekey', { now: fakeNow });
      expect(res1.status).toBe(200);
      const b1 = (await res1.json()) as { ok: boolean; resealed: boolean };
      expect(b1.resealed).toBe(true);
      const stored = await runInDurableObject(doStub, async (_i, state) => {
        const rows = [
          ...state.storage.sql.exec(
            'SELECT session_uri_envelope FROM session WHERE id = 1',
          ),
        ];
        return rows[0]?.session_uri_envelope as string;
      });
      const envelope = decodeEnvelope(stored);
      expect(envelope.keyId).toBe(await masterKeyLabel(FOREIGN_KEY));
      // The envelope still opens — the keyring selects by stored keyId.
      const ring = createSecretKeyring<string>(
        { APP_MASTER_KEY_NEXT: FOREIGN_KEY },
        'upload-session',
      );
      const opened = await ring.openSecret(
        envelope,
        sessionContext(view.uploadId),
      );
      expect(new TextDecoder().decode(opened)).toContain(
        'upload_id=session-1',
      );
      // Idempotent: already under the write label → resealed, no rewrite.
      const res2 = await doPost(view.uploadId, '/rekey', {
        now: fakeNow + 1,
      });
      expect(res2.status).toBe(200);
      const b2 = (await res2.json()) as { ok: boolean; resealed: boolean };
      expect(b2.resealed).toBe(true);
    } finally {
      await env.DB.prepare('DELETE FROM maintenance_state').run();
    }
  });
});
