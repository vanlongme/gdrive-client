import {
  addToReadPool,
  bulkSetServiceAccounts,
  removeFromReadPool,
} from "../../lib/admin-api";
import type {
  MountAdminView,
  ServiceAccountBulkResponse,
  ServiceAccountBulkResult,
} from "../../../shared/contracts/admin";

/**
 * Chunked SA mutations (wave-10 review fix M2): select-all spans every
 * filtered page, which can exceed the server caps — 200 ids per bulk call,
 * 100 per read-pool edit. These helpers split the id list, run the chunks
 * SEQUENTIALLY (a mount's readPoolVersion should not race itself) and merge
 * a per-id ok/failed summary so nothing fails outright on size alone.
 */

export const SA_BULK_CHUNK_SIZE = 200;
export const SA_POOL_CHUNK_SIZE = 100;

export function saChunks<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
}

export interface SaBulkOutcome {
  readonly results: ServiceAccountBulkResult[];
  readonly ok: number;
  readonly failed: number;
}

export interface SaActionCalls {
  readonly bulk?: (
    action: "enable" | "disable",
    ids: string[],
  ) => Promise<ServiceAccountBulkResponse>;
  readonly pool?: (
    mountId: string,
    ids: string[],
  ) => Promise<{ mount: MountAdminView }>;
}

/**
 * Enable/disable `ids` in chunks of SA_BULK_CHUNK_SIZE. A chunk whose whole
 * request fails marks each of its ids as failed — partial results inside a
 * successful response are honoured as-is. Request order is preserved.
 */
export async function runSaBulkAction(
  action: "enable" | "disable",
  ids: readonly string[],
  calls: SaActionCalls = {},
): Promise<SaBulkOutcome> {
  const run = calls.bulk ?? bulkSetServiceAccounts;
  const results: ServiceAccountBulkResult[] = [];
  for (const chunk of saChunks(ids, SA_BULK_CHUNK_SIZE)) {
    try {
      const res = await run(action, [...chunk]);
      results.push(...res.results);
    } catch (error) {
      for (const id of chunk) {
        results.push({
          id,
          ok: false,
          code: "INTERNAL_ERROR",
          message:
            error instanceof Error && error.message !== ""
              ? error.message
              : "The request failed.",
        });
      }
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  return { results, ok: results.length - failed, failed };
}

export interface SaPoolOutcome {
  readonly ok: number;
  readonly failed: number;
  /** The mount view from the last successful chunk, when any. */
  readonly mount?: MountAdminView;
}

/**
 * Add/remove `ids` on `mountId` in chunks of SA_POOL_CHUNK_SIZE. Pool edits
 * answer the whole mount, not per-id results, so a chunk settles all-or-
 * nothing; a failed chunk counts its ids as failed and the run continues.
 */
export async function runSaPoolAction(
  op: "add" | "remove",
  mountId: string,
  ids: readonly string[],
  calls: SaActionCalls = {},
): Promise<SaPoolOutcome> {
  const run =
    calls.pool ?? (op === "add" ? addToReadPool : removeFromReadPool);
  let ok = 0;
  let failed = 0;
  let mount: MountAdminView | undefined;
  for (const chunk of saChunks(ids, SA_POOL_CHUNK_SIZE)) {
    try {
      const res = await run(mountId, [...chunk]);
      mount = res.mount;
      ok += chunk.length;
    } catch {
      failed += chunk.length;
    }
  }
  return { ok, failed, ...(mount === undefined ? {} : { mount }) };
}
