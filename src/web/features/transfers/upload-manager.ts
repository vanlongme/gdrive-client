import type {
  DecimalBytes,
  ReaderAccessState,
} from "../../../shared/contracts/common";
import type {
  CreateUploadRequest,
  UploadView,
} from "../../../shared/contracts/uploads";

/**
 * Browser UploadManager (spec section 6, plan T09, wave-4 contract A).
 *
 * A singleton living outside the React routes: route changes and preview
 * dialogs never cancel the queue. The class is deliberately free of DOM-only
 * globals — every external surface (HTTP, hashing, recovery persistence,
 * clock, id generation) is an injectable port so `tests/unit/upload-manager
 * .test.ts` runs in the workerd pool without DOM/IndexedDB, and `File`
 * satisfies `UploadFileLike` structurally.
 *
 * Protocol surface (existing worker routes, spec section 10.2):
 *   POST /api/v1/uploads                          create, Idempotency-Key header
 *   GET  /api/v1/uploads/:u                       canonical UploadView
 *   PUT  /api/v1/uploads/:u/chunks?generation=N&offset=D
 *   POST /api/v1/uploads/:u/reconcile|pause|resume|cancel
 * The server's UploadView is always canonical: the client only ever sends the
 * exact Blob.slice at view.confirmedOffset of view.sessionGeneration, at most
 * two files concurrently and one chunk in flight per file.
 */

/** Minimal file surface needed by the manager; `File` satisfies this. */
export interface UploadFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  slice(start: number, end?: number): Blob;
}

export interface FileHashes {
  sha256: string;
  md5: string;
}

export interface HashProgress {
  /** Decimal string of bytes hashed so far. */
  done: DecimalBytes;
  total: DecimalBytes;
}

export interface HasherPort {
  hash(
    file: UploadFileLike,
    opts: { signal?: AbortSignal; onProgress?: (p: HashProgress) => void },
  ): Promise<FileHashes>;
}

