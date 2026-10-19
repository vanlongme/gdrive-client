/**
 * W3-E2: real HTTP upload streaming probe (local only, no cloud calls).
 *
 * Source worker: the REAL createUploadRouter + real UploadSession Durable
 * Object + real D1 migrations + real GoogleOAuthProvider +
 * ServiceAccountReadProvider + real DriveTransport. Fixture seams are the
 * same dependency-injection points the router exposes: a fixture Google
 * worker behind a service binding (SINK) answers generateIds / resumable
 * session start / PUT chunks+probe / files.get / files.create, and a
 * fixture CoordinatorTokenSource mints placeholder bearer tokens. Byte
 * bodies are generated in bounded 1 MiB pieces and end-to-end verified at
 * the fixture sink (offset pattern check + SHA-256), so the probe asserts
 * exact streamed content — never buffers the whole file.
 *
 * Run: PATH=/home/ubuntu/.local/node24/bin:$PATH node tests/integration/upload-http-probe.cjs
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require('miniflare');

const MIB = 1024 * 1024;
const CHUNK_SIZE = 8 * MIB; // default route chunk policy (8 MiB)
const TAIL = 3;
const TOTAL = CHUNK_SIZE + TAIL; // 8 MiB exact chunk + short final chunk
const PATTERN_MOD = 251;
const DRIVE_ID = 'drive-local';
const PARENT_ID = 'parent-local';
const TEST_APP_MASTER_KEY =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const byteAt = (i) => i % PATTERN_MOD;

/** Bounded byte generator: at most `width` bytes materialize at once. */
function* bytePieces(start, length, width = MIB) {
  for (let off = 0; off < length; off += width) {
    const n = Math.min(width, length - off);
    const piece = new Uint8Array(n);
    for (let i = 0; i < n; i++) piece[i] = byteAt(start + off + i);
    yield piece;
  }
}

/**
 * Real HTTP PUT with an explicit Content-Length and incremental writes —
 * the route requires the declared length, and pieces go out in bounded
 * 1 MiB writes so the whole file is never materialized client-side.
 */
function httpPut(origin, urlPath, start, length) {
  const target = new URL(urlPath, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(length),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    const it = bytePieces(start, length);
    const write = () => {
      const next = it.next();
      if (next.done) {
        req.end();
        return;
      }
      if (req.write(next.value)) {
        write();
      } else {
        req.once('drain', write);
      }
    };
    write();
  });
}

function digests(start, length) {
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  for (const piece of bytePieces(start, length)) {
    sha.update(piece);
    md5.update(piece);
  }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex') };
}

// ---------------------------------------------------------------------------
// Fixture Google worker (SINK service binding)
// ---------------------------------------------------------------------------

