/**
 * Journey server (T15, frozen decisions 1-2): boots the BUILT worker bundle
 * from dist/ under Miniflare 5's programmatic API with `outboundService`
 * routing every worker-bound request through the stateful fake Google
 * boundary. A small proxy on 127.0.0.1:8878 forwards /api* to the worker
 * (identical to wrangler's run_worker_first semantics) and serves
 * dist/client statics with the checked-in _headers rules + SPA fallback —
 * Miniflare 5's assets router requires the vite plugin's multi-worker
 * structure, so the front proxy owns routing instead (recorded limitation).
 *
 * Control plane on 127.0.0.1:8898 exposes the fake's request log and state
 * levers; non-control paths there go through the same fake dispatch.
 * Never port 8877, never the developer's .wrangler/state.
 */

import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import {
  unstable_getMiniflareWorkerOptions,
  unstable_readConfig,
} from "wrangler";
import { createFakeGoogle } from "./fake-google/index";
import { controlHandler } from "./fake-google/control";

const ROOT = process.cwd();
const PORT = 8878;
const WORKER_PORT = 8890;
const CONTROL_PORT = 8898;
const ORIGIN = `http://localhost:${PORT}`;
const PERSIST_ROOT = process.env.JOURNEY_PERSIST_ROOT ?? ".e2e-state/journey";
const PERSIST_DIR = `${PERSIST_ROOT}/run-${Date.now()}`;

const SETUP_TOKEN =
  process.env.E2E_SETUP_TOKEN ?? "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const APP_MASTER_KEY =
  process.env.E2E_APP_MASTER_KEY ??
  "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=";

const WORKER_DIR = path.join(ROOT, "dist", "drive_worker");
const WORKER_CONFIG = path.join(WORKER_DIR, "wrangler.json");
const CLIENT_DIR = path.join(ROOT, "dist", "client");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pfb": "application/x-font",
  ".bcmap": "application/octet-stream",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** Minimal _headers support: only the `/*` rule this app ships. */
function staticHeaders(): Record<string, string> {
  const file = path.join(CLIENT_DIR, "_headers");
  const headers: Record<string, string> = {};
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    let inWildcard = false;
    for (const line of lines) {
      if (line.trim() === "/*") {
        inWildcard = true;
        continue;
      }
      if (inWildcard && /^[ \t]+\S/.test(line)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      } else if (line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t")) {
        inWildcard = false;
      }
    }
  } catch {
    // no _headers file — serve without.
  }
  return headers;
}

function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string>,
): void {
  const url = new URL(req.url ?? "/", ORIGIN);
  let filePath = path.normalize(decodeURIComponent(url.pathname));
  if (filePath.startsWith("..") || path.isAbsolute(filePath) === false) {
    res.writeHead(400).end("bad path");
    return;
  }
  const candidate = path.join(CLIENT_DIR, filePath);
  const file =
    existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : path.join(CLIENT_DIR, "index.html");
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    ...headers,
  });
  res.end(readFileSync(file));
}

