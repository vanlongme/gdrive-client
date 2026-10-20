/**
 * Catalog routes (architecture §10.2; wave-3 worker A), exported as
 * createCatalogRouter() with paths relative to /api/v1/mounts.
 *
 * Invariants:
 *   - Listing, search and file metadata run ONLY through the OAuth catalog
 *     connection of the mount — never the SA read pool and never another
 *     connection. File detail also exposes the SA readiness PROJECTION;
 *     the SA probe endpoint itself lives in the content router (worker B).
 *   - Every request re-authorizes via requireMountAccess before any cached
 *     page is consulted, so grant/policy revocation is always effective;
 *     cache keys bind actor+session, mount, connection+client versions,
 *     policy version and the exact query/page.
 *   - Pagination cursors are opaque AES-GCM tokens (cursors.ts); an expired
 *     or mismatched cursor fails closed and the client restarts cleanly.
 *   - Resource scope is proven, not assumed: folder/file ids resolve through
 *     resolveResource, which proves containment (driveId equality on a
 *     Shared Drive, a cached ancestor walk on a My Drive folder mount) at
 *     every shortcut hop. A listed parent is proven once; its children are
 *     contained by construction and are not walked. Out-of-mount ids answer
 *     FILE_NOT_ACCESSIBLE, identical to a missing resource.
 *   - No public DTO carries connection ids, principal ids, resource keys or
 *     page tokens (spec §10.2).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import {
  FileChildrenPageSchema,
  FileDetailSchema,
  MountListResponseSchema,
  SearchPageSchema,
  type DriveEntryKind,
  type DriveFileEntry,
  type MountOperationName,
} from '../../shared/contracts/drive';
import type { ReaderAccessState } from '../../shared/contracts/common';
import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE } from './providers/common';
import { createCoordinatorTokenSource } from './coordinator-client';
import { createGoogleOAuthProvider } from './providers/google-oauth';
import { CursorError, openCursor, signCursor, type CursorSubject } from './cursors';
import { validateDriveId } from './transport';
import { resolveResource, ResourceScopeError } from './shortcuts';
import { createD1VerdictStore, mountKindOf, mountScopeOf } from './containment';
import { searchMyDriveMount } from './my-drive-search';
import type {
  CatalogEntry,
  CatalogPage,
  OAuthCatalogWriteProvider,
} from './types';
import { recordCatalogQuery } from '../admin/metrics';
import {
  createFileMetadataCache,
  rowsFromCatalogEntries,
} from './metadata-cache';
import {
  defer,
  requestTokenMemo,
  timedTokenSource,
  timingFor,
} from '../timing';
import {
  ApiRequestError,
  actorKey,
  failureFromError,
  listMountAccesses,
  requireMountAccess,
  requireUsableOAuthWriter,
  resolveActor as realResolveActor,
  type MountAccessEnv,
  type MountRecord,
  type ResolveActorFn,
} from './mounts';
import { DriveError } from './errors';
import type { Actor, MountAccess } from '../auth/grants';

// ---------------------------------------------------------------------------
// Listing metadata cache: TTL 30 s, bounded to 8 MiB per isolate (spec §9.4).
// Keys bind actor(session), mount, connection+client versions, policy and
// the exact query+page; entries never cross actors, identities or policies.
// ---------------------------------------------------------------------------

export const CATALOG_CACHE_TTL_MS = 30_000;
export const CATALOG_CACHE_MAX_BYTES = 8 * 1024 * 1024;

interface CacheEntry {
  readonly page: CatalogPage;
  readonly bytes: number;
  readonly expiresAt: number;
}

export interface CatalogCacheOptions {
  readonly ttlMs?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

/** Bounded LRU over upstream CatalogPage results (insertion-order eviction). */
export class CatalogCache {
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(options: CatalogCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? CATALOG_CACHE_TTL_MS;
    this.maxBytes = options.maxBytes ?? CATALOG_CACHE_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  get(key: string): CatalogPage | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      return undefined;
    }
    // Refresh LRU position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.page;
  }

  set(key: string, page: CatalogPage): void {
    const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
    if (bytes > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.totalBytes -= existing.bytes;
    }
    // Evict expired first, then least-recently-used until the page fits.
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt <= now) {
        this.entries.delete(k);
        this.totalBytes -= e.bytes;
      }
    }
    while (this.totalBytes + bytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted !== undefined) this.totalBytes -= evicted.bytes;
    }
    this.entries.set(key, { page, bytes, expiresAt: now + this.ttlMs });
    this.totalBytes += bytes;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Test introspection: live entry count and approximate byte total. */
  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.totalBytes };
  }
}