const SINK_SCRIPT = `
const files = new Map();
const sessions = new Map();
const stats = { generateIds: 0, uploadStart: 0, put: 0, probe: 0, filesGet: 0, create: 0, patch: 0, saGet: 0, bytesReceived: 0, reads: 0, ranges: [] };
let genCounter = 0;
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// Checksums of the deterministic client byte pattern, computed Node-side
// and preinjected: the sink never accumulates a whole file. Per-byte
// validation against the same generator already proves the received
// content, so returning this checksum is honest.
const EXPECTED_SHA = 'EXPECTED_SHA256';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Writable-destination fixtures: the pinned drive root and the parent
// folder production proves before any upload session starts.
const staticMeta = new Map([
  ['PARENT_ID', {
    id: 'PARENT_ID', name: 'Probe folder', mimeType: FOLDER_MIME,
    size: '0', modifiedTime: '2026-01-01T00:00:00.000Z', trashed: false,
    driveId: 'DRIVE_ID',
    capabilities: { canDownload: true, canAddChildren: true, canTrash: true, canReadRevisions: true },
  }],
  ['DRIVE_ID', {
    id: 'DRIVE_ID', name: 'Local drive', mimeType: FOLDER_MIME,
    size: '0', modifiedTime: '2026-01-01T00:00:00.000Z', trashed: false,
    driveId: 'DRIVE_ID',
    capabilities: { canDownload: true, canAddChildren: true, canTrash: true, canReadRevisions: true },
  }],
]);

function fileRecord(sess, size) {
  return {
    id: sess.fileId, name: sess.name, mimeType: sess.mimeType,
    size: String(size), modifiedTime: '2026-01-01T00:00:00.000Z',
    trashed: false, parents: sess.parents, driveId: 'DRIVE_ID',
    sha256Checksum: EXPECTED_SHA, headRevisionId: 'rev-1',
    capabilities: { canDownload: true, canAddChildren: true, canTrash: true, canReadRevisions: true },
  };
}

export default {
  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === '/stats') {
      return Response.json(stats);
    }
    if (u.hostname !== 'www.googleapis.com') {
      return new Response('off-fixture host', { status: 400 });
    }
    const auth = request.headers.get('authorization');
    const isOAuth = auth === 'Bearer oauth-local-fixture';
    const isSA = auth === 'Bearer sa-local-fixture';
    if (!isOAuth && !isSA) return new Response('bad auth', { status: 401 });

    if (request.method === 'GET' && u.pathname === '/drive/v3/files/generateIds') {
      stats.generateIds += 1;
      return Response.json({ ids: ['gen-file-' + ++genCounter] });
    }

    if (request.method === 'GET' && u.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(u.pathname.slice('/drive/v3/files/'.length));
      if (isSA) stats.saGet += 1; else stats.filesGet += 1;
      const rec = files.get(id) ?? staticMeta.get(id);
      if (rec === undefined) {
        return Response.json({ error: { code: 404, message: 'not found', errors: [] } }, { status: 404 });
      }
      if (isSA && rec.name === 'blocked.bin') {
        return Response.json({ ...rec, capabilities: { ...rec.capabilities, canDownload: false } });
      }
      return Response.json(rec);
    }

    if (request.method === 'PATCH' && u.pathname.startsWith('/drive/v3/files/')) {
      stats.patch += 1;
      const id = decodeURIComponent(u.pathname.slice('/drive/v3/files/'.length));
      const rec = files.get(id);
      if (rec === undefined) return Response.json({ error: { code: 404, message: 'nf', errors: [] } }, { status: 404 });
      rec.trashed = true;
      return Response.json(rec);
    }

    if (request.method === 'POST' && u.pathname === '/upload/drive/v3/files' && u.searchParams.get('uploadType') === 'resumable') {
      stats.uploadStart += 1;
      const meta = await request.json();
      const uploadId = 'sess-' + (sessions.size + 1);
      sessions.set(uploadId, {
        fileId: meta.id, name: meta.name, mimeType: meta.mimeType,
        parents: meta.parents, received: 0,
      });
      return new Response(null, {
        status: 200,
        headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + uploadId },
      });
    }

    if (request.method === 'PUT' && u.pathname === '/upload/drive/v3/files') {
      const sess = sessions.get(u.searchParams.get('upload_id'));
      if (sess === undefined) return new Response('unknown session', { status: 404 });
      const range = request.headers.get('content-range') ?? '';
      const probeMatch = /^bytes \\*\\/([0-9]+)$/.exec(range);
      if (probeMatch !== null) {
        stats.probe += 1;
        const total = Number(probeMatch[1]);
        if (sess.received >= total) {
          return Response.json(files.get(sess.fileId), { status: 200 });
        }
        const headers = sess.received === 0 ? {} : { range: 'bytes=0-' + (sess.received - 1) };
        return new Response(null, { status: 308, headers });
      }
      const m = /^bytes ([0-9]+)-([0-9]+)\\/([0-9]+)$/.exec(range);
      if (m === null) return new Response('bad content-range: ' + range, { status: 400 });
      const start = Number(m[1]); const end = Number(m[2]); const total = Number(m[3]);
      if (start !== sess.received) return new Response('offset mismatch ' + start + ' != ' + sess.received, { status: 409 });
      stats.put += 1;
      stats.ranges.push(range);
      const reader = request.body.getReader();
      let count = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stats.reads += 1;
        for (let i = 0; i < value.length; i++) {
          if (value[i] !== (sess.received + i) % 251) {
            return new Response('byte mismatch at absolute ' + (sess.received + i), { status: 400 });
          }
        }
        sess.received += value.length;
        count += value.length;
      }
      if (count !== end - start + 1) return new Response('length mismatch', { status: 400 });
      stats.bytesReceived += count;
      if (sess.received < total) {
        return new Response(null, { status: 308, headers: { range: 'bytes=0-' + (sess.received - 1) } });
      }
      const rec = fileRecord(sess, total);
      files.set(sess.fileId, rec);
      return Response.json(rec, { status: 200 });
    }

    if (request.method === 'POST' && u.pathname === '/drive/v3/files') {
      stats.create += 1;
      const meta = await request.json();
      const rec = {
        id: meta.id, name: meta.name, mimeType: meta.mimeType,
        size: '0', modifiedTime: '2026-01-01T00:00:00.000Z',
        trashed: false, parents: meta.parents, driveId: 'DRIVE_ID',
        sha256Checksum: EMPTY_SHA, headRevisionId: 'rev-1',
        capabilities: { canDownload: true, canAddChildren: true, canTrash: true, canReadRevisions: true },
      };
      files.set(meta.id, rec);
      return Response.json(rec, { status: 200 });
    }

    return new Response('unhandled fixture route: ' + request.method + ' ' + u.pathname + u.search, { status: 400 });
  },
};
`;

