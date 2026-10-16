/**
 * Media package routes (architecture §8.2/§10.2, plan T13; wave-4 D),
 * mounted by the coordinator under /api/v1/media-packages:
 *
 *   POST /                              create-or-lookup by entry file id
 *   GET  /:packageId                    package view; playerUrl only when ready
 *   POST /:packageId/advance            one bounded index/verify batch
 *   GET|HEAD /:packageId/resources/:r   rewritten playlist or resource bytes
 *
 * Auth policy mirrors the content pipeline: session users with read on the
 * mount, package- or mount-scoped share links, and package-scoped media
 * tickets (GET/HEAD only) all pass through the same admission. Name
 * resolution runs on the mount's OAuth catalog connection; every byte —
 * manifest reads for parsing and all resource streams — comes from the SA
 * read pool. OAuth never serves bytes, not even to cover an SA failure.
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import {
  AdvanceMediaPackageResponseSchema,
  CreateMediaPackageRequestSchema,
  MediaPackageViewSchema,
  type MediaPackageView,
} from '../../shared/contracts/media';
import { authorizeMount, type MountAccess } from '../auth/grants';
import type { AuthUser } from '../auth/session';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { DriveError } from '../drive/errors';
import {
  ApiRequestError,
  failureFromError,
  getMount,
  requireUsableOAuthWriter,
  type MountRecord,
} from '../drive/mounts';
import { createGoogleOAuthProvider } from '../drive/providers/google-oauth';
import { ResourceScopeError, resolveResource } from '../drive/shortcuts';
import type {
  CoordinatorTokenSource,
  OAuthCatalogWriteProvider,
  ServiceAccountContentReadProvider,
} from '../drive/types';
import {
  getShareLink,
  checkShareValid,
  shareScopeCovers,
  shareScopeOf,
} from '../security/shares';
import {
  ticketScopeCovers,
  type MediaTicketPayload,
} from '../security/tickets';
import {
  assertQueryParams,
  contentErrorResponse,
  downstreamAbortableBody,
  fail,
  linkRequestSignal,
  openWithFailover,
  providerFor,
  requireDriveId,
  requireParam,
  resolveRequestActor,
  verifiedFileForRead,
  type ResolvedRequestActor,
  type ContentRouteDeps,
  type RouterContext,
  type VerifiedFileRead,
} from '../transfers/content-access';
import {
  buildContentDisposition,
  resolveDisposition,
} from '../transfers/content-disposition';
import { parseSingleRange } from '../transfers/range';
import {
  HLS_MAX_PLAYLIST_BYTES,
  HlsPlaylistError,
  isHlsPlaylistError,
  parseHlsPlaylist,
  rewriteHlsPlaylist,
  type ParsedHlsPlaylist,
} from './hls-parser';
import {
  advancePackageIndex,
  PackageProviderError,
  findMediaPackageByEntry,
  getMediaPackage,
  getPackageResource,
  insertMediaPackage,
  isPackageIndexError,
  listGenerationResources,
  markPackageStale,
  resourceVersionMatches,
  type MediaPackageRow,
  type MediaPackageResourceRow,
} from './package-index';

export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/** Per (package, actor) advance cooldown for non-user actors (W4-R2 #13). */
export const HLS_ADVANCE_THROTTLE_MS = 2_000;
const advanceThrottle = new Map<string, number>();

function advanceActorKey(resolved: ResolvedRequestActor): string {
  if (resolved.kind === 'share') return `share:${resolved.share.id}`;
  if (resolved.kind === 'ticket') return 'ticket';
  if (resolved.actor.kind === 'user') return `user:${resolved.actor.user.id}`;
  return 'public';
}

export interface PackageRouterDeps {
  /** Session actor resolution (tests inject a fixture). */
  readonly resolveSessionActor?: ContentRouteDeps['resolveSessionActor'];
  /** OAuth catalog provider — name resolution only, never bytes. */
  readonly oauthProvider?: OAuthCatalogWriteProvider;
  /** SA read provider — every byte of every resource. */
  readonly readProvider?: ServiceAccountContentReadProvider;
  readonly tokenSource?: CoordinatorTokenSource;
  readonly now?: () => number;
  /** Per-call advance work budget (tests shrink it to exercise paging). */
  readonly workBudget?: number;
}

