import type {
  BatchNodeInput,
  BatchNodeView,
  FolderView,
  UploadBatchView,
} from "../../../shared/contracts/uploads";
import { planFolderTree, type FolderPlan } from "./folder-plan";
import type { UploadFileLike, UploadManager } from "./upload-manager";

/**
 * Folder-upload orchestrator (spec section 6.6, plan T10; wave-4 task A2).
 *
 * Drives the full sequence over the existing routes: planFolderTree →
 * POST /upload-batches → paged POST /:b/nodes → POST /:b/seal (asserting
 * planVersion + planHash) → parent-first metadata-only POST /folders,
 * scheduling a child only after its parent's confirmed driveFileId mapping —
 * → file nodes through the singleton UploadManager with batchId/nodeId.
 *
 * Everything except the plan runs through injectable ports so the scheduler
 * is unit-tested in workerd (no DOM/IndexedDB). Identity is by nodeId only —
 * display names are never keys, so two same-named folders keep distinct
 * Drive IDs. No automatic cleanup: completed siblings stay completed and a
 * failed node is only retried explicitly, with a new idempotency key.
 */

export interface FolderUploadFileInput {
  /** Relative path (webkitRelativePath / drop traversal), '/' separators. */
  path: string;
  file: UploadFileLike;
}

export interface FolderDestination {
  mountId: string;
  /** Drive folder ID of the Explorer folder the tree is dropped into. */
  parentId: string;
}

export interface FolderUploadPorts {
  createBatch(
    body: { mountId: string; rootParentId: string },
    idempotencyKey: string,
  ): Promise<UploadBatchView>;
  getBatch(batchId: string, cursor?: string): Promise<UploadBatchView>;
  appendNodes(
    batchId: string,
    body: { planVersion: number; nodes: BatchNodeInput[] },
  ): Promise<UploadBatchView>;
  sealBatch(
    batchId: string,
    body: { planVersion?: number; planHash?: string },
  ): Promise<UploadBatchView>;
  createFolder(
    body: {
      mountId: string;
      parentId: string;
      name: string;
      batchId?: string;
      nodeId?: string;
    },
    idempotencyKey?: string,
  ): Promise<FolderView>;
  manager: UploadManager;
  newId?: () => string;
}

export type FolderBatchState =
  | "planning"
  | "sealing"
  | "executing"
  | "needs-reselect"
  | "digest-mismatch"
  | "completed"
  | "failed";

export interface FolderNodeView {
  nodeId: string;
  parentNodeId: string | null;
  kind: "folder" | "file";
  displayName: string;
  depth: number;
  state: BatchNodeView["state"];
  /** Drive ID once the server confirmed the folder's mapping. */
  driveFileId?: string;
}

export interface FolderBatchItem {
  id: string;
  batchId: string | null;
  rootName: string;
  mountId: string;
  parentId: string;
  state: FolderBatchState;
  digest: string | null;
  nodes: FolderNodeView[];
  fileCount: number;
  folderCount: number;
  error: string | null;
}

export interface FolderBatchRecord {
  id: string;
  batchId: string | null;
  mountId: string;
  parentId: string;
  rootName: string;
  digest: string;
  /** nodeId → relative path, for file re-attachment after reload. */
  filePaths: Record<string, string>;
  state: FolderBatchState;
  updatedAt: number;
}