async function main(): Promise<void> {
  mkdirSync(PERSIST_DIR, { recursive: true });

  // Same mechanism as tests/e2e/global-setup.ts, pointed at this run's dir.
  execFileSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", PERSIST_DIR],
    { stdio: "inherit" },
  );

  const fake = createFakeGoogle();

  // `vite build` emits dist/drive_worker/.dev.vars from the developer's file;
  // remove the emitted copy so secrets come only from the E2E bindings.
  rmSync(path.join(WORKER_DIR, ".dev.vars"), { force: true });

  const config = unstable_readConfig({ config: WORKER_CONFIG } as never);
  const converted = unstable_getMiniflareWorkerOptions(config as never, undefined, {
    envFiles: [],
  } as never);
  const workerOptions = converted.workerOptions as Record<string, unknown>;

  const modules = [
    { type: "ESModule", path: path.basename(String(config.main ?? "index.js")) },
    ...readdirSync(WORKER_DIR, { recursive: true })
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.endsWith(".js") && entry !== "index.js",
      )
      .map((entry) => ({ type: "ESModule", path: entry.split(path.sep).join("/") })),
  ];

  const worker = {
    ...workerOptions,
    name: "drive-worker",
    rootPath: WORKER_DIR,
    modules,
    bindings: {
      ...((workerOptions.bindings as Record<string, unknown> | undefined) ?? {}),
      APP_MASTER_KEY,
      SETUP_TOKEN,
    },
    outboundService: (request: Request) => fake.handle(request),
  };

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: WORKER_PORT,
      log: new Log(LogLevel.ERROR),
      logRequests: false,
      telemetry: { enabled: false },
      resourcePersistencePath: path.join(PERSIST_DIR, "v3"),
      workers: [worker as never, ...((converted.externalWorkers as never[]) ?? [])],
    }),
  );
  await mf.ready;

  // Front proxy: /api* -> worker (run_worker_first semantics); else statics.
  // Request and response bodies are STREAMED end to end (never buffered):
  // the upload path must prove the built worker handles file bytes without
  // a whole-file hop at the boundary.
  const headers = staticHeaders();
  const proxy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", ORIGIN);
    if (url.pathname.startsWith("/api")) {
      const fwd = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host" || k === "connection" || k === "transfer-encoding") continue;
        if (typeof v === "string") fwd.set(k, v);
        else if (Array.isArray(v)) fwd.set(k, v.join(","));
      }
      fwd.set("host", `localhost:${PORT}`);
      const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");
      const dispatch = mf.dispatchFetch(`${ORIGIN}${url.pathname}${url.search}`, {
        method: req.method ?? "GET",
        headers: fwd,
        body: hasBody
          ? (Readable.toWeb(req) as ReadableStream<Uint8Array>)
          : undefined,
        redirect: "manual",
        duplex: "half",
      } as never);
      req.on("error", () => {
        if (!res.headersSent) res.writeHead(400);
        res.end();
      });
      dispatch
        .then((out) => {
          const outHeaders: Record<string, string> = {};
          out.headers.forEach((v, k) => {
            if (
              !["content-length", "transfer-encoding", "connection", "keep-alive"].includes(k)
            ) {
              outHeaders[k] = v;
            }
          });
          res.writeHead(out.status, outHeaders);
          if (out.body === null || req.method === "HEAD") {
            res.end();
            return;
          }
          const body = Readable.fromWeb(
            out.body as import("node:stream/web").ReadableStream<Uint8Array>,
          );
          res.on("close", () => body.destroy());
          body.on("error", () => res.destroy());
          body.pipe(res);
        })
        .catch((err) => {
          if (!res.headersSent) res.writeHead(502);
          res.end(`proxy: ${err instanceof Error ? err.message : err}`);
        });
      return;
    }
    serveStatic(req, res, headers);
  });
  await new Promise<void>((resolve) => proxy.listen(PORT, "127.0.0.1", resolve));

  const control = createServer(controlHandler(fake));
  await new Promise<void>((resolve) => control.listen(CONTROL_PORT, "127.0.0.1", resolve));

  mkdirSync(".e2e-state", { recursive: true });
  writeFileSync(".e2e-state/journey-persist-dir", PERSIST_DIR, "utf8");

  const health = await mf.dispatchFetch(`http://localhost:${PORT}/api/v1/health`);
  if (health.status !== 200) {
    const body = await health.text().catch(() => "");
    throw new Error(`journey worker health check failed: ${health.status} ${body.slice(0, 500)}`);
  }
  const health2 = await fetch(`${ORIGIN}/api/v1/health`);
  if (health2.status !== 200) {
    throw new Error(`proxy health check failed: ${health2.status}`);
  }

  console.log(
    `JOURNEY_READY ${JSON.stringify({ origin: ORIGIN, controlPort: CONTROL_PORT, workerPort: WORKER_PORT, persistDir: PERSIST_DIR })}`,
  );

  const shutdown = async () => {
    control.close();
    proxy.close();
    await mf.dispose();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error("journey-server failed:", err);
  process.exit(1);
});
