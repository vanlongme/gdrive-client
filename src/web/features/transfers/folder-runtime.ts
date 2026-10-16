import {
  appendBatchNodes,
  createFolder,
  createUploadBatch,
  getUploadBatch,
  sealUploadBatch,
} from "../../lib/upload-api";
import {
  createFolderUploader,
  type FolderUploader,
} from "./folder-upload";
import { createFolderBatchStore } from "./recovery-store";
import { getUploadManager } from "./upload-runtime";

/**
 * Singleton folder-upload orchestrator (T10). Same persistence model as the
 * UploadManager: module scope, IndexedDB metadata, reselect on reload.
 */
let uploader: FolderUploader | null = null;

export function getFolderUploader(): FolderUploader {
  if (uploader === null) {
    uploader = createFolderUploader({
      createBatch: createUploadBatch,
      getBatch: getUploadBatch,
      appendNodes: appendBatchNodes,
      sealBatch: sealUploadBatch,
      createFolder,
      manager: getUploadManager(),
    });
    uploader.attachStore(createFolderBatchStore());
    // Folder node states reflect the file uploads they own.
    getUploadManager().subscribe(() => uploader?.refresh());
    void uploader.restore();
  }
  return uploader;
}

/**
 * Directory drag-and-drop: walk DataTransferEntry trees where supported
 * (Chromium webkitGetAsEntry); returns null when the drop carries no
 * directory — the caller then ignores it (plain file drops stay on the
 * standard file-input path).
 */
export async function collectDroppedDirectory(
  items: DataTransferItemList,
): Promise<{ path: string; file: File }[] | null> {
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    const fn = (item as { webkitGetAsEntry?: () => FileSystemEntry | null })
      .webkitGetAsEntry;
    const entry = typeof fn === "function" ? fn.call(item) : null;
    if (entry !== null) entries.push(entry);
  }
  if (entries.length === 0 || !entries.some((e) => e.isDirectory)) {
    return null;
  }
  const out: { path: string; file: File }[] = [];
  const readAll = async (
    reader: FileSystemDirectoryReader,
  ): Promise<FileSystemEntry[]> => {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    return batch.length === 0
      ? batch
      : batch.concat(await readAll(reader));
  };
  const walk = async (entry: FileSystemEntry, prefix: string) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      out.push({ path, file });
      return;
    }
    if (entry.isDirectory) {
      const reader = (
        entry as FileSystemDirectoryEntry
      ).createReader();
      for (const child of await readAll(reader)) await walk(child, path);
    }
  };
  for (const entry of entries) {
    await walk(entry, "");
  }
  return out;
}
