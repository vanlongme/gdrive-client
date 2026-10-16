import type { Page, Route } from "@playwright/test";
import { canonicalPlanDigest } from "../../src/shared/contracts/uploads";
import type { UploadFixture } from "./upload-fixtures";
import { installUploadFixtures } from "./upload-fixtures";

/**
 * Folder-upload E2E fixtures (T10): protocol-faithful in-memory batch +
 * folder routes mirroring worker B's semantics — Idempotency-Key batch
 * create, planVersion CAS on paged node appends, planHash assertion at seal,
 * parent-mapping-confirmed gating on POST /folders, derived batch-node
 * idempotency. File-node state is linked to the upload fixture's real
 * UploadManager-driven traffic. [fixture] — not live Google evidence.
 */

interface E2eNode {
  nodeId: string;
  parentNodeId: string | null;
  kind: "folder" | "file";
  displayName: string;
  state: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  driveFileId?: string;
  uploadId?: string;
  mimeType?: string;
  totalBytes?: string;
}

interface E2eBatch {
  batchId: string;
  mountId: string;
  rootParentId: string;
  planVersion: number;
  sealed: boolean;
  planHash: string | null;
  nodes: E2eNode[];
}

export interface FolderFixture {
  calls: string[];
  batchOf(): E2eBatch | undefined;
  /** Fail the folder create for this displayName once (DRIVE_UNAVAILABLE). */
  failFolderOnce(name: string): void;
  uploads: UploadFixture;
}

function err(code: string, message: string): string {
  return JSON.stringify({ error: { code, message, requestId: "e2e-fu" } });
}

function viewOf(b: E2eBatch): Record<string, unknown> {
  return {
    batchId: b.batchId,
    state: b.sealed ? "executing" : "draft",
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
      ...(n.uploadId === undefined ? {} : { uploadId: n.uploadId }),
      ...(n.mimeType === undefined ? {} : { mimeType: n.mimeType }),
      ...(n.totalBytes === undefined ? {} : { totalBytes: n.totalBytes }),
    })),
  };
}

