import { z } from 'zod';
import {
  DecimalBytesSchema,
  IdSchema,
  IsoTimestampSchema,
  ReaderAccessStateSchema,
} from './common';

// Canonical upload states (spec section 6.4). Order is not meaningful.
export const UPLOAD_STATES = [
  'created',
  'preparing',
  'uploading',
  'paused',
  'reconciling',
  'verifying',
  'completed',
  'cancel_requested',
  'cancelled',
  'expired',
  'blocked',
  'conflict',
  'cleanup_pending',
] as const;
export const UploadStateSchema = z.enum(UPLOAD_STATES);
export type UploadState = z.infer<typeof UploadStateSchema>;

// Public view of an upload. Deliberately excludes pinned OAuth writer
// identity, attempt/lease internals, remote session URI and hashes: those are
// server-only (spec sections 5.3, 10.2; plan T02).
export const UploadViewSchema = z
  .object({
    uploadId: IdSchema,
    state: UploadStateSchema,
    sessionGeneration: z.number().int().min(1),
    confirmedOffset: DecimalBytesSchema,
    totalBytes: DecimalBytesSchema,
    chunkSize: z.number().int().positive(),
    readerAccessState: ReaderAccessStateSchema,
  })
  .strict();
export type UploadView = z.infer<typeof UploadViewSchema>;

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected lowercase sha256 hex');
export const Md5HexSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'expected lowercase md5 hex');