// ---------------------------------------------------------------------------
// Error translation. HlsPlaylistError/PackageIndexError are permanent
// generation failures and carry their own API mapping; DriveError provenance
// is tracked by package-index (OAuth catalog vs SA read pool) so the public
// code taxonomy stays provider-accurate.
// ---------------------------------------------------------------------------

function hlsErrorCode(err: HlsPlaylistError): { status: number; code: ApiErrorCode } {
  switch (err.reason) {
    case 'unsupported':
      return { status: 415, code: 'PREVIEW_UNSUPPORTED' };
    case 'uri-external':
    case 'uri-escape':
    case 'invalid':
      return { status: 400, code: 'VALIDATION_FAILED' };
    case 'oversize':
      return { status: 400, code: 'VALIDATION_FAILED' };
  }
}

function indexErrorStatus(err: { code: string }): { status: number; code: ApiErrorCode } {
  switch (err.code) {
    case 'ambiguous':
      return { status: 409, code: 'FILE_CONFLICT' };
    case 'not-found':
    case 'scope':
      return { status: 404, code: 'FILE_NOT_ACCESSIBLE' };
    case 'cycle':
    case 'oversize':
      return { status: 400, code: 'VALIDATION_FAILED' };
    default:
      return { status: 500, code: 'INTERNAL_ERROR' };
  }
}

function packageErrorResponse(c: RouterContext, err: unknown): Response {
  if (err instanceof ApiRequestError) {
    return fail(c, err.status as ContentfulStatusCode, err.code, err.message);
  }
  if (err instanceof ResourceScopeError) {
    // Out-of-mount/shortcut failures are indistinguishable from missing.
    return fail(c, 404, 'FILE_NOT_ACCESSIBLE', 'File is not accessible.');
  }
  if (isHlsPlaylistError(err)) {
    const mapped = hlsErrorCode(err);
    return fail(
      c,
      mapped.status as ContentfulStatusCode,
      mapped.code,
      'The HLS playlist is outside the supported subset.',
    );
  }
  if (isPackageIndexError(err)) {
    const mapped = indexErrorStatus(err);
    return fail(
      c,
      mapped.status as ContentfulStatusCode,
      mapped.code,
      'The media package could not be indexed.',
    );
  }
  if (err instanceof PackageProviderError) {
    const failure = failureFromError(err.driveError, {
      provider: err.provider,
      surface: err.provider === 'service_account' ? 'content' : 'catalog',
    });
    return fail(
      c,
      failure.status as ContentfulStatusCode,
      failure.code,
      failure.message,
      failure.retryAfterSeconds,
    );
  }
  if (err instanceof DriveError) {
    // Index-time catalog failures default to the OAuth context; SA calls
    // in package-index are always wrapped in PackageProviderError.
    const failure = failureFromError(err, {
      provider: 'google_oauth',
      surface: 'catalog',
    });
    return fail(
      c,
      failure.status as ContentfulStatusCode,
      failure.code,
      failure.message,
      failure.retryAfterSeconds,
    );
  }
  return contentErrorResponse(c, err);
}

// ---------------------------------------------------------------------------
// Package-scoped admission (session user / share link / media ticket).
// ---------------------------------------------------------------------------

type PackageAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'auth-required' | 'denied' };

async function sessionAdmitsPackage(
  env: Env,
  resolved: Extract<ResolvedRequestActor, { kind: 'session' }>,
  mount: MountRecord,
): Promise<PackageAdmission> {
  const actor = resolved.actor;
  if (actor.kind === 'user') {
    const access = await authorizeMount(env.DB, actor, mount.id);
    if (access === null || !access.operations.has('read')) {
      return { ok: false, reason: 'denied' };
    }
    return { ok: true };
  }
  if (actor.kind === 'public') {
    return mount.visibility === 'public_read'
      ? { ok: true }
      : { ok: false, reason: 'auth-required' };
  }
  return { ok: false, reason: 'denied' };
}

function shareAdmitsPackage(
  share: Parameters<typeof shareScopeOf>[0],
  mount: MountRecord,
  packageId: string,
  generation: number,
  now: number,
): PackageAdmission {
  const validity = checkShareValid(share, mount.policyVersion, now);
  if (validity !== 'ok') return { ok: false, reason: 'denied' };
  const scope = shareScopeOf(share);
  if (
    scope === null ||
    !shareScopeCovers(scope, {
      mountId: mount.id,
      packageId,
      indexGeneration: generation,
    })
  ) {
    return { ok: false, reason: 'denied' };
  }
  return { ok: true };
}