/** Isolate-shared default cache (per-isolate bound per spec §9.4). */
export const defaultCatalogCache = new CatalogCache();

// ---------------------------------------------------------------------------
// Router dependencies. Defaults wire the real providers through the project
// coordinator; tests inject fixtures at this seam only.
// ---------------------------------------------------------------------------

export interface CatalogRouterDeps {
  /** Actor resolution (session or public). Defaults to the real resolver. */
  readonly resolveActor?: ResolveActorFn;
  /** OAuth catalog/write provider (fixture in tests). */
  readonly oauthProvider?: OAuthCatalogWriteProvider;
  /** Listing cache (test isolation); production uses the isolate default. */
  readonly cache?: CatalogCache;
  readonly now?: () => number;
}

type RouterContext = Context<{
  Bindings: Env;
  Variables: { requestId?: string };
}>;

function fail(
  c: RouterContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  return c.json(buildApiError(code, message, requestId, retryAfterSeconds), status);
}

function errorResponse(
  c: RouterContext,
  err: unknown,
  surface: 'catalog' | 'content',
): Response {
  // Scope violations are indistinguishable from missing resources.
  if (err instanceof ResourceScopeError) {
    return fail(c, 404, 'FILE_NOT_ACCESSIBLE', 'File is not accessible.');
  }
  if (err instanceof CursorError) {
    return fail(
      c,
      400,
      'VALIDATION_FAILED',
      'The pagination cursor is invalid or expired; restart the listing.',
    );
  }
  const failure = failureFromError(err, {
    provider: 'google_oauth',
    surface,
  });
  return fail(
    c,
    failure.status as ContentfulStatusCode,
    failure.code,
    failure.message,
    failure.retryAfterSeconds,
  );
}

async function actorOrResponse(
  c: RouterContext,
  resolveActor: ResolveActorFn,
): Promise<{ actor: Actor } | { response: Response }> {
  try {
    return { actor: await resolveActor(c.req.raw, c.env as MountAccessEnv) };
  } catch (err) {
    return { response: errorResponse(c, err, 'catalog') };
  }
}

const FALLBACK_MODIFIED_TIME = '1970-01-01T00:00:00.000Z';

function entryToDto(entry: CatalogEntry): DriveFileEntry {
  const dto: DriveFileEntry = {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    mimeType: entry.mimeType,
    size: entry.size,
    modifiedTime: entry.modifiedTime ?? FALLBACK_MODIFIED_TIME,
    hasThumbnail: entry.hasThumbnail,
  };
  if (entry.kind === 'shortcut' && entry.shortcutTargetId !== undefined) {
    // shortcutTargetId is a display hint only — resolution is always
    // server-side and scope-checked; the resource key stays internal.
    return { ...dto, shortcutTargetId: entry.shortcutTargetId };
  }
  return dto;
}

function sortOperations(access: {
  operations: ReadonlySet<string>;
}): MountOperationName[] {
  const order: MountOperationName[] = ['read', 'upload', 'admin'];
  return order.filter((op) => access.operations.has(op));
}

function kindOf(meta: { mimeType: string }): DriveEntryKind {
  if (meta.mimeType === FOLDER_MIME_TYPE) return 'folder';
  if (meta.mimeType === SHORTCUT_MIME_TYPE) return 'shortcut';
  return 'file';
}

function cacheKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

/**
 * Client-supplied Drive ids are validated at the route boundary (reviewer
 * F5): a malformed id is a 400 and never reaches the OAuth provider. The
 * 'invalid-input' DriveError keeps mapping to INTERNAL_ERROR only for ids
 * generated inside the worker, which should already be well-formed.
 */
function validRouteDriveId(raw: string, context: string): string {
  try {
    return validateDriveId(raw, context);
  } catch (err) {
    if (err instanceof DriveError && err.reason === 'invalid-input') {
      throw new ApiRequestError(
        400,
        'VALIDATION_FAILED',
        'The Drive file or folder id is malformed.',
      );
    }
    throw err;
  }
}
interface ReadinessRow {
  reader_access_state: string;
  checked_at: number | null;
  reason: string | null;
  read_pool_version: number;
  policy_version: number;
}

async function readReadinessProjection(
  db: D1Database,
  mountId: string,
  fileId: string,
): Promise<ReadinessRow | null> {
  const row = await db
    .prepare(
      'SELECT reader_access_state, checked_at, reason, read_pool_version, policy_version ' +
        'FROM file_readiness WHERE mount_id = ? AND file_id = ?',
    )
    .bind(mountId, fileId)
    .first<ReadinessRow>();
  return row ?? null;
}

/**
 * The readiness projection is only valid while the read pool and policy it
 * was probed under are current (reviewer F6): a changed pool version or
 * policy version makes the stored verdict stale, so it is reported as
 * 'unchecked' rather than surfacing an old reason/timestamp as fresh.
 */
