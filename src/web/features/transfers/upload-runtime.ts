import {
  cancelUpload,
  createUpload,
  getUpload,
  pauseUpload,
  putUploadChunk,
  reconcileUpload,
  resumeUpload,
} from "../../lib/upload-api";
import { createWorkerHasher } from "./hash-client";
import { createRecoveryStore } from "./recovery-store";
import {
  createUploadManager,
  type EnqueueEntry,
  type FileHandlePort,
  type UploadFileLike,
  type UploadHttpPort,
  type UploadManager,
} from "./upload-manager";

/**
 * Singleton UploadManager wired to real ports (plan T09). Lives at module
 * scope — outside the router — so changing routes or closing a preview never
 * cancels the queue. Tab close stops work naturally; IndexedDB records drive
 * the reselect/resume flow on the next load.
 */

const http: UploadHttpPort = {
  create: createUpload,
  get: getUpload,
  putChunk: putUploadChunk,
  reconcile: reconcileUpload,
  pause: pauseUpload,
  resumeUpload,
  cancelUpload,
};

/**
 * File System Access is a progressive enhancement only (spec section 6.5):
 * a persisted handle whose permission is still granted can re-read the file
 * after reload without a picker; every other browser falls back to the
 * standard file input.
 */
interface FsHandle {
  getFile(): Promise<File>;
  queryPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
}

export function isFsHandle(value: unknown): value is FsHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getFile?: unknown }).getFile === "function"
  );
}

/** Read the file behind a stored handle; `request` requires a user gesture. */
export async function fileFromHandle(
  handle: unknown,
  opts: { request?: boolean } = {},
): Promise<UploadFileLike | null> {
  if (!isFsHandle(handle)) return null;
  try {
    if (handle.queryPermission !== undefined) {
      const state = await handle.queryPermission({ mode: "read" });
      if (state === "denied") return null;
      if (
        state === "prompt" &&
        (opts.request !== true || handle.requestPermission === undefined)
      ) {
        return null;
      }
      if (state === "prompt" && handle.requestPermission !== undefined) {
        const granted = await handle.requestPermission({ mode: "read" });
        if (granted !== "granted") return null;
      }
    }
    return await handle.getFile();
  } catch {
    return null;
  }
}

/**
 * File picker using showOpenFilePicker when available — the returned
 * FileSystemFileHandle is persisted in IndexedDB so a reload can re-read the
 * source with a permission prompt instead of a picker. Returns null when the
 * API is unavailable (caller falls back to a standard file input) and an
 * empty array when the user dismissed the picker.
 */
export async function pickFilesWithHandles(): Promise<EnqueueEntry[] | null> {
  const picker = (
    window as unknown as {
      showOpenFilePicker?: (opts: { multiple: boolean }) => Promise<unknown[]>;
    }
  ).showOpenFilePicker;
  if (picker === undefined) return null;
  let handles: unknown[];
  try {
    handles = await picker.call(window, { multiple: true });
  } catch (error) {
    const name =
      typeof error === "object" && error !== null
        ? (error as { name?: unknown }).name
        : undefined;
    return name === "AbortError" ? [] : null;
  }
  const entries: EnqueueEntry[] = [];
  for (const handle of handles) {
    if (!isFsHandle(handle)) continue;
    const file = await handle.getFile();
    entries.push({ file, fileHandle: handle });
  }
  return entries;
}

const fileHandlePort: FileHandlePort = {
  getFile: (handle) => fileFromHandle(handle),
};

let manager: UploadManager | null = null;

export function getUploadManager(): UploadManager {
  if (manager === null) {
    manager = createUploadManager({
      http,
      hasher: createWorkerHasher(),
      recovery: createRecoveryStore(),
      fileHandle: fileHandlePort,
    });
  }
  return manager;
}