async function ticketPrincipalAdmitsPackage(
  env: Env,
  principal: MediaTicketPayload['principal'],
  mount: MountRecord,
  packageId: string,
  generation: number,
  now: number,
): Promise<boolean> {
  switch (principal.kind) {
    case 'user': {
      const row = await env.DB
        .prepare(
          'SELECT id, name, email, role, banned, "createdAt" FROM "user" WHERE id = ?',
        )
        .bind(principal.userId)
        .first<{
          id: string;
          name: string;
          email: string;
          role: string | null;
          banned: number | null;
          createdAt: string;
        }>();
      if (row === null) return false;
      const user: AuthUser = {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role === 'admin' ? 'admin' : 'user',
        disabled: row.banned === 1,
        createdAt: new Date(row.createdAt).toISOString(),
      };
      const access = await authorizeMount(
        env.DB,
        { kind: 'user', user, sessionId: 'media-ticket' },
        mount.id,
      );
      return access !== null && access.operations.has('read');
    }
    case 'share': {
      const share = await getShareLink(env.DB, principal.shareId);
      if (share === null) return false;
      return shareAdmitsPackage(share, mount, packageId, generation, now).ok;
    }
    case 'public':
      return mount.visibility === 'public_read';
  }
}

async function admitPackageAccess(
  env: Env,
  resolved: ResolvedRequestActor,
  mount: MountRecord,
  packageId: string,
  generation: number,
  method: string,
  now: number,
): Promise<PackageAdmission> {
  if (resolved.kind === 'session') {
    return sessionAdmitsPackage(env, resolved, mount);
  }
  if (resolved.kind === 'share') {
    return shareAdmitsPackage(resolved.share, mount, packageId, generation, now);
  }
  // Scoped tickets are GET/HEAD capabilities only (spec §9.3).
  if (method !== 'GET' && method !== 'HEAD') {
    return { ok: false, reason: 'denied' };
  }
  const scope = resolved.payload.scope;
  if (
    scope.kind !== 'package' ||
    scope.mountId !== mount.id ||
    scope.packageId !== packageId ||
    !ticketScopeCovers(scope, { packageGeneration: generation })
  ) {
    return { ok: false, reason: 'denied' };
  }
  const stillValid = await ticketPrincipalAdmitsPackage(
    env,
    resolved.payload.principal,
    mount,
    packageId,
    generation,
    now,
  );
  return stillValid ? { ok: true } : { ok: false, reason: 'denied' };
}

