import type {
  FolderBatchRecord,
  FolderBatchStorePort,
} from "./folder-upload";
import type { RecoveryRecord, RecoveryStorePort } from "./upload-manager";

/**
 * IndexedDB recovery store (spec section 6.5, plan T09/T10): upload metadata
 * only — checksums, ids, confirmed offset, optional FileSystemFileHandle,
 * plus folder-batch descriptors (batchId, digest, nodeId→path map). Never
 * tokens, file bytes or localStorage credentials. When IndexedDB is
 * unavailable the stores degrade to in-memory maps for the tab's lifetime.
 */

const DB_NAME = "drive-worker-transfers";
const DB_VERSION = 2;
const STORE = "uploads";
const BATCH_STORE = "batches";

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(BATCH_STORE)) {
        db.createObjectStore(BATCH_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed."));
  });
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function createIdbStore(): RecoveryStorePort {
  return {
    async list() {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readonly");
        const all = await wrap(
          tx.objectStore(STORE).getAll() as IDBRequest<RecoveryRecord[]>,
        );
        return all;
      } finally {
        db.close();
      }
    },
    async put(record) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        await wrap(tx.objectStore(STORE).put(record));
      } finally {
        db.close();
      }
    },
    async delete(id) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        await wrap(tx.objectStore(STORE).delete(id));
      } finally {
        db.close();
      }
    },
  };
}

export function createMemoryRecoveryStore(): RecoveryStorePort {
  const records = new Map<string, RecoveryRecord>();
  return {
    list: () => Promise.resolve([...records.values()]),
    put: (record) => {
      records.set(record.id, record);
      return Promise.resolve();
    },
    delete: (id) => {
      records.delete(id);
      return Promise.resolve();
    },
  };
}

export function createRecoveryStore(): RecoveryStorePort {
  return idbAvailable() ? createIdbStore() : createMemoryRecoveryStore();
}

export function createFolderBatchStore(): FolderBatchStorePort {
  if (!idbAvailable()) {
    const records = new Map<string, FolderBatchRecord>();
    return {
      list: () => Promise.resolve([...records.values()]),
      put: (r) => {
        records.set(r.id, r);
        return Promise.resolve();
      },
      delete: (id) => {
        records.delete(id);
        return Promise.resolve();
      },
    };
  }
  return {
    async list() {
      const db = await openDb();
      try {
        const tx = db.transaction(BATCH_STORE, "readonly");
        return await wrap(
          tx.objectStore(BATCH_STORE).getAll() as IDBRequest<FolderBatchRecord[]>,
        );
      } finally {
        db.close();
      }
    },
    async put(record) {
      const db = await openDb();
      try {
        const tx = db.transaction(BATCH_STORE, "readwrite");
        await wrap(tx.objectStore(BATCH_STORE).put(record));
      } finally {
        db.close();
      }
    },
    async delete(id) {
      const db = await openDb();
      try {
        const tx = db.transaction(BATCH_STORE, "readwrite");
        await wrap(tx.objectStore(BATCH_STORE).delete(id));
      } finally {
        db.close();
      }
    },
  };
}
