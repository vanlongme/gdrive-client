import type { Page, Route } from "@playwright/test";

/**
 * Upload E2E fixtures (T09). Auth/session run against the REAL local workerd
 * preview; the upload/catalog endpoints are Playwright route fixtures that
 * keep the real protocol semantics: canonical UploadView answers, strict
 * generation+offset chunk addressing, Idempotency-Key replay, error
 * envelopes. Labelled [fixture] — never claimed as live Google evidence.
 */

export const UPLOAD_MOUNT = {
  id: "mnt-e2e-up",
  label: "Upload Drive",
  visibility: "private",
  rootFolderId: "root-folder",
  operations: ["read", "upload"],
};

export interface FixtureFileEntry {
  id: string;
  kind: "file" | "folder";
  name: string;
  mimeType: string;
  size: string;
  modifiedTime: string;
  hasThumbnail: boolean;
}

interface FixtureUpload {
  uploadId: string;
  state: string;
  sessionGeneration: number;
  confirmed: bigint;
  total: bigint;
  chunkSize: number;
  readerAccessState: string;
  name: string;
  parentId: string;
}

export interface ChunkCall {
  uploadId: string;
  generation: number;
  offset: string;
  byteLength: number;
}

const CHUNK_SIZE = 64 * 1024; // server-chosen; small enough for multi-chunk e2e

export interface UploadFixture {
  calls: string[];
  chunks: ChunkCall[];
  maxConcurrentChunks: number;
  uploadedEntries: FixtureFileEntry[];
  /** Epoch ms when the first chunk PUT arrived (enqueue→send latency). */
  chunkStartedAt: number | undefined;
  /** Mark the next chunk of an upload as a lost-but-committed response. */
  silentNextChunk(): void;
  /** Mark the next chunk request as a transport failure (no commit). */
  failNextChunk(): void;
  /** Reader access state reported when this filename completes. */
  blockedReaderNames: Set<string>;
}

function errorBody(code: string, message: string): string {
  return JSON.stringify({
    error: { code, message, requestId: "e2e-req" },
  });
}

function viewOf(u: FixtureUpload): Record<string, unknown> {
  return {
    uploadId: u.uploadId,
    state: u.state,
    sessionGeneration: u.sessionGeneration,
    confirmedOffset: u.confirmed.toString(10),
    totalBytes: u.total.toString(10),
    chunkSize: u.chunkSize,
    readerAccessState: u.readerAccessState,
  };
}

