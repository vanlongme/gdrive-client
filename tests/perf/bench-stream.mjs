#!/usr/bin/env node
/**
 * Streaming resource-budget bench (T15, wave-5 worker C).
 *
 * Streams a bounded, generated-only body (never written to disk) through the
 * real worker code paths, hosted by Miniflare 5 (workerd) with the real D1
 * schema and the real UploadSession Durable Object:
 *
 *   download  GET /api/v1/mounts/mount-1/files/f-1/content  — the production
 *             content/download router streaming the SA provider body out.
 *   range     the same route with single Range requests (206 path).
 *   upload    POST /api/v1/uploads + PUT .../chunks — the production resumable
 *             upload path: request body -> UploadSession DO claim -> provider
 *             putChunk stream -> D1 projection.
 *
 * Provider boundaries are the existing test seams (fixture providers injected
 * via deps), so nothing touches Google. Measured per scenario:
 *   - first-byte latency (download/range: request -> first body byte)
 *   - end-to-end wall time and throughput (MiB/s of payload)
 *   - workerd process RSS baseline/peak/delta, sampled from /proc every 50 ms
 *     (summed VmRSS of workerd children of this harness process)
 *   - D1 statement counts and UploadSession DO stub fetches, counted inside
 *     the fixture worker and diffed per scenario (GET /_perf/counters)
 *
 * Usage:
 *   node tests/perf/bench-stream.mjs [--scenario all|download|range|upload]
 *       [--size-mib 1024] [--chunk-mib 8] [--ranges 8] [--range-mib 64]
 *       [--repeat 1] [--json]
 *
 * A fixture run measures the LOCAL worker pipeline only — it is never
 * evidence for live Google transfer of any size.
 */

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorkerdSampler, workerdRssKb } from "./lib/proc.mjs";
import { patternBlock, patternSlice, hashPattern, parseFlags } from "./lib/pattern.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIB = 1024 * 1024;
const MOUNT = "mount-1";
const FILE = "f-1";

const HELP = `bench-stream.mjs — bounded streaming budget bench (local fixture, no Google)

Options:
  --scenario <all|download|range|upload>  which scenario(s) to run (default: all)
  --size-mib <n>    generated object size in MiB (default: 1024)
  --chunk-mib <n>   upload chunk size in MiB (default: 8; must be <= 8, the
                    worker's MAX_CHUNK_BYTES policy)
  --ranges <n>      number of ranged GETs in the range scenario (default: 8)
  --range-mib <n>   bytes per ranged GET in MiB (default: 64)
  --repeat <n>      repeat each scenario n times (default: 1)
  --json            print the machine-readable result object only
  --help            show this help

Method notes are embedded in each result; workerd RSS is summed /proc VmRSS of
workerd children of this harness, sampled every 50 ms.`;

function die(msg) {
  console.error(`bench-stream: ${msg}`);
  process.exit(2);
}

async function bundleFixture() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, "tests/perf/fixture-entry.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "esnext",
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

async function applyMigrations(db) {
  // Same splitter the vitest plugin uses for the checked-in migrations;
  // each parsed statement is applied in file order.
  const migrations = await readD1Migrations(path.join(ROOT, "migrations"));
  for (const migration of migrations) {
    for (const query of migration.queries) {
      await db.prepare(query).run();
    }
  }
}