/** Effective access for resolveResource's scoped context. */
async function accessForIndex(
  env: Env,
  resolved: ResolvedRequestActor,
  mount: MountRecord,
): Promise<MountAccess> {
  if (resolved.kind === 'session' && resolved.actor.kind === 'user') {
    const access = await authorizeMount(env.DB, resolved.actor, mount.id);
    if (access !== null) return access;
  }
  // Share/public actors: admission already ran package-scope; the catalog
  // hop checks in resolveResource only need a retained viewer context.
  return {
    mountId: mount.id,
    role: 'viewer',
    operations: new Set(['read']),
  };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function packageView(pkg: MediaPackageRow): MediaPackageView {
  const view = {
    packageId: pkg.id,
    state: pkg.state,
    indexGeneration: pkg.indexGeneration,
    ...(pkg.readyGeneration === null ? {} : { readyGeneration: pkg.readyGeneration }),
    strictSnapshot: pkg.strictSnapshot,
    ...(pkg.state === 'ready' && pkg.readyGeneration !== null
      ? { playerUrl: `/api/v1/media-packages/${pkg.id}/resources/r1` }
      : {}),
    ...(pkg.failureReason === null ? {} : { failureReason: pkg.failureReason }),
  };
  return MediaPackageViewSchema.parse(view);
}

/** Generation a share/ticket pin is checked against. */
function admissionGeneration(pkg: MediaPackageRow): number {
  return pkg.readyGeneration ?? pkg.indexGeneration;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createPackageRouter(deps: PackageRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const now = deps.now ?? Date.now;
  const contentDeps: ContentRouteDeps = {
    ...(deps.resolveSessionActor === undefined
      ? {}
      : { resolveSessionActor: deps.resolveSessionActor }),
    ...(deps.readProvider === undefined ? {} : { readProvider: deps.readProvider }),
    ...(deps.tokenSource === undefined ? {} : { tokenSource: deps.tokenSource }),
    now,
  };

  const oauthProviderFor = (env: Env): OAuthCatalogWriteProvider =>
    deps.oauthProvider ??
    createGoogleOAuthProvider({
      tokenSource: createCoordinatorTokenSource(env),
    });

  async function actorFor(
    c: RouterContext,
    resource:
      | { kind: 'file'; mountId: string; fileId: string }
      | { kind: 'package'; mountId: string; packageId: string },
  ): Promise<ResolvedRequestActor> {
    return resolveRequestActor(contentDeps, {
      request: c.req.raw,
      env: c.env,
      resource,
      now: now(),
    });
  }

  function denied(c: RouterContext, reason: 'auth-required' | 'denied'): Response {
    return reason === 'auth-required'
      ? fail(c, 401, 'AUTH_REQUIRED', 'Authentication is required.')
      : fail(c, 403, 'FORBIDDEN', 'Access to this package is denied.');
  }

  // -----------------------------------------------------------------------
  // POST / — create-or-lookup a package for an entry playlist file.
  // -----------------------------------------------------------------------
  app.post('/', async (c) => {
    try {
      assertQueryParams(c, ['share', 'ticket']);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
      }
      const parsed = CreateMediaPackageRequestSchema.safeParse(body);
      if (!parsed.success) {
        return fail(c, 400, 'VALIDATION_FAILED', 'Invalid package request.');
      }
      const mountId = parsed.data.mountId;
      const entryFileId = requireDriveId(parsed.data.entryFileId, 'entryFileId');
      const mount = await getMount(c.env.DB, mountId);
      if (mount === null) {
        return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      }
      const resolved = await actorFor(c, {
        kind: 'file',
        mountId,
        fileId: entryFileId,
      });
      // A ticket is a GET/HEAD capability; it can never create or advance.
      if (resolved.kind === 'ticket') {
        return fail(c, 403, 'FORBIDDEN', 'Media tickets cannot create packages.');
      }
      // Session admission runs BEFORE any upstream catalog call: a caller
      // without read on the mount never triggers Google traffic.
      if (resolved.kind === 'session') {
        const sessionAdmission = await sessionAdmitsPackage(c.env, resolved, mount);
        if (!sessionAdmission.ok) return denied(c, sessionAdmission.reason);
      } else {
        // Share actors must cover the requested entry file id or the mount;
        // the resolved-id scope check happens again after resolveResource.
        const scope = shareScopeOf(resolved.share);
        const preCovered =
          scope !== null &&
          (shareScopeCovers(scope, { mountId: mount.id }) ||
            shareScopeCovers(scope, { mountId: mount.id, fileId: entryFileId }));
        const validity = checkShareValid(resolved.share, mount.policyVersion, now());
        if (validity !== 'ok' || !preCovered) {
          return denied(c, 'denied');
        }
      }

      const writerState = await requireUsableOAuthWriter(
        c.env.DB,
        mount.catalogConnectionId,
        'catalog',
      );
      const oauth = oauthProviderFor(c.env);
      const access = await accessForIndex(c.env, resolved, mount);
      const entry = await resolveResource(
        {
          access,
          mount,
          writer: writerState.writer,
          provider: oauth,
          signal: c.req.raw.signal,
        },
        { id: entryFileId },
      );
      // Entry must be a directly downloadable file — folders, shortcuts
      // and Google-native documents can never be playlist bytes (W4-R2 #9).
      if (entry.meta.mimeType.startsWith('application/vnd.google-apps.')) {
        throw new ApiRequestError(
          415,
          'PREVIEW_UNSUPPORTED',
          'The entry file is not a playable media playlist.',
        );
      }
      const parents = entry.meta.parents ?? [];
      if (parents.length !== 1) {
        throw new ApiRequestError(
          409,
          'FILE_CONFLICT',
          'The entry file does not have exactly one parent folder.',
        );
      }
      const rootFolderId = parents[0] as string;

      const existing = await findMediaPackageByEntry(
        c.env.DB,
        mount.id,
        entry.meta.id,
      );

      // Post-resolution admission: session users already passed the mount
      // check; share scopes must cover the RESOLVED entry id (a shortcut
      // can't widen a file share into its target), the mount, or the
      // package being looked up. Public callers may only look up an
      // existing package — anonymous create can't attribute a creator.
      if (resolved.kind === 'session') {
        if (resolved.actor.kind !== 'user' && existing === null) {
          return fail(
            c,
            403,
            'FORBIDDEN',
            'Package creation requires an authenticated user or share.',
          );
        }
      } else {
        const scope = shareScopeOf(resolved.share);
        const covered =
          scope !== null &&
          (shareScopeCovers(scope, {
            mountId: mount.id,
            fileId: entry.meta.id,
          }) ||
            shareScopeCovers(scope, { mountId: mount.id }) ||
            (existing !== null &&
              shareScopeCovers(scope, {
                mountId: mount.id,
                packageId: existing.id,
                indexGeneration: admissionGeneration(existing),
              })));
        if (!covered) {
          return denied(c, 'denied');
        }
      }

      if (existing !== null) {
        return c.json(packageView(existing), 200);
      }
      const createdBy =
        resolved.kind === 'session' && resolved.actor.kind === 'user'
          ? resolved.actor.user.id
          : resolved.kind === 'share'
            ? resolved.share.createdBy
            : null;
      if (createdBy === null) {
        return fail(c, 403, 'FORBIDDEN', 'Package creation requires a creator.');
      }
      const inserted = await insertMediaPackage(c.env.DB, {
        mountId: mount.id,
        entryFileId: entry.meta.id,
        entryName: entry.meta.name,
        rootFolderId,
        createdBy,
        now: now(),
      });
      const pkg =
        inserted ??
        (await findMediaPackageByEntry(c.env.DB, mount.id, entry.meta.id));
      if (pkg === null) {
        throw new ApiRequestError(500, 'INTERNAL_ERROR', 'Package creation failed.');
      }
      return c.json(packageView(pkg), 201);
    } catch (err) {
      return packageErrorResponse(c, err);
    }
  });

  // -----------------------------------------------------------------------
  // GET /:packageId — package view; playerUrl only on a ready generation.
  // -----------------------------------------------------------------------
  app.get('/:packageId', async (c) => {
    try {
      assertQueryParams(c, ['share', 'ticket']);
      const packageId = requireParam(c, 'packageId');
      const pkg = await getMediaPackage(c.env.DB, packageId);
      if (pkg === null) {
        return fail(c, 404, 'NOT_FOUND', 'Package not found.');
      }
      const mount = await getMount(c.env.DB, pkg.mountId);
      if (mount === null) {
        return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      }
      const resolved = await actorFor(c, {
        kind: 'package',
        mountId: mount.id,
        packageId: pkg.id,
      });
      const admission = await admitPackageAccess(
        c.env,
        resolved,
        mount,
        pkg.id,
        admissionGeneration(pkg),
        'GET',
        now(),
      );
      if (!admission.ok) return denied(c, admission.reason);
      return c.json(packageView(pkg));
    } catch (err) {
      return packageErrorResponse(c, err);
    }
  });

  // -----------------------------------------------------------------------
  // POST /:packageId/advance — one bounded index/verify batch.
  // -----------------------------------------------------------------------
  app.post('/:packageId/advance', async (c) => {
    try {
      assertQueryParams(c, ['share', 'ticket']);
      const packageId = requireParam(c, 'packageId');
      const pkg = await getMediaPackage(c.env.DB, packageId);
      if (pkg === null) {
        return fail(c, 404, 'NOT_FOUND', 'Package not found.');
      }
      const mount = await getMount(c.env.DB, pkg.mountId);
      if (mount === null) {
        return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      }
      const resolved = await actorFor(c, {
        kind: 'package',
        mountId: mount.id,
        packageId: pkg.id,
      });
      if (resolved.kind === 'ticket') {
        return fail(c, 403, 'FORBIDDEN', 'Media tickets cannot advance packages.');
      }
      const admission = await admitPackageAccess(
        c.env,
        resolved,
        mount,
        pkg.id,
        pkg.indexGeneration,
        'POST',
        now(),
      );
      if (!admission.ok) return denied(c, admission.reason);
      // Throttle advance for share/public actors: each call can fan out to
      // many upstream API calls, so anonymous access on public mounts must
      // not be an unauthenticated amplifier (W4-R2 #13).
      const privileged =
        resolved.kind === 'session' && resolved.actor.kind === 'user';
      if (!privileged) {
        const key = `${pkg.id}:${advanceActorKey(resolved)}`;
        const t = now();
        const last = advanceThrottle.get(key);
        if (last !== undefined && t - last < HLS_ADVANCE_THROTTLE_MS) {
          return fail(
            c,
            429,
            'RATE_LIMITED',
            'Advance is rate-limited for this actor.',
            Math.ceil((HLS_ADVANCE_THROTTLE_MS - (t - last)) / 1000),
          );
        }
        if (advanceThrottle.size > 8192) advanceThrottle.clear();
        advanceThrottle.set(key, t);
      }
      const access = await accessForIndex(c.env, resolved, mount);
      const writerState = await requireUsableOAuthWriter(
        c.env.DB,
        mount.catalogConnectionId,
        'catalog',
      );
      const outcome = await advancePackageIndex(c.env.DB, pkg, {
        env: c.env,
        oauthProvider: oauthProviderFor(c.env),
        readProvider: providerFor(c, contentDeps),
        writer: writerState.writer,
        mount,
        access,
        signal: c.req.raw.signal,
        now,
        ...(privileged
          ? deps.workBudget === undefined
            ? {}
            : { workBudget: deps.workBudget }
          : { workBudget: Math.min(deps.workBudget ?? 16, 4) }),
      });
      return c.json(
        AdvanceMediaPackageResponseSchema.parse({
          packageId: outcome.pkg.id,
          state: outcome.pkg.state,
          indexGeneration: outcome.pkg.indexGeneration,
          complete: outcome.complete,
          processedResources: outcome.processedResources,
        }),
      );
    } catch (err) {
      return packageErrorResponse(c, err);
    }
  });

  // -----------------------------------------------------------------------
  // GET|HEAD /:packageId/resources/:resourceId — rewritten playlist or
  // resource bytes. The generation served is always the published one.
  // -----------------------------------------------------------------------
  const handleResource = async (c: RouterContext): Promise<Response> => {
    try {
      assertQueryParams(c, ['share', 'ticket']);
      const packageId = requireParam(c, 'packageId');
      const resourceId = requireParam(c, 'resourceId');
      const pkg = await getMediaPackage(c.env.DB, packageId);
      if (pkg === null) {
        return fail(c, 404, 'NOT_FOUND', 'Package not found.');
      }
      const mount = await getMount(c.env.DB, pkg.mountId);
      if (mount === null) {
        return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      }
      const resolved = await actorFor(c, {
        kind: 'package',
        mountId: mount.id,
        packageId: pkg.id,
      });
      const admission = await admitPackageAccess(
        c.env,
        resolved,
        mount,
        pkg.id,
        admissionGeneration(pkg),
        c.req.method,
        now(),
      );
      if (!admission.ok) return denied(c, admission.reason);
      if (pkg.state !== 'ready' || pkg.readyGeneration === null) {
        throw new ApiRequestError(
          409,
          'MEDIA_PACKAGE_NOT_READY',
          'The media package has no ready generation.',
        );
      }
      const generation = pkg.readyGeneration;
      const resource = await getPackageResource(
        c.env.DB,
        pkg.id,
        generation,
        resourceId,
      );
      if (resource === null) {
        return fail(c, 404, 'NOT_FOUND', 'Resource not found.');
      }
      const provider = providerFor(c, contentDeps);
      const verified = await verifiedFileForRead(
        provider,
        c.env,
        mount,
        resource.fileId,
        c.req.raw.signal,
      ).catch(async (err: unknown) => {
        if (err instanceof DriveError && (err.reason === 'not-found' || err.reason === 'gone')) {
          await markPackageStale(c.env.DB, pkg, now());
          throw new ApiRequestError(409, 'CONTENT_CHANGED', 'A package resource was removed upstream; re-index it.');
        }
        if (err instanceof ApiRequestError && err.status === 404) {
          await markPackageStale(c.env.DB, pkg, now());
        }
        throw err instanceof DriveError
          ? new PackageProviderError('service_account', err)
          : err;
      });
      // Best-effort mutation detection: a changed version marker invalidates
      // the ready generation before any byte is served (spec §8.2).
      if (!resourceVersionMatches(resource.revisionId, verified.meta)) {
        await markPackageStale(c.env.DB, pkg, now());
        throw new ApiRequestError(
          409,
          'CONTENT_CHANGED',
          'A package resource changed since indexing; re-index it.',
        );
      }

      const isHead = c.req.method === 'HEAD';
      if (resource.kind === 'playlist') {
        return await servePlaylist(c, deps, {
          pkg,
          mount,
          resource,
          generation,
          provider,
          isHead,
          verified,
        });
      }
      return await serveBytes(c, {
        pkg,
        mount,
        resource,
        provider,
        isHead,
        verified,
      });
    } catch (err) {
      return packageErrorResponse(c, err);
    }
  };
  app.on(['GET', 'HEAD'], '/:packageId/resources/:resourceId', handleResource);

  return app;
}

// ---------------------------------------------------------------------------
// Resource serving
// ---------------------------------------------------------------------------

type VerifiedRead = VerifiedFileRead;

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new HlsPlaylistError('oversize', 'playlist exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already finished or broken */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function credentialSuffix(c: RouterContext): string {
  const share = c.req.query('share');
  const ticket = c.req.query('ticket');
  if (share !== undefined && share !== '') {
    return `?share=${encodeURIComponent(share)}`;
  }
  if (ticket !== undefined && ticket !== '') {
    return `?ticket=${encodeURIComponent(ticket)}`;
  }
  return '';
}

async function servePlaylist(
  c: RouterContext,
  deps: PackageRouterDeps,
  input: {
    pkg: MediaPackageRow;
    mount: MountRecord;
    resource: MediaPackageResourceRow;
    generation: number;
    provider: ServiceAccountContentReadProvider;
    isHead: boolean;
    verified: VerifiedRead;
  },
): Promise<Response> {
  const { pkg, mount, resource, generation, provider, isHead, verified } = input;
  const declared =
    verified.meta.size !== undefined ? BigInt(verified.meta.size) : undefined;
  if (declared !== undefined && declared > BigInt(HLS_MAX_PLAYLIST_BYTES)) {
    throw new HlsPlaylistError('oversize', 'playlist exceeds 1 MiB');
  }
  if (isHead) {
    const headers = new Headers();
    headers.set('Content-Type', HLS_PLAYLIST_CONTENT_TYPE);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(null, { status: 200, headers });
  }

  const controller = new AbortController();
  linkRequestSignal(c.req.raw, controller);
  const upstream = await openWithFailover(
    provider,
    mount,
    resource.fileId,
    verified,
    controller.signal,
    (identity, ref) =>
      provider.openContent({ identity, ref, signal: controller.signal }),
  ).catch((err: unknown) => {
    throw err instanceof DriveError
      ? new PackageProviderError('service_account', err)
      : err;
  });
  const bytes = await readBoundedBody(upstream.body, HLS_MAX_PLAYLIST_BYTES)
    .catch(async (err: unknown) => {
      await markPackageStale(c.env.DB, pkg, (deps.now ?? Date.now)());
      throw err;
    });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    await markPackageStale(c.env.DB, pkg, (deps.now ?? Date.now)());
    throw new ApiRequestError(
      409,
      'CONTENT_CHANGED',
      'The playlist content changed since indexing.',
    );
  }
  let parsed: ParsedHlsPlaylist;
  try {
    const baseDir = resource.path.includes('/')
      ? resource.path.slice(0, resource.path.lastIndexOf('/'))
      : '';
    parsed = parseHlsPlaylist(text, baseDir === '' ? [] : baseDir.split('/'));
  } catch (err) {
    if (isHlsPlaylistError(err)) {
      await markPackageStale(c.env.DB, pkg, (deps.now ?? Date.now)());
      throw new ApiRequestError(
        409,
        'CONTENT_CHANGED',
        'The playlist content changed since indexing.',
      );
    }
    throw err;
  }

  const generationRows = await listGenerationResources(c.env.DB, pkg.id, generation);
  const byPath = new Map<string, MediaPackageResourceRow>();
  for (const row of generationRows) byPath.set(row.path, row);
  const suffix = credentialSuffix(c);
  let rewritten: string;
  try {
    rewritten = rewriteHlsPlaylist(parsed, (ref) => {
      const target = byPath.get(ref.segments.join('/'));
      if (target === undefined) {
        // The served bytes reference something the generation never indexed —
        // the graph drifted after publication; never leak the raw URI.
        throw new ApiRequestError(
          409,
          'CONTENT_CHANGED',
          'The playlist content changed since indexing.',
        );
      }
      return `${target.resourceId}${suffix}`;
    });
  } catch (err) {
    if (err instanceof ApiRequestError) {
      await markPackageStale(c.env.DB, pkg, (deps.now ?? Date.now)());
    }
    throw err;
  }
  const encoded = new TextEncoder().encode(rewritten);
  const headers = new Headers();
  headers.set('Content-Type', HLS_PLAYLIST_CONTENT_TYPE);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Length', encoded.byteLength.toString(10));
  return new Response(encoded, { status: 200, headers });
}

