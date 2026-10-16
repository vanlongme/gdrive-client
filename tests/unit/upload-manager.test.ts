import { describe, expect, it } from "vitest";
import type { DecimalBytes } from "../../src/shared/contracts/common";
import type {
  CreateUploadRequest,
  UploadView,
} from "../../src/shared/contracts/uploads";
import {
  createUploadManager,
  type HasherPort,
  type RecoveryRecord,
  type RecoveryStorePort,
  type TransferItemView,
  type TransferSnapshot,
  type UploadFileLike,
  type UploadHttpPort,
  type UploadManager,
} from "../../src/web/features/transfers/upload-manager";

/**
 * UploadManager unit tests (T09) run in the workerd pool — no DOM, no
 * IndexedDB, no wasm. Every port is injected: a scripted fake upload server
 * that keeps the real routes' protocol semantics (canonical UploadView,
 * generation+offset addressing, reconcile/pause/resume/cancel), a fake
 * incremental hasher and an in-memory recovery store.
 */

class FakeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.requestId = "req-test";
  }
}

interface FakeUpload {
  uploadId: string;
  state: UploadView["state"];
  sessionGeneration: number;
  confirmed: bigint;
  total: bigint;
  chunkSize: number;
  readerAccessState: UploadView["readerAccessState"];
  input: CreateUploadRequest;
}

interface ChunkCall {
  uploadId: string;
  generation: number;
  offset: string;
  bytes: Uint8Array;
}

class FakeUploadServer implements UploadHttpPort {
  readonly uploads = new Map<string, FakeUpload>();
  readonly idem = new Map<string, string>();
  readonly chunks: ChunkCall[] = [];
  readonly calls: string[] = [];
  chunkSize = 8;
  /** Per-chunk artificial delay in ticks (0 = synchronous microtask). */
  chunkDelayTicks = 0;
  /**
   * Deterministic gate: once this many chunks have completed, every further
   * putChunk blocks until {@link releaseHeld} is called. Lets tests observe
   * pause/cancel while a chunk is genuinely in flight.
   */
  holdAfter: number | null = null;
  heldChunks = 0;
  private release: (() => void) | null = null;
  /** Fault queue consumed by putChunk, in order. */
  chunkFaults: Array<"network" | "reconcile" | "silent" | undefined> = [];
  /** Fault queue consumed by cancelUpload, in order. */
  cancelFaults: Array<"network" | "conflict" | undefined> = [];
  /** When set, reconcile() returns this state instead of the row's. */
  reconcileState: UploadView["state"] | null = null;
  inflight = 0;
  maxInflight = 0;
  maxInflightPerUpload = 0;
  private perUploadInflight = new Map<string, number>();
  private nextId = 1;

  /** Releases the currently held chunk and disables the gate afterwards. */
  releaseHeld(): void {
    const release = this.release;
    this.release = null;
    this.holdAfter = null;
    release?.();
  }

  private view(u: FakeUpload): UploadView {
    return {
      uploadId: u.uploadId,
      state: u.state,
      sessionGeneration: u.sessionGeneration,
      confirmedOffset: u.confirmed.toString(10) as DecimalBytes,
      totalBytes: u.total.toString(10) as DecimalBytes,
      chunkSize: u.chunkSize,
      readerAccessState: u.readerAccessState,
    };
  }

  private find(uploadId: string): FakeUpload {
    const u = this.uploads.get(uploadId);
    if (u === undefined) throw new FakeApiError("NOT_FOUND", 404, "gone");
    return u;
  }

  async create(
    body: CreateUploadRequest,
    idempotencyKey: string,
  ): Promise<UploadView> {
    this.calls.push("create");
    const replayed = this.idem.get(idempotencyKey);
    if (replayed !== undefined) return this.view(this.find(replayed));
    const uploadId = `upl-${this.nextId}`;
    this.nextId += 1;
    const u: FakeUpload = {
      uploadId,
      state: "uploading",
      sessionGeneration: 1,
      confirmed: 0n,
      total: BigInt(body.totalBytes),
      chunkSize: this.chunkSize,
      readerAccessState: "unchecked",
      input: body,
    };
    if (u.total === 0n) {
      u.state = "completed";
      u.readerAccessState = "readable";
    }
    this.uploads.set(uploadId, u);
    this.idem.set(idempotencyKey, uploadId);
    return this.view(u);
  }