function readinessStateFromRow(
  row: ReadinessRow | null,
  mount: MountRecord,
): ReaderAccessState {
  if (row === null) return 'unchecked';
  if (
    row.read_pool_version !== mount.readPoolVersion ||
    row.policy_version !== mount.policyVersion
  ) {
    return 'unchecked';
  }
  const state = row.reader_access_state;
  return state === 'pending' ||
    state === 'readable' ||
    state === 'blocked'
    ? state
    : 'unchecked';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createCatalogRouter(deps: CatalogRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const resolveActorFn = deps.resolveActor ?? realResolveActor;
  const cache = deps.cache ?? defaultCatalogCache;
  const now = deps.now ?? Date.now;

  const oauthProviderFor = (env: Env, c?: Context): OAuthCatalogWriteProvider => {
    if (deps.oauthProvider !== undefined) return deps.oauthProvider;
    // Wave-9: per-request token memo + timing (admits shared across all
    // catalog calls of one request; never across requests).
    const base = createCoordinatorTokenSource(env);
    const timed = c === undefined ? undefined : timingFor(c.req.raw);
    const tokenSource =
      c === undefined
        ? base
        : requestTokenMemo(c.req.raw).wrap(
            timed === undefined ? base : timedTokenSource(base, timed),
          );
    return createGoogleOAuthProvider({ tokenSource });
  };

  // -------------------------------------------------------------------------
  // GET / — every mount the actor can see, with the operations they hold.
  // -------------------------------------------------------------------------
  app.get('/', async (c) => {
    const resolved = await actorOrResponse(c, resolveActorFn);
    if ('response' in resolved) return resolved.response;
    try {
      const entries = await listMountAccesses(c.env.DB, resolved.actor);
      return c.json(
        MountListResponseSchema.parse({
          mounts: entries.map(({ mount, access }) => ({
            id: mount.id,
            label: mount.label,
            visibility: mount.visibility,
            rootFolderId: mount.rootFolderId,
            operations: sortOperations(access),
          })),
        }),
      );
    } catch (err) {
      return errorResponse(c, err, 'catalog');
    }
  });

  // -------------------------------------------------------------------------
  // GET /:m/folders/:f/children — cursor-paginated direct listing.
  // -------------------------------------------------------------------------
  app.get('/:mountId/folders/:folderId/children', async (c) => {
    const mountId = c.req.param('mountId');
    const folderId = c.req.param('folderId');
    let actor: Actor;
    let access: MountAccess;
    let mount: MountRecord;
    try {
      const resolved = await requireMountAccess(
        c.env as MountAccessEnv,
        c.req.raw,
        mountId,
        'read',
        resolveActorFn,
      );
      actor = resolved.actor;
      access = resolved.access;
      mount = resolved.mount;
    } catch (err) {
      return errorResponse(c, err, 'catalog');
    }

    try {
      const folder = validRouteDriveId(folderId, 'catalog.children');
      const mountScope = mountScopeOf(mount);
      const writerState = await requireUsableOAuthWriter(
        c.env.DB,
        mount.catalogConnectionId,
        'catalog',
      );
      const writer = writerState.writer;
      const provider = oauthProviderFor(c.env, c);

      // Prove folder scope, following shortcuts inside the mount. The mount
      // root (folderId === rootFolderId) is implicitly in-mount on both
      // kinds; every other folder passes containment via resolveResource.
      let resolvedFolderId = folder;
      if (folder !== mountScope.rootFolderId) {
        const resolved = await resolveResource(
          { access, mount, writer, provider, shared: createD1VerdictStore(c.env.DB) },
          { id: folder },
        );
        if (resolved.meta.mimeType !== FOLDER_MIME_TYPE) {
          return fail(
            c,
            400,
            'VALIDATION_FAILED',
            'The requested folder is not a folder.',
          );
        }
        resolvedFolderId = resolved.meta.id;
      }

      const subject: CursorSubject = {
        kind: 'children',
        mountId: mount.id,
        actorKey: actorKey(actor),
        writer: {
          connectionId: writer.connectionId,
          connectionVersion: writer.connectionVersion,
          oauthClientId: writer.oauthClientId,
          oauthClientVersion: writer.oauthClientVersion,
          principalId: writer.principalId,
        },
        policyVersion: mount.policyVersion,
        // The cursor binds the RESOLVED folder id (reviewer F9): a shortcut
        // that retargets between pages invalidates the old cursor instead
        // of reusing a page token against a different parent.
        spec: { folderId: resolvedFolderId },
      };

      let pageToken: string | undefined;
      const cursorParam = c.req.query('cursor');
      if (cursorParam !== undefined) {
        const opened = await openCursor(
          cursorParam,
          c.env.APP_MASTER_KEY,
          now(),
          subject,
        );
        pageToken = opened.pageToken;
      }

      const key = cacheKey([
        'children',
        subject.actorKey,
        mount.id,
        writer.connectionId,
        writer.connectionVersion,
        writer.oauthClientId,
        writer.oauthClientVersion,
        writer.principalId,
        mount.policyVersion,
        resolvedFolderId,
        pageToken ?? null,
      ]);
      let page = cache.get(key);
      if (page === undefined) {
        const startedMs = Date.now();
        try {
          page = await provider.listChildren({
            writer,
            scope: mountScope,
            parentFolderId: resolvedFolderId,
            ...(pageToken === undefined ? {} : { pageToken }),
          });
        } finally {
          recordCatalogQuery('list', Date.now() - startedMs);
        }
        cache.set(key, page);
        // Wave-10 fill (off the critical path): listing metadata feeds the
        // content-open cache; only freshly fetched pages write. fetchedAt
        // is the fetch START so an invalidation mid-flight tombstones this
        // data out of the fill (review L2).
        defer(
          c,
          createFileMetadataCache(c.env.DB).put(
            rowsFromCatalogEntries(mount.id, page.entries, now(), startedMs),
          ),
        );
      }

      const body = {
        entries: page.entries.map(entryToDto),
        ...(page.nextPageToken === undefined
          ? {}
          : {
              nextCursor: await signCursor(
                subject,
                page.nextPageToken,
                c.env.APP_MASTER_KEY,
                now(),
              ),
            }),
      };
      return c.json(FileChildrenPageSchema.parse(body));
    } catch (err) {
      return errorResponse(c, err, 'catalog');
    }
  });

  // -------------------------------------------------------------------------
  // GET /:m/search — q + scope=folder|drive (+folderId) + optional cursor.
  // -------------------------------------------------------------------------
  app.get('/:mountId/search', async (c) => {
    const mountId = c.req.param('mountId');
    let actor: Actor;
    let access: MountAccess;
    let mount: MountRecord;
    try {
      const resolved = await requireMountAccess(
        c.env as MountAccessEnv,
        c.req.raw,
        mountId,
        'read',
        resolveActorFn,
      );
      actor = resolved.actor;
      access = resolved.access;
      mount = resolved.mount;
    } catch (err) {
      return errorResponse(c, err, 'catalog');
    }

    try {
      const q = (c.req.query('q') ?? '').trim();
      const scope = c.req.query('scope');
      const folderIdParam = c.req.query('folderId');
      if (q.length === 0 || q.length > 512) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'Search query must be 1-512 characters.',
        );
      }
      if (scope !== 'folder' && scope !== 'drive') {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          "Search scope must be 'folder' or 'drive'.",
        );
      }
      if (scope === 'folder' && folderIdParam === undefined) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'folderId is required for folder-scoped search.',
        );
      }
      if (scope === 'drive' && folderIdParam !== undefined) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'folderId is only valid for folder-scoped search.',
        );
      }
      const mountScope = mountScopeOf(mount);
      // My Drive whole-mount search is the only filtered/bounded variant:
      // folder-scoped search runs inside an already-proven folder, and a
      // Shared Drive search is contained by its corpora.
      const wholeMountSearch =
        mountKindOf(mountScope) === 'my_drive_folder' && scope === 'drive';

      const writerState = await requireUsableOAuthWriter(
        c.env.DB,
        mount.catalogConnectionId,
        'catalog',
      );
      const writer = writerState.writer;
      const provider = oauthProviderFor(c.env, c);

      let scopedFolderId: string | undefined;
      if (scope === 'folder') {
        const folder = validRouteDriveId(
          folderIdParam as string,
          'catalog.search',
        );
        if (folder === mountScope.rootFolderId) {
          scopedFolderId = folder;
        } else {
          const resolved = await resolveResource(
            { access, mount, writer, provider, shared: createD1VerdictStore(c.env.DB) },
            { id: folder },
          );
          if (resolved.meta.mimeType !== FOLDER_MIME_TYPE) {
            return fail(
              c,
              400,
              'VALIDATION_FAILED',
              'The requested search folder is not a folder.',
            );
          }
          scopedFolderId = resolved.meta.id;
        }
      }

      const spec: CursorSubject['spec'] =
        scope === 'folder'
          ? { q, scope: 'folder' as const, folderId: scopedFolderId as string }
          : { q, scope: 'drive' as const };
      const subject: CursorSubject = {
        kind: 'search',
        mountId: mount.id,
        actorKey: actorKey(actor),
        writer: {
          connectionId: writer.connectionId,
          connectionVersion: writer.connectionVersion,
          oauthClientId: writer.oauthClientId,
          oauthClientVersion: writer.oauthClientVersion,
          principalId: writer.principalId,
        },
        policyVersion: mount.policyVersion,
        spec,
      };

      let pageToken: string | undefined;
      const cursorParam = c.req.query('cursor');
      if (cursorParam !== undefined) {
        const opened = await openCursor(
          cursorParam,
          c.env.APP_MASTER_KEY,
          now(),
          subject,
        );
        pageToken = opened.pageToken;
      }

      const key = cacheKey([
        'search',
        subject.actorKey,
        mount.id,
        writer.connectionId,
        writer.connectionVersion,
        writer.oauthClientId,
        writer.oauthClientVersion,
        writer.principalId,
        mount.policyVersion,
        spec,
        pageToken ?? null,
      ]);
      let page = cache.get(key);
      if (page === undefined) {
        const startedMs = Date.now();
        let result: CatalogPage;
        try {
          result = wholeMountSearch
            ? await searchMyDriveMount({
                provider,
                writer,
                scope: mountScope,
                query: q,
                ...(pageToken === undefined ? {} : { pageToken }),
                signal: c.req.raw.signal,
              })
            : await provider.search({
                writer,
                scope: mountScope,
                query: q,
                searchScope: scope,
                ...(scopedFolderId === undefined
                  ? {}
                  : { folderId: scopedFolderId }),
                ...(pageToken === undefined ? {} : { pageToken }),
              });
        } finally {
          recordCatalogQuery('search', Date.now() - startedMs);
        }
        page = result;
        cache.set(key, page);
        // Wave-10 fill: scoped search results feed the same cache; the
        // fetch-start time guards against a racing invalidation (L2).
        defer(
          c,
          createFileMetadataCache(c.env.DB).put(
            rowsFromCatalogEntries(mount.id, page.entries, now(), startedMs),
          ),
        );
      }

      const body = {
        entries: page.entries.map(entryToDto),
        scope,
        ...(wholeMountSearch && page.nextPageToken !== undefined
          ? { partial: true }
          : {}),
        ...(page.nextPageToken === undefined
          ? {}
          : {
              nextCursor: await signCursor(
                subject,
                page.nextPageToken,
                c.env.APP_MASTER_KEY,
                now(),
              ),
            }),
      };
      return c.json(SearchPageSchema.parse(body));
    } catch (err) {
      return errorResponse(c, err, 'catalog');
    }
  });

  // -------------------------------------------------------------------------
  // GET /:m/files/:f — OAuth catalog metadata + independent SA readiness
  // projection + preview descriptor (the two axes never merge).
  // -------------------------------------------------------------------------
  app.get('/:mountId/files/:fileId', async (c) => {
    const mountId = c.req.param('mountId');
    const fileId = c.req.param('fileId');
    let access: MountAccess;
    let mount: MountRecord;
    try {
      const resolved = await requireMountAccess(
        c.env as MountAccessEnv,
        c.req.raw,
        mountId,
        'read',
        resolveActorFn,
      );
      access = resolved.access;
      mount = resolved.mount;
    } catch (err) {
      return errorResponse(c, err, 'catalog');
    }

    try {
      const file = validRouteDriveId(fileId, 'catalog.file');
      const writerState = await requireUsableOAuthWriter(
        c.env.DB,
        mount.catalogConnectionId,
        'catalog',
      );
      const provider = oauthProviderFor(c.env, c);
      const resolved = await resolveResource(
        {
          access,
          mount,
          writer: writerState.writer,
          provider,
          shared: createD1VerdictStore(c.env.DB),
        },
        { id: file },
      );
      const meta = resolved.meta;

      // Readiness projection: independent of OAuth capability claims and
      // stale by design — content admission re-verifies at read time.
      const readiness = await readReadinessProjection(
        c.env.DB,
        mount.id,
        meta.id,
      );
      const readerAccessState = readinessStateFromRow(readiness, mount);

      const detail = {
        id: meta.id,
        kind: kindOf(meta),
        name: meta.name,
        mimeType: meta.mimeType,
        size: meta.size ?? '0',
        modifiedTime: meta.modifiedTime ?? FALLBACK_MODIFIED_TIME,
        hasThumbnail: meta.hasThumbnail,
        readerAccessState,
        preview: {
          contentMode: 'current-content',
          strictResumeSupported: false,
          readerAccessState,
          ...(meta.headRevisionId === undefined
            ? {}
            : { versionHint: meta.headRevisionId }),
        },
      };
      return c.json(FileDetailSchema.parse(detail));
    } catch (err) {
      return errorResponse(c, err, 'catalog');
    }
  });

  return app;
}
