import { describe, expect, it } from "vitest";
import {
  createFolderUploader,
  type FolderBatchItem,
  type FolderBatchRecord,
  type FolderBatchStorePort,
  type FolderUploadFileInput,
} from "../../src/web/features/transfers/folder-upload";
import {
  canonicalPlanDigest,
  type BatchNodeInput,
  type BatchNodeView,
  type FolderView,
  type UploadBatchView,
} from "../../src/shared/contracts/uploads";
import type { DecimalBytes } from "../../src/shared/contracts/common";
import type {
  TransferSnapshot,
  UploadManager,
} from "../../src/web/features/transfers/upload-manager";

/**
 * Folder-upload scheduler tests (T10 acceptance): parent-first gating,
 * duplicate display names → distinct nodes, partial failure + retry with a
 * new idempotency key, reload → reselect → digest-checked resume, and clear
 * digest-mismatch refusal. All ports are faked; no DOM/IndexedDB needed.
 */

class FakeApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId = "req-t10";
  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

function apiError(code: string, status: number, message = code): Error {
  return new FakeApiError(code, status, message);
}

interface FakeNode {
  nodeId: string;
  parentNodeId: string | null;
  kind: "folder" | "file";
  displayName: string;
  state: BatchNodeView["state"];
  driveFileId?: string;
  mimeType?: string;
  totalBytes?: string;
}

interface FakeBatch {
  batchId: string;
  planVersion: number;
  state: string;
  sealed: boolean;
  planHash: string | null;
  nodes: FakeNode[];
  mountId: string;
  rootParentId: string;
}

class FakeBatchServer {
  readonly calls: string[] = [];
  readonly batches = new Map<string, FakeBatch>();
  readonly folderKeys: string[] = []; // idempotency keys used for POST /folders
  folderFaults = new Map<string, number>(); // nodeId → times to fail
  private nextId = 1;

  private view(b: FakeBatch): UploadBatchView {
    return {
      batchId: b.batchId,
      state: b.state as UploadBatchView["state"],
      planVersion: b.planVersion,
      ...(b.sealed ? { sealedAt: "2026-10-16T00:00:00Z" } : {}),
      ...(b.planHash === null ? {} : { planHash: b.planHash }),
      nodes: b.nodes.map((n) => ({
        nodeId: n.nodeId,
        parentNodeId: n.parentNodeId,
        kind: n.kind,
        displayName: n.displayName,
        state: n.state,
        ...(n.driveFileId === undefined ? {} : { driveFileId: n.driveFileId }),
        ...(n.mimeType === undefined ? {} : { mimeType: n.mimeType }),
        ...(n.totalBytes === undefined
          ? {}
          : { totalBytes: n.totalBytes as DecimalBytes }),
      })),
    } as UploadBatchView;
  }

  createBatch = async (
    body: { mountId: string; rootParentId: string },
    _key: string,
  ): Promise<UploadBatchView> => {
    this.calls.push("createBatch");
    const batchId = `batch-${this.nextId++}`;
    this.batches.set(batchId, {
      batchId,
      planVersion: 0,
      state: "draft",
      sealed: false,
      planHash: null,
      nodes: [],
      mountId: body.mountId,
      rootParentId: body.rootParentId,
    });
    return this.view(this.batches.get(batchId) as FakeBatch);
  };

  getBatch = async (batchId: string): Promise<UploadBatchView> => {
    this.calls.push(`getBatch:${batchId}`);
    const b = this.batches.get(batchId);
    if (b === undefined) throw apiError("NOT_FOUND", 404);
    return this.view(b);
  };

  appendNodes = async (
    batchId: string,
    body: { planVersion: number; nodes: BatchNodeInput[] },
  ): Promise<UploadBatchView> => {
    this.calls.push(`append:${batchId}:${body.nodes.length}`);
    const b = this.batches.get(batchId);
    if (b === undefined) throw apiError("NOT_FOUND", 404);
    if (b.sealed) throw apiError("VALIDATION_FAILED", 409, "sealed");
    if (body.planVersion !== b.planVersion) {
      throw apiError("VALIDATION_FAILED", 409, "planVersion mismatch");
    }
    for (const n of body.nodes) {
      b.nodes.push({ ...n, state: "pending", totalBytes: n.totalBytes });
    }
    b.planVersion += 1;
    return this.view(b);
  };

