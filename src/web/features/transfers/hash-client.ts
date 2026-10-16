import type { DecimalBytes } from "../../../shared/contracts/common";
import { HashAbortedError } from "./hash-core";
import type { HashWorkerMessage, HashWorkerRequest } from "./hash.worker";
import type { FileHashes, HasherPort } from "./upload-manager";

/**
 * Main-thread side of the bundled hashing worker (T09). One Worker instance
 * serves all jobs; each message is keyed by jobId so concurrent hashes
 * interleave safely. Cancellation posts a cancel message and aborts the
 * caller's promise immediately — the worker drops the job at the next slice
 * boundary.
 */

interface PendingJob {
  resolve: (hashes: FileHashes) => void;
  reject: (error: Error) => void;
  onProgress?: (p: { done: DecimalBytes; total: DecimalBytes }) => void;
}

export function createWorkerHasher(): HasherPort {
  let worker: Worker | null = null;
  let counter = 0;
  const pending = new Map<string, PendingJob>();

  function ensureWorker(): Worker {
    if (worker === null) {
      worker = new Worker(new URL("./hash.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<HashWorkerMessage>) => {
        const message = event.data;
        const job = pending.get(message.jobId);
        if (job === undefined) return;
        if (message.type === "progress") {
          job.onProgress?.({
            done: message.done as DecimalBytes,
            total: message.total as DecimalBytes,
          });
          return;
        }
        pending.delete(message.jobId);
        if (message.type === "result") {
          job.resolve({ sha256: message.sha256, md5: message.md5 });
        } else if (message.code === "aborted") {
          job.reject(new HashAbortedError());
        } else {
          job.reject(new Error(message.message));
        }
      };
      worker.onerror = () => {
        for (const job of pending.values()) {
          job.reject(new Error("The hashing worker crashed."));
        }
        pending.clear();
        worker = null;
      };
    }
    return worker;
  }

  return {
    hash(file, opts) {
      if (opts.signal?.aborted === true) {
        return Promise.reject(new HashAbortedError());
      }
      const w = ensureWorker();
      const jobId = `hash-${counter}`;
      counter += 1;
      return new Promise<FileHashes>((resolve, reject) => {
        const signal = opts.signal;
        const onAbort = () => {
          pending.delete(jobId);
          const cancel: HashWorkerRequest = { type: "cancel", jobId };
          w.postMessage(cancel);
          reject(new HashAbortedError());
        };
        pending.set(jobId, {
          resolve,
          reject,
          ...(opts.onProgress === undefined
            ? {}
            : { onProgress: opts.onProgress }),
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        // File/Blob structured-clone without copying bytes.
        const request: HashWorkerRequest = {
          type: "hash",
          jobId,
          blob: file.slice(0, file.size),
        };
        w.postMessage(request);
      });
    },
  };
}