async function seed(db) {
  const stmts = [
    "INSERT OR REPLACE INTO app_settings (id, installation_id, setup_state, canonical_origin, version, created_at, updated_at) VALUES (1, 'install-1', 'complete', 'http://perf.local', 1, 0, 0)",
    "INSERT OR REPLACE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('admin-1', 'Perf Admin', 'perf-admin@test', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
    "INSERT OR REPLACE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', 'Perf User', 'perf-user@test', 1, '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')",
    "INSERT OR REPLACE INTO google_oauth_clients (id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) VALUES ('client-1', 'proj-1', 'cid', 'env', 'http://perf.local/cb', 1, 1, 0, 0)",
    "INSERT OR REPLACE INTO google_connections (id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, state, enabled, version, connected_by, created_at, updated_at) VALUES ('conn-1', 'client-1', 'perm-1', 'w@test', NULL, '', 'connected', 1, 1, 'admin-1', 0, 0)",
    "INSERT OR REPLACE INTO mounts (id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) VALUES ('mount-1', 'Perf', 'drive-1', 'drive-1', 'conn-1', 'conn-1', 1, 'private', 1, 0, 0)",
    "INSERT OR REPLACE INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) VALUES ('user-1', 'mount-1', 'uploader', '[\"read\",\"upload\"]', 'admin-1', 0, 0)",
    "INSERT OR REPLACE INTO service_accounts (id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) VALUES ('sa-1', 'proj-1', 'sa-1@proj-1.iam.gserviceaccount.com', 'k1', 'env', 1, 1, 0, 0)",
    "INSERT OR REPLACE INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) VALUES ('mount-1', 'sa-1', 1, 1, 0)",
  ];
  for (const sql of stmts) await db.prepare(sql).run();
}

function mib(bytes) {
  return bytes / MIB;
}

async function getCounters(mfFetch) {
  const res = await mfFetch("/_perf/counters");
  return res.json();
}

function counterDelta(before, after) {
  const flat = (c) => ({
    d1:
      c.d1.prepare + c.d1.exec + c.d1.batch +
      c.d1.first + c.d1.all + c.d1.run + c.d1.raw,
    doStubFetches: c.doStubFetches,
    providerRead: c.providerRead,
    providerWrite: c.providerWrite,
    upstreamBytesRead: c.upstreamBytesRead,
    upstreamBytesWritten: c.upstreamBytesWritten,
  });
  const b = flat(before);
  const a = flat(after);
  const calls = (x, y) => {
    const out = {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      out[k] = (y[k] ?? 0) - (x[k] ?? 0);
    }
    return out;
  };
  return {
    d1Operations: a.d1 - b.d1,
    doStubFetches: a.doStubFetches - b.doStubFetches,
    providerReadCalls: calls(b.providerRead, a.providerRead),
    providerWriteCalls: calls(b.providerWrite, a.providerWrite),
    upstreamBytesRead: a.upstreamBytesRead - b.upstreamBytesRead,
    upstreamBytesWritten: a.upstreamBytesWritten - b.upstreamBytesWritten,
  };
}

async function measure(mfFetch, fn) {
  await mfFetch("/_perf/reset");
  const sampler = startWorkerdSampler(50);
  const baselineKb = workerdRssKb();
  const countersBefore = await getCounters(mfFetch);
  const t0 = performance.now();
  const extra = await fn();
  const wallMs = performance.now() - t0;
  const countersAfter = await getCounters(mfFetch);
  const { peakKb } = sampler.stop();
  return {
    wallMs,
    counters: counterDelta(countersBefore, countersAfter),
    workerdRss: {
      baselineKb,
      peakKb,
      deltaKb: peakKb - baselineKb,
      method:
        "summed VmRSS of workerd descendant processes of this harness, " +
        "sampled from /proc every 50 ms; baseline taken post-warmup, " +
        "peak during the scenario",
    },
    harnessRssBytes: process.memoryUsage().rss,
    ...extra,
  };
}

async function scenarioDownload(mfFetch, totalBytes) {
  const url = `/api/v1/mounts/${MOUNT}/files/${FILE}/content`;
  return measure(mfFetch, async () => {
    const t0 = performance.now();
    const res = await mfFetch(url);
    if (res.status !== 200) {
      throw new Error(`download status ${res.status}: ${await res.text()}`);
    }
    const reader = res.body.getReader();
    let bytes = 0;
    let firstByteMs = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs < 0) firstByteMs = performance.now() - t0;
      bytes += value.byteLength;
    }
    if (bytes !== totalBytes) {
      throw new Error(`short body: ${bytes} != ${totalBytes}`);
    }
    return {
      bytes,
      firstByteMs,
      throughputMiBs: mib(bytes) / ((performance.now() - t0) / 1000),
    };
  });
}