async function serveBytes(
  c: RouterContext,
  input: {
    pkg: MediaPackageRow;
    mount: MountRecord;
    resource: MediaPackageResourceRow;
    provider: ServiceAccountContentReadProvider;
    isHead: boolean;
    verified: VerifiedRead;
  },
): Promise<Response> {
  const { mount, resource, provider, isHead, verified } = input;
  const size =
    verified.meta.size !== undefined ? BigInt(verified.meta.size) : undefined;

  const headers = new Headers();
  const contentType = verified.meta.mimeType;
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', 'private, no-store');
  const name = resource.path.split('/').at(-1) ?? resource.path;
  headers.set(
    'Content-Disposition',
    buildContentDisposition(resolveDisposition(contentType, undefined), name),
  );
  if (size !== undefined) {
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Length', size.toString(10));
  }
  if (verified.meta.modifiedTime !== undefined) {
    headers.set('Last-Modified', new Date(verified.meta.modifiedTime).toUTCString());
  }
  if (isHead) {
    return new Response(null, { status: 200, headers });
  }

  let upstreamRange: { start: bigint; end: bigint } | undefined;
  const rangeHeader = c.req.raw.headers.get('range');
  if (rangeHeader !== null && size !== undefined) {
    const parsed = parseSingleRange(rangeHeader, size);
    if (parsed.type === 'satisfiable') {
      upstreamRange = { start: parsed.start, end: parsed.end };
    } else if (parsed.type === 'unsatisfiable') {
      const rangeHeaders = new Headers();
      rangeHeaders.set('Content-Range', `bytes */${parsed.size.toString(10)}`);
      rangeHeaders.set('Cache-Control', 'private, no-store');
      rangeHeaders.set('Content-Type', 'application/json; charset=UTF-8');
      return new Response(
        JSON.stringify(
          buildApiError(
            'VALIDATION_FAILED',
            'The requested range cannot be satisfied.',
            c.get('requestId') ?? crypto.randomUUID(),
          ),
        ),
        { status: 416, headers: rangeHeaders },
      );
    }
  }

  const controller = new AbortController();
  linkRequestSignal(c.req.raw, controller);
  const upstream = await openWithFailover(
    provider,
    mount,
    resource.fileId,
    verified,
    controller.signal,
    (identity, ref) =>
      provider.openContent({
        identity,
        ref,
        ...(upstreamRange === undefined ? {} : { range: upstreamRange }),
        signal: controller.signal,
      }),
  ).catch((err: unknown) => {
    throw err instanceof DriveError
      ? new PackageProviderError('service_account', err)
      : err;
  });
  if (upstream.contentType !== undefined) {
    headers.set('Content-Type', upstream.contentType);
    headers.set(
      'Content-Disposition',
      buildContentDisposition(resolveDisposition(upstream.contentType, undefined), name),
    );
  }
  if (upstream.status === 206 && upstream.contentRange !== undefined) {
    headers.set('Content-Range', upstream.contentRange);
    headers.set('Accept-Ranges', 'bytes');
  }
  const length =
    upstream.contentLength ?? (upstream.status === 200 ? size : undefined);
  if (length !== undefined) {
    headers.set('Content-Length', length.toString(10));
  }
  const body = downstreamAbortableBody(upstream.body, () => controller.abort());
  return new Response(body, { status: upstream.status, headers });
}