  sealBatch = async (
    batchId: string,
    body: { planVersion?: number; planHash?: string },
  ): Promise<UploadBatchView> => {
    this.calls.push(`seal:${batchId}`);
    const b = this.batches.get(batchId);
    if (b === undefined) throw apiError("NOT_FOUND", 404);
    if (body.planVersion !== undefined && body.planVersion !== b.planVersion) {
      throw apiError("VALIDATION_FAILED", 409, "planVersion mismatch");
    }
    const digest = await canonicalPlanDigest(b.nodes);
    if (body.planHash !== undefined && body.planHash !== digest) {
      throw apiError("VALIDATION_FAILED", 409, "planHash mismatch");
    }
    b.sealed = true;
    b.planHash = digest;
    b.state = "executing";
    return this.view(b);
  };

  createFolder = async (
    body: {
      mountId: string;
      parentId: string;
      name: string;
      batchId?: string;
      nodeId?: string;
    },
    idempotencyKey?: string,
  ): Promise<FolderView> => {
    this.calls.push(
      `folder:${body.nodeId ?? "none"}:${idempotencyKey ?? "derived"}`,
    );
    this.folderKeys.push(idempotencyKey ?? "derived");
    const b = this.batches.get(body.batchId ?? "");
    const node = b?.nodes.find((n) => n.nodeId === body.nodeId);
    if (b === undefined || node === undefined) {
      throw apiError("NOT_FOUND", 404, "no such node");
    }
    // Server gate: a child may only run once its parent's mapping is durable.
    if (node.parentNodeId !== null) {
      const parent = b.nodes.find((n) => n.nodeId === node.parentNodeId);
      if (parent?.driveFileId === undefined || parent.driveFileId !== body.parentId) {
        throw apiError("VALIDATION_FAILED", 409, "parent not confirmed");
      }
    } else if (body.parentId !== b.rootParentId) {
      throw apiError("VALIDATION_FAILED", 409, "wrong root parent");
    }
    const left = this.folderFaults.get(node.nodeId) ?? 0;
    if (left > 0) {
      this.folderFaults.set(node.nodeId, left - 1);
      node.state = "failed";
      throw apiError("DRIVE_UNAVAILABLE", 503, "folder create failed");
    }
    node.state = "completed";
    node.driveFileId = `drive-${node.nodeId}`;
    return {
      uploadId: `op-${node.nodeId}`,
      state: "completed",
      sessionGeneration: 1,
      confirmedOffset: "0" as DecimalBytes,
      totalBytes: "0" as DecimalBytes,
      chunkSize: 8 * 1024 * 1024,
      readerAccessState: "readable",
      driveFileId: node.driveFileId,
    };
  };
}

/** Minimal UploadManager stub — records enqueues, drives refresh(). */
function stubManager(): UploadManager & {
  enqueued: Array<{ name?: string; batchId?: string; nodeId?: string; dest: { mountId: string; parentId: string } }>;
  resumed: string[];
  states: Map<string, string>;
} {
  const enqueued: Array<{
    name?: string;
    batchId?: string;
    nodeId?: string;
    dest: { mountId: string; parentId: string };
  }> = [];
  const resumed: string[] = [];
  const states = new Map<string, string>();
  return {
    enqueued,
    resumed,
    states,
    enqueue(entries, destination) {
      const ids: string[] = [];
      for (const e of entries) {
        const id = `item-${enqueued.length + 1}`;
        enqueued.push({
          name: e.name,
          ...(e.batchId === undefined ? {} : { batchId: e.batchId }),
          ...(e.nodeId === undefined ? {} : { nodeId: e.nodeId }),
          dest: destination,
        });
        if (e.nodeId !== undefined) states.set(e.nodeId, "queued");
        ids.push(id);
      }
      return ids;
    },
    pause() {},
    resume(id) {
      resumed.push(id);
      const items = [...states.entries()].find(([, s]) => s === "needs-reselect");
      if (items !== undefined) states.set(items[0], "sending");
      void id;
    },
    cancel() {},
    remove() {},
    subscribe: () => () => {},
    getSnapshot(): TransferSnapshot {
      const items = [...states.entries()].map(([nodeId, state], i) => ({
        id: `item-${i + 1}`,
        uploadId: `upl-${nodeId}`,
        name: nodeId,
        mimeType: "application/octet-stream",
        mountId: "m1",
        parentId: "p",
        nodeId,
        totalBytes: "0" as DecimalBytes,
        confirmedBytes: "0" as DecimalBytes,
        sentBytes: "0" as DecimalBytes,
        preparedBytes: "0" as DecimalBytes,
        state: state as TransferSnapshot["items"][number]["state"],
        serverState: null,
        readerAccessState: null,
        error: null,
        hasFile: state !== "needs-reselect",
        hasStoredHandle: false,
      }));
      return { items, activeCount: 0 };
    },
    getStoredHandle: () => null,
    restore: () => Promise.resolve(),
  };
}