export function installFolderFixtures(page: Page): FolderFixture {
  const calls: string[] = [];
  const batches = new Map<string, E2eBatch>();
  const failedOnce = new Set<string>();
  const failList = new Set<string>();
  const fixture: FolderFixture = {
    calls,
    uploads: undefined as unknown as UploadFixture,
    batchOf: () => batches.values().next().value,
    failFolderOnce: (name) => failList.add(name),
  };
  let nextId = 1;

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  // File nodes track the upload fixture's real traffic.
  fixture.uploads = installUploadFixtures(page, {
    onUploadCreated: ({ batchId, nodeId, uploadId }) => {
      const b = batches.get(batchId ?? "");
      const node = b?.nodes.find((n) => n.nodeId === nodeId);
      if (node !== undefined) {
        node.uploadId = uploadId;
        if (node.state === "pending") node.state = "in_progress";
      }
    },
    onUploadView: ({ uploadId, state }) => {
      for (const b of batches.values()) {
        const node = b.nodes.find((n) => n.uploadId === uploadId);
        if (node !== undefined && state === "completed") {
          node.state = "completed";
        }
      }
    },
  });

  void page.route("**/api/v1/upload-batches**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    calls.push(`${method} ${path}${url.search}`);

    if (path === "/api/v1/upload-batches" && method === "POST") {
      const key = route.request().headers()["idempotency-key"];
      if (key === undefined || key === "") {
        await json(route, err("VALIDATION_FAILED", "Idempotency-Key required"), 400);
        return;
      }
      const body = route.request().postDataJSON() as {
        mountId: string;
        rootParentId: string;
      };
      const batchId = `batch-e2e-${nextId++}`;
      batches.set(batchId, {
        batchId,
        mountId: body.mountId,
        rootParentId: body.rootParentId,
        planVersion: 0,
        sealed: false,
        planHash: null,
        nodes: [],
      });
      await json(route, viewOf(batches.get(batchId) as E2eBatch));
      return;
    }

    const nodesMatch = path.match(/^\/api\/v1\/upload-batches\/([^/]+)\/nodes$/);
    if (nodesMatch !== null && method === "POST") {
      const b = batches.get(decodeURIComponent(nodesMatch[1] ?? ""));
      if (b === undefined) {
        await json(route, err("NOT_FOUND", "gone"), 404);
        return;
      }
      const body = route.request().postDataJSON() as {
        planVersion: number;
        nodes: E2eNode[];
      };
      if (b.sealed || body.planVersion !== b.planVersion) {
        await json(route, err("VALIDATION_FAILED", "planVersion mismatch"), 409);
        return;
      }
      for (const n of body.nodes) {
        b.nodes.push({ ...n, state: "pending" });
      }
      b.planVersion += 1;
      await json(route, viewOf(b));
      return;
    }

    const sealMatch = path.match(/^\/api\/v1\/upload-batches\/([^/]+)\/seal$/);
    if (sealMatch !== null && method === "POST") {
      const b = batches.get(decodeURIComponent(sealMatch[1] ?? ""));
      if (b === undefined) {
        await json(route, err("NOT_FOUND", "gone"), 404);
        return;
      }
      const body = route.request().postDataJSON() as {
        planVersion?: number;
        planHash?: string;
      };
      if (body.planVersion !== undefined && body.planVersion !== b.planVersion) {
        await json(route, err("VALIDATION_FAILED", "planVersion mismatch"), 409);
        return;
      }
      const digest = await canonicalPlanDigest(b.nodes);
      if (body.planHash !== undefined && body.planHash !== digest) {
        await json(route, err("VALIDATION_FAILED", "planHash mismatch"), 409);
        return;
      }
      b.sealed = true;
      b.planHash = digest;
      await json(route, viewOf(b));
      return;
    }

    const getMatch = path.match(/^\/api\/v1\/upload-batches\/([^/]+)$/);
    if (getMatch !== null && method === "GET") {
      const b = batches.get(decodeURIComponent(getMatch[1] ?? ""));
      if (b === undefined) {
        await json(route, err("NOT_FOUND", "gone"), 404);
        return;
      }
      await json(route, viewOf(b));
      return;
    }

    await json(route, err("NOT_FOUND", "unhandled"), 404);
  });

  void page.route("**/api/v1/folders**", async (route) => {
    if (route.request().method() !== "POST") {
      await json(route, err("NOT_FOUND", "unhandled"), 404);
      return;
    }
    const body = route.request().postDataJSON() as {
      mountId: string;
      parentId: string;
      name: string;
      batchId?: string;
      nodeId?: string;
    };
    calls.push(`folder:${body.name}`);
    const b = batches.get(body.batchId ?? "");
    const node = b?.nodes.find((n) => n.nodeId === body.nodeId);
    if (b === undefined || node === undefined) {
      await json(route, err("NOT_FOUND", "no such node"), 404);
      return;
    }
    // Parent mapping must be confirmed before the child op.
    if (node.parentNodeId !== null) {
      const parent = b.nodes.find((n) => n.nodeId === node.parentNodeId);
      if (parent === undefined || parent.driveFileId !== body.parentId) {
        await json(route, err("VALIDATION_FAILED", "parent not confirmed"), 409);
        return;
      }
    } else if (body.parentId !== b.rootParentId) {
      await json(route, err("VALIDATION_FAILED", "wrong root parent"), 409);
      return;
    }
    if (failList.has(node.displayName) && !failedOnce.has(node.nodeId)) {
      failedOnce.add(node.nodeId);
      node.state = "failed";
      await json(route, err("DRIVE_UNAVAILABLE", "folder create lost"), 503);
      return;
    }
    node.state = "completed";
    node.driveFileId = `drv-${node.nodeId}`;
    await json(route, {
      uploadId: `fop-${node.nodeId}`,
      state: "completed",
      sessionGeneration: 1,
      confirmedOffset: "0",
      totalBytes: "0",
      chunkSize: 8388608,
      readerAccessState: "readable",
      driveFileId: node.driveFileId,
    });
  });

  return fixture;
}
