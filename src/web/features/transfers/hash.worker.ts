import { hashBlob, HashAbortedError } from "./hash-core";

/**
 * Bundled hashing worker (spec section 6.1, plan T09): hash-wasm incremental
 * SHA-256+MD5 over 1 MiB slices, off the main thread. Loaded via
 * `new Worker(new URL("./hash.worker.ts", import.meta.url))` so Vite bundles
 * it same-origin; CSP needs 'wasm-unsafe-eval' in script-src (public/_headers,
 * owned by the preview worker in wave 4).
 *
 * Protocol (structured-cloneable messages only — File/Blob clone by handle,
 * no bytes are copied):
 *   in : {type:"hash", jobId, blob}      {type:"cancel", jobId}
 *   out: {type:"progress", jobId, done, total}  {type:"result", jobId, sha256, md5}
 *        {type:"error", jobId, code: "aborted"|"failed", message}
 */

export interface HashJobRequest {
  type: "hash";
  jobId: string;
  blob: Blob;
  sliceBytes?: number;
}

export interface HashCancelRequest {
  type: "cancel";
  jobId: string;
}

export type HashWorkerRequest = HashJobRequest | HashCancelRequest;

export type HashWorkerMessage =
  | { type: "progress"; jobId: string; done: string; total: string }
  | { type: "result"; jobId: string; sha256: string; md5: string }
  | { type: "error"; jobId: string; code: "aborted" | "failed"; message: string };

interface WorkerScope {
  postMessage(message: HashWorkerMessage): void;
  onmessage: ((event: MessageEvent<HashWorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const cancelled = new Set<string>();

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.jobId);
    return;
  }
  const jobId = request.jobId;
  cancelled.delete(jobId);
  void hashBlob(request.blob, {
    ...(request.sliceBytes === undefined
      ? {}
      : { sliceBytes: request.sliceBytes }),
    shouldAbort: () => cancelled.has(jobId),
    onProgress: (done, total) => {
      scope.postMessage({ type: "progress", jobId, done, total });
    },
  })
    .then((result) => {
      scope.postMessage({
        type: "result",
        jobId,
        sha256: result.sha256,
        md5: result.md5,
      });
    })
    .catch((error: unknown) => {
      const aborted = error instanceof HashAbortedError;
      scope.postMessage({
        type: "error",
        jobId,
        code: aborted ? "aborted" : "failed",
        message: error instanceof Error ? error.message : "Hashing failed.",
      });
    })
    .finally(() => cancelled.delete(jobId));
};
