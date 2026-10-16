import type { DecimalBytes } from "../../shared/contracts/common";
import {
  UploadViewSchema,
  type CreateUploadRequest,
  type UploadView,
} from "../../shared/contracts/uploads";
import { apiFetch, parseJson } from "./api";

/**
 * Upload API client (spec section 10.2, plan T09): thin wrappers over the
 * existing /api/v1/uploads routes. Every mutation answers with the canonical
 * UploadView; upstream 308 never reaches the browser. Chunk bodies are exact
 * Blob.slice ranges — no base64, no multipart, no whole-file buffering.
 */

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** POST /api/v1/uploads — idempotent init, Idempotency-Key header required. */
export function createUpload(
  body: CreateUploadRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<UploadView> {
  return apiFetch("/api/v1/uploads", {
    method: "POST",
    jsonBody: body,
    headers: { "Idempotency-Key": idempotencyKey },
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, UploadViewSchema));
}

/** GET /api/v1/uploads/:u — canonical snapshot or tombstone. */
export function getUpload(
  uploadId: string,
  signal?: AbortSignal,
): Promise<UploadView> {
  return apiFetch(`/api/v1/uploads/${enc(uploadId)}`, {
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, UploadViewSchema));
}

/**
 * PUT /api/v1/uploads/:u/chunks?generation=N&offset=D — one chunk at the
 * confirmed offset. The Blob body makes the browser set Content-Length,
 * which the route requires.
 */
export function putUploadChunk(
  uploadId: string,
  generation: number,
  offset: DecimalBytes,
  chunk: Blob,
  signal?: AbortSignal,
): Promise<UploadView> {
  return apiFetch(
    `/api/v1/uploads/${enc(uploadId)}/chunks?generation=${generation}&offset=${offset}`,
    {
      method: "PUT",
      body: chunk,
      ...(signal === undefined ? {} : { signal }),
    },
  ).then((res) => parseJson(res, UploadViewSchema));
}

function postAction(
  uploadId: string,
  action: "reconcile" | "pause" | "resume" | "cancel",
  signal?: AbortSignal,
): Promise<UploadView> {
  return apiFetch(`/api/v1/uploads/${enc(uploadId)}/${action}`, {
    method: "POST",
    jsonBody: {},
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, UploadViewSchema));
}

/** POST reconcile — probe the remote session, answer with canonical state. */
export function reconcileUpload(
  uploadId: string,
  signal?: AbortSignal,
): Promise<UploadView> {
  return postAction(uploadId, "reconcile", signal);
}

export function pauseUpload(
  uploadId: string,
  signal?: AbortSignal,
): Promise<UploadView> {
  return postAction(uploadId, "pause", signal);
}

export function resumeUpload(
  uploadId: string,
  signal?: AbortSignal,
): Promise<UploadView> {
  return postAction(uploadId, "resume", signal);
}

export function cancelUpload(
  uploadId: string,
  signal?: AbortSignal,
): Promise<UploadView> {
  return postAction(uploadId, "cancel", signal);
}

// --- Folder-upload batches (spec section 6.6, plan T10; worker B routes) ---
// POST /upload-batches (Idempotency-Key) → paged POST /:b/nodes → POST seal
// (planVersion/planHash assertions) → metadata-only POST /folders. File nodes
// go through the UploadManager with batchId/nodeId.

import {
  FolderViewSchema,
  UploadBatchViewSchema,
  type AppendBatchNodesRequest,
  type CreateFolderRequest,
  type CreateUploadBatchRequest,
  type FolderView,
  type SealUploadBatchRequest,
  type UploadBatchView,
} from "../../shared/contracts/uploads";

export function createUploadBatch(
  body: CreateUploadBatchRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<UploadBatchView> {
  return apiFetch("/api/v1/upload-batches", {
    method: "POST",
    jsonBody: body,
    headers: { "Idempotency-Key": idempotencyKey },
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, UploadBatchViewSchema));
}

export function getUploadBatch(
  batchId: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<UploadBatchView> {
  const query = cursor === undefined ? "" : `?cursor=${enc(cursor)}`;
  return apiFetch(`/api/v1/upload-batches/${enc(batchId)}${query}`, {
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, UploadBatchViewSchema));
}

export function appendBatchNodes(
  batchId: string,
  body: AppendBatchNodesRequest,
  signal?: AbortSignal,
): Promise<UploadBatchView> {
  return apiFetch(`/api/v1/upload-batches/${enc(batchId)}/nodes`, {
    method: "POST",
    jsonBody: body,
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, UploadBatchViewSchema));
}

export function sealUploadBatch(
  batchId: string,
  body: SealUploadBatchRequest,
  signal?: AbortSignal,
): Promise<UploadBatchView> {
  return apiFetch(`/api/v1/upload-batches/${enc(batchId)}/seal`, {
    method: "POST",
    jsonBody: body,
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, UploadBatchViewSchema));
}

/** Metadata-only folder create; batch-node ops may omit the header key. */
export function createFolder(
  body: CreateFolderRequest,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<FolderView> {
  return apiFetch("/api/v1/folders", {
    method: "POST",
    jsonBody: body,
    ...(idempotencyKey === undefined
      ? {}
      : { headers: { "Idempotency-Key": idempotencyKey } }),
    ...(signal === undefined ? {} : { signal }),
  }).then((res) => parseJson(res, FolderViewSchema));
}