// Upload init. The Idempotency-Key travels in the request header; optional
// batchId/nodeId attach the operation to a sealed folder-upload plan.
export const CreateUploadRequestSchema = z
  .object({
    mountId: IdSchema,
    parentId: IdSchema,
    name: z.string().min(1).max(32768),
    mimeType: z.string().min(1).max(512),
    totalBytes: DecimalBytesSchema,
    sha256: Sha256HexSchema,
    md5: Md5HexSchema,
    batchId: IdSchema.optional(),
    nodeId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

// Chunk PUT addressing. `offset` must equal the confirmed offset of the given
// session generation; the server validates before reading the body.
export const ChunkAddressSchema = z
  .object({
    generation: z.number().int().min(1),
    offset: DecimalBytesSchema,
  })
  .strict();
export type ChunkAddress = z.infer<typeof ChunkAddressSchema>;

// Chunk/reconcile/pause/resume/cancel all answer with the current UploadView
// (JSON 200; upstream 308 never leaks to the browser).

export const UPLOAD_BATCH_STATES = [
  'draft',
  'sealed',
  'executing',
  'completed',
  'failed',
  'cancelled',
] as const;
export const UploadBatchStateSchema = z.enum(UPLOAD_BATCH_STATES);
export type UploadBatchState = z.infer<typeof UploadBatchStateSchema>;

export const UPLOAD_NODE_KINDS = ['folder', 'file'] as const;
export const UploadNodeKindSchema = z.enum(UPLOAD_NODE_KINDS);
export type UploadNodeKind = z.infer<typeof UploadNodeKindSchema>;

export const UPLOAD_NODE_STATES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;
export const UploadNodeStateSchema = z.enum(UPLOAD_NODE_STATES);
export type UploadNodeState = z.infer<typeof UploadNodeStateSchema>;

export const BatchNodeInputSchema = z
  .object({
    nodeId: z.string().min(1).max(256),
    parentNodeId: z.string().min(1).max(256).nullable(),
    kind: UploadNodeKindSchema,
    displayName: z.string().min(1).max(32768),
    mimeType: z.string().min(1).max(512).optional(),
    totalBytes: DecimalBytesSchema.optional(),
  })
  .strict();
export type BatchNodeInput = z.infer<typeof BatchNodeInputSchema>;

export const BatchNodeViewSchema = BatchNodeInputSchema.extend({
  state: UploadNodeStateSchema,
  driveFileId: IdSchema.optional(),
  uploadId: IdSchema.optional(),
}).strict();
export type BatchNodeView = z.infer<typeof BatchNodeViewSchema>;

export const CreateUploadBatchRequestSchema = z
  .object({
    mountId: IdSchema,
    rootParentId: IdSchema,
  })
  .strict();
export type CreateUploadBatchRequest = z.infer<
  typeof CreateUploadBatchRequestSchema
>;

export const AppendBatchNodesRequestSchema = z
  .object({
    planVersion: z.number().int().min(0),
    nodes: z.array(BatchNodeInputSchema).min(1).max(500),
  })
  .strict();
export type AppendBatchNodesRequest = z.infer<
  typeof AppendBatchNodesRequestSchema
>;

export const UploadBatchViewSchema = z
  .object({
    batchId: IdSchema,
    state: UploadBatchStateSchema,
    planVersion: z.number().int().min(0),
    sealedAt: IsoTimestampSchema.optional(),
    planHash: Sha256HexSchema.optional(),
    nodes: z.array(BatchNodeViewSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
export type UploadBatchView = z.infer<typeof UploadBatchViewSchema>;

// Seal is idempotent: an already-sealed batch answers its view. Optional
// planVersion/planHash let the client assert the exact sealed plan so a
// stale client never seals or resumes a different tree (spec §6.6).
export const SealUploadBatchRequestSchema = z
  .object({
    planVersion: z.number().int().min(0).optional(),
    planHash: Sha256HexSchema.optional(),
  })
  .strict();
export type SealUploadBatchRequest = z.infer<
  typeof SealUploadBatchRequestSchema
>;

export const CreateFolderRequestSchema = z
  .object({
    mountId: IdSchema,
    parentId: IdSchema,
    name: z.string().min(1).max(32768),
    batchId: IdSchema.optional(),
    nodeId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CreateFolderRequest = z.infer<typeof CreateFolderRequestSchema>;

// Folder create answers the canonical UploadView plus the confirmed Drive
// folder ID so callers can persist parent mappings without a second read.
export const FolderViewSchema = UploadViewSchema.extend({
  driveFileId: IdSchema.optional(),
}).strict();
export type FolderView = z.infer<typeof FolderViewSchema>;

// ---------------------------------------------------------------------------
// Canonical plan encoding + structural checks (spec §6.6, plan T10). Shared
// by the browser folder planner and the batch seal route so the client-side
// digest and the server-side plan_hash describe the exact same tree.
// ---------------------------------------------------------------------------

export const FOLDER_PLAN_DIGEST_PREFIX = 'gdrive-folder-plan/v1';

type PlanNodeLike = Pick<
  BatchNodeInput,
  'nodeId' | 'parentNodeId' | 'kind' | 'displayName' | 'mimeType' | 'totalBytes'
>;

/**
 * One canonical line per node in the caller's order (the sealed plan order —
 * parents before children). NFC normalization keeps visually identical
 * Unicode names on one digest regardless of the source encoding.
 */
export function canonicalPlanEncoding(nodes: readonly PlanNodeLike[]): string {
  const lines = nodes.map((n) =>
    [
      n.nodeId,
      n.parentNodeId ?? '',
      n.kind,
      n.displayName.normalize('NFC'),
      n.mimeType ?? '',
      n.totalBytes ?? '',
    ].join('|'),
  );
  return `${FOLDER_PLAN_DIGEST_PREFIX}\n${lines.join('\n')}`;
}

export async function canonicalPlanDigest(
  nodes: readonly PlanNodeLike[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalPlanEncoding(nodes)),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type PlanGraphIssue = {
  readonly nodeId: string;
  readonly reason:
    | 'duplicate-node'
    | 'missing-parent'
    | 'parent-not-folder'
    | 'cycle';
};

/**
 * Structural validation over a complete node set: every non-root
 * parentNodeId must name a folder node in the same set and following parent
 * links must terminate at a root — no cycles, no self-parenting, no foreign
 * references. Deterministic: issues surface in input order.
 */
export function findPlanGraphIssue(
  nodes: readonly Pick<
    BatchNodeInput,
    'nodeId' | 'parentNodeId' | 'kind'
  >[],
): PlanGraphIssue | null {
  const byId = new Map<
    string,
    Pick<BatchNodeInput, 'nodeId' | 'parentNodeId' | 'kind'>
  >();
  for (const n of nodes) {
    if (byId.has(n.nodeId)) {
      return { nodeId: n.nodeId, reason: 'duplicate-node' };
    }
    byId.set(n.nodeId, n);
  }
  for (const n of nodes) {
    const parentId = n.parentNodeId;
    if (parentId === null) continue;
    if (parentId === n.nodeId) {
      return { nodeId: n.nodeId, reason: 'cycle' };
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      return { nodeId: n.nodeId, reason: 'missing-parent' };
    }
    if (parent.kind !== 'folder') {
      return { nodeId: n.nodeId, reason: 'parent-not-folder' };
    }
  }
  for (const n of nodes) {
    const seen = new Set<string>([n.nodeId]);
    let cursor = n.parentNodeId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        return { nodeId: n.nodeId, reason: 'cycle' };
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentNodeId ?? null;
    }
  }
  return null;
}