  async get(uploadId: string): Promise<UploadView> {
    this.calls.push(`get:${uploadId}`);
    return this.view(this.find(uploadId));
  }

  async putChunk(
    uploadId: string,
    generation: number,
    offset: DecimalBytes,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<UploadView> {
    this.calls.push(`chunk:${uploadId}`);
    const u = this.find(uploadId);
    this.inflight += 1;
    const per = (this.perUploadInflight.get(uploadId) ?? 0) + 1;
    this.perUploadInflight.set(uploadId, per);
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    this.maxInflightPerUpload = Math.max(this.maxInflightPerUpload, per);
    try {
      for (let i = 0; i < this.chunkDelayTicks; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (this.holdAfter !== null && this.chunks.length >= this.holdAfter) {
        this.heldChunks += 1;
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
      }
      if (signal?.aborted === true) {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      const bytes = new Uint8Array(await chunk.arrayBuffer());
      this.chunks.push({ uploadId, generation, offset, bytes });
      if (u.state === "paused") {
        throw new FakeApiError(
          "VALIDATION_FAILED",
          409,
          "upload is paused",
        );
      }
      if (generation !== u.sessionGeneration) {
        throw new FakeApiError("VALIDATION_FAILED", 409, "stale generation");
      }
      if (BigInt(offset) !== u.confirmed) {
        throw new FakeApiError("VALIDATION_FAILED", 409, "offset mismatch");
      }
      const fault = this.chunkFaults.shift();
      if (fault === "network") {
        throw new FakeApiError("NETWORK_ERROR", 0, "lost connection");
      }
      if (fault === "reconcile") {
        throw new FakeApiError(
          "UPLOAD_NEEDS_RECONCILIATION",
          409,
          "outcome unknown",
        );
      }
      if (fault === "silent") {
        // Upstream applied the bytes but the response never arrived: the
        // server commits the chunk, the client only learns via reconcile.
        u.confirmed += BigInt(bytes.length);
        if (u.confirmed >= u.total) u.state = "completed";
        throw new FakeApiError("NETWORK_ERROR", 0, "response lost");
      }
      u.confirmed += BigInt(bytes.length);
      if (u.confirmed >= u.total) {
        u.state = "completed";
        u.readerAccessState = "readable";
      }
      return this.view(u);
    } finally {
      this.inflight -= 1;
      this.perUploadInflight.set(
        uploadId,
        (this.perUploadInflight.get(uploadId) ?? 1) - 1,
      );
    }
  }

  async reconcile(uploadId: string): Promise<UploadView> {
    this.calls.push(`reconcile:${uploadId}`);
    const u = this.find(uploadId);
    if (this.reconcileState !== null) {
      return { ...this.view(u), state: this.reconcileState };
    }
    return this.view(u);
  }

  async pause(uploadId: string): Promise<UploadView> {
    this.calls.push(`pause:${uploadId}`);
    const u = this.find(uploadId);
    if (u.state === "uploading") u.state = "paused";
    return this.view(u);
  }

  async resumeUpload(uploadId: string): Promise<UploadView> {
    this.calls.push(`resume:${uploadId}`);
    const u = this.find(uploadId);
    if (u.state === "paused") u.state = "uploading";
    return this.view(u);
  }

  async cancelUpload(uploadId: string): Promise<UploadView> {
    this.calls.push(`cancel:${uploadId}`);
    const fault = this.cancelFaults.shift();
    if (fault === "network") {
      throw new FakeApiError("NETWORK_ERROR", 0, "cancel call lost");
    }
    if (fault === "conflict") {
      throw new FakeApiError("VALIDATION_FAILED", 409, "cancel rejected");
    }
    const u = this.find(uploadId);
    u.state = "cancelled";
    return this.view(u);
  }
}

function fakeHasher(opts?: {
  sha?: string;
  md5?: string;
  forContent?: (bytes: Uint8Array) => { sha256: string; md5: string };
  delayTicks?: number;
}): HasherPort {
  const sha = opts?.sha ?? "a".repeat(64);
  const md5 = opts?.md5 ?? "b".repeat(32);
  return {
    async hash(file, { onProgress }) {
      const delay = opts?.delayTicks ?? 0;
      const slice = 1024;
      for (let offset = 0; offset < file.size; offset += slice) {
        for (let i = 0; i < delay; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const end = Math.min(offset + slice, file.size);
        onProgress?.({
          done: end.toString(10) as DecimalBytes,
          total: file.size.toString(10) as DecimalBytes,
        });
      }
      if (opts?.forContent !== undefined) {
        const data = new Uint8Array(
          await file.slice(0, file.size).arrayBuffer(),
        );
        return opts.forContent(data);
      }
      return { sha256: sha, md5 };
    },
  };
}

/** Simple content-derived digests so reselect mismatch tests are honest. */
export function contentHashes(bytes: Uint8Array): {
  sha256: string;
  md5: string;
} {
  let a = 0n;
  let b = 0n;
  for (const byte of bytes) {
    a = (a + BigInt(byte) * 31n) % (1n << 128n);
    b = (b * 33n + BigInt(byte)) % (1n << 64n);
  }
  return {
    sha256: a.toString(16).padStart(64, "0"),
    md5: b.toString(16).padStart(32, "0"),
  };
}

function memoryStore(): RecoveryStorePort & { records: RecoveryRecord[] } {
  const records: RecoveryRecord[] = [];
  return {
    records,
    async list() {
      return records.map((r) => ({ ...r }));
    },
    async put(record) {
      const i = records.findIndex((r) => r.id === record.id);
      if (i === -1) records.push({ ...record });
      else records[i] = { ...record };
    },
    async delete(id) {
      const i = records.findIndex((r) => r.id === id);
      if (i !== -1) records.splice(i, 1);
    },
  };
}

function makeManager(opts?: {
  server?: FakeUploadServer;
  hasher?: HasherPort;
  store?: ReturnType<typeof memoryStore>;
  maxConcurrent?: number;
}): {
  manager: UploadManager;
  server: FakeUploadServer;
  store: ReturnType<typeof memoryStore>;
} {
  const server = opts?.server ?? new FakeUploadServer();
  const store = opts?.store ?? memoryStore();
  let n = 0;
  const manager = createUploadManager({
    http: server,
    hasher: opts?.hasher ?? fakeHasher(),
    recovery: store,
    newId: () => `id-${++n}`,
    sleep: () => Promise.resolve(),
    ...(opts?.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: opts.maxConcurrent }),
  });
  return { manager, server, store };
}

function fileOf(
  bytes: Uint8Array<ArrayBuffer>,
  name = "file.bin",
): UploadFileLike {
  return new File([bytes], name, { type: "application/octet-stream" });
}

function itemOf(snap: TransferSnapshot, id: string): TransferItemView {
  const item = snap.items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`missing item ${id}`);
  return item;
}

/**
 * vi.waitFor does not poll in the workerd pool (it resolves after a single
 * evaluation), so synchronization uses this explicit poll loop.
 */
async function waitFor(
  cond: () => boolean,
  timeoutMs = 5_000,
  debug?: () => unknown,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out: ${JSON.stringify(debug?.())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("UploadManager", () => {
  it("runs at most two files concurrently, one chunk in flight each", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 4;
    server.chunkDelayTicks = 3;
    const { manager } = makeManager({ server });
    const ids = manager.enqueue(
      [
        { file: fileOf(new Uint8Array(24).fill(7), "a.bin") },
        { file: fileOf(new Uint8Array(24).fill(8), "b.bin") },
        { file: fileOf(new Uint8Array(24).fill(9), "c.bin") },
      ],
      { mountId: "m1", parentId: "root" },
    );
    expect(ids).toHaveLength(3);
    await waitFor(
      () =>
        manager.getSnapshot().items.every((i) => i.state === "completed"),
    );
    expect(server.maxInflight).toBeLessThanOrEqual(2);
    expect(server.maxInflightPerUpload).toBe(1);
    // Each 24-byte file at 4-byte chunks = 6 chunks per file.
    expect(server.chunks).toHaveLength(18);
  });

  it("sends exact Blob.slice boundaries at confirmed offsets", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    const { manager } = makeManager({ server });
    const source = new Uint8Array(20);
    for (let i = 0; i < source.length; i++) source[i] = i;
    manager.enqueue([{ file: fileOf(source) }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(() => manager.getSnapshot().items[0]?.state === "completed");
    expect(server.chunks.map((c) => c.offset)).toEqual(["0", "8", "16"]);
    const joined = new Uint8Array(
      server.chunks.reduce((n, c) => n + c.bytes.length, 0),
    );
    let at = 0;
    for (const c of server.chunks) {
      joined.set(c.bytes, at);
      at += c.bytes.length;
    }
    expect([...joined]).toEqual([...source]);
  });

  it("keeps sent bytes optimistic and confirmed bytes canonical", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.holdAfter = 1; // hold the second chunk in flight deterministically
    const { manager } = makeManager({ server });
    const [id] = manager.enqueue(
      [{ file: fileOf(new Uint8Array(16).fill(1)) }],
      { mountId: "m1", parentId: "root" },
    );
    await waitFor(() => server.heldChunks === 1);
    // Chunk 2 is in flight: sent bytes show the optimistic upper bound while
    // confirmed bytes stay at the server's last canonical offset.
    const mid = itemOf(manager.getSnapshot(), id ?? "");
    expect(mid.state).toBe("sending");
    expect(mid.sentBytes).toBe("16");
    expect(mid.confirmedBytes).toBe("8");
    server.releaseHeld();
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "completed",
    );
    const done = itemOf(manager.getSnapshot(), id ?? "");
    expect(done.confirmedBytes).toBe("16");
    expect(done.serverState).toBe("completed");
  });

  it("pause stops granting new chunks; resume continues from canonical offset", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.holdAfter = 1; // chunk 2 stays in flight until released
    const { manager } = makeManager({ server });
    const [id] = manager.enqueue(
      [{ file: fileOf(new Uint8Array(32).fill(3)) }],
      { mountId: "m1", parentId: "root" },
    );
    await waitFor(
      () => server.heldChunks === 1,
      3_000,
      () => ({
        calls: server.calls,
        held: server.heldChunks,
        items: manager.getSnapshot(),
      }),
    );
    manager.pause(id ?? "");
    server.releaseHeld(); // the in-flight chunk still commits
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "paused",
      4_000,
      () => ({ calls: server.calls, items: manager.getSnapshot() }),
    );
    const uploadId = itemOf(manager.getSnapshot(), id ?? "").uploadId;
    expect(server.calls).toContain(`pause:${uploadId}`);
    // Chunk 1 (committed) + held chunk 2 finished in flight; no third chunk
    // was granted while paused.
    expect(server.chunks.map((c) => c.offset)).toEqual(["0", "8"]);
    manager.resume(id ?? "");
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "completed",
    );
    expect(server.calls).toContain(`resume:${uploadId}`);
    expect(server.chunks.map((c) => c.offset)).toEqual([
      "0",
      "8",
      "16",
      "24",
    ]);
  });