// ---------------------------------------------------------------------------
// App worker bundle: real router + DO + providers + transport
// ---------------------------------------------------------------------------

const WORKER_SOURCE = `
import { Hono } from 'hono';
import { createUploadRouter } from './src/worker/transfers/upload-routes.ts';
import { createGoogleOAuthProvider } from './src/worker/drive/providers/google-oauth.ts';
import { createServiceAccountReadProvider } from './src/worker/drive/providers/service-account-read.ts';
import { createDriveTransport } from './src/worker/drive/transport.ts';
export { UploadSession } from './src/worker/objects/upload-session.ts';

const tokenSource = {
  getToken: async (identity) => {
    if (identity.provider === 'google_oauth') {
      return { ok: true, accessToken: 'oauth-local-fixture', expiresAtMs: Date.now() + 60000 };
    }
    if (identity.provider === 'service_account') {
      return { ok: true, accessToken: 'sa-local-fixture', expiresAtMs: Date.now() + 60000 };
    }
    throw new Error('unexpected token identity provider');
  },
  reportFailure: async () => {},
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__do-snapshot') {
      const stub = env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName(url.searchParams.get('id')));
      return stub.fetch('https://upload-session.internal/snapshot');
    }
    if (url.pathname === '/__stats') {
      return env.SINK.fetch('https://www.googleapis.com/stats');
    }
    const oauthTransport = createDriveTransport('google_oauth', {
      fetchImpl: (input, init) => env.SINK.fetch(input, init),
    });
    const provider = createGoogleOAuthProvider({ tokenSource, transport: oauthTransport });
    const saTransport = createDriveTransport('service_account', {
      fetchImpl: (input, init) => env.SINK.fetch(input, init),
    });
    const readProvider = createServiceAccountReadProvider({ tokenSource, transport: saTransport });
    const app = new Hono();
    app.route('/api/v1/uploads', createUploadRouter({
      providerFor: () => provider,
      readProviderFor: () => readProvider,
      resolveActorFn: async () => ({
        kind: 'user',
        user: {
          id: 'user-1', name: 'Probe', email: 'probe@test',
          role: 'user', disabled: false,
          createdAt: new Date(0).toISOString(),
        },
        sessionId: 'sess-probe',
      }),
    }));
    return app.fetch(request, env);
  },
};
`;

