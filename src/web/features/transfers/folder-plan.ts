/**
 * Pure folder-upload planner (spec §6.6, plan T10; wave-4 contract B).
 *
 * Input: the relative paths and byte sizes a `webkitdirectory` picker or a
 * drag-drop traversal reports — no DOM, no File objects, no I/O beyond
 * WebCrypto hashing, so it runs identically in the SPA, tests and workerd.
 * Output: a deterministic node plan (stable opaque nodeIds, parents always
 * before children) plus a sha256 plan digest that matches the server's
 * canonical `plan_hash` for the same sealed tree.
 *
 * Determinism contract: the same input entries produce the same nodeIds,
 * ordering and digest regardless of input array order. Duplicate exact
 * paths, file/folder kind collisions, escaping paths and invalid sizes are
 * rejected with stable error codes — never silently merged or reordered.
 * Display names keep their original bytes; only the identity key is
 * NFC-folded so macOS NFD and Linux NFC views of one directory plan the
 * same tree.
 */

import {
  DECIMAL_BYTES_PATTERN,
  type DecimalBytes,
} from '../../../shared/contracts/common';
import {
  canonicalPlanDigest,
  findPlanGraphIssue,
  type BatchNodeInput,
} from '../../../shared/contracts/uploads';

export interface FolderPlanFile {
  /** Relative path; '/' or '\' separators both accepted. */
  readonly path: string;
  /** Byte size: decimal string, safe integer or bigint. */
  readonly totalBytes: string | number | bigint;
  readonly mimeType?: string;
}

export type FolderPlanErrorCode =
  | 'EMPTY_PLAN'
  | 'INVALID_PATH'
  | 'PATH_ESCAPE'
  | 'INVALID_NAME'
  | 'INVALID_SIZE'
  | 'DUPLICATE_PATH'
  | 'KIND_COLLISION'
  | 'PLAN_TOO_LARGE'
  | 'INTERNAL_INCONSISTENCY';

export interface FolderPlanError {
  readonly code: FolderPlanErrorCode;
  readonly message: string;
  /** The offending input path when applicable. */
  readonly path?: string;
}

export interface FolderPlan {
  /** Parents always precede children; sibling order is deterministic. */
  readonly nodes: readonly BatchNodeInput[];
  readonly fileCount: number;
  readonly folderCount: number;
  readonly totalBytes: DecimalBytes;
  /** sha256 hex of the canonical plan encoding (matches server plan_hash). */
  readonly digest: string;
}

export type FolderPlanResult =
  | { readonly ok: true; readonly plan: FolderPlan }
  | { readonly ok: false; readonly error: FolderPlanError };

export interface FolderPlanOptions {
  /** Hard cap on total planned nodes (folders + files). Default 10_000. */
  readonly maxNodes?: number;
  /** Display-name character cap. Default 32768 (contract maximum). */
  readonly maxNameLength?: number;
}

const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_NAME_LENGTH = 32768;
const NODE_ID_PREFIX = 'n';
const NODE_ID_HEX = 40;

interface TreeEntry {
  /** NFC-folded identity key — never a display name (spec §6.6). */
  readonly key: string;
  readonly depth: number;
  readonly segment: string;
  readonly kind: 'folder' | 'file';
  readonly mimeType?: string;
  readonly totalBytes?: DecimalBytes;
  readonly parentKey?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function normalizeSize(
  value: string | number | bigint,
): DecimalBytes | null {
  if (typeof value === 'string') {
    return DECIMAL_BYTES_PATTERN.test(value) && value.length <= 30
      ? (value as DecimalBytes)
      : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value.toString(10).length <= 30
      ? (value.toString(10) as DecimalBytes)
      : null;
  }
  if (Number.isSafeInteger(value) && value >= 0) {
    return String(value) as DecimalBytes;
  }
  return null;
}

/**
 * Split a relative path into display segments. Rejects empty segments
 * (leading/trailing/doubled separators), '.', NUL bytes and traversal —
 * the planner never interprets a path as an escape from the batch root.
 */
function splitSegments(
  raw: string,
): { readonly ok: true; readonly segments: string[] } | FolderPlanError {
  const unified = raw.replace(/\\/g, '/');
  if (unified.length === 0) {
    return { code: 'INVALID_PATH', message: 'path is empty', path: raw };
  }
  const segments = unified.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      return {
        code: 'INVALID_PATH',
        message: 'path contains an empty segment',
        path: raw,
      };
    }
    if (segment === '.') {
      return {
        code: 'INVALID_PATH',
        message: "path contains a '.' segment",
        path: raw,
      };
    }
    if (segment === '..') {
      return {
        code: 'PATH_ESCAPE',
        message: "path contains a '..' segment",
        path: raw,
      };
    }
    if (segment.includes('\u0000')) {
      return {
        code: 'INVALID_PATH',
        message: 'path contains a NUL byte',
        path: raw,
      };
    }
  }
  return { ok: true, segments };
}