  it("recovers a lost chunk response via reconcile without resending bytes", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    // The second chunk's response is lost but upstream committed the bytes.
    server.chunkFaults = ["silent"];
    const { manager } = makeManager({ server });
    const source = new Uint8Array(16).fill(5);
    manager.enqueue([{ file: fileOf(source) }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(() => manager.getSnapshot().items[0]?.state === "completed");
    expect(server.calls.filter((c) => c.startsWith("reconcile")).length)
      .toBeGreaterThanOrEqual(1);
    // The silent chunk consumed bytes server-side; the client must not
    // re-send that range — only one PUT per offset.
    expect(server.chunks.map((c) => c.offset)).toEqual(["0", "8"]);
  });

  it("after restore, reselect+rehash resumes from the canonical view", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.holdAfter = 1;
    const store = memoryStore();
    const hasher = fakeHasher({ forContent: contentHashes });
    const first = makeManager({ server, store, hasher });
    const source = new Uint8Array(24);
    for (let i = 0; i < source.length; i++) source[i] = i + 1;
    const file = fileOf(source, "report.pdf");
    const [id] = first.manager.enqueue([{ file }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(
      () => server.heldChunks === 1,
      4_000,
      () => ({ calls: server.calls, items: first.manager.getSnapshot() }),
    );
    first.manager.pause(id ?? "");
    server.releaseHeld();
    await waitFor(
      () => itemOf(first.manager.getSnapshot(), id ?? "").state === "paused",
      4_000,
      () => ({ calls: server.calls, items: first.manager.getSnapshot() }),
    );
    expect(server.chunks.map((c) => c.offset)).toEqual(["0", "8"]);

    // Simulate reload: a fresh manager over the same recovery store.
    const second = makeManager({ server, store, hasher });
    await second.manager.restore();
    const restored = itemOf(second.manager.getSnapshot(), id ?? "");
    expect(restored.state).toBe("needs-reselect");
    expect(restored.hasFile).toBe(false);

    // Wrong content under an identical name/size must not resume.
    const wrongFile = fileOf(new Uint8Array(24).fill(9), "report.pdf");
    const chunksBefore = server.chunks.length;
    second.manager.resume(id ?? "", wrongFile);
    await waitFor(
      () =>
        itemOf(second.manager.getSnapshot(), id ?? "").state ===
        "needs-reselect",
    );
    const mismatch = itemOf(second.manager.getSnapshot(), id ?? "");
    expect(mismatch.error?.code).toBe("RESELECT_MISMATCH");
    expect(server.chunks.length).toBe(chunksBefore);

    // Correct file: rehash matches, canonical view drives resume at offset 16.
    second.manager.resume(id ?? "", fileOf(source, "report.pdf"));
    await waitFor(
      () =>
        itemOf(second.manager.getSnapshot(), id ?? "").state === "completed",
    );
    const last = itemOf(second.manager.getSnapshot(), id ?? "");
    expect(last.confirmedBytes).toBe("24");
    expect(server.chunks.map((c) => c.offset)).toEqual(["0", "8", "16"]);
  });

  it("replays idempotent init when the first response was lost pre-reload", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    const store = memoryStore();
    const hasher = fakeHasher({ forContent: contentHashes });
    // Seed a record as if the tab died before the create response landed.
    const source = new Uint8Array(10).fill(4);
    const hashes = contentHashes(source);
    const record: RecoveryRecord = {
      id: "id-seeded",
      uploadId: null,
      idempotencyKey: "idem-seeded",
      mountId: "m1",
      parentId: "root",
      name: "seed.bin",
      mimeType: "application/octet-stream",
      totalBytes: "10",
      lastModified: 0,
      sha256: hashes.sha256,
      md5: hashes.md5,
      confirmedOffset: "0",
      state: "preparing",
      updatedAt: 0,
    };
    await store.put(record);
    const { manager } = makeManager({ server, store, hasher });
    await manager.restore();
    expect(itemOf(manager.getSnapshot(), "id-seeded").state).toBe(
      "needs-reselect",
    );
    manager.resume("id-seeded", fileOf(source, "seed.bin"));
    await waitFor(
      () => itemOf(manager.getSnapshot(), "id-seeded").state === "completed",
    );
    expect(server.calls.filter((c) => c === "create")).toHaveLength(1);
    const uploadId = itemOf(manager.getSnapshot(), "id-seeded").uploadId;
    expect(uploadId).not.toBeNull();
    // Replaying the same Idempotency-Key returns the same operation.
    const replay = await server.create(
      {
        mountId: "m1",
        parentId: "root",
        name: "seed.bin",
        mimeType: "application/octet-stream",
        totalBytes: "10",
        sha256: hashes.sha256,
        md5: hashes.md5,
      },
      "idem-seeded",
    );
    expect(replay.uploadId).toBe(uploadId);
  });

  it("cancel aborts the in-flight chunk and informs the server once", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.holdAfter = 1;
    const { manager } = makeManager({ server });
    const [id] = manager.enqueue(
      [{ file: fileOf(new Uint8Array(32).fill(6)) }],
      { mountId: "m1", parentId: "root" },
    );
    await waitFor(() => server.heldChunks === 1);
    manager.cancel(id ?? "");
    server.releaseHeld(); // the aborted PUT never lands
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "cancelled",
    );
    expect(
      server.calls.filter((c) => c.startsWith("cancel")),
    ).toHaveLength(1);
    // Only the first chunk was recorded; the aborted one never committed.
    expect(server.chunks.map((c) => c.offset)).toEqual(["0"]);
  });

  it("zero-byte file completes through init with no chunk calls", async () => {
    const server = new FakeUploadServer();
    const { manager } = makeManager({ server });
    manager.enqueue([{ file: fileOf(new Uint8Array(0), "empty.txt") }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(() => manager.getSnapshot().items[0]?.state === "completed");
    expect(server.chunks).toHaveLength(0);
    expect(server.calls).toContain("create");
  });

  it("surfaces a non-retriable API failure as an error item", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    const { manager } = makeManager({ server });
    server.create = () => {
      throw new FakeApiError("FORBIDDEN", 403, "no upload grant");
    };
    const [id] = manager.enqueue([{ file: fileOf(new Uint8Array(4)) }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(() => itemOf(manager.getSnapshot(), id ?? "").state === "error");
    expect(itemOf(manager.getSnapshot(), id ?? "").error?.code).toBe(
      "FORBIDDEN",
    );
  });

  it("notifies subscribers and keeps a stable snapshot between changes", async () => {
    const { manager } = makeManager();
    const seen: number[] = [];
    manager.subscribe(() => seen.push(manager.getSnapshot().items.length));
    const before = manager.getSnapshot();
    expect(manager.getSnapshot()).toBe(before);
    manager.enqueue([{ file: fileOf(new Uint8Array(2)) }], {
      mountId: "m1",
      parentId: "root",
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(manager.getSnapshot()).not.toBe(before);
    await waitFor(() => manager.getSnapshot().items[0]?.state === "completed");
  });

  // --- R1 review regressions (W4-R1 items 8-13) ---

  it("R1-8: canonical view rewinds confirmed bytes after a generation bump", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.holdAfter = 1; // hold chunk 2 while we rewind the session
    const { manager } = makeManager({ server });
    const [id] = manager.enqueue(
      [{ file: fileOf(new Uint8Array(24).fill(4)) }],
      { mountId: "m1", parentId: "root" },
    );
    await waitFor(() => server.heldChunks === 1);
    const uploadId = itemOf(manager.getSnapshot(), id ?? "").uploadId ?? "";
    // Server rewinds: generation bump + confirmed back to 0.
    const u = server.uploads.get(uploadId);
    if (u === undefined) throw new Error("missing fake upload");
    u.confirmed = 0n;
    u.sessionGeneration = 2;
    server.releaseHeld(); // the held chunk 2 now hits stale generation 409
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "completed",
      4_000,
      () => ({ calls: server.calls, items: manager.getSnapshot() }),
    );
    // After the rewind, the next chunk was re-sent at offset 0, generation 2.
    const rewound = server.chunks.find(
      (c) => c.offset === "0" && c.generation === 2,
    );
    expect(rewound).toBeDefined();
  });

  it("R1-9: reselect with a null-digest record adopts fresh hashes and resumes", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.holdAfter = 0; // hold the first chunk so the upload stays resumable
    const store = memoryStore();
    const hasher = fakeHasher({ forContent: contentHashes });
    const first = makeManager({ server, store, hasher });
    const bytes = new Uint8Array(16).fill(9);
    const [id] = first.manager.enqueue([{ file: fileOf(bytes) }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(() => server.heldChunks === 1);
    first.manager.pause(id ?? "");
    server.releaseHeld();
    await waitFor(
      () => itemOf(first.manager.getSnapshot(), id ?? "").state === "paused",
      4_000,
      () => first.manager.getSnapshot(),
    );
    // Simulate an older/incomplete record: digests were never persisted.
    const record = store.records.find((r) => r.id === id);
    if (record === undefined) throw new Error("missing record");
    record.sha256 = null;
    record.md5 = null;
    const second = makeManager({ server, store, hasher });
    await second.manager.restore();
    expect(itemOf(second.manager.getSnapshot(), id ?? "").state).toBe(
      "needs-reselect",
    );
    second.manager.resume(id ?? "", fileOf(bytes));
    await waitFor(
      () =>
        itemOf(second.manager.getSnapshot(), id ?? "").state === "completed",
      4_000,
      () => second.manager.getSnapshot(),
    );
    expect(server.calls).toContain(`resume:${record.uploadId ?? ""}`);
  });

  it("R1-10: reconcile loop is bounded and backs off instead of storming", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.chunkFaults = [undefined, "network"]; // chunk 2's PUT fails
    server.reconcileState = "reconciling"; // the server never settles
    const sleeps: number[] = [];
    const m2 = createUploadManager({
      http: server,
      hasher: fakeHasher(),
      recovery: memoryStore(),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const [id] = m2.enqueue([{ file: fileOf(new Uint8Array(16)) }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(
      () => itemOf(m2.getSnapshot(), id ?? "").state === "error",
      4_000,
      () => ({
        calls: server.calls.length,
        items: m2.getSnapshot(),
        sleeps: sleeps.length,
      }),
    );
    const reconciles = server.calls.filter((c) => c.includes("reconcile"));
    expect(reconciles.length).toBeGreaterThan(1);
    expect(reconciles.length).toBeLessThanOrEqual(8);
    expect(sleeps.length).toBeGreaterThan(0); // backoff was used
  });

  it("R1-11: a failed PUT rewinds optimistic sent bytes", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.chunkFaults = ["network"]; // first chunk fails mid-flight
    const { manager } = makeManager({ server });
    const samples: Array<{ state: string; sent: string }> = [];
    manager.subscribe(() => {
      const i = manager.getSnapshot().items[0];
      if (i !== undefined) samples.push({ state: i.state, sent: i.sentBytes });
    });
    const [id] = manager.enqueue([{ file: fileOf(new Uint8Array(8)) }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "completed",
      4_000,
    );
    // A confirming sample must show sent rewound to the confirmed floor.
    const rewound = samples.find(
      (s) => s.state === "confirming" && s.sent === "0",
    );
    expect(rewound).toBeDefined();
    // The failed chunk was retried exactly once after reconcile.
    expect(server.chunks.filter((c) => c.offset === "0").length).toBe(2);
  });

  it("R1-12: restore isolates a malformed record and keeps the rest", async () => {
    const store = memoryStore();
    store.records.push(
      {
        id: "bad-1",
        uploadId: "upl-x",
        idempotencyKey: "k1",
        mountId: "m1",
        parentId: "root",
        name: "broken.bin",
        mimeType: "application/octet-stream",
        totalBytes: "not-a-number" as never,
        confirmedOffset: "0",
        sha256: null,
        md5: null,
        state: "uploading",
        lastModified: 0,
      } as never,
      {
        id: "good-1",
        uploadId: "upl-y",
        idempotencyKey: "k2",
        mountId: "m1",
        parentId: "root",
        name: "good.bin",
        mimeType: "application/octet-stream",
        totalBytes: "8",
        confirmedOffset: "0",
        sha256: null,
        md5: null,
        state: "uploading",
        lastModified: 0,
      } as never,
    );
    const { manager } = makeManager({ store });
    await manager.restore();
    const items = manager.getSnapshot().items;
    expect(items.map((i) => i.id)).toEqual(["good-1"]);
    expect(items[0]?.state).toBe("needs-reselect");
  });

  it("R1-13: retriable cancel failure stays pending, not locally cancelled", async () => {
    const server = new FakeUploadServer();
    server.chunkSize = 8;
    server.holdAfter = 1;
    server.cancelFaults = ["network"];
    const { manager } = makeManager({ server });
    const [id] = manager.enqueue([{ file: fileOf(new Uint8Array(24)) }], {
      mountId: "m1",
      parentId: "root",
    });
    await waitFor(() => server.heldChunks === 1);
    manager.cancel(id ?? "");
    server.releaseHeld();
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "error",
      4_000,
      () => manager.getSnapshot(),
    );
    expect(itemOf(manager.getSnapshot(), id ?? "").state).toBe("error");
    // Retry the cancel — second attempt succeeds.
    manager.cancel(id ?? "");
    await waitFor(
      () => itemOf(manager.getSnapshot(), id ?? "").state === "cancelled",
      4_000,
      () => manager.getSnapshot(),
    );
  });
});