export interface UploadHttpPort {
  create(
    body: CreateUploadRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<UploadView>;
  get(uploadId: string, signal?: AbortSignal): Promise<UploadView>;
  putChunk(
    uploadId: string,
    generation: number,
    offset: DecimalBytes,
    chunk: Blob,
    signal?: AbortSignal,
  ): Promise<UploadView>;
  reconcile(uploadId: string, signal?: AbortSignal): Promise<UploadView>;
  pause(uploadId: string, signal?: AbortSignal): Promise<UploadView>;
  resumeUpload(uploadId: string, signal?: AbortSignal): Promise<UploadView>;
  cancelUpload(uploadId: string, signal?: AbortSignal): Promise<UploadView>;
}

/**
 * Recovery metadata persisted in IndexedDB (spec section 6.5): checksums,
 * session identity and confirmed offset only — never tokens, file bytes or
 * credentials. `fileHandle` optionally stores a FileSystemFileHandle so a
 * reload can re-read the source without a picker on browsers that support it.
 */
export interface RecoveryRecord {
  id: string;
  uploadId: string | null;
  idempotencyKey: string;
  mountId: string;
  parentId: string;
  batchId?: string;
  nodeId?: string;
  name: string;
  mimeType: string;
  totalBytes: DecimalBytes;
  lastModified: number;
  sha256: string | null;
  md5: string | null;
  confirmedOffset: DecimalBytes;
  state: TransferState;
  updatedAt: number;
  fileHandle?: unknown;
}

export interface RecoveryStorePort {
  list(): Promise<RecoveryRecord[]>;
  put(record: RecoveryRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Optional File System Access seam. `getFile` returns the re-readable source
 * or null when the handle is missing/permission was not granted yet — the
 * item then falls back to the explicit reselect flow.
 */
export interface FileHandlePort {
  getFile(handle: unknown): Promise<UploadFileLike | null>;
}

export type TransferState =
  | "queued"
  | "preparing"
  | "sending"
  | "confirming"
  | "paused"
  | "needs-reselect"
  | "completed"
  | "cancelled"
  | "error";

export interface TransferError {
  code: string;
  message: string;
  requestId?: string;
}

export interface TransferItemView {
  id: string;
  uploadId: string | null;
  name: string;
  mimeType: string;
  mountId: string;
  parentId: string;
  /** Batch linkage when the item belongs to a folder-upload plan. */
  batchId?: string;
  nodeId?: string;
  totalBytes: DecimalBytes;
  /** Bytes the server has confirmed persisted (canonical). */
  confirmedBytes: DecimalBytes;
  /** Bytes the client has sent but not yet had confirmed — display only. */
  sentBytes: DecimalBytes;
  /** Bytes hashed so far while state === "preparing". */
  preparedBytes: DecimalBytes;
  state: TransferState;
  /** Last canonical server state, when known. */
  serverState: UploadView["state"] | null;
  readerAccessState: ReaderAccessState | null;
  error: TransferError | null;
  /** Whether the manager still holds a readable source for this item. */
  hasFile: boolean;
  /** Whether a FileSystemFileHandle was persisted for handle-based resume. */
  hasStoredHandle: boolean;
}

export interface TransferSnapshot {
  items: TransferItemView[];
  activeCount: number;
}

export interface UploadDestination {
  mountId: string;
  parentId: string;
}

/**
 * One file to enqueue. `batchId`/`nodeId` attach the operation to a sealed
 * folder-upload plan (CreateUploadRequest already carries both fields); the
 * Wave 5 folder UI from worker B resolves the parent Drive ID itself and
 * passes it through `destination.parentId`.
 */
export interface EnqueueEntry {
  file: UploadFileLike;
  /** Display name override; defaults to file.name. */
  name?: string;
  batchId?: string;
  nodeId?: string;
  /** Optional FileSystemFileHandle persisted for reload-less reselect. */
  fileHandle?: unknown;
}

export interface UploadManagerPorts {
  http: UploadHttpPort;
  hasher: HasherPort;
  recovery: RecoveryStorePort;
  fileHandle?: FileHandlePort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** Max files uploading at once (spec: two). */
  maxConcurrent?: number;
  /** Bounded reconcile/refresh retries before an item errors. */
  maxRecoveryAttempts?: number;
}

export interface UploadManager {
  enqueue(entries: EnqueueEntry[], destination: UploadDestination): string[];
  pause(id: string): void;
  resume(id: string, file?: UploadFileLike): void;
  cancel(id: string): void;
  /** Drop a terminal/needs-reselect item from the list and its record. */
  remove(id: string): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): TransferSnapshot;
  /** Opaque persisted handle (FileSystemFileHandle) for reselect flows. */
  getStoredHandle(id: string): unknown | null;
  /** Load persisted recovery records once after startup/reload. */
  restore(): Promise<void>;
}

interface Item {
  id: string;
  uploadId: string | null;
  idempotencyKey: string;
  mountId: string;
  parentId: string;
  batchId?: string;
  nodeId?: string;
  name: string;
  mimeType: string;
  totalBytes: DecimalBytes;
  total: bigint;
  lastModified: number;
  file: UploadFileLike | null;
  fileHandle: unknown;
  sha256: string | null;
  md5: string | null;
  state: TransferState;
  serverState: UploadView["state"] | null;
  readerAccessState: ReaderAccessState | null;
  confirmed: bigint;
  sent: bigint;
  prepared: bigint;
  chunkSize: number;
  sessionGeneration: number;
  error: TransferError | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  abort: AbortController | null;
  running: boolean;
  enqueueSeq: number;
}

type StepResult = "continue" | "stop";

const TERMINAL_SERVER_STATES = new Set<UploadView["state"]>([
  "completed",
  "cancelled",
  "expired",
  "conflict",
  "cleanup_pending",
]);

const TERMINAL_ITEM_STATES = new Set<TransferState>([
  "completed",
  "cancelled",
  "error",
]);

const CONFIRMING_SERVER_STATES = new Set<UploadView["state"]>([
  "reconciling",
  "verifying",
]);

function toDecimal(value: bigint): DecimalBytes {
  return value.toString(10) as DecimalBytes;
}

function errorInfo(error: unknown): TransferError {
  if (typeof error === "object" && error !== null) {
    const e = error as {
      code?: unknown;
      message?: unknown;
      requestId?: unknown;
    };
    if (typeof e.code === "string" && typeof e.message === "string") {
      const requestId =
        typeof e.requestId === "string" ? e.requestId : undefined;
      return requestId === undefined
        ? { code: e.code, message: e.message }
        : { code: e.code, message: e.message, requestId };
    }
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "Unknown upload failure." };
}

function isRetriable(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code !== "string") return true;
  return (
    code === "NETWORK_ERROR" ||
    code === "DRIVE_UNAVAILABLE" ||
    code === "UPLOAD_NEEDS_RECONCILIATION" ||
    code === "VALIDATION_FAILED" ||
    code === "RATE_LIMITED" ||
    code === "INTERNAL_ERROR"
  );
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function createUploadManager(ports: UploadManagerPorts): UploadManager {
  const now = ports.now ?? (() => Date.now());
  const sleep =
    ports.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const newId =
    ports.newId ??
    (() => {
      return crypto.randomUUID();
    });
  const maxConcurrent = ports.maxConcurrent ?? 2;
  const maxRecoveryAttempts = ports.maxRecoveryAttempts ?? 4;

  const items = new Map<string, Item>();
  const listeners = new Set<() => void>();
  let snapshotCache: TransferSnapshot = { items: [], activeCount: 0 };
  let snapshotDirty = true;
  let seq = 0;
  let restorePromise: Promise<void> | null = null;

  function markDirty(): void {
    snapshotDirty = true;
    for (const listener of listeners) listener();
  }

  function snapshotOf(item: Item): TransferItemView {
    return {
      id: item.id,
      uploadId: item.uploadId,
      name: item.name,
      mimeType: item.mimeType,
      mountId: item.mountId,
      parentId: item.parentId,
      ...(item.batchId === undefined ? {} : { batchId: item.batchId }),
      ...(item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
      totalBytes: item.totalBytes,
      confirmedBytes: toDecimal(item.confirmed),
      sentBytes: toDecimal(item.sent),
      preparedBytes: toDecimal(item.prepared),
      state: item.state,
      serverState: item.serverState,
      readerAccessState: item.readerAccessState,
      error: item.error,
      hasFile: item.file !== null,
      hasStoredHandle: item.fileHandle != null,
    };
  }

  function persist(item: Item): void {
    const record: RecoveryRecord = {
      id: item.id,
      uploadId: item.uploadId,
      idempotencyKey: item.idempotencyKey,
      mountId: item.mountId,
      parentId: item.parentId,
      ...(item.batchId === undefined ? {} : { batchId: item.batchId }),
      ...(item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
      name: item.name,
      mimeType: item.mimeType,
      totalBytes: item.totalBytes,
      lastModified: item.lastModified,
      sha256: item.sha256,
      md5: item.md5,
      confirmedOffset: toDecimal(item.confirmed),
      state: item.state,
      updatedAt: now(),
      ...(item.fileHandle == null ? {} : { fileHandle: item.fileHandle }),
    };
    // Persistence is best-effort metadata; a store failure must not break
    // an in-flight upload.
    void ports.recovery.put(record).catch(() => undefined);
  }

  function setState(item: Item, state: TransferState): void {
    if (item.state === state) return;
    item.state = state;
    markDirty();
  }

  function applyView(item: Item, view: UploadView): void {
    item.uploadId = view.uploadId;
    item.serverState = view.state;
    item.readerAccessState = view.readerAccessState;
    item.chunkSize = view.chunkSize;
    item.sessionGeneration = view.sessionGeneration;
    const confirmed = BigInt(view.confirmedOffset);
    // The canonical view is authoritative even on a rewind: after a session
    // generation bump or renew the server may legitimately lower
    // confirmedOffset, and locally-sent bytes are then unconfirmed.
    const rewound = confirmed < item.confirmed;
    item.confirmed = confirmed;
    if (item.sent < item.confirmed || rewound) item.sent = item.confirmed;
    markDirty();
  }

  /** Re-read the server's canonical UploadView (never trust local bytes). */
  async function canonicalView(item: Item): Promise<UploadView> {
    if (item.uploadId !== null) {
      try {
        return await ports.http.get(item.uploadId);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        if (code !== "NOT_FOUND") throw error;
        // The record is gone server-side; fall through to a fresh idempotent
        // init which replays into the same operation via the Idempotency-Key.
      }
    }
    if (item.sha256 === null || item.md5 === null || item.file === null) {
      throw new Error("upload item is missing its verified source");
    }
    const body: CreateUploadRequest = {
      mountId: item.mountId,
      parentId: item.parentId,
      name: item.name,
      mimeType: item.mimeType,
      totalBytes: item.totalBytes,
      sha256: item.sha256,
      md5: item.md5,
      ...(item.batchId === undefined ? {} : { batchId: item.batchId }),
      ...(item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
    };
    return ports.http.create(body, item.idempotencyKey);
  }

  async function ensureHashes(item: Item): Promise<void> {
    if (item.sha256 !== null && item.md5 !== null) return;
    if (item.file === null) {
      setState(item, "needs-reselect");
      throw new Error("unreachable: hashing without a file");
    }
    setState(item, "preparing");
    const file = item.file;
    const signal = item.abort?.signal;
    const hashes = await ports.hasher.hash(file, {
      ...(signal === undefined ? {} : { signal }),
      onProgress: (p) => {
        item.prepared = BigInt(p.done);
        markDirty();
      },
    });
    item.sha256 = hashes.sha256;
    item.md5 = hashes.md5;
    persist(item);
  }

  async function sendNextChunk(item: Item): Promise<UploadView> {
    if (item.file === null) {
      setState(item, "needs-reselect");
      throw new Error("unreachable: sending without a file");
    }
    const offset = item.confirmed;
    const end =
      offset + BigInt(item.chunkSize) < item.total
        ? offset + BigInt(item.chunkSize)
        : item.total;
    const chunk = item.file.slice(Number(offset), Number(end));
    item.sent = end;
    markDirty();
    const controller = new AbortController();
    item.abort = controller;
    try {
      return await ports.http.putChunk(
        item.uploadId ?? "",
        item.sessionGeneration,
        toDecimal(offset),
        chunk,
        controller.signal,
      );
    } finally {
      item.abort = null;
    }
  }

  async function pump(item: Item): Promise<void> {
    if (item.running) return;
    item.running = true;
    try {
      for (;;) {
        if (item.cancelRequested) {
          await runCancel(item);
          return;
        }
        if (item.pauseRequested) {
          await runPause(item);
          return;
        }
        const result = await step(item);
        if (result === "stop") return;
      }
    } finally {
      item.running = false;
      markDirty();
      schedule();
    }
  }

  async function step(item: Item): Promise<StepResult> {
    try {
      if (item.file === null) {
        setState(item, "needs-reselect");
        return "stop";
      }
      await ensureHashes(item);
      const view = await canonicalView(item);
      applyView(item, view);
      persist(item);
      // Bounded control-loop: consecutive reconcile/resume calls back off
      // like recover() and give up after a bound, never storming the server.
      let controlCalls = 0;
      for (;;) {
        if (item.cancelRequested) return "continue";
        if (item.pauseRequested) return "continue";
        if (item.serverState === null) return "stop";
        if (TERMINAL_SERVER_STATES.has(item.serverState)) {
          finishTerminal(item);
          return "stop";
        }
        const needsControl =
          CONFIRMING_SERVER_STATES.has(item.serverState) ||
          item.serverState === "paused" ||
          item.confirmed >= item.total;
        if (needsControl && controlCalls >= maxRecoveryAttempts) {
          fail(item, {
            code: "UNEXPECTED_RESPONSE",
            message: "Upload did not settle after bounded reconciliation.",
          });
          return "stop";
        }
        if (needsControl) {
          if (controlCalls > 0) {
            await sleep(Math.min(250 * 2 ** controlCalls, 4000));
            if (item.cancelRequested || item.pauseRequested) return "continue";
          }
          controlCalls += 1;
        }
        if (CONFIRMING_SERVER_STATES.has(item.serverState)) {
          setState(item, "confirming");
          const reconciled = await ports.http.reconcile(item.uploadId ?? "");
          applyView(item, reconciled);
          persist(item);
          continue;
        }
        if (item.serverState === "paused") {
          // Pump is only running because the user wants the upload active —
          // a server-side paused view needs an explicit resume call first.
          const resumed = await ports.http.resumeUpload(item.uploadId ?? "");
          applyView(item, resumed);
          persist(item);
          continue;
        }
        if (item.serverState === "blocked") {
          fail(item, { code: "UPLOAD_BLOCKED", message: "Upload is blocked." });
          return "stop";
        }
        // created | preparing | uploading: send the next confirmed chunk.
        if (item.confirmed >= item.total) {
          // Everything sent; a completed state must come from the server —
          // reconcile once per pass to give it a chance to finalize.
          setState(item, "confirming");
          const reconciled = await ports.http.reconcile(item.uploadId ?? "");
          applyView(item, reconciled);
          persist(item);
          continue;
        }
        setState(item, "sending");
        try {
          const result = await sendNextChunk(item);
          applyView(item, result);
          persist(item);
          controlCalls = 0;
        } catch (error) {
          // A failed PUT rewinds the optimistic sent bound — the bytes are
          // unconfirmed until the canonical view says otherwise.
          item.sent = item.confirmed;
          markDirty();
          if (item.cancelRequested || isAbort(error)) return "continue";
          const recovered = await recover(item, error);
          if (!recovered) return "stop";
        }
      }
    } catch (error) {
      if (item.cancelRequested || isAbort(error)) return "continue";
      if (item.pauseRequested) return "continue";
      if (
        item.state === "needs-reselect" ||
        item.state === "paused" ||
        item.state === "error"
      ) {
        return "stop";
      }
      const recovered = await recover(item, error);
      return recovered ? "continue" : "stop";
    }
  }

  /**
   * Bounded recovery: ask the server for the canonical view (reconcile
   * probes the remote session, get falls back to the projection), backing
   * off between attempts. Returns false when the item moved to a terminal
   * error/paused/reselect state.
   */
  async function recover(item: Item, cause: unknown): Promise<boolean> {
    if (!isRetriable(cause)) {
      fail(item, errorInfo(cause));
      return false;
    }
    const info = errorInfo(cause);
    for (let attempt = 0; attempt < maxRecoveryAttempts; attempt++) {
      if (item.cancelRequested || item.pauseRequested) return true;
      try {
        setState(item, "confirming");
        await sleep(Math.min(500 * 2 ** attempt, 5000));
        const view =
          item.uploadId === null
            ? await canonicalView(item)
            : await ports.http.reconcile(item.uploadId);
        applyView(item, view);
        persist(item);
        item.error = null;
        return true;
      } catch (error) {
        if (item.cancelRequested || isAbort(error)) return true;
        if (item.pauseRequested) return true;
        if (!isRetriable(error)) {
          fail(item, errorInfo(error));
          return false;
        }
      }
    }
    fail(item, info);
    return false;
  }

  function finishTerminal(item: Item): void {
    switch (item.serverState) {
      case "completed":
        item.confirmed = item.total;
        item.sent = item.total;
        setState(item, "completed");
        break;
      case "cancelled":
      case "cleanup_pending":
        setState(item, "cancelled");
        break;
      case "expired":
        fail(item, {
          code: "UPLOAD_EXPIRED",
          message: "The upload session expired before completion.",
        });
        break;
      case "conflict":
        fail(item, {
          code: "FILE_CONFLICT",
          message: "The uploaded file conflicts with an existing file.",
        });
        break;
      default:
        fail(item, {
          code: "INTERNAL_ERROR",
          message: "Upload ended in an unexpected state.",
        });
    }
    persist(item);
  }

  function fail(item: Item, error: TransferError): void {
    item.error = error;
    setState(item, "error");
    persist(item);
  }

  async function runPause(item: Item): Promise<void> {
    item.pauseRequested = false;
    if (item.uploadId !== null && item.serverState !== null) {
      try {
        const view = await ports.http.pause(item.uploadId);
        applyView(item, view);
      } catch (error) {
        if (!isRetriable(error)) {
          fail(item, errorInfo(error));
          return;
        }
        // A failed pause call still leaves the local item paused — the next
        // resume reconciles before granting chunks.
      }
    }
    setState(item, "paused");
    persist(item);
  }

  async function runCancel(item: Item): Promise<void> {
    if (item.uploadId !== null) {
      try {
        const view = await ports.http.cancelUpload(item.uploadId);
        applyView(item, view);
      } catch (error) {
        if (!isRetriable(error)) {
          item.cancelRequested = false;
          fail(item, errorInfo(error));
          return;
        }
        // A retriable cancel failure must NOT mark the item cancelled — the
        // server still believes it uploads. Keep the request pending so an
        // explicit cancel/retry repeats the call.
        item.error = errorInfo(error);
        setState(item, "error");
        persist(item);
        return;
      }
    }
    item.cancelRequested = false;
    setState(item, "cancelled");
    persist(item);
  }

  /**
   * Reselect + rehash + canonical view before resuming (spec section 6.1):
   * name/size/time is never proof of identical content — the stored
   * SHA-256/MD5 must match the recomputed digests.
   */
  async function reselect(item: Item, file: UploadFileLike): Promise<void> {
    item.file = file;
    setState(item, "preparing");
    item.error = null;
    try {
      const hashes = await ports.hasher.hash(file, {
        onProgress: (p) => {
          item.prepared = BigInt(p.done);
          markDirty();
        },
      });
      if (item.sha256 === null || item.md5 === null) {
        // Records restored without digests adopt the fresh hashes; the
        // server-side input_hash still guards a genuinely different file.
        item.sha256 = hashes.sha256;
        item.md5 = hashes.md5;
      }
      if (
        BigInt(file.size) !== item.total ||
        hashes.sha256 !== item.sha256 ||
        hashes.md5 !== item.md5
      ) {
        item.file = null;
        fail(item, {
          code: "RESELECT_MISMATCH",
          message: "The selected file does not match the interrupted upload.",
        });
        setState(item, "needs-reselect");
        persist(item);
        return;
      }
      const view = await canonicalView(item);
      applyView(item, view);
      persist(item);
      await pump(item);
    } catch (error) {
      if (isAbort(error)) return;
      const recovered = await recover(item, error);
      if (recovered) await pump(item);
    }
  }

  function schedule(): void {
    let active = 0;
    for (const item of items.values()) {
      if (item.running) active += 1;
    }
    if (active >= maxConcurrent) return;
    const queued = [...items.values()]
      .filter((item) => item.state === "queued" && !item.running)
      .sort((a, b) => a.enqueueSeq - b.enqueueSeq);
    for (const item of queued) {
      if (active >= maxConcurrent) return;
      active += 1;
      void pump(item);
    }
  }

  function enqueue(
    entries: EnqueueEntry[],
    destination: UploadDestination,
  ): string[] {
    const ids: string[] = [];
    for (const entry of entries) {
      const id = newId();
      const item: Item = {
        id,
        uploadId: null,
        idempotencyKey: newId(),
        mountId: destination.mountId,
        parentId: destination.parentId,
        ...(entry.batchId === undefined ? {} : { batchId: entry.batchId }),
        ...(entry.nodeId === undefined ? {} : { nodeId: entry.nodeId }),
        name: entry.name ?? entry.file.name,
        mimeType: entry.file.type || "application/octet-stream",
        totalBytes: toDecimal(BigInt(entry.file.size)),
        total: BigInt(entry.file.size),
        lastModified: entry.file.lastModified,
        file: entry.file,
        fileHandle: entry.fileHandle ?? null,
        sha256: null,
        md5: null,
        state: "queued",
        serverState: null,
        readerAccessState: null,
        confirmed: 0n,
        sent: 0n,
        prepared: 0n,
        chunkSize: 8 * 1024 * 1024,
        sessionGeneration: 1,
        error: null,
        pauseRequested: false,
        cancelRequested: false,
        abort: null,
        running: false,
        enqueueSeq: seq,
      };
      seq += 1;
      items.set(id, item);
      persist(item);
      ids.push(id);
    }
    markDirty();
    schedule();
    return ids;
  }

  function pause(id: string): void {
    const item = items.get(id);
    if (item === undefined) return;
    if (item.state === "queued") {
      setState(item, "paused");
      persist(item);
      return;
    }
    if (item.state === "paused" || TERMINAL_ITEM_STATES.has(item.state)) {
      return;
    }
    item.pauseRequested = true;
    if (!item.running) void pump(item);
    markDirty();
  }

  function resume(id: string, file?: UploadFileLike): void {
    const item = items.get(id);
    if (item === undefined) return;
    if (item.state === "needs-reselect") {
      if (file === undefined) return;
      void reselect(item, file);
      return;
    }
    if (item.state === "error" && item.file === null) {
      if (file === undefined) return;
      item.file = file;
      item.error = null;
      void reselect(item, file);
      return;
    }
    if (item.state !== "paused" && item.state !== "error") {
      // In-flight states: a resume click during the stop window simply
      // cancels a pending pause request so the pump keeps going.
      item.pauseRequested = false;
      markDirty();
      return;
    }
    item.pauseRequested = false;
    item.error = null;
    setState(item, "queued");
    markDirty();
    schedule();
  }

  function cancel(id: string): void {
    const item = items.get(id);
    if (item === undefined) return;
    // A retriable cancel failure parks the item in error with the request
    // still pending — clicking cancel again retries the server call.
    if (item.state === "error" && item.cancelRequested) {
      if (!item.running) void pump(item);
      return;
    }
    if (TERMINAL_ITEM_STATES.has(item.state)) return;
    item.cancelRequested = true;
    item.abort?.abort();
    if (!item.running) void pump(item);
    markDirty();
  }

  function remove(id: string): void {
    const item = items.get(id);
    if (item === undefined) return;
    if (!TERMINAL_ITEM_STATES.has(item.state) && item.state !== "needs-reselect") {
      return;
    }
    if (item.uploadId !== null && item.state === "needs-reselect") {
      // Best-effort: the user discarded a resumable upload — let the server
      // record the intent; failure here is harmless.
      void ports.http.cancelUpload(item.uploadId).catch(() => undefined);
    }
    items.delete(id);
    void ports.recovery.delete(id).catch(() => undefined);
    markDirty();
  }

  /** One persisted record → Item, isolated so a malformed row is skipped. */
  function restoreRecord(record: RecoveryRecord): void {
    if (items.has(record.id)) return;
    const state = TERMINAL_ITEM_STATES.has(record.state)
      ? record.state
      : "needs-reselect";
    const item: Item = {
      id: record.id,
      uploadId: record.uploadId,
      idempotencyKey: record.idempotencyKey,
      mountId: record.mountId,
      parentId: record.parentId,
      ...(record.batchId === undefined ? {} : { batchId: record.batchId }),
      ...(record.nodeId === undefined ? {} : { nodeId: record.nodeId }),
      name: record.name,
      mimeType: record.mimeType,
      totalBytes: record.totalBytes,
      total: BigInt(record.totalBytes),
      lastModified: record.lastModified,
      file: null,
      fileHandle: record.fileHandle ?? null,
      sha256: record.sha256,
      md5: record.md5,
      state,
      serverState: null,
      readerAccessState: null,
      confirmed: BigInt(record.confirmedOffset),
      sent: BigInt(record.confirmedOffset),
      prepared: 0n,
      chunkSize: 8 * 1024 * 1024,
      sessionGeneration: 1,
      error:
        state === "error"
          ? { code: "INTERNAL_ERROR", message: "Upload did not finish." }
          : null,
      pauseRequested: false,
      cancelRequested: false,
      abort: null,
      running: false,
      enqueueSeq: seq,
    };
    seq += 1;
    items.set(item.id, item);
  }

  async function restore(): Promise<void> {
    if (restorePromise !== null) return restorePromise;
    restorePromise = (async () => {
      let records: RecoveryRecord[] = [];
      try {
        records = await ports.recovery.list();
      } catch {
        return;
      }
      for (const record of records) {
        try {
          restoreRecord(record);
        } catch {
          // One malformed record must not lose every other pending upload.
        }
      }
      markDirty();
      // Optional File System Access upgrade: a persisted handle whose read
      // permission is still granted lets the item re-verify and resume
      // without a picker (spec: FSA is an improvement, never a requirement).
      if (ports.fileHandle !== undefined) {
        for (const item of items.values()) {
          if (item.state !== "needs-reselect" || item.fileHandle == null) {
            continue;
          }
          const file = await ports.fileHandle
            .getFile(item.fileHandle)
            .catch(() => null);
          if (file !== null) void reselect(item, file);
        }
      }
    })();
    return restorePromise;
  }

  return {
    enqueue,
    pause,
    resume,
    cancel,
    remove,
    restore,
    getStoredHandle(id) {
      return items.get(id)?.fileHandle ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      if (snapshotDirty) {
        snapshotCache = {
          items: [...items.values()].map(snapshotOf),
          activeCount: [...items.values()].filter(
            (item) =>
              item.running ||
              item.state === "queued" ||
              item.state === "preparing" ||
              item.state === "sending" ||
              item.state === "confirming",
          ).length,
        };
        snapshotDirty = false;
      }
      return snapshotCache;
    },
  };
}
