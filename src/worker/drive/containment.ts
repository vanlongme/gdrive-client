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
  readonly name?: string;
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
      ...(meta.name === undefined ? {} : { name: meta.name }),
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

function cacheGet(scope: MountScope, folderId: string, now: number): CacheEntry | undefined {
  const key = cacheKey(scope, folderId);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  cache.delete(key);
  if (entry.expiresAt <= now) return undefined;
  cache.set(key, entry); // refresh recency
  return entry;
}

function cacheSet(scope: MountScope, folderId: string, inMount: boolean, expiresAt: number): void {
  const key = cacheKey(scope, folderId);
  cache.delete(key);
  cache.set(key, { inMount, expiresAt });
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

// ---------------------------------------------------------------------------
// Cross-isolate positive verdicts (wave 9 step 2b). The per-isolate LRU
// above dies with the isolate; a D1 table shares "folder is on a path to the
// mount root" verdicts across isolates for up to 60 s. NEGATIVE verdicts are
// never shared: a folder moved out of the mount elsewhere must be re-walked
// locally rather than poison every isolate. App-initiated creates/trashes
// invalidate via SharedVerdictStore.invalidate; external Drive changes are
// seen at TTL expiry (same accepted window as the isolate cache).
// ---------------------------------------------------------------------------

export interface SharedVerdictStore {
  /** The live row's expiry when a positive verdict exists; `undefined` = miss. */
  get(
    scope: MountScope,
    folderId: string,
  ): Promise<{ readonly expiresAt: number } | undefined>;
  /**
   * Persist positive verdicts for all folders on the walked path. Derived
   * rows never outlive the verdict they were proven from: `expiresAt` caps
   * the stored expiry (review M2).
   */
  set(
    scope: MountScope,
    folderIds: readonly string[],
    expiresAt?: number,
  ): Promise<void>;
  invalidate(scope: MountScope, folderId: string): Promise<void>;
}

export const SHARED_VERDICT_TTL_MS = 60_000;

export function createD1VerdictStore(
  db: D1Database,
  options: { ttlMs?: number; now?: () => number } = {},
): SharedVerdictStore {
  const ttlMs = options.ttlMs ?? SHARED_VERDICT_TTL_MS;
  const now = options.now ?? Date.now;
  return {
    async get(scope, folderId) {
      const row = await db
        .prepare(
          'SELECT expires_at FROM containment_verdicts ' +
            'WHERE mount_id = ? AND root_folder_id = ? AND folder_id = ? AND expires_at > ?',
        )
        .bind(scope.mountId, scope.rootFolderId, folderId, now())
        .first<{ expires_at: number }>();
      return row === null ? undefined : { expiresAt: row.expires_at };
    },
    async set(scope, folderIds, expiresAt) {
      if (folderIds.length === 0) return;
      const expiry = Math.min(now() + ttlMs, expiresAt ?? now() + ttlMs);
      const statements = folderIds.map((folderId) =>
        db
          .prepare(
            'INSERT OR REPLACE INTO containment_verdicts ' +
              '(mount_id, root_folder_id, folder_id, expires_at) VALUES (?, ?, ?, ?)',
          )
          .bind(scope.mountId, scope.rootFolderId, folderId, expiry),
      );
      // Expired rows are pruned on every write so the table stays bounded.
      statements.push(
        db
          .prepare('DELETE FROM containment_verdicts WHERE expires_at <= ?')
          .bind(now()),
      );
      await db.batch(statements);
    },
    async invalidate(scope, folderId) {
      await db
        .prepare(
          'DELETE FROM containment_verdicts WHERE mount_id = ? AND folder_id = ?',
        )
        .bind(scope.mountId, folderId)
        .run();
    },
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof DriveError && (err.reason === 'not-found' || err.status === 404);
}

/**
 * Walk from `start` (the resource's first parent) toward the root folder.
 * Returns the verdict and caches it for every folder looked up on the way.
 * Upstream failures other than 404 propagate and cache nothing.
 */
async function walkToRoot(scope: MountScope, start: string | undefined, lookup: ParentLookup, shared?: SharedVerdictStore): Promise<boolean> {
  const path: string[] = [];
  let current = start;
  let verdict = false;
  // The expiry of the cache row the walk ended on: derived verdicts never
  // outlive the row they were proven from (review M2).
  let hitExpiresAt: number | undefined;
  for (let hops = 0; ; hops++) {
    if (current === undefined) break;
    if (current === scope.rootFolderId) {
      verdict = true;
      break;
    }
    const cached = cacheGet(scope, current, Date.now());
    if (cached !== undefined) {
      verdict = cached.inMount;
      hitExpiresAt = cached.expiresAt;
      break;
    }
    if (hops >= CONTAINMENT_MAX_DEPTH) break;
    // Cross-isolate positive verdicts: only 'inside' is ever shared, so a
    // hit ends the walk affirmatively; a miss proves nothing either way.
    // The store is queried once — for the start folder — so a cold or
    // negative walk gains no sequential D1 round trip per hop, and a store
    // failure (D1 down, or migration 0009 unapplied) degrades to a miss
    // and the live walk decides (review M3).
    if (hops === 0 && shared !== undefined) {
      try {
        const hit = await shared.get(scope, current);
        if (hit !== undefined) {
          verdict = true;
          hitExpiresAt = hit.expiresAt;
          break;
        }
      } catch {
        // Degraded to a miss.
      }
    }
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
  const expiresAt =
    hitExpiresAt === undefined
      ? now + CONTAINMENT_TTL_MS
      : Math.min(now + CONTAINMENT_TTL_MS, hitExpiresAt);
  for (const folderId of path) cacheSet(scope, folderId, verdict, expiresAt);
  if (verdict && shared !== undefined && path.length > 0) {
    // Positive verdicts only: the shared store proves membership, never
    // exclusion. A failed D1 write degrades to isolate-only caching.
    await shared.set(scope, path, expiresAt).catch(() => undefined);
  }
  return verdict;
}

export async function isInMount(scope: MountScope, meta: ParentMeta, lookup: ParentLookup, shared?: SharedVerdictStore): Promise<boolean> {
  if (meta.trashed === true) return false;
  if (scope.driveId !== null) return meta.driveId === scope.driveId;
  if (meta.driveId !== undefined) return false;
  if (meta.id === scope.rootFolderId) return true;
  return walkToRoot(scope, meta.parents?.[0], lookup, shared);
}

/** Throws ResourceScopeError('trashed') or ResourceScopeError('outside-mount'). */
export async function assertInMount(scope: MountScope, meta: ParentMeta, lookup: ParentLookup, shared?: SharedVerdictStore): Promise<void> {
  if (meta.trashed === true) throw new ResourceScopeError('trashed', 'resource is trashed');
  if (!(await isInMount(scope, meta, lookup, shared))) {
    throw new ResourceScopeError('outside-mount', 'resource is outside the mount');
  }
}

// ---------------------------------------------------------------------------
// Public-link descendant proof (wave 8 Phase B2). isWithinFolder decides
// whether a resource is `rootFolderId` itself or inside it, for BOTH mount
// kinds — a public link narrows mount containment to one subtree, so the
// Shared-Drive driveId shortcut is not enough. The walk runs toward the link
// root through the mount's OAuth catalog connection with its own depth cap
// and a short verdict cache; anything unprovable answers false.
// ---------------------------------------------------------------------------

export const LINK_DESCENDANT_MAX_DEPTH = 32;
export const LINK_DESCENDANT_TTL_MS = 30_000;
export const LINK_DESCENDANT_CACHE_MAX = 5000;

export interface DescendantProof {
  readonly inside: boolean;
  /** Ancestor folders nearest-first, excluding the root (names for breadcrumbs). */
  readonly path: readonly { id: string; name: string }[];
}

interface DescendantCacheEntry {
  readonly inside: boolean;
  readonly path: readonly { id: string; name: string }[];
  readonly expiresAt: number;
}

const descendantCache = new Map<string, DescendantCacheEntry>();

function descendantKey(scope: MountScope, rootFolderId: string, folderId: string): string {
  return `${scope.mountId}:${rootFolderId}:${folderId}`;
}

function descendantGet(scope: MountScope, rootFolderId: string, folderId: string): DescendantCacheEntry | undefined {
  const key = descendantKey(scope, rootFolderId, folderId);
  const entry = descendantCache.get(key);
  if (entry === undefined) return undefined;
  descendantCache.delete(key);
  if (entry.expiresAt <= Date.now()) return undefined;
  descendantCache.set(key, entry);
  return entry;
}

function descendantSet(scope: MountScope, rootFolderId: string, folderId: string, inside: boolean, path: readonly { id: string; name: string }[]): void {
  const key = descendantKey(scope, rootFolderId, folderId);
  descendantCache.delete(key);
  descendantCache.set(key, { inside, path, expiresAt: Date.now() + LINK_DESCENDANT_TTL_MS });
  while (descendantCache.size > LINK_DESCENDANT_CACHE_MAX) {
    const oldest = descendantCache.keys().next();
    if (oldest.done === true) break;
    descendantCache.delete(oldest.value);
  }
}

export function resetDescendantCacheForTests(): void {
  descendantCache.clear();
}

/** Mount gate for one resource: Shared Drive = same driveId; My Drive = none present. */
function mountGate(scope: MountScope, meta: ParentMeta): boolean {
  return scope.driveId === null ? meta.driveId === undefined : meta.driveId === scope.driveId;
}

/**
 * Is `meta` the folder `rootFolderId` or a descendant of it? `inside` alone
 * never proves mount containment for the ROOT — callers still assert the
 * link root stays inside the mount (assertInMount) on every request.
 * `path` is meaningful only when inside=true: the folders walked between
 * the resource and the root, nearest ancestor first, root excluded.
 */
export async function isWithinFolder(
  scope: MountScope,
  rootFolderId: string,
  meta: ParentMeta,
  lookup: ParentLookup,
): Promise<DescendantProof> {
  if (meta.id === rootFolderId) {
    return { inside: mountGate(scope, meta) && meta.trashed !== true, path: [] };
  }
  if (meta.trashed === true || !mountGate(scope, meta)) {
    return { inside: false, path: [] };
  }
  const collected: { id: string; name: string }[] = [];
  let current = meta.parents?.[0];
  for (let hops = 0; ; hops++) {
    if (current === rootFolderId) {
      for (let i = 0; i < collected.length; i++) {
        const f = collected[i]!;
        descendantSet(scope, rootFolderId, f.id, true, collected.slice(i));
      }
      return { inside: true, path: collected };
    }
    if (current === undefined || current === scope.rootFolderId) {
      break; // reached the mount boundary without passing the link root
    }
    const cached = descendantGet(scope, rootFolderId, current);
    if (cached !== undefined) {
      if (cached.inside) {
        return { inside: true, path: collected.concat(cached.path) };
      }
      break;
    }
    if (hops >= LINK_DESCENDANT_MAX_DEPTH) break;
    let folder: ParentMeta;
    try {
      folder = await lookup(current);
    } catch (err) {
      if (isNotFound(err)) break;
      throw err;
    }
    if (folder.id !== current || folder.trashed === true || !mountGate(scope, folder)) {
      break;
    }
    collected.push({ id: folder.id, name: folder.name ?? folder.id });
    current = folder.parents?.[0];
  }
  for (const f of collected) descendantSet(scope, rootFolderId, f.id, false, []);
  return { inside: false, path: [] };
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