async function scenarioRange(mfFetch, totalBytes, ranges, rangeBytes) {
  const url = `/api/v1/mounts/${MOUNT}/files/${FILE}/content`;
  const span = Math.max(1, Math.floor(totalBytes / ranges) - rangeBytes);
  const latencies = [];
  let bytes = 0;
  return measure(mfFetch, async () => {
    for (let i = 0; i < ranges; i += 1) {
      const start = i * (span + rangeBytes);
      const end = start + rangeBytes - 1;
      const t0 = performance.now();
      const res = await mfFetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (res.status !== 206) {
        throw new Error(`range status ${res.status}: ${await res.text()}`);
      }
      const reader = res.body.getReader();
      let got = 0;
      let firstByteMs = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByteMs < 0) firstByteMs = performance.now() - t0;
        got += value.byteLength;
      }
      if (got !== rangeBytes) {
        throw new Error(`short range body: ${got} != ${rangeBytes}`);
      }
      latencies.push({ firstByteMs, totalMs: performance.now() - t0 });
      bytes += got;
    }
    return {
      bytes,
      requests: ranges,
      rangeBytes,
      firstByteMs: {
        min: Math.min(...latencies.map((l) => l.firstByteMs)),
        mean:
          latencies.reduce((s, l) => s + l.firstByteMs, 0) / latencies.length,
        max: Math.max(...latencies.map((l) => l.firstByteMs)),
      },
      throughputMiBs:
        mib(bytes) /
        (latencies.reduce((s, l) => s + l.totalMs, 0) / 1000),
    };
  });
}