function memoryBatchStore(): FolderBatchStorePort & {
  records: FolderBatchRecord[];
} {
  const records: FolderBatchRecord[] = [];
  return {
    records,
    list: () => Promise.resolve(records.map((r) => ({ ...r }))),
    put: (r) => {
      const i = records.findIndex((x) => x.id === r.id);
      if (i === -1) records.push({ ...r });
      else records[i] = { ...r };
      return Promise.resolve();
    },
    delete: (id) => {
      const i = records.findIndex((r) => r.id === id);
      if (i !== -1) records.splice(i, 1);
      return Promise.resolve();
    },
  };
}

function file(path: string, size = 4): FolderUploadFileInput {
  return {
    path,
    file: new File([new Uint8Array(size)], path.split("/").pop() ?? path),
  };
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 4_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function batchOf(
  list: readonly FolderBatchItem[],
  id: string,
): FolderBatchItem {
  const b = list.find((x) => x.id === id);
  if (b === undefined) throw new Error("missing batch");
  return b;
}

describe("folder uploader", () => {
  it("plans, batches, seals and schedules folders parent-first", async () => {
    const server = new FakeBatchServer();
    const manager = stubManager();
    const up = createFolderUploader({ ...server, manager });
    const id = await up.start(
      [
        file("root/a/x.txt"),
        file("root/a/b/y.txt"),
        file("root/c/z.txt"),
      ],
      { mountId: "m1", parentId: "drv-root" },
      "root",
    );
    expect(id).not.toBeNull();
    await waitFor(() => {
      const b = batchOf(up.getSnapshot(), id ?? "");
      return b.nodes.some((n) => n.state === "in_progress") ||
        b.state === "completed";
    });
    // Folder creates ran in plan order — parents strictly before children.
    const folderCalls = server.calls.filter((c) => c.startsWith("folder:"));
    expect(folderCalls.length).toBe(4); // root, root/a, root/a/b, root/c
    // File nodes enqueued into confirmed parent mappings only.
    for (const e of manager.enqueued) {
      expect(e.batchId).toMatch(/^batch-/);
      expect(e.nodeId).toMatch(/^n[0-9a-f]{40}$/);
      expect(e.dest.parentId).toMatch(/^(drive-n|drv-root)/);
    }
    const b = batchOf(up.getSnapshot(), id ?? "");
    expect(b.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(server.calls).toContain("createBatch");
    expect(server.calls.some((c) => c.startsWith("seal:"))).toBe(true);
  });

  it("gives same-named files in different folders distinct nodes", async () => {
    const server = new FakeBatchServer();
    const manager = stubManager();
    const up = createFolderUploader({ ...server, manager });
    const id = await up.start(
      [file("root/p1/same.txt"), file("root/p2/same.txt")],
      { mountId: "m1", parentId: "drv-root" },
      "root",
    );
    await waitFor(() => {
      const b = batchOf(up.getSnapshot(), id ?? "");
      return b.nodes.some((n) => n.state === "in_progress");
    });
    const b = batchOf(up.getSnapshot(), id ?? "");
    const sameFiles = b.nodes.filter(
      (n) => n.kind === "file" && n.displayName === "same.txt",
    );
    expect(sameFiles.length).toBe(2);
    expect(sameFiles[0]?.nodeId).not.toBe(sameFiles[1]?.nodeId);
    const enq = manager.enqueued.filter((e) => e.name === "same.txt");
    expect(enq.length).toBe(2);
    expect(enq[0]?.dest.parentId).not.toBe(enq[1]?.dest.parentId);
  });

  it("partial folder failure stops children; retry uses a new idempotency key", async () => {
    const server3 = new FakeBatchServer();
    const manager3 = stubManager();
    // Fail the 'bad' folder's first create; 'good' must still complete.
    // NOTE: ports are spread-copied — override BEFORE creating the uploader.
    let failOnceDone = false;
    const origCreate = server3.createFolder;
    server3.createFolder = async (body, key) => {
      if (body.name === "bad" && !failOnceDone) {
        failOnceDone = true;
        const b = server3.batches.get(body.batchId ?? "");
        const node = b?.nodes.find((n) => n.nodeId === body.nodeId);
        if (node !== undefined) node.state = "failed";
        server3.calls.push(`folder:${body.nodeId}:failed`);
        throw apiError("DRIVE_UNAVAILABLE", 503);
      }
      return origCreate(body, key);
    };
    const up3 = createFolderUploader({ ...server3, manager: manager3 });
    const id3 = await up3.start(
      [file("r/bad/f.txt"), file("r/good/g.txt")],
      { mountId: "m1", parentId: "drv-root" },
      "r",
    );
    await waitFor(
      () => batchOf(up3.getSnapshot(), id3 ?? "").state === "failed",
      4_000,
    );
    const snap = batchOf(up3.getSnapshot(), id3 ?? "");
    // 'good' sibling completed; 'bad' failed; its file node stayed pending.
    const good = snap.nodes.find(
      (n) => n.kind === "folder" && n.displayName === "good",
    );
    const bad = snap.nodes.find(
      (n) => n.kind === "folder" && n.displayName === "bad",
    );
    expect(good?.state).toBe("completed");
    expect(bad?.state).toBe("failed");
    const goodFile = snap.nodes.find(
      (n) => n.kind === "file" && n.displayName === "g.txt",
    );
    expect(goodFile?.state).toBe("in_progress"); // sibling kept going
    // Retry the failed node — a NEW idempotency key, not the derived one.
    const keysBefore = server3.folderKeys.length;
    await up3.retryNode(id3 ?? "", bad?.nodeId ?? "");
    const lastKey = server3.folderKeys[server3.folderKeys.length - 1];
    expect(server3.folderKeys.length).toBe(keysBefore + 1);
    expect(lastKey).not.toBe("derived");
    expect(batchOf(up3.getSnapshot(), id3 ?? "").nodes.find(
      (n) => n.nodeId === bad?.nodeId,
    )?.state).toBe("completed");
  });

  it("reload → needs-reselect → resume refuses a mismatched plan digest", async () => {
    const server = new FakeBatchServer();
    const manager = stubManager();
    const store = memoryBatchStore();
    const up = createFolderUploader({ ...server, manager });
    up.attachStore(store);
    const id = await up.start([file("r/s/f.txt", 8)], {
      mountId: "m1",
      parentId: "drv-root",
    }, "r");
    await waitFor(() =>
      batchOf(up.getSnapshot(), id ?? "").nodes.length > 0,
    );
    const rec = store.records.find((r) => r.id === id);
    expect(rec?.batchId).toMatch(/^batch-/);
    expect(rec?.digest).toMatch(/^[0-9a-f]{64}$/);

    // A second uploader restores the record → needs-reselect.
    const up2 = createFolderUploader({ ...server, manager });
    up2.attachStore(store);
    await up2.restore();
    await waitFor(() => {
      const b = up2.getSnapshot().find((x) => x.id === id);
      return b !== undefined && b.nodes.length > 0;
    });
    expect(batchOf(up2.getSnapshot(), id ?? "").state).toBe("needs-reselect");

    // Reselect a DIFFERENT tree → clear digest-mismatch refusal.
    const ok = await up2.resumeWithFiles(id ?? "", [
      file("other/s/f.txt", 8),
    ]);
    expect(ok).toBe(false);
    expect(batchOf(up2.getSnapshot(), id ?? "").state).toBe(
      "digest-mismatch",
    );

    // Correct tree: digest matches, batch resumes and enqueues file nodes.
    const ok2 = await up2.resumeWithFiles(id ?? "", [file("r/s/f.txt", 8)]);
    expect(ok2).toBe(true);
    const b2 = batchOf(up2.getSnapshot(), id ?? "");
    expect(b2.state === "executing" || b2.state === "completed").toBe(true);
    expect(manager.enqueued.length).toBeGreaterThan(0);
    expect(manager.enqueued.every((e) => e.batchId === rec?.batchId)).toBe(
      true,
    );
  });
});