export interface FolderBatchStorePort {
  list(): Promise<FolderBatchRecord[]>;
  put(record: FolderBatchRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

const NODE_PAGE = 500;

interface RunCtx {
  batch: FolderBatchItem;
  dest: FolderDestination;
  plan: FolderPlan;
  /** nodeId → File for pending file nodes. */
  files: Map<string, UploadFileLike>;
  /** nodeId → confirmed Drive folder ID. */
  folderIds: Map<string, string>;
}

export function createFolderUploader(ports: FolderUploadPorts) {
  const newId = ports.newId ?? (() => crypto.randomUUID());
  const batches = new Map<string, RunCtx & { record?: FolderBatchRecord }>();
  const listeners = new Set<() => void>();
  let snapshotCache: FolderBatchItem[] = [];
  let dirty = true;
  let restored = false;
  let store: FolderBatchStorePort | null = null;

  function notify(): void {
    dirty = true;
    for (const l of listeners) l();
  }

  function setBatchState(ctx: RunCtx, state: FolderBatchState, error?: string) {
    ctx.batch.state = state;
    ctx.batch.error = error ?? null;
    notify();
    void persist(ctx);
  }

  async function persist(ctx: RunCtx): Promise<void> {
    if (store === null || ctx.batch.digest === null) return;
    const filePaths: Record<string, string> = {};
    for (const node of ctx.batch.nodes) {
      if (node.kind !== "file") continue;
      const f = ctx.files.get(node.nodeId);
      if (f !== undefined) filePaths[node.nodeId] = pathForNode(ctx, node.nodeId);
    }
    await store
      .put({
        id: ctx.batch.id,
        batchId: ctx.batch.batchId,
        mountId: ctx.batch.mountId,
        parentId: ctx.batch.parentId,
        rootName: ctx.batch.rootName,
        digest: ctx.batch.digest,
        filePaths,
        state: ctx.batch.state,
        updatedAt: Date.now(),
      })
      .catch(() => undefined);
  }

  /** Recompute a file node's relative path — works for fresh plans and for
   * restored batches whose nodes came back from the server view. */
  function pathForNode(ctx: RunCtx, nodeId: string): string {
    const byId = new Map(ctx.batch.nodes.map((n) => [n.nodeId, n]));
    const parts: string[] = [];
    let cur: FolderNodeView | undefined = byId.get(nodeId);
    while (cur !== undefined) {
      parts.unshift(cur.displayName);
      cur =
        cur.parentNodeId === null ? undefined : byId.get(cur.parentNodeId);
    }
    return parts.join("/");
  }

  function toNodeView(n: BatchNodeInput | BatchNodeView): FolderNodeView {
    return {
      nodeId: n.nodeId,
      parentNodeId: n.parentNodeId,
      kind: n.kind,
      displayName: n.displayName,
      depth: 0,
      state: "state" in n ? n.state : "pending",
      ...("driveFileId" in n && n.driveFileId !== undefined
        ? { driveFileId: n.driveFileId }
        : {}),
    };
  }

  function computeDepths(nodes: FolderNodeView[]): void {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const depth = (n: FolderNodeView): number => {
      if (n.parentNodeId === null) return 0;
      const p = byId.get(n.parentNodeId);
      return p === undefined ? 0 : depth(p) + 1;
    };
    for (const n of nodes) n.depth = depth(n);
  }

  /**
   * Execute a sealed batch: folders parent-first (a child only starts once
   * its parent's driveFileId mapping is confirmed by the server), then file
   * nodes via the UploadManager with batchId/nodeId.
   */
  /** True when any ancestor node is failed — blocks the subtree. */
  function hasFailedAncestor(ctx: RunCtx, node: FolderNodeView): boolean {
    const byId = new Map(ctx.batch.nodes.map((n) => [n.nodeId, n]));
    let cur = node.parentNodeId;
    while (cur !== null) {
      const p = byId.get(cur);
      if (p === undefined) return false;
      if (p.state === "failed") return true;
      cur = p.parentNodeId;
    }
    return false;
  }

  async function execute(ctx: RunCtx): Promise<void> {
    if (ctx.batch.state !== "failed") setBatchState(ctx, "executing");
    const failedFolders = new Set<string>();
    for (const node of ctx.batch.nodes) {
      if (node.kind !== "folder" || node.state === "completed") continue;
      if (node.state === "failed" || hasFailedAncestor(ctx, node)) continue;
      const parentDriveId =
        node.parentNodeId === null
          ? ctx.dest.parentId
          : ctx.folderIds.get(node.parentNodeId);
      if (parentDriveId === undefined) continue; // parent not confirmed yet
      try {
        const view = await ports.createFolder({
          mountId: ctx.dest.mountId,
          parentId: parentDriveId,
          name: node.displayName,
          batchId: ctx.batch.batchId ?? undefined,
          nodeId: node.nodeId,
        });
        if (view.driveFileId === undefined) {
          throw new Error("folder create returned no driveFileId");
        }
        ctx.folderIds.set(node.nodeId, view.driveFileId);
        node.state = "completed";
        node.driveFileId = view.driveFileId;
        notify();
      } catch (error) {
        node.state = "failed";
        failedFolders.add(node.nodeId);
        ctx.batch.error =
          error instanceof Error ? error.message : "folder create failed";
        notify();
      }
    }
    // File nodes enqueue once their folder mapping is confirmed; nodes under
    // a failed folder stay pending until that node is retried.
    for (const node of ctx.batch.nodes) {
      if (node.kind !== "file" || node.state === "completed") continue;
      if (node.state === "in_progress" || node.state === "failed") continue;
      if (hasFailedAncestor(ctx, node)) continue;
      const file = ctx.files.get(node.nodeId);
      const parentDriveId =
        node.parentNodeId === null
          ? ctx.dest.parentId
          : ctx.folderIds.get(node.parentNodeId);
      if (file === undefined || parentDriveId === undefined) continue;
      ports.manager.enqueue(
        [{ file, name: node.displayName, batchId: ctx.batch.batchId ?? undefined, nodeId: node.nodeId }],
        { mountId: ctx.dest.mountId, parentId: parentDriveId },
      );
      node.state = "in_progress";
      notify();
    }
    if (failedFolders.size > 0) {
      ctx.batch.state = "failed";
      notify();
      void persist(ctx);
    }
  }

  async function start(
    inputs: FolderUploadFileInput[],
    dest: FolderDestination,
    rootName: string,
  ): Promise<string | null> {
    const planned = await planFolderTree(
      inputs.map((i) => ({
        path: i.path,
        totalBytes: i.file.size,
        mimeType: i.file.type || "application/octet-stream",
      })),
    );
    const item: FolderBatchItem = {
      id: newId(),
      batchId: null,
      rootName,
      mountId: dest.mountId,
      parentId: dest.parentId,
      state: "planning",
      digest: null,
      nodes: [],
      fileCount: 0,
      folderCount: 0,
      error: null,
    };
    if (!planned.ok) {
      item.state = "failed";
      item.error = `${planned.error.code}: ${planned.error.message}`;
      batches.set(item.id, { batch: item, dest, plan: { nodes: [], fileCount: 0, folderCount: 0, totalBytes: "0" as never, digest: "" }, files: new Map(), folderIds: new Map() });
      notify();
      return item.id;
    }
    const ctx: RunCtx = {
      batch: item,
      dest,
      plan: planned.plan,
      files: new Map(),
      folderIds: new Map(),
    };
    item.digest = planned.plan.digest;
    item.fileCount = planned.plan.fileCount;
    item.folderCount = planned.plan.folderCount;
    item.nodes = planned.plan.nodes.map(toNodeView);
    computeDepths(item.nodes);
    // Match files to nodes by exact relative path — same display name in
    // different folders keeps distinct nodes.
    const byPath = new Map(inputs.map((i) => [i.path, i.file]));
    for (const node of item.nodes) {
      if (node.kind !== "file") continue;
      const file = byPath.get(pathForNode(ctx, node.nodeId));
      if (file !== undefined) ctx.files.set(node.nodeId, file);
    }
    batches.set(item.id, ctx);
    notify();
    try {
      const created = await ports.createBatch(
        { mountId: dest.mountId, rootParentId: dest.parentId },
        newId(),
      );
      item.batchId = created.batchId;
      setBatchState(ctx, "sealing");
      let version = created.planVersion;
      for (let i = 0; i < planned.plan.nodes.length; i += NODE_PAGE) {
        const res = await ports.appendNodes(created.batchId, {
          planVersion: version,
          nodes: planned.plan.nodes.slice(i, i + NODE_PAGE),
        });
        version = res.planVersion;
      }
      const sealed = await ports.sealBatch(created.batchId, {
        planVersion: version,
        planHash: planned.plan.digest,
      });
      // Server canonical node states drive scheduling.
      syncNodes(ctx, sealed.nodes);
      void persist(ctx);
      void execute(ctx);
    } catch (error) {
      setBatchState(
        ctx,
        "failed",
        error instanceof Error ? error.message : "batch setup failed",
      );
    }
    return item.id;
  }

  /** Merge server node states into the client node list. */
  function syncNodes(ctx: RunCtx, serverNodes: readonly BatchNodeView[]): void {
    const byId = new Map(serverNodes.map((n) => [n.nodeId, n]));
    for (const node of ctx.batch.nodes) {
      const s = byId.get(node.nodeId);
      if (s === undefined) continue;
      node.state = s.state;
      if (s.driveFileId !== undefined) {
        node.driveFileId = s.driveFileId;
        ctx.folderIds.set(node.nodeId, s.driveFileId);
      }
    }
  }

  /**
   * Reload resume: a persisted batch record without live File objects drops
   * into needs-reselect; resumeWithFolder re-plans the user-reselected tree
   * and refuses clearly when the digest differs from the sealed plan_hash.
   */
  async function resumeWithFiles(
    id: string,
    inputs: FolderUploadFileInput[],
  ): Promise<boolean> {
    const ctx = batches.get(id);
    if (ctx === undefined || ctx.batch.batchId === null) return false;
    try {
      return await resumeWithFilesInner(ctx, inputs);
    } catch (error) {
      // Never leave a silent rejection — surface the failure on the card.
      ctx.batch.error =
        error instanceof Error ? error.message : "reselect failed";
      notify();
      return false;
    }
  }

  async function resumeWithFilesInner(
    ctx: RunCtx,
    inputs: FolderUploadFileInput[],
  ): Promise<boolean> {
    const planned = await planFolderTree(
      inputs.map((i) => ({
        path: i.path,
        totalBytes: i.file.size,
        mimeType: i.file.type || "application/octet-stream",
      })),
    );
    if (!planned.ok || planned.plan.digest !== ctx.batch.digest) {
      setBatchState(ctx, "digest-mismatch");
      return false;
    }
    const rePaths = new Map(inputs.map((i) => [i.path, i.file]));
    for (const node of ctx.batch.nodes) {
      if (node.kind !== "file") continue;
      const file = rePaths.get(pathForNode(ctx, node.nodeId));
      if (file !== undefined) ctx.files.set(node.nodeId, file);
    }
    const batchId = ctx.batch.batchId;
    if (batchId === null) return false;
    const view = await ports.getBatch(batchId);
    syncNodes(ctx, view.nodes);
    // File nodes resume through the manager's own reselect path when an
    // item exists, or enqueue fresh when the upload never started.
    const items = ports.manager.getSnapshot().items;
    for (const node of ctx.batch.nodes) {
      if (node.kind !== "file" || node.state === "completed") continue;
      const file = ctx.files.get(node.nodeId);
      if (file === undefined) continue;
      const existing = items.find((i) => i.nodeId === node.nodeId);
      if (existing !== undefined && existing.state === "needs-reselect") {
        ports.manager.resume(existing.id, file);
        node.state = "in_progress";
      } else if (existing === undefined) {
        const parentDriveId =
          node.parentNodeId === null
            ? ctx.dest.parentId
            : ctx.folderIds.get(node.parentNodeId);
        if (parentDriveId === undefined) continue;
        ports.manager.enqueue(
          [{ file, name: node.displayName, batchId: ctx.batch.batchId ?? undefined, nodeId: node.nodeId }],
          { mountId: ctx.dest.mountId, parentId: parentDriveId },
        );
        node.state = "in_progress";
      }
    }
    setBatchState(ctx, "executing");
    void execute(ctx); // pending folder nodes replay idempotently
    return true;
  }

  /** Retry one failed node; folder ops need a fresh idempotency key. */
  async function retryNode(id: string, nodeId: string): Promise<void> {
    const ctx = batches.get(id);
    if (ctx === undefined) return;
    const node = ctx.batch.nodes.find((n) => n.nodeId === nodeId);
    if (node === undefined || node.state !== "failed") return;
    if (node.kind === "folder") {
      const parentDriveId =
        node.parentNodeId === null
          ? ctx.dest.parentId
          : ctx.folderIds.get(node.parentNodeId);
      if (parentDriveId === undefined) return;
      const view = await ports.createFolder(
        {
          mountId: ctx.dest.mountId,
          parentId: parentDriveId,
          name: node.displayName,
          batchId: ctx.batch.batchId ?? undefined,
          nodeId: node.nodeId,
        },
        newId(), // new idempotency key — the derived key replays the old op
      );
      if (view.driveFileId !== undefined) {
        ctx.folderIds.set(node.nodeId, view.driveFileId);
        node.driveFileId = view.driveFileId;
      }
      node.state = "completed";
      notify();
      void execute(ctx);
      return;
    }
    const file = ctx.files.get(node.nodeId);
    const parentDriveId =
      node.parentNodeId === null
        ? ctx.dest.parentId
        : ctx.folderIds.get(node.parentNodeId);
    if (file === undefined || parentDriveId === undefined) return;
    ports.manager.enqueue(
      [{ file, name: node.displayName, batchId: ctx.batch.batchId ?? undefined, nodeId: node.nodeId }],
      { mountId: ctx.dest.mountId, parentId: parentDriveId },
    );
    node.state = "in_progress";
    notify();
  }

  function attachStore(s: FolderBatchStorePort): void {
    store = s;
  }

  async function restore(): Promise<void> {
    if (restored || store === null) return;
    restored = true;
    const records = await store.list().catch(() => []);
    for (const r of records) {
      const item: FolderBatchItem = {
        id: r.id,
        batchId: r.batchId,
        rootName: r.rootName,
        mountId: r.mountId,
        parentId: r.parentId,
        state: r.batchId === null ? "failed" : "needs-reselect",
        digest: r.digest,
        nodes: [],
        fileCount: 0,
        folderCount: 0,
        error: null,
      };
      batches.set(r.id, {
        batch: item,
        dest: { mountId: r.mountId, parentId: r.parentId },
        plan: { nodes: [], fileCount: 0, folderCount: 0, totalBytes: "0" as never, digest: r.digest },
        files: new Map(),
        folderIds: new Map(),
      });
      if (r.batchId !== null) {
        // Rebuild node view + confirmed mappings from the canonical server.
        void ports
          .getBatch(r.batchId)
          .then((view) => {
            const ctx = batches.get(r.id);
            if (ctx === undefined) return;
            ctx.batch.nodes = view.nodes.map(toNodeView);
            computeDepths(ctx.batch.nodes);
            syncNodes(ctx, view.nodes);
            ctx.batch.fileCount = ctx.batch.nodes.filter((n) => n.kind === "file").length;
            ctx.batch.folderCount = ctx.batch.nodes.length - ctx.batch.fileCount;
            if (ctx.batch.state === "needs-reselect" &&
                ctx.batch.nodes.every((n) => n.state === "completed")) {
              ctx.batch.state = "completed";
            }
            notify();
          })
          .catch(() => undefined);
      }
    }
    notify();
  }

  return {
    start,
    resumeWithFiles,
    retryNode,
    attachStore,
    restore,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): FolderBatchItem[] {
      if (dirty) {
        snapshotCache = [...batches.values()].map((c) => ({ ...c.batch, nodes: [...c.batch.nodes] }));
        dirty = false;
      }
      return snapshotCache;
    },
    /** Mark batch complete when every node is completed (manager-driven). */
    refresh(): void {
      const items = ports.manager.getSnapshot().items;
      for (const ctx of batches.values()) {
        if (ctx.batch.state !== "executing") continue;
        let changed = false;
        for (const node of ctx.batch.nodes) {
          if (node.kind !== "file" || node.state === "completed") continue;
          const item = items.find((i) => i.nodeId === node.nodeId);
          if (item === undefined) continue;
          if (item.state === "completed") {
            node.state = "completed";
            changed = true;
          } else if (item.state === "error" || item.state === "cancelled") {
            node.state = "failed";
            changed = true;
          }
        }
        if (ctx.batch.nodes.every((n) => n.state === "completed")) {
          ctx.batch.state = "completed";
          changed = true;
        }
        if (changed) {
          notify();
          void persist(ctx);
        }
      }
    },
    remove(id: string): void {
      const ctx = batches.get(id);
      if (ctx === undefined) return;
      if (ctx.batch.state !== "completed" && ctx.batch.state !== "failed") return;
      batches.delete(id);
      void store?.delete(id).catch(() => undefined);
      notify();
    },
  };
}

export type FolderUploader = ReturnType<typeof createFolderUploader>;
