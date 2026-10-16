# Perf benches (T15 resource budgets)

Local-only resource measurements for the streaming paths. Every bench streams
a deterministic **generated** body — nothing is written to disk, nothing
touches Google or Cloudflare. A fixture run is never evidence for live
large-file transfer; it measures only the local worker pipeline.

## `bench-stream.mjs`

Hosts the real content-download and upload-chunk routers under Miniflare 5
(workerd) with fixture providers injected at the existing test seams
(`ContentRouteDeps.readProvider`, `UploadRouterDeps.providerFor`), the real
D1 schema (checked-in migrations) and the real `UploadSession` Durable Object.

```sh
node tests/perf/bench-stream.mjs --help
node tests/perf/bench-stream.mjs --scenario all --size-mib 1024 --json
```

Scenarios: `download` (full-body GET …/content), `range` (N single-range
GETs), `upload` (init + 8 MiB chunk PUTs through the DO claim → provider
stream → D1 projection chain). Measures first-byte latency, wall time,
throughput, workerd RSS (summed /proc VmRSS of workerd children, 50 ms
samples), D1 statement counts and DO stub fetches (counted inside the fixture
worker, `GET /_perf/counters`).

## `bench-hash.mjs`

Bundles the app's real `src/web/features/transfers/hash.worker.ts`
(hash-wasm SHA-256+MD5, 1 MiB slices) and drives it from a Playwright browser
page with a generated in-memory Blob.

```sh
node tests/perf/bench-hash.mjs --help
node tests/perf/bench-hash.mjs --browser all --size-mib 256
```

Requires Playwright browsers installed locally (`channel: chrome` for the
chromium run, the playwright-managed `firefox` build for firefox).