async function scenarioUpload(mfFetch, totalBytes, chunkBytes, block, hashes) {
  const chunks = Math.ceil(totalBytes / chunkBytes);
  const chunkLatencies = [];
  return measure(mfFetch, async () => {
    const init = await mfFetch("/api/v1/uploads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `perf-${Date.now()}`,
      },
      body: JSON.stringify({
        mountId: MOUNT,
        parentId: "parent-1",
        name: "perf.bin",
        mimeType: "application/octet-stream",
        totalBytes: String(totalBytes),
        sha256: hashes.sha256,
        md5: hashes.md5,
      }),
    });
    if (init.status !== 200 && init.status !== 201) {
      throw new Error(`init status ${init.status}: ${await init.text()}`);
    }
    const view = await init.json();
    const uploadId = view.uploadId;
    const generation = view.sessionGeneration;
    let offset = 0;
    for (let i = 0; i < chunks; i += 1) {
      const len = Math.min(chunkBytes, totalBytes - offset);
      const body = patternSlice(block, len);
      const t0 = performance.now();
      const res = await mfFetch(
        `/api/v1/uploads/${uploadId}/chunks?generation=${generation}&offset=${offset}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(len),
          },
          body,
        },
      );
      chunkLatencies.push(performance.now() - t0);
      if (res.status !== 200) {
        throw new Error(`chunk ${i} status ${res.status}: ${await res.text()}`);
      }
      const v = await res.json();
      offset += len;
      if (i === chunks - 1 && v.state !== "completed") {
        throw new Error(`final chunk state ${v.state}`);
      }
    }
    const sorted = [...chunkLatencies].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return {
      bytes: totalBytes,
      chunks,
      chunkBytes,
      chunkLatencyMs: {
        min: sorted[0],
        mean: chunkLatencies.reduce((a, b) => a + b, 0) / chunks,
        p95,
        max: sorted[sorted.length - 1],
      },
      throughputMiBs: undefined, // filled by caller via wallMs
    };
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), {
    scenario: "all",
    "size-mib": "1024",
    "chunk-mib": "8",
    ranges: "8",
    "range-mib": "64",
    repeat: "1",
    json: false,
  });
  if (flags.help) {
    console.log(HELP);
    return;
  }
  const scenario = flags.scenario;
  if (!["all", "download", "range", "upload"].includes(scenario)) {
    die(`--scenario must be all|download|range|upload`);
  }
  const sizeMib = Number(flags["size-mib"]);
  const chunkMib = Number(flags["chunk-mib"]);
  const ranges = Number(flags.ranges);
  const rangeMib = Number(flags["range-mib"]);
  const repeat = Number(flags.repeat);
  if (!(sizeMib > 0) || !(chunkMib > 0) || chunkMib > 8) {
    die("--size-mib must be > 0 and --chunk-mib in 1..8");
  }
  const totalBytes = sizeMib * MIB;
  const chunkBytes = chunkMib * MIB;
  const rangeBytes = rangeMib * MIB;

  const block = patternBlock();
  const hashes = hashPattern(block, totalBytes);

  const script = await bundleFixture();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      workers: [
        {
          name: "perf",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: "fixture-entry.mjs",
              contents: script,
            },
          ],
          d1Databases: ["DB"],
          durableObjects: {
            UPLOAD_SESSION: { className: "UploadSession", useSQLite: true },
          },
          bindings: {
            // Public test fixture (same value as tests/e2e/e2e-env.ts): the
            // UploadSession DO seals its session URI into a vault envelope,
            // so a syntactically valid master key must exist. Never a real
            // secret.
            APP_MASTER_KEY: "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=",
            PERF_FILE_BYTES: String(totalBytes),
            PERF_SHA256: hashes.sha256,
            PERF_MD5: hashes.md5,
          },
        },
      ],
    }),
  );

  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(db);
    await seed(db);

    // Prefer a real loopback HTTP socket; fall back to dispatchFetch.
    let base = null;
    try {
      base = (await mf.unsafeGetDirectURL()).toString().replace(/\/$/, "");
    } catch {
      base = null;
    }
    const mfFetch = base
      ? (p, init) => fetch(`${base}${p}`, init)
      : (p, init) => mf.dispatchFetch(`http://perf.local${p}`, init);
    const transport = base === null ? "dispatchFetch" : "loopback-http";

    // Warmup: small download settles routes/DO/binding lazily so baselines are
    // taken after one-time costs.
    const warm = await mfFetch(
      `/api/v1/mounts/${MOUNT}/files/${FILE}/content`,
      { headers: { Range: "bytes=0-1048575" } },
    );
    if (warm.status !== 206) {
      throw new Error(`warmup status ${warm.status}: ${await warm.text()}`);
    }
    await warm.arrayBuffer();

    const results = {};
    const runN = async (name, fn) => {
      results[name] = [];
      for (let i = 0; i < repeat; i += 1) {
        const r = await fn();
        r.transport = transport;
        results[name].push(r);
        if (!flags.json) {
          console.error(
            `[${name}#${i}] ${mib(r.bytes ?? 0).toFixed(0)} MiB in ` +
              `${(r.wallMs / 1000).toFixed(1)}s ` +
              `(${(mib(r.bytes ?? 0) / (r.wallMs / 1000)).toFixed(1)} MiB/s), ` +
              `workerd RSS Δ${(r.workerdRss.deltaKb / 1024).toFixed(1)} MiB, ` +
              `D1 ops ${r.counters.d1Operations}, DO fetches ${r.counters.doStubFetches}`,
          );
        }
      }
    };

    if (scenario === "all" || scenario === "download") {
      await runN("download", () => scenarioDownload(mfFetch, totalBytes));
    }
    if (scenario === "all" || scenario === "range") {
      await runN("range", () =>
        scenarioRange(mfFetch, totalBytes, ranges, rangeBytes),
      );
    }
    if (scenario === "all" || scenario === "upload") {
      await runN("upload", async () => {
        const r = await scenarioUpload(
          mfFetch,
          totalBytes,
          chunkBytes,
          block,
          hashes,
        );
        r.throughputMiBs = mib(totalBytes) / (r.wallMs / 1000);
        return r;
      });
    }

    const report = {
      tool: "bench-stream.mjs",
      method:
        "Miniflare 5 hosting the bundled fixture worker (real content + " +
        "upload routers, fixture providers at the existing test seams, real " +
        "D1 schema + real UploadSession DO). Generated deterministic body " +
        "only — nothing written to disk, nothing sent to Google. A fixture " +
        "run is never evidence for live large-file transfer.",
      params: { scenario, sizeMib, chunkMib, ranges, rangeMib, repeat },
      environment: {
        node: process.version,
        transport,
      },
      results,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mf.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