/**
 * Build the node plan. Folder entries are deduplicated by their NFC-folded
 * path key so every file sharing a directory prefix lands under one node;
 * two files at the same folded path are a deterministic duplicate error,
 * and a file/dir collision at one path is a kind error. Display names are
 * never dedup keys — two sibling folders may share a name legitimately in
 * later (non-path) inputs and keep distinct nodeIds.
 */
export async function planFolderTree(
  files: readonly FolderPlanFile[],
  options: FolderPlanOptions = {},
): Promise<FolderPlanResult> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxNameLength = options.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH;
  if (files.length === 0) {
    return {
      ok: false,
      error: { code: 'EMPTY_PLAN', message: 'the plan has no files' },
    };
  }
  const entries = new Map<string, TreeEntry>();
  let totalBytes = 0n;

  for (const file of files) {
    const split = splitSegments(file.path);
    if (!('ok' in split)) {
      return { ok: false, error: split };
    }
    const { segments } = split;
    const name = segments[segments.length - 1] as string;
    if (name.length > maxNameLength) {
      return {
        ok: false,
        error: {
          code: 'INVALID_NAME',
          message: 'a display name exceeds the maximum length',
          path: file.path,
        },
      };
    }
    const size = normalizeSize(file.totalBytes);
    if (size === null) {
      return {
        ok: false,
        error: {
          code: 'INVALID_SIZE',
          message: 'file size is not a valid non-negative decimal',
          path: file.path,
        },
      };
    }

    // Materialize every missing folder prefix first.
    let parentKey: string | undefined;
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const key = segments
        .slice(0, depth + 1)
        .map((s) => s.normalize('NFC'))
        .join('');
      const existing = entries.get(key);
      if (existing !== undefined) {
        if (existing.kind !== 'folder') {
          return {
            ok: false,
            error: {
              code: 'KIND_COLLISION',
              message: 'a file path is also used as a directory',
              path: file.path,
            },
          };
        }
      } else {
        entries.set(key, {
          key,
          depth: depth + 1,
          segment: segments[depth] as string,
          kind: 'folder',
          ...(parentKey === undefined ? {} : { parentKey }),
        });
      }
      parentKey = key;
    }

    const fileKey = segments
      .map((s) => s.normalize('NFC'))
      .join('');
    const existing = entries.get(fileKey);
    if (existing !== undefined) {
      return {
        ok: false,
        error: {
          code:
            existing.kind === 'folder' ? 'KIND_COLLISION' : 'DUPLICATE_PATH',
          message:
            existing.kind === 'folder'
              ? 'a directory path is also used as a file'
              : 'two input entries share the same path',
          path: file.path,
        },
      };
    }
    entries.set(fileKey, {
      key: fileKey,
      depth: segments.length,
      segment: name,
      kind: 'file',
      ...(parentKey === undefined ? {} : { parentKey }),
      ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
      totalBytes: size,
    });
    totalBytes += BigInt(size);
    if (entries.size > maxNodes) {
      return {
        ok: false,
        error: {
          code: 'PLAN_TOO_LARGE',
          message: `the plan exceeds ${maxNodes} nodes`,
          path: file.path,
        },
      };
    }
  }

  // Deterministic emission order: shallow first (parents before children),
  // then code-unit order of the folded path key.
  const ordered = [...entries.values()].sort(
    (a, b) => a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const nodeIds = new Map<string, string>();
  await Promise.all(
    ordered.map(async (entry) => {
      const hex = await sha256Hex(`folder-node/v1:${entry.key}`);
      nodeIds.set(entry.key, `${NODE_ID_PREFIX}${hex.slice(0, NODE_ID_HEX)}`);
    }),
  );

  const nodes: BatchNodeInput[] = ordered.map((entry) => ({
    nodeId: nodeIds.get(entry.key) as string,
    parentNodeId:
      entry.parentKey === undefined
        ? null
        : (nodeIds.get(entry.parentKey) as string),
    kind: entry.kind,
    displayName: entry.segment,
    ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
    ...(entry.totalBytes === undefined ? {} : { totalBytes: entry.totalBytes }),
  }));

  // The emitted graph is a tree by construction; this re-check is the
  // deterministic guard that keeps a planner bug from shipping a cycle.
  if (findPlanGraphIssue(nodes) !== null) {
    return {
      ok: false,
      error: {
        code: 'INTERNAL_INCONSISTENCY',
        message: 'the emitted plan failed graph validation',
      },
    };
  }

  let fileCount = 0;
  let folderCount = 0;
  for (const entry of ordered) {
    if (entry.kind === 'file') fileCount += 1;
    else folderCount += 1;
  }

  return {
    ok: true,
    plan: {
      nodes,
      fileCount,
      folderCount,
      totalBytes: totalBytes.toString(10) as DecimalBytes,
      digest: await canonicalPlanDigest(nodes),
    },
  };
}