export function installUploadFixtures(
  page: Page,
  opts?: {
    initialEntries?: FixtureFileEntry[];
    /** Called when an upload op is created (body carries batchId/nodeId). */
    onUploadCreated?: (body: {
      batchId?: string;
      nodeId?: string;
      uploadId: string;
    }) => void;
    /** Called after a chunk commits; view.state tells completion. */
    onUploadView?: (view: { uploadId: string; state: string }) => void;
  },
): UploadFixture {
  const uploads = new Map<string, FixtureUpload>();
  const idem = new Map<string, string>();
  const uploadedEntries: FixtureFileEntry[] = [...(opts?.initialEntries ?? [])];
  const fixture: UploadFixture = {
    calls: [],
    chunks: [],
    maxConcurrentChunks: 0,
    uploadedEntries,
    chunkStartedAt: undefined,
    blockedReaderNames: new Set<string>(),
    silentNextChunk() {
      nextFault = "silent";
    },
    failNextChunk() {
      nextFault = "network";
    },
  };
  let nextFault: "silent" | "network" | null = null;
  let nextId = 1;
  let inflight = 0;

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const findUpload = (id: string) => {
    const u = uploads.get(id);
    if (u === undefined) return null;
    return u;
  };

  void page.route("**/api/v1/mounts**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/v1/mounts") {
      await json(route, { mounts: [UPLOAD_MOUNT] });
      return;
    }
    const childrenMatch = path.match(
      /^\/api\/v1\/mounts\/([^/]+)\/folders\/([^/]+)\/children$/,
    );
    if (childrenMatch !== null) {
      const folderId = decodeURIComponent(childrenMatch[2] ?? "");
      const entries =
        folderId === UPLOAD_MOUNT.rootFolderId ? uploadedEntries : [];
      await json(route, { entries });
      return;
    }
    await json(route, errorBody("NOT_FOUND", "unknown"), 404);
  });

  void page.route("**/api/v1/uploads**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    fixture.calls.push(`${method} ${path}${url.search}`);

    if (path === "/api/v1/uploads" && method === "POST") {
      const key = route.request().headers()["idempotency-key"];
      if (key === undefined || key === "") {
        await json(
          route,
          errorBody("VALIDATION_FAILED", "Idempotency-Key required"),
          400,
        );
        return;
      }
      const replayed = idem.get(key);
      if (replayed !== undefined) {
        await json(route, viewOf(findUpload(replayed) as FixtureUpload));
        return;
      }
      const body = route.request().postDataJSON() as {
        name: string;
        mimeType: string;
        totalBytes: string;
        parentId: string;
        batchId?: string;
        nodeId?: string;
      };
      const uploadId = `upl-e2e-${nextId}`;
      nextId += 1;
      const u: FixtureUpload = {
        uploadId,
        state: "uploading",
        sessionGeneration: 1,
        confirmed: 0n,
        total: BigInt(body.totalBytes),
        chunkSize: CHUNK_SIZE,
        readerAccessState: "unchecked",
        name: body.name,
        parentId: body.parentId,
      };
      if (u.total === 0n) {
        u.state = "completed";
        u.readerAccessState = "readable";
      }
      uploads.set(uploadId, u);
      idem.set(key, uploadId);
      opts?.onUploadCreated?.({
        ...(body.batchId === undefined ? {} : { batchId: body.batchId }),
        ...(body.nodeId === undefined ? {} : { nodeId: body.nodeId }),
        uploadId,
      });
      await json(route, viewOf(u));
      return;
    }

    const chunkMatch = path.match(/^\/api\/v1\/uploads\/([^/]+)\/chunks$/);
    if (chunkMatch !== null && method === "PUT") {
      const u = findUpload(decodeURIComponent(chunkMatch[1] ?? ""));
      if (u === null) {
        await json(route, errorBody("NOT_FOUND", "gone"), 404);
        return;
      }
      const generation = Number(url.searchParams.get("generation") ?? "0");
      const offset = url.searchParams.get("offset") ?? "";
      inflight += 1;
      fixture.maxConcurrentChunks = Math.max(
        fixture.maxConcurrentChunks,
        inflight,
      );
      try {
        // Small delay so client concurrency is observable.
        await new Promise((resolve) => setTimeout(resolve, 40));
        const body = route.request().postDataBuffer();
        const len = body?.byteLength ?? 0;
        fixture.chunks.push({
          uploadId: u.uploadId,
          generation,
          offset,
          byteLength: len,
        });
        fixture.chunkStartedAt ??= Date.now();
        if (u.state === "paused") {
          await json(
            route,
            errorBody("VALIDATION_FAILED", "upload is paused"),
            409,
          );
          return;
        }
        if (generation !== u.sessionGeneration) {
          await json(
            route,
            errorBody("VALIDATION_FAILED", "stale generation"),
            409,
          );
          return;
        }
        if (BigInt(offset) !== u.confirmed) {
          await json(
            route,
            errorBody("VALIDATION_FAILED", "offset mismatch"),
            409,
          );
          return;
        }
        const fault = nextFault;
        nextFault = null;
        if (fault === "network") {
          await json(
            route,
            errorBody("DRIVE_UNAVAILABLE", "transport lost"),
            503,
          );
          return;
        }
        if (fault === "silent") {
          // Upstream committed but the response was lost — the client must
          // reconcile before resending.
          u.confirmed += BigInt(len);
          if (u.confirmed >= u.total) u.state = "completed";
          await json(
            route,
            errorBody("DRIVE_UNAVAILABLE", "response lost"),
            503,
          );
          return;
        }
        u.confirmed += BigInt(len);
        if (u.confirmed >= u.total) {
          u.state = "completed";
          u.readerAccessState = fixture.blockedReaderNames.has(u.name)
            ? "blocked"
            : "readable";
          uploadedEntries.push({
            id: `drive-${u.uploadId}`,
            kind: "file",
            name: u.name,
            mimeType: "application/octet-stream",
            size: u.total.toString(10),
            modifiedTime: "2026-10-16T00:00:00Z",
            hasThumbnail: false,
          });
        }
        await json(route, viewOf(u));
        opts?.onUploadView?.({ uploadId: u.uploadId, state: u.state });
        return;
      } finally {
        inflight -= 1;
      }
    }

    const actionMatch = path.match(
      /^\/api\/v1\/uploads\/([^/]+)\/(reconcile|pause|resume|cancel)$/,
    );
    if (actionMatch !== null && method === "POST") {
      const u = findUpload(decodeURIComponent(actionMatch[1] ?? ""));
      if (u === null) {
        await json(route, errorBody("NOT_FOUND", "gone"), 404);
        return;
      }
      const action = actionMatch[2];
      if (action === "pause" && u.state === "uploading") u.state = "paused";
      if (action === "resume" && u.state === "paused") u.state = "uploading";
      if (action === "cancel") u.state = "cancelled";
      await json(route, viewOf(u));
      return;
    }

    const getMatch = path.match(/^\/api\/v1\/uploads\/([^/]+)$/);
    if (getMatch !== null && method === "GET") {
      const u = findUpload(decodeURIComponent(getMatch[1] ?? ""));
      if (u === null) {
        await json(route, errorBody("NOT_FOUND", "gone"), 404);
        return;
      }
      await json(route, viewOf(u));
      return;
    }

    await json(route, errorBody("NOT_FOUND", "unhandled"), 404);
  });

  return fixture;
}
