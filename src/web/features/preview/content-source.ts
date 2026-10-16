import { apiFetch, contentUrl } from "../../lib/api";
import type { FileDetail } from "../../../shared/contracts/drive";
import type { PreviewDescriptor } from "../../../shared/contracts/media";

/**
 * Preview byte sources (architecture §7/§8). Every byte comes through the
 * existing same-origin SA content URLs — session cookie attached by the
 * browser, never a fetched credential and never a whole-file buffer. The
 * pinned-revision mode reuses the API's `mode=revision&revision=ID` form.
 */

export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Content URL honoring the descriptor's pinned revision when present. */
export function previewSourceUrl(
  mountId: string,
  file: Pick<FileDetail, "id">,
  descriptor?: PreviewDescriptor,
): string {
  const revisionId =
    descriptor?.contentMode === "pinned-revision"
      ? descriptor.revisionId
      : undefined;
  return contentUrl(mountId, file.id, revisionId);
}

/** Google Workspace export — the provider allowlist currently holds 'pdf'. */
export function workspaceExportUrl(mountId: string, fileId: string): string {
  return `/api/v1/mounts/${enc(mountId)}/files/${enc(fileId)}/export?format=pdf`;
}

export interface BoundedText {
  text: string;
  /** True when the file is larger than the preview budget. */
  truncated: boolean;
}

interface LimitedRead {
  bytes: Uint8Array;
  hitLimit: boolean;
}

/** Reads at most `limit` bytes of a response body, then cancels the stream. */
async function readAtMost(
  res: Response,
  limit: number,
  signal: AbortSignal,
): Promise<LimitedRead> {
  const body = res.body;
  if (body === null) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf.subarray(0, limit), hitLimit: buf.byteLength > limit };
  }
  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", onAbort);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    while (total < limit) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
    if (!done) await reader.cancel();
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, out.byteLength - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= out.byteLength) break;
  }
  return { bytes: out, hitLimit: !done };
}

/**
 * Fetches preview text capped at `maxBytes` (default 2 MiB). A Range header
 * asks the server for just the prefix; if the response is a full 200 body
 * anyway the stream is still cut at the cap — the file body is never fully
 * buffered. Errors surface as ApiClientError via the shared apiFetch path.
 */
export async function fetchBoundedText(
  url: string,
  signal: AbortSignal,
  maxBytes: number = TEXT_PREVIEW_MAX_BYTES,
): Promise<BoundedText> {
  const res = await apiFetch(url, {
    headers: { Range: `bytes=0-${maxBytes - 1}` },
    signal,
  });
  const { bytes, hitLimit } = await readAtMost(res, maxBytes + 1, signal);
  const truncated = res.status === 206 || hitLimit;
  const text = new TextDecoder().decode(bytes.subarray(0, maxBytes));
  return { text, truncated };
}