function splitSqlStatements(sql) {
  const noComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return noComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

async function seedD1(db, rootDir) {
  for (const file of fs.readdirSync(path.join(rootDir, 'migrations')).sort()) {
    if (!file.endsWith('.sql')) continue;
    const sql = fs.readFileSync(path.join(rootDir, 'migrations', file), 'utf8');
    const stmts = splitSqlStatements(sql).map((stmt) => db.prepare(stmt));
    if (stmts.length > 0) await db.batch(stmts);
  }
  const inserts = [
    "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1','Probe','probe@test',1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')",
    "INSERT INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('client-local','proj-local','cid-local','unused','https://app.test/cb',1,1,0,0)",
    "INSERT INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-local','client-local','perm-local','w@test',NULL,'','connected',1,1,'user-1',0,0)",
    "INSERT INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('m-local','Local','drive-local','drive-local','conn-local','conn-local',1,'private',1,0,0)",
    "INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES ('user-1','m-local','uploader','[\"read\",\"upload\"]','user-1',0,0)",
    "INSERT INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-local','proj-local','sa@local.test','key','unused',1,1,0,0)",
    "INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('m-local','sa-local',1,1,0)",
    "INSERT INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) VALUES (1,'install-local','complete','https://app.test',1,0,0)",
  ];
  for (const sql of inserts) await db.prepare(sql).run();
}

async function json(res, label) {
  const text = await res.text();
  return jsonText(res.status, text, label);
}

function jsonText(status, text, label) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label}: non-JSON ${status}: ${text.slice(0, 300)}`);
  }
  if (status !== 200) {
    throw new Error(`${label}: HTTP ${status}: ${text.slice(0, 300)}`);
  }
  return body;
}

async function main() {
  // Digests over the deterministic pattern — computed in bounded pieces,
  // then preinjected into the fixture so it never accumulates the file.
  const content = digests(0, TOTAL);
  const sinkScript = SINK_SCRIPT.replaceAll('EXPECTED_SHA256', content.sha256)
    .replaceAll('DRIVE_ID', DRIVE_ID)
    .replaceAll('PARENT_ID', PARENT_ID);
  const bundle = await build({
    stdin: {
      contents: WORKER_SOURCE,
      resolveDir: process.cwd(),
      sourcefile: 'w3-upload-http-worker.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['cloudflare:*', 'node:*'],
  });

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      port: 0,
      log: new Log({ level: LogLevel.ERROR }),
      verbose: false,
      workers: [
        {
          name: 'app',
          modules: true,
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          script: bundle.outputFiles[0].text,
          bindings: { APP_MASTER_KEY: TEST_APP_MASTER_KEY },
          d1Databases: { DB: 'w3-upload-local' },
          durableObjects: {
            UPLOAD_SESSION: {
              className: 'UploadSession',
              useSQLite: true,
            },
          },
          serviceBindings: { SINK: 'sink' },
        },
        {
          name: 'sink',
          modules: true,
          compatibilityDate: '2026-10-01',
          compatibilityFlags: ['nodejs_compat'],
          script: sinkScript,
        },
      ],
    }),
  );

  const results = { checks: [] };
  try {
    const db = await mf.getD1Database('DB');
    await seedD1(db, process.cwd());
    const origin = await mf.ready;
    const api = (p) => new URL(p, origin).toString();
    const stats = async () => (await fetch(api('/__stats'))).json();
    const doSnapshot = async (id) =>
      (await fetch(api(`/__do-snapshot?id=${id}`))).json();

    const initBody = {
      mountId: 'm-local',
      parentId: PARENT_ID,
      name: 'probe.bin',
      mimeType: 'application/octet-stream',
      totalBytes: String(TOTAL),
      sha256: content.sha256,
      md5: content.md5,
    };

    // -- init: real POST through router -> DO init -> generateIds -> resumable
    const initViews = await Promise.all(
      [0, 1].map(async (index) => json(await fetch(api('/api/v1/uploads'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-main',
        },
        body: JSON.stringify(initBody),
      }), `concurrent-init-${index}`)),
    );
    assert.equal(typeof initViews[0].uploadId, 'string');
    assert.equal(initViews[0].uploadId, initViews[1].uploadId);
    // The losing request may observe preparing while the winner owns init.
    // Once both finish, the read-only HTTP state must show the single session.
    const init = await json(
      await fetch(api(`/api/v1/uploads/${initViews[0].uploadId}`)),
      'init-state',
    );
    const initStats = await stats();
    assert.equal(initStats.generateIds, 1);
    assert.equal(initStats.uploadStart, 1);
    results.checks.push('concurrent-init-single-operation');
    assert.equal(init.state, 'uploading');
    assert.equal(init.confirmedOffset, '0');
    const uploadId = init.uploadId;
    const generation = init.sessionGeneration;
    results.checks.push('init-ok');

    // -- idempotent replay: same key+input answers the same operation
    const replay = await json(
      await fetch(api('/api/v1/uploads'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-main',
        },
        body: JSON.stringify(initBody),
      }),
      'idempotent-replay',
    );
    assert.equal(replay.uploadId, uploadId);
    let st = await stats();
    assert.equal(st.generateIds, 1);
    assert.equal(st.uploadStart, 1);
    results.checks.push('idempotent-replay');

    const conflict = await fetch(api('/api/v1/uploads'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idem-main',
      },
      body: JSON.stringify({ ...initBody, name: 'other.bin' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
    results.checks.push('idempotency-conflict-409');

    // -- DO snapshot: session pinned, zero bytes through the DO itself
    let snap = await doSnapshot(uploadId);
    assert.equal(snap.ok, true);
    assert.equal(snap.snapshot.state, 'uploading');
    assert.equal(snap.snapshot.confirmedOffset, '0');
    assert.equal(snap.snapshot.hasSessionUri, true);
    assert.equal(snap.snapshot.generatedFileId, 'gen-file-1');
    results.checks.push('do-pinned-session');

    // -- chunk 1: exact 8 MiB streamed via HTTP PUT
    const put1res = await httpPut(
      origin,
      `/api/v1/uploads/${uploadId}/chunks?generation=${generation}&offset=0`,
      0,
      CHUNK_SIZE,
    );
    const put1 = jsonText(put1res.status, put1res.text, 'put-chunk-1');
    assert.equal(put1.state, 'uploading');
    assert.equal(put1.confirmedOffset, String(CHUNK_SIZE));
    st = await stats();
    assert.equal(st.put, 1);
    assert.equal(st.bytesReceived, CHUNK_SIZE);
    assert.deepEqual(st.ranges, [`bytes 0-${CHUNK_SIZE - 1}/${TOTAL}`]);
    results.checks.push('chunk-8mib-streamed');

    snap = await doSnapshot(uploadId);
    assert.equal(snap.snapshot.confirmedOffset, String(CHUNK_SIZE));
    assert.equal(snap.snapshot.state, 'uploading');

    // -- healthy reconcile: no uncertainty, so no session probe is owed
    const rec = await json(
      await fetch(api(`/api/v1/uploads/${uploadId}/reconcile`), {
        method: 'POST',
      }),
      'reconcile',
    );
    assert.equal(rec.state, 'uploading');
    assert.equal(rec.confirmedOffset, String(CHUNK_SIZE));
    st = await stats();
    assert.equal(st.probe, 0);
    results.checks.push('reconcile-healthy-noop');

    // -- chunk 2: final short chunk -> completed file -> verify -> completed
    const put2res = await httpPut(
      origin,
      `/api/v1/uploads/${uploadId}/chunks?generation=${generation}&offset=${CHUNK_SIZE}`,
      CHUNK_SIZE,
      TAIL,
    );
    const put2 = jsonText(put2res.status, put2res.text, 'put-chunk-2');
    assert.equal(put2.state, 'completed');
    assert.equal(put2.confirmedOffset, String(TOTAL));
    st = await stats();
    assert.equal(st.put, 2);
    assert.equal(st.bytesReceived, TOTAL);
    assert.equal(st.ranges[1], `bytes ${CHUNK_SIZE}-${TOTAL - 1}/${TOTAL}`);
    assert.ok(st.filesGet >= 1);
    results.checks.push('final-chunk-completed');

    // Reader axis (strict): the completing PUT's response view must carry
    // the finalized reader state once the SA check ran in-request. R12
    // defect: upload-routes snapshots the view before finalizeReaderAccess
    // — tracked as an explicit failure until C's fix lands.
    assert.ok(st.saGet >= 1);
    try {
      assert.equal(put2.readerAccessState, 'readable');
      results.checks.push('reader-access-response-readable');
    } catch {
      (results.failures ??= []).push(
        "reader-access-response-readable: PUT response shows stale 'unchecked' (R12, awaiting C fix)",
      );
    }
    snap = await doSnapshot(uploadId);
    assert.equal(snap.snapshot.state, 'completed');
    assert.equal(snap.snapshot.confirmedOffset, String(TOTAL));
    assert.equal(snap.snapshot.readerAccessState, 'readable');
    const opRow = await db
      .prepare(
        'SELECT state, generated_file_id, result FROM upload_operations WHERE id = ?',
      )
      .bind(uploadId)
      .first();
    assert.equal(opRow.state, 'completed');
    assert.equal(opRow.generated_file_id, 'gen-file-1');
    const opResult = JSON.parse(opRow.result);
    assert.equal(opResult.outcome, 'completed');
    assert.equal(opResult.verification, 'sha256');
    const ready = await db
      .prepare(
        'SELECT reader_access_state FROM file_readiness WHERE mount_id = ? AND file_id = ?',
      )
      .bind('m-local', 'gen-file-1')
      .first();
    assert.equal(ready.reader_access_state, 'readable');
    results.checks.push('d1-projection-tombstone');

    // -- terminal replay after detail purge: the permanent result is sufficient.
    await db.prepare(
      'UPDATE upload_operations SET summary = NULL, detail_purged_at = 1 WHERE id = ?',
    ).bind(uploadId).run();
    const statsBefore = st;
    const replay2 = await json(
      await fetch(api('/api/v1/uploads'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-main',
        },
        body: JSON.stringify(initBody),
      }),
      'tombstone-replay',
    );
    assert.equal(replay2.state, 'completed');
    assert.equal(replay2.uploadId, uploadId);
    assert.equal(replay2.totalBytes, String(TOTAL));
    assert.equal(replay2.confirmedOffset, String(TOTAL));
    assert.equal(replay2.sessionGeneration, generation);
    assert.equal(replay2.readerAccessState, 'readable');
    st = await stats();
    assert.deepEqual(
      { g: st.generateIds, u: st.uploadStart, p: st.put },
      { g: statsBefore.generateIds, u: statsBefore.uploadStart, p: statsBefore.put },
    );
    results.checks.push('terminal-tombstone-replay');

    // -- zero-byte upload: metadata-only create + verify, no session/PUT
    const empty = digests(0, 0);
    const zeroInit = await json(
      await fetch(api('/api/v1/uploads'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-zero',
        },
        body: JSON.stringify({ ...initBody, name: 'empty.bin', totalBytes: '0', sha256: empty.sha256, md5: empty.md5 }),
      }),
      'zero-byte-init',
    );
    assert.equal(zeroInit.state, 'completed');
    st = await stats();
    assert.equal(st.create, 1);
    assert.equal(st.uploadStart, 1); // still only the first upload's session
    assert.equal(st.put, 2); // no chunks for the empty file
    assert.equal(st.bytesReceived, TOTAL);
    results.checks.push('zero-byte-completed');

    const zeroSnap = await doSnapshot(zeroInit.uploadId);
    assert.equal(zeroSnap.snapshot.state, 'completed');
    assert.equal(zeroSnap.snapshot.hasSessionUri, false);
    results.checks.push('zero-byte-no-session');

    // -- cancel after a confirmed partial chunk: real probeUpload on the
    //    session URI (308 Range), generated-ID lookup 404 -> proven-absent
    //    -> cancelled. A follow-up reconcile re-runs the lookup and stays
    //    cancelled (R4 late-create re-check).
    const cancelInit = await json(
      await fetch(api('/api/v1/uploads'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-cancel',
        },
        body: JSON.stringify({ ...initBody, name: 'cancel.bin' }),
      }),
      'cancel-init',
    );
    assert.equal(cancelInit.state, 'uploading');
    const cancelId = cancelInit.uploadId;
    const cancelGen = cancelInit.sessionGeneration;
    const cancelPut = await httpPut(
      origin,
      `/api/v1/uploads/${cancelId}/chunks?generation=${cancelGen}&offset=0`,
      0,
      CHUNK_SIZE,
    );
    const cancelPutView = jsonText(cancelPut.status, cancelPut.text, 'cancel-put');
    assert.equal(cancelPutView.state, 'uploading');
    const statsBeforeCancel = await stats();
    const cancelRes = await json(
      await fetch(api(`/api/v1/uploads/${cancelId}/cancel`), {
        method: 'POST',
      }),
      'cancel',
    );
    assert.equal(cancelRes.state, 'cancelled');
    st = await stats();
    assert.equal(st.probe, 1); // real bytes */total probeUpload on the session URI
    assert.ok(st.filesGet > statsBeforeCancel.filesGet); // generated-ID lookup
    assert.equal(st.put, 3); // no further chunk PUTs after cancel
    const cancelSnap = await doSnapshot(cancelId);
    assert.equal(cancelSnap.snapshot.state, 'cancelled');
    const cancelOp = await db
      .prepare('SELECT state, result FROM upload_operations WHERE id = ?')
      .bind(cancelId)
      .first();
    assert.equal(cancelOp.state, 'cancelled');
    results.checks.push('cancel-probe-lookup-cancelled');

    const cancelReconcile = await json(
      await fetch(api(`/api/v1/uploads/${cancelId}/reconcile`), {
        method: 'POST',
      }),
      'cancel-reconcile',
    );
    assert.equal(cancelReconcile.state, 'cancelled');
    st = await stats();
    assert.equal(st.probe, 1); // lookup-file only; no new session probe
    results.checks.push('cancelled-reconcile-relookup');

    // OAuth completion is independent of a definitive SA download restriction.
    const blockedBody = {
      ...initBody, name: 'blocked.bin', totalBytes: '0',
      sha256: empty.sha256, md5: empty.md5,
    };
    const blockedInit = async () => json(await fetch(api('/api/v1/uploads'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-blocked-reader' },
      body: JSON.stringify(blockedBody),
    }), 'completed-reader-blocked');
    const blocked = await blockedInit();
    assert.equal(blocked.state, 'completed');
    assert.equal(blocked.readerAccessState, 'blocked');
    const beforeBlockedReplay = await stats();
    await db.prepare(
      'UPDATE upload_operations SET summary = NULL, detail_purged_at = 1 WHERE id = ?',
    ).bind(blocked.uploadId).run();
    const blockedReplay = await blockedInit();
    assert.equal(blockedReplay.uploadId, blocked.uploadId);
    assert.equal(blockedReplay.state, 'completed');
    assert.equal(blockedReplay.readerAccessState, 'blocked');
    st = await stats();
    assert.deepEqual(st, beforeBlockedReplay);
    results.checks.push('completed-reader-blocked-no-recreate-after-purge');

    results.totalBytes = TOTAL;
    results.sinkStats = st;
    results.note =
      'Real HTTP -> real upload router -> real UploadSession DO + D1 -> real OAuth provider/transport -> fixture Google worker. ' +
      'DO observed via /snapshot only (JSON commands; bytes never enter it).';
    results.status = results.failures === undefined ? 'PASS' : 'FAIL';
    console.log(JSON.stringify(results, null, 1));
    if (results.failures !== undefined) {
      process.exitCode = 1;
    }
  } finally {
    await mf.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
