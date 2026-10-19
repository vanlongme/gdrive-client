/**
 * Mount containment (spec 2026-10-18 §3). A mount is a root folder plus an
 * optional Shared Drive id, and this module is the single place that
 * decides whether a Drive resource is inside one:
 *
 *   - Shared Drive mounts keep the original rule: `meta.driveId ===
 *     scope.driveId` (and not trashed).
 *   - My Drive folder mounts (driveId === null) walk `parents[0]` upward
 *     through the mount's OAuth connection until the root folder is
 *     reached. A `driveId` anywhere on the path, a trashed ancestor, no
 *     parent, a 404 or more than CONTAINMENT_MAX_DEPTH lookups means
 *     "outside". Containment that cannot be proven is denied.
 *
 * Verdicts for every folder on a walked path are cached per isolate for
 * CONTAINMENT_TTL_MS in a bounded LRU (CONTAINMENT_CACHE_MAX). App-initiated
 * folder create/move/trash calls invalidateFolder; external moves made in
 * the Drive UI are seen once the TTL expires (accepted window, spec §11).
 * "An SA can read it" is never proof of containment.
 */

import { DriveError } from './errors';
import type { MountKind, MountRecord } from './mounts';
import type { OAuthCatalogWriteProvider, ResolvedWriter } from './types';

export const CONTAINMENT_MAX_DEPTH = 32;
export const CONTAINMENT_TTL_MS = 60_000;
export const CONTAINMENT_CACHE_MAX = 5000;

export interface MountScope {
  readonly mountId: string;
  readonly rootFolderId: string;
  readonly driveId: string | null;
}

export function mountScopeOf(
  mount: Pick<MountRecord, 'id' | 'rootFolderId' | 'driveId'>,
): MountScope {
  return {
    mountId: mount.id,
    rootFolderId: mount.rootFolderId,
    driveId: mount.driveId,
  };
}

export function mountKindOf(scope: { readonly driveId: string | null }): MountKind {
  return scope.driveId === null ? 'my_drive_folder' : 'shared_drive';
}

/** Why a resource was refused scope into a mount operation. */
export type ResourceScopeReason =
  /** Not inside the mount (wrong drive, no path to the root folder). */
  | 'outside-mount'
  /** The resource (or an ancestor on the walk) is trashed upstream. */
  | 'trashed'
  /** Shortcut chain exceeded the bound or revisited a node. */
  | 'shortcut-cycle'
  /** A shortcut whose target could not be determined/loaded. */
  | 'shortcut-unresolvable';

export class ResourceScopeError extends Error {
  readonly reason: ResourceScopeReason;
  constructor(reason: ResourceScopeReason, message: string) {
    super(message);
    this.name = 'ResourceScopeError';
    this.reason = reason;
  }
}

/** The metadata facts containment needs about one resource. */
export interface ParentMeta {
  readonly id: string;
  readonly parents?: readonly string[];
  readonly trashed?: boolean;
  readonly driveId?: string;
}

/** Resolves one folder's ParentMeta. Throws DriveError on upstream failure; a 404/not-found DriveError is treated as "outside". */
export type ParentLookup = (folderId: string) => Promise<ParentMeta>;

/** Ancestor lookups through the mount's OAuth connection (spec §3 provider rule). */
export function oauthParentLookup(ctx: {
  readonly provider: OAuthCatalogWriteProvider;
  readonly writer: ResolvedWriter;
  readonly signal?: AbortSignal;
}): ParentLookup {
  return async (folderId) => {
    const meta = await ctx.provider.getMetadata({
      writer: ctx.writer,
      ref: { id: folderId },
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    return {
      id: meta.id,
      ...(meta.parents === undefined ? {} : { parents: meta.parents }),
      ...(meta.trashed === undefined ? {} : { trashed: meta.trashed }),
      ...(meta.driveId === undefined ? {} : { driveId: meta.driveId }),
    };
  };
}

// Per-isolate verdict cache: Map insertion order is the LRU order.

interface CacheEntry {
  readonly inMount: boolean;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(scope: MountScope, folderId: string): string {
  return `${scope.mountId}:${folderId}`;
}

function cacheGet(scope: MountScope, folderId: string, now: number): boolean | undefined {
  const key = cacheKey(scope, folderId);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  cache.delete(key);
  if (entry.expiresAt <= now) return undefined;
  cache.set(key, entry); // refresh recency
  return entry.inMount;
}

function cacheSet(scope: MountScope, folderId: string, inMount: boolean, now: number): void {
  const key = cacheKey(scope, folderId);
  cache.delete(key);
  cache.set(key, { inMount, expiresAt: now + CONTAINMENT_TTL_MS });
  while (cache.size > CONTAINMENT_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** Drop one folder's cached verdict after an app-initiated create/move/trash. */
export function invalidateFolder(scope: MountScope, folderId: string): void {
  cache.delete(cacheKey(scope, folderId));
}

export function resetContainmentCacheForTests(): void {
  cache.clear();
}

function isNotFound(err: unknown): boolean {
  return err instanceof DriveError && (err.reason === 'not-found' || err.status === 404);
}

/**
 * Walk from `start` (the resource's first parent) toward the root folder.
 * Returns the verdict and caches it for every folder looked up on the way.
 * Upstream failures other than 404 propagate and cache nothing.
 */
async function walkToRoot(scope: MountScope, start: string | undefined, lookup: ParentLookup): Promise<boolean> {
  const path: string[] = [];
  let current = start;
  let verdict = false;
  for (let hops = 0; ; hops++) {
    if (current === undefined) break;
    if (current === scope.rootFolderId) {
      verdict = true;
      break;
    }
    const cached = cacheGet(scope, current, Date.now());
    if (cached !== undefined) {
      verdict = cached;
      break;
    }
    if (hops >= CONTAINMENT_MAX_DEPTH) break;
    path.push(current);
    let folder: ParentMeta;
    try {
      folder = await lookup(current);
    } catch (err) {
      if (isNotFound(err)) break;
      throw err;
    }
    if (folder.id !== current || folder.trashed === true || folder.driveId !== undefined) break;
    current = folder.parents?.[0];
  }
  const now = Date.now();
  for (const folderId of path) cacheSet(scope, folderId, verdict, now);
  return verdict;
}

export async function isInMount(scope: MountScope, meta: ParentMeta, lookup: ParentLookup): Promise<boolean> {
  if (meta.trashed === true) return false;
  if (scope.driveId !== null) return meta.driveId === scope.driveId;
  if (meta.driveId !== undefined) return false;
  if (meta.id === scope.rootFolderId) return true;
  return walkToRoot(scope, meta.parents?.[0], lookup);
}

/** Throws ResourceScopeError('trashed') or ResourceScopeError('outside-mount'). */
export async function assertInMount(scope: MountScope, meta: ParentMeta, lookup: ParentLookup): Promise<void> {
  if (meta.trashed === true) throw new ResourceScopeError('trashed', 'resource is trashed');
  if (!(await isInMount(scope, meta, lookup))) {
    throw new ResourceScopeError('outside-mount', 'resource is outside the mount');
  }
}

/**
 * Shared-Drive-only call sites not yet migrated: returns driveId or throws
 * ResourceScopeError('outside-mount'). Fails closed for My Drive mounts.
 */
export function requireSharedDriveId(scope: MountScope): string {
  if (scope.driveId === null) {
    throw new ResourceScopeError(
      'outside-mount',
      'operation is not yet supported on a My Drive folder mount',
    );
  }
  return scope.driveId;
}
