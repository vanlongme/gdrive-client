import { useEffect, useRef, useSyncExternalStore } from "react";
import { fileFromHandle, getUploadManager } from "./upload-runtime";
import type { TransferItemView, TransferSnapshot } from "./upload-manager";
import { getFolderUploader } from "./folder-runtime";
import type { FolderBatchItem } from "./folder-upload";

/**
 * React binding for the singleton UploadManager. The store lives outside the
 * router, so this hook re-renders on state changes but never owns the queue.
 */
export function useTransferSnapshot(): TransferSnapshot {
  const manager = getUploadManager();
  return useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot,
  );
}

/** Loads persisted recovery metadata once (reload → reselect flow). */
export function useTransferRestore(): void {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void getUploadManager().restore();
  }, []);
}

/**
 * Reselect flow after reload: prefer a user-gesture permission prompt on the
 * persisted FileSystemFileHandle; otherwise open the standard file input.
 */
export function useReselectFile(
  item: TransferItemView,
  inputRef: React.RefObject<HTMLInputElement | null>,
): () => Promise<void> {
  const manager = getUploadManager();
  return async () => {
    const handle = manager.getStoredHandle(item.id);
    if (handle !== null) {
      const file = await fileFromHandle(handle, { request: true });
      if (file !== null) {
        manager.resume(item.id, file);
        return;
      }
    }
    inputRef.current?.click();
  };
}

/** Folder-upload batches (T10): the singleton orchestrator's snapshot. */
export function useFolderBatches(): FolderBatchItem[] {
  const uploader = getFolderUploader();
  return useSyncExternalStore(
    uploader.subscribe,
    uploader.getSnapshot,
    uploader.getSnapshot,
  );
}
