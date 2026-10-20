/**
 * Shared content-access pipeline for the T06 routes (wave-3 track B helper
 * module, announced to the coordinator). Everything the content, thumbnail
 * and export handlers need to authorize and locate bytes:
 *
 *   mount lookup (A's getMount) -> actor resolution (session/share/ticket)
 *   -> exact scope admission -> SA read-pool selection -> verified SA
 *   metadata (driveId / trashed / canDownload).
 *
 * Provider boundary: the only credential path here is the mount's
 * service-account read pool; no OAuth identity, catalog connection or
 * arbitrary URL can reach content bytes (spec §5.1/§7.1).
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import { authorizeMount, type Actor } from '../auth/grants';
import type { AuthUser } from '../auth/session';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import {
  assertInMount,
  createD1VerdictStore,
  mountScopeOf,
  oauthParentLookup,
  type SharedVerdictStore,
} from '../drive/containment';
import { DriveError, type DriveFailureReason } from '../drive/errors';
import {
  cachedMetaToDriveFileMeta,
  createFileMetadataCache,
  isMediaAuthorityFailure,
  rowFromDriveMeta,
  type FileMetaCacheSource,
  type FileMetadataCacheStore,
} from '../drive/metadata-cache';
import {
  ApiRequestError,
  failureFromError,
  getMount,
  listReadPool,
  requireUsableOAuthWriter,
  resolveActor,
  type MountRecord,
  type ResolvedWriterState,
} from '../drive/mounts';
import { SHORTCUT_MIME_TYPE } from '../drive/providers/common';
import { createGoogleOAuthProvider } from '../drive/providers/google-oauth';
import { createServiceAccountReadProvider } from '../drive/providers/service-account-read';
import { ResourceScopeError } from '../drive/shortcuts';
import { validateDriveId } from '../drive/transport';
import type {
  CoordinatorTokenSource,
  DriveFileMeta,
  DriveResourceRef,
  OAuthCatalogWriteProvider,
  ReadIdentity,
  ResolvedWriter,
  ServiceAccountContentReadProvider,
} from '../drive/types';
import {
  checkShareValid,
  getShareLink,
  resolveShareToken,
  shareScopeCovers,
  shareScopeOf,
  type ShareLinkRow,
} from '../security/shares';
import {
  ticketScopeCovers,
  verifyMediaTicket,
  type MediaTicketPayload,
  type TicketPrincipal,
} from '../security/tickets';
import {
  defer,
  requestTokenMemo,
  timedParentLookup,
  timedSaProvider,
  timedTokenSource,
  timingFor,
  type RequestTiming,
} from '../timing';

export type { MountRecord } from '../drive/mounts';
export { ApiRequestError } from '../drive/mounts';

// ---------------------------------------------------------------------------
// Injectable dependencies. Defaults are the frozen production surfaces;
// tests inject fixtures and never touch Google or a real session.
// ---------------------------------------------------------------------------

export type GetMountFn = (
  db: D1Database,
  mountId: string,
) => Promise<MountRecord | null>;

/** Session/public actor resolution (A's resolveActor: user or public). */
export type ResolveSessionActorFn = (
  request: Request,
  env: Env,
) => Promise<Actor>;

export interface ContentRouteDeps {
  readonly getMount?: GetMountFn;
  readonly resolveSessionActor?: ResolveSessionActorFn;
  readonly readProvider?: ServiceAccountContentReadProvider;
  /**
   * OAuth catalog provider used ONLY to prove containment on My Drive
   * mounts (ancestor walk). It has no content method. Fixture in tests.
   */
  readonly oauthProvider?: OAuthCatalogWriteProvider;
  readonly tokenSource?: CoordinatorTokenSource;
  readonly now?: () => number;
}

export type RouterContext = Context<{
  Bindings: Env;
  Variables: { requestId?: string };
}>;

/**
 * The cross-isolate containment verdict store for this request's D1
 * (migration 0009). Verdict TTL is 60 s; app-initiated tree mutations
 * invalidate affected keys (wave-9 step 2b).
 */
export function sharedVerdictStoreFor(c: RouterContext): SharedVerdictStore {
  return createD1VerdictStore(c.env.DB);
}

/** The wave-10 file metadata cache for this request's D1 (migration 0010). */
export function metaCacheFor(c: RouterContext): FileMetadataCacheStore {
  return createFileMetadataCache(c.env.DB);
}

export function providerFor(
  c: RouterContext,
  deps: ContentRouteDeps,
): ServiceAccountContentReadProvider {
  const provider =
    deps.readProvider ??
    createServiceAccountReadProvider({
      tokenSource: deps.tokenSource ?? tokenSourceFor(c, c.env),
    });
  const timing = timingFor(c.req.raw);
  return timing === undefined ? provider : timedSaProvider(provider, timing);
}

/**
 * The per-request token source: the DO /admit for one identity+file is
 * shared by the SA metadata call and the media call (and by every OAuth
 * ancestor hop of a containment walk). The memo lives only for the request.
 */
export function tokenSourceFor(
  c: RouterContext,
  env: Env,
): CoordinatorTokenSource {
  const memo = requestTokenMemo(c.req.raw);
  const timing = timingFor(c.req.raw);
  const base = createCoordinatorTokenSource(env);
  return memo.wrap(timing === undefined ? base : timedTokenSource(base, timing));
}

// ---------------------------------------------------------------------------
// Error translation — delegates to A's failureFromError so every wave-3
// route emits the same envelope/status taxonomy.
// ---------------------------------------------------------------------------

function jsonFail(
  c: RouterContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  return c.json(
    buildApiError(code, message, requestId, retryAfterSeconds),
    status,
  );
}

export function fail(
  c: RouterContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  retryAfterSeconds?: number,
): Response {
  if (c.req.method === 'HEAD') {
    return new Response(null, { status });
  }
  return jsonFail(c, status, code, message, retryAfterSeconds);
}

export function contentErrorResponse(
  c: RouterContext,
  err: unknown,
): Response {
  const failure = failureFromError(err, {
    provider: 'service_account',
    surface: 'content',
  });
  return fail(
    c,
    failure.status as ContentfulStatusCode,
    failure.code,
    failure.message,
    failure.retryAfterSeconds,
  );
}

// ---------------------------------------------------------------------------
// Query validation — only allowlisted parameters are accepted (coordinator
// decision: reject unknown mode/url parameters rather than accepting an
// arbitrary source). No `url=` or upstream-addressing parameter exists.
// ---------------------------------------------------------------------------

export function assertQueryParams(
  c: RouterContext,
  allowed: readonly string[],
): void {
  const params = new URL(c.req.url).searchParams;
  let rejected: string | undefined;
  params.forEach((_value, key) => {
    if (!allowed.includes(key) && rejected === undefined) rejected = key;
  });
  if (rejected !== undefined) {
    throw new ApiRequestError(
      400,
      'VALIDATION_FAILED',
      `Query parameter '${rejected}' is not supported on this route.`,
    );
  }
}

/** Route params are declared in the pattern but typed optional — fail closed. */
export function requireParam(c: RouterContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === '') {
    throw new ApiRequestError(
      400,
      'VALIDATION_FAILED',
      `Missing route parameter '${name}'.`,
    );
  }
  return value;
}

/**
 * Client-supplied Drive ids are validated at the route boundary (reviewer
 * F5): a malformed id is a 400 and never reaches a provider call. The
 * 'invalid-input' DriveError keeps mapping to INTERNAL_ERROR only for
 * ids generated inside the worker, which should already be well-formed.
 */
export function requireDriveId(value: string, name: string): string {
  try {
    return validateDriveId(value, 'content.route');
  } catch (err) {
    if (err instanceof DriveError && err.reason === 'invalid-input') {
      throw new ApiRequestError(
        400,
        'VALIDATION_FAILED',
        `Route parameter '${name}' is not a valid Drive file id.`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Actor resolution: session user (A's resolveActor), scoped share token or
// scoped media ticket. A presented share/ticket credential is the sole
// authority for that request — invalid credentials fail closed rather than
// silently downgrading to session/public access.
// ---------------------------------------------------------------------------

export type ResolvedRequestActor =
  | { readonly kind: 'session'; readonly actor: Actor }
  | { readonly kind: 'share'; readonly share: ShareLinkRow }
  | { readonly kind: 'ticket'; readonly payload: MediaTicketPayload };

export async function resolveRequestActor(
  deps: ContentRouteDeps,
  input: {
    readonly request: Request;
    readonly env: Env;
    readonly resource:
      | {
          readonly kind: 'file';
          readonly mountId: string;
          readonly fileId: string;
        }
      | {
          readonly kind: 'package';
          readonly mountId: string;
          readonly packageId: string;
        };
    readonly now: number;
  },
): Promise<ResolvedRequestActor> {
  const url = new URL(input.request.url);
  const ticket = url.searchParams.get('ticket');
  const share = url.searchParams.get('share');
  // Two scoped credentials in one request make the authority ambiguous
  // (reviewer F12) — reject before either is validated or consumed.
  if (ticket !== null && share !== null) {
    throw new ApiRequestError(
      400,
      'VALIDATION_FAILED',
      'Provide either a share link or a media ticket, not both.',
    );
  }
  if (ticket !== null) {
    let verified;
    try {
      verified = await verifyMediaTicket(
        input.env,
        ticket,
        input.resource,
        input.now,
      );
    } catch {
      throw new ApiRequestError(
        503,
        'BOOTSTRAP_SECRETS_INVALID',
        'Ticket validation is unavailable.',
      );
    }
    if (!verified.ok) {
      throw new ApiRequestError(
        403,
        'FORBIDDEN',
        'The media ticket is invalid or expired.',
      );
    }
    return { kind: 'ticket', payload: verified.payload };
  }
  if (share !== null) {
    const row = await resolveShareToken(input.env.DB, share);
    if (row === null) {
      throw new ApiRequestError(403, 'FORBIDDEN', 'The share link is invalid.');
    }
    return { kind: 'share', share: row };
  }
  const resolveSession = deps.resolveSessionActor ?? resolveActor;
  return {
    kind: 'session',
    actor: await resolveSession(input.request, input.env),
  };
}

// ---------------------------------------------------------------------------
// Admission: does the resolved actor cover this exact resource and mode?
// ---------------------------------------------------------------------------

export interface AdmitTarget {
  readonly fileId: string;
  /** Set when the request explicitly reads a pinned revision. */
  readonly revisionId?: string;
}

export type Admission =
  | { readonly ok: true; readonly principal: TicketPrincipal }
  | { readonly ok: false; readonly reason: string };

async function sessionAdmits(
  env: Env,
  actor: Actor,
  mount: MountRecord,
): Promise<Admission> {
  if (actor.kind === 'user') {
    const access = await authorizeMount(env.DB, actor, mount.id, mount);
    if (access === null || !access.operations.has('read')) {
      return { ok: false, reason: 'no-read-access' };
    }
    return { ok: true, principal: { kind: 'user', userId: actor.user.id } };
  }
  if (actor.kind === 'public') {
    if (mount.visibility !== 'public_read') {
      return { ok: false, reason: 'auth-required' };
    }
    return { ok: true, principal: { kind: 'public' } };
  }
  // grants.Actor has a 'share' variant that only this module resolves; a
  // session resolver returning it would be a contract violation — fail closed.
  return { ok: false, reason: 'actor-unsupported' };
}

/**
 * Share-scope admission shared by share actors and ticket principals minted
 * under a share. `share` is revalidated against the mount's current policy
 * version and clock, then scope coverage is checked exactly — a file share
 * pinned to a revision admits only that revision mode, and no share widens
 * into a whole mount or a shortcut target it does not name.
 */
export function shareAdmits(
  share: ShareLinkRow,
  mount: MountRecord,
  target: AdmitTarget,
  now: number,
): Admission {
  const validity = checkShareValid(share, mount.policyVersion, now);
  if (validity !== 'ok') {
    return { ok: false, reason: validity };
  }
  const scope = shareScopeOf(share);
  if (
    scope === null ||
    !shareScopeCovers(scope, { mountId: mount.id, ...target })
  ) {
    return { ok: false, reason: 'scope-mismatch' };
  }
  return { ok: true, principal: { kind: 'share', shareId: share.id } };
}

/** Fresh user row -> current read grant (ticket principal recheck). */
async function userStillAdmits(
  env: Env,
  userId: string,
  mountId: string,
): Promise<boolean> {
  const row = await env.DB
    .prepare(
      'SELECT id, name, email, role, banned, "createdAt" FROM "user" WHERE id = ?',
    )
    .bind(userId)
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
    mountId,
  );
  return access !== null && access.operations.has('read');
}

async function ticketPrincipalStillAdmits(
  env: Env,
  principal: TicketPrincipal,
  mount: MountRecord,
  target: AdmitTarget,
  now: number,
): Promise<boolean> {
  switch (principal.kind) {
    case 'user':
      return userStillAdmits(env, principal.userId, mount.id);
    case 'share': {
      const share = await getShareLink(env.DB, principal.shareId);
      if (share === null) return false;
      return shareAdmits(share, mount, target, now).ok;
    }
    case 'public':
      return mount.visibility === 'public_read';
  }
}

export async function admitFileAccess(
  env: Env,
  resolved: ResolvedRequestActor,
  mount: MountRecord,
  target: AdmitTarget,
  now: number,
  method: string,
): Promise<Admission> {
  if (resolved.kind === 'session') {
    return sessionAdmits(env, resolved.actor, mount);
  }
  if (resolved.kind === 'share') {
    return shareAdmits(resolved.share, mount, target, now);
  }
  // Scoped tickets are GET/HEAD capabilities only (spec §9.3).
  if (method !== 'GET' && method !== 'HEAD') {
    return { ok: false, reason: 'method-not-allowed' };
  }
  const scope = resolved.payload.scope;
  if (scope.kind !== 'file' || !ticketScopeCovers(scope, target)) {
    return { ok: false, reason: 'scope-mismatch' };
  }
  const stillValid = await ticketPrincipalStillAdmits(
    env,
    resolved.payload.principal,
    mount,
    target,
    now,
  );
  if (!stillValid) return { ok: false, reason: 'principal-revoked' };
  return { ok: true, principal: resolved.payload.principal };
}

// ---------------------------------------------------------------------------
// SA read pool selection and bounded failover (spec §5.4). Identities come
// from A's listReadPool — SQL on mount_read_credentials + service_accounts,
// never OAuth.
// ---------------------------------------------------------------------------

const MAX_READ_ATTEMPTS = 3;

export async function listReadIdentities(
  db: D1Database,
  mountId: string,
): Promise<ReadIdentity[]> {
  const pool = await listReadPool(db, mountId);
  return pool
    .filter((entry) => entry.enabled)
    .slice(0, MAX_READ_ATTEMPTS)
    .map((entry) => entry.identity);
}

/**
 * Reasons that never trigger a different-identity retry: file-level download
 * limits must cooldown the file (never rotate the pool to evade them), and
 * rate/quota failures stay with the reported identity — the coordinator
 * collapses file-scoped cooldowns into 'rate-limited', so rotating SAs here
 * would be a cooldown-evasion channel (coordinator R5 decision). The
 * caller's own abort is terminal, and local input/destination refusals are
 * programming errors (spec §5.4).
 */
export const NON_FAILOVER_REASONS = new Set<DriveFailureReason>([
  'download-restricted',
  'rate-limited',
  'quota-exceeded',
  'aborted',
  'invalid-input',
  'operation-not-allowed',
  'destination-refused',
]);

export async function withReadIdentity<T>(
  identities: readonly ReadIdentity[],
  fn: (identity: ReadIdentity) => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (const identity of identities) {
    try {
      return await fn(identity);
    } catch (err) {
      if (
        err instanceof DriveError &&
        !NON_FAILOVER_REASONS.has(err.reason)
      ) {
        last = err;
        continue;
      }
      throw err;
    }
  }
  throw (
    last ??
    new DriveError(
      'upstream-unavailable',
      'content: no service account in the read pool could serve the request',
    )
  );
}

// ---------------------------------------------------------------------------
// Verified SA-side file access. driveId, trash state and canDownload are all
// checked from the SA's own metadata read — OAuth capabilities never enter.
// ---------------------------------------------------------------------------

export interface VerifiedFileRead {
  readonly meta: DriveFileMeta;
  /** ref to use for body reads; carries the SA-observed resourceKey. */
  readonly ref: DriveResourceRef;
  /** The SA that read the metadata — every body read uses the same one. */
  readonly identity: ReadIdentity;
  /** All enabled pool candidates in selection order (for open failover). */
  readonly identities: readonly ReadIdentity[];
  /**
   * True when `meta` came from the wave-10 metadata cache instead of a
   * live SA files.get. Fields the cache deliberately does not store
   * (thumbnailLink) must not be treated as "known absent".
   */
  readonly fromCache?: boolean;
}

const OUTSIDE_MOUNT_MESSAGE = 'The file is trashed or outside the mount drive.';

/**
 * File-level facts an SA metadata read must prove before bytes are served:
 * canonical id match, not trashed, inside the mount's drive, and not
 * explicitly download-restricted. These fail closed (missing driveId
 * denies) and never consult OAuth data. Shortcuts are rejected rather than
 * traversed (coordinator F8 decision): content addresses literal file ids
 * only — the client resolves a shortcut target through the catalog, which
 * does the same scoped hop checks under OAuth. My Drive mounts additionally
 * require an OAuth-proven ancestor path (proveMyDriveContainment); the SA's
 * ability to read a file is never evidence of containment.
 */
function checkFileMeta(
  meta: DriveFileMeta,
  mount: MountRecord,
  fileId: string,
): void {
  if (meta.id !== fileId) {
    throw new DriveError(
      'unexpected-response',
      'content: upstream metadata id does not match the requested file',
    );
  }
  // Shared Drive: the SA's own driveId verdict, unchanged. My Drive: the SA
  // can only rule files OUT here (trashed, or a Shared Drive file reported
  // under a My Drive mount); containment itself is proven afterwards through
  // the OAuth catalog connection in verifiedFileForRead, never from the SA's
  // view of the file.
  const outsideDrive =
    mount.driveId === null
      ? meta.driveId !== undefined
      : meta.driveId === undefined || meta.driveId !== mount.driveId;
  if (meta.trashed === true || outsideDrive) {
    throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', OUTSIDE_MOUNT_MESSAGE);
  }
  if (meta.mimeType === SHORTCUT_MIME_TYPE) {
    throw new ApiRequestError(
      404,
      'FILE_NOT_ACCESSIBLE',
      'Shortcuts have no content here; resolve the target through the catalog.',
    );
  }
  if (meta.capabilities?.canDownload === false) {
    throw new ApiRequestError(
      502,
      'FILE_NOT_READABLE_BY_POOL',
      'The read pool may not download this file.',
    );
  }
  if (meta.capabilities?.canDownload !== true) {
    // Readability needs an affirmative capability — a missing flag is
    // inconclusive, never 'readable' (parity with verify.checkReaderAccess
    // in worker E's pipeline). Thrown as an upstream-unclear DriveError so
    // another pool identity may still affirm it; a readiness probe records
    // 'pending', and a fully-exhausted pool answers 502 DRIVE_UNAVAILABLE.
    throw new DriveError(
      'upstream-unavailable',
      'content: SA metadata did not affirm download capability',
    );
  }
}

/**
 * My Drive containment: walk the SA-reported parents upward through the
 * mount's OAuth CATALOG connection. The SA metadata supplies only the
 * starting `parents`; every ancestor fact comes from the catalog writer.
 * Anything unprovable denies: there is no retry through another provider
 * and the OAuth provider type has no content method to fall back to.
 */
async function proveMyDriveContainment(
  env: Env,
  mount: MountRecord,
  meta: DriveFileMeta,
  signal: AbortSignal | undefined,
  oauthProvider: OAuthCatalogWriteProvider | undefined,
  opts: VerifiedFileReadOpts = {},
  writerStateP?: Promise<ResolvedWriterState>,
): Promise<void> {
  let writer: ResolvedWriter;
  try {
    const state = await (
      writerStateP ??
      requireUsableOAuthWriter(env.DB, mount.catalogConnectionId, 'catalog')
    );
    writer = state.writer;
  } catch (err) {
    if (err instanceof ApiRequestError) {
      // A disabled/needs-reauth catalog connection cannot prove anything:
      // deny as inconclusive (readiness stays 'pending', not 'blocked').
      throw new DriveError(
        'upstream-unavailable',
        'content: the catalog connection cannot prove containment',
        { cause: err },
      );
    }
    throw err;
  }
  const provider =
    oauthProvider ??
    createGoogleOAuthProvider({
      tokenSource: opts.tokenSource ?? createCoordinatorTokenSource(env),
    });
  let lookup = oauthParentLookup({
    provider,
    writer,
    ...(signal === undefined ? {} : { signal }),
  });
  if (opts.timing !== undefined) lookup = timedParentLookup(lookup, opts.timing);
  try {
    await assertInMount(mountScopeOf(mount), meta, lookup, opts.shared);
  } catch (err) {
    if (err instanceof ResourceScopeError) {
      throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', OUTSIDE_MOUNT_MESSAGE);
    }
    if (
      err instanceof DriveError &&
      err.reason !== 'aborted' &&
      err.reason !== 'rate-limited'
    ) {
      throw new DriveError(
        'upstream-unavailable',
        'content: ancestor lookup failed; containment is unproven',
        { cause: err },
      );
    }
    throw err;
  }
}

export interface VerifiedFileReadOpts {
  /** Per-request memoized source for the OAuth provider's admissions. */
  readonly tokenSource?: CoordinatorTokenSource;
  readonly timing?: RequestTiming;
  /** Cross-isolate containment verdict store (migration 0009). */
  readonly shared?: SharedVerdictStore;
  /** Pre-resolved read pool (skips a duplicate listReadIdentities read). */
  readonly identities?: readonly ReadIdentity[];
  /**
   * Wave-10 metadata cache (migration 0010): a fresh, reader-eligible row
   * substitutes for the SA metadata read; anything else takes the live
   * path and refills the cache off the critical path via writeBehind.
   */
  readonly metaCache?: FileMetadataCacheStore;
  /**
   * Restrict cache hits to rows written by this source (review M1): HEAD
   * never opens media, so only a row carrying the SA's own verdict
   * ('sa_meta') may answer — an OAuth-inferred verdict has no SA proof.
   */
  readonly metaCacheSource?: FileMetaCacheSource;
  /** Off-critical-path write hook (route-level defer/waitUntil). */
  readonly writeBehind?: (work: Promise<unknown>) => void;
  /**
   * Fired exactly once after the winning SA metadata read passes
   * checkFileMeta, BEFORE the My Drive containment walk — the caller may
   * overlap a media open with the walk while no byte is served yet
   * (coordinator M4 ruling: media opens only after metadata checks pass).
   * `fromCache` reports whether the verified meta was synthesized from a
   * cache row, so the overlapped open can mark itself accordingly.
   */
  readonly onMetaVerified?: (verified: {
    readonly meta: DriveFileMeta;
    readonly identity: ReadIdentity;
    readonly fromCache: boolean;
  }) => void;
}

export async function verifiedFileForRead(
  provider: ServiceAccountContentReadProvider,
  env: Env,
  mount: MountRecord,
  fileId: string,
  signal?: AbortSignal,
  oauthProvider?: OAuthCatalogWriteProvider,
  opts: VerifiedFileReadOpts = {},
): Promise<VerifiedFileRead> {
  // My Drive mounts need the OAuth catalog writer for the ancestor walk:
  // start its D1 read now so it overlaps the SA metadata call.
  const writerStateP =
    mount.driveId === null
      ? requireUsableOAuthWriter(env.DB, mount.catalogConnectionId, 'catalog')
      : undefined;
  writerStateP?.catch(() => undefined);
  const identities =
    opts.identities ?? (await listReadIdentities(env.DB, mount.id));
  if (identities.length === 0) {
    throw new DriveError(
      'upstream-unavailable',
      'content: the mount read pool has no enabled service account',
    );
  }
  // Wave-10: a fresh, reader-eligible cache row substitutes for the SA
  // metadata call. get() already filtered expired and
  // reader_can_download = 0 rows and swallowed D1 errors; a miss or any
  // lookup failure falls through to the identical live path.
  const cached =
    opts.metaCache === undefined
      ? undefined
      : await opts.metaCache.get(mount, fileId, opts.metaCacheSource);
  // Only a configured cache earns a mark — the media-denial live re-check
  // passes no metaCache and must not append a second, misleading 'miss'
  // after the first call's 'hit' (review round-2).
  if (opts.metaCache !== undefined) {
    opts.timing?.mark('meta-cache', cached === undefined ? 'miss' : 'hit');
  }
  let meta: DriveFileMeta;
  let identity: ReadIdentity;
  let fromCache = false;
  if (cached !== undefined) {
    meta = cachedMetaToDriveFileMeta(fileId, cached);
    // The same verdicts run on cached facts exactly as on a live read:
    // id match, trashed, outside-drive and shortcut all still deny. The
    // canDownload arm cannot fire — eligibility already required the
    // stored reader verdict, and the media call stays the final authority.
    checkFileMeta(meta, mount, fileId);
    identity = identities[0]!;
    fromCache = true;
  } else {
    const resolved = await withReadIdentity(
      identities,
      async (identity) => {
        // fetchedAt must predate the upstream call (review round-2): the
        // tombstone guard compares against the fetch START, so a read that
        // raced an invalidation can never resurrect the stale row.
        const fetchStartedAt = Date.now();
        const meta = await provider.getReadMetadata({
          identity,
          ref: { id: fileId },
          ...(signal === undefined ? {} : { signal }),
        });
        // Fill source 'sa_meta' off the critical path — even when the
        // verdict denies: a trashed/outside-drive row caches the denial
        // and a restricted row lands with reader_can_download = 0 so it
        // can never hit. Only exact-id, keyless, non-shortcut,
        // non-folder metas produce a row.
        const row = rowFromDriveMeta(mount.id, meta, Date.now(), fetchStartedAt);
        if (opts.metaCache !== undefined && row !== undefined) {
          const work = opts.metaCache.put([row]);
          opts.writeBehind?.(work);
        }
        // Scope checks inside the failover loop: an identity that answers
        // for the wrong object or cannot affirm the capability fails over;
        // objective scope verdicts (outside drive, trashed, shortcut,
        // canDownload=false) are ApiRequestError and never rotate.
        checkFileMeta(meta, mount, fileId);
        return { identity, meta };
      },
    );
    meta = resolved.meta;
    identity = resolved.identity;
  }
  // checkFileMeta has passed for this exact identity: the earliest point a
  // media open may start (coordinator M4). Runs before the containment walk.
  opts.onMetaVerified?.({ meta, identity, fromCache });
  // Proven once per admission, outside the SA failover loop: containment is a
  // property of the file id, not of which pool identity happened to read it.
  if (mount.driveId === null) {
    await proveMyDriveContainment(
      env,
      mount,
      meta,
      signal,
      oauthProvider,
      opts,
      writerStateP,
    );
  }
  return {
    meta,
    ref: {
      id: fileId,
      ...(meta.resourceKey === undefined
        ? {}
        : { resourceKey: meta.resourceKey }),
    },
    identity,
    identities,
    fromCache,
  };
}

/**
 * Open a body read with bounded failover (spec §5.4): the SA that already
 * verified metadata opens first; on a failover-eligible failure each
 * remaining candidate re-verifies metadata before opening, so metadata and
 * body always come from the same identity. File-level download limits never
 * rotate the pool.
 */
export async function openWithFailover<T>(
  provider: ServiceAccountContentReadProvider,
  mount: MountRecord,
  fileId: string,
  admitted: VerifiedFileRead,
  signal: AbortSignal | undefined,
  open: (
    identity: ReadIdentity,
    ref: DriveResourceRef,
  ) => Promise<T>,
): Promise<T> {
  try {
    return await open(admitted.identity, admitted.ref);
  } catch (firstErr) {
    if (
      !(firstErr instanceof DriveError) ||
      NON_FAILOVER_REASONS.has(firstErr.reason)
    ) {
      throw firstErr;
    }
    let last: unknown = firstErr;
    for (const identity of admitted.identities) {
      if (identity.serviceAccountId === admitted.identity.serviceAccountId) {
        continue;
      }
      let ref: DriveResourceRef;
      try {
        const meta = await provider.getReadMetadata({
          identity,
          ref: { id: fileId },
          ...(signal === undefined ? {} : { signal }),
        });
        checkFileMeta(meta, mount, fileId);
        ref = {
          id: fileId,
          ...(meta.resourceKey === undefined
            ? {}
            : { resourceKey: meta.resourceKey }),
        };
      } catch (metaErr) {
        if (
          metaErr instanceof DriveError &&
          !NON_FAILOVER_REASONS.has(metaErr.reason)
        ) {
          last = metaErr;
          continue;
        }
        throw metaErr;
      }
      try {
        return await open(identity, ref);
      } catch (openErr) {
        if (
          openErr instanceof DriveError &&
          !NON_FAILOVER_REASONS.has(openErr.reason)
        ) {
          last = openErr;
          continue;
        }
        throw openErr;
      }
    }
    throw last;
  }
}

// ---------------------------------------------------------------------------
// Combined gate: mount lookup -> actor resolution -> scope admission ->
// verified SA metadata. Shared by content, thumbnail and export handlers.
// ---------------------------------------------------------------------------

export interface AdmittedRead {
  readonly mount: MountRecord;
  readonly verified: VerifiedFileRead;
  readonly principal: TicketPrincipal;
}

export interface AdmittedRequest {
  readonly mount: MountRecord;
  readonly principal: TicketPrincipal;
  /** Enabled pool candidates in selection order (resolved during admission). */
  readonly identities: readonly ReadIdentity[];
}

/**
 * Mount + actor + scope admission and the read-pool listing — everything
 * before the SA Drive calls. The mount read, actor resolution and pool
 * listing are independent and run concurrently; attach-only catches keep a
 * loser rejection from becoming an unhandled rejection.
 */
export async function admitFileRequest(
  c: RouterContext,
  deps: ContentRouteDeps,
  options: { readonly revisionId?: string } = {},
): Promise<AdmittedRequest> {
  const mountId = requireParam(c, 'mountId');
  const fileId = requireDriveId(requireParam(c, 'fileId'), 'fileId');
  const now = (deps.now ?? Date.now)();
  const mountP = (deps.getMount ?? getMount)(c.env.DB, mountId);
  mountP.catch(() => undefined);
  const resolvedP = resolveRequestActor(deps, {
    request: c.req.raw,
    env: c.env,
    resource: { kind: 'file', mountId, fileId },
    now,
  });
  resolvedP.catch(() => undefined);
  const identitiesP = listReadIdentities(c.env.DB, mountId);
  identitiesP.catch(() => undefined);
  const mount = await mountP;
  if (mount === null) {
    throw new ApiRequestError(404, 'NOT_FOUND', 'Mount not found.');
  }
  const resolved = await resolvedP;
  const admission = await admitFileAccess(
    c.env,
    resolved,
    mount,
    {
      fileId,
      ...(options.revisionId === undefined
        ? {}
        : { revisionId: options.revisionId }),
    },
    now,
    c.req.method,
  );
  if (!admission.ok) {
    const status = admission.reason === 'auth-required' ? 401 : 403;
    const code: ApiErrorCode =
      admission.reason === 'auth-required' ? 'AUTH_REQUIRED' : 'FORBIDDEN';
    throw new ApiRequestError(status, code, 'Access to this content is denied.');
  }
  const identities = await identitiesP;
  return { mount, principal: admission.principal, identities };
}

/**
 * Media-authority failure handling shared by the content, thumbnail and
 * export routes (wave-10 §3, review M2/L4/M4). A denial-class media failure
 * means any cached row is stale: the row is invalidated off the critical
 * path (waitUntil) — and when the read was served FROM the cache, the live
 * SA metadata check runs again so the caller surfaces exactly the error
 * the live path returns (e.g. checkFileMeta's FILE_NOT_READABLE_BY_POOL).
 * The recheck deliberately passes no metaCache: the deferred delete may not
 * have landed yet, and a row filled right after a media denial would keep
 * a genuinely-limited file from ever reporting its cooldown.
 * Returns the error to surface; the recheck's own denial wins when thrown.
 */
export async function mediaDenialError(
  c: RouterContext,
  deps: ContentRouteDeps,
  input: {
    readonly mount: MountRecord;
    readonly fileId: string;
    readonly verified: VerifiedFileRead;
    readonly err: unknown;
  },
): Promise<unknown> {
  if (!isMediaAuthorityFailure(input.err)) return input.err;
  defer(c, metaCacheFor(c).invalidateFile(input.fileId));
  if (input.verified.fromCache !== true) return input.err;
  // Throws the live path's denial on stale verdicts; on a pass the
  // original error stands (it maps to the same response either way).
  await verifiedFileForRead(
    providerFor(c, deps),
    c.env,
    input.mount,
    input.fileId,
    c.req.raw.signal,
    deps.oauthProvider,
    {
      tokenSource: tokenSourceFor(c, c.env),
      timing: timingFor(c.req.raw),
      shared: sharedVerdictStoreFor(c),
      identities: input.verified.identities,
    },
  );
  return input.err;
}

export async function admitFileRead(
  c: RouterContext,
  deps: ContentRouteDeps,
  options: { readonly revisionId?: string } = {},
): Promise<AdmittedRead> {
  const fileId = requireDriveId(requireParam(c, 'fileId'), 'fileId');
  const admitted = await admitFileRequest(c, deps, options);
  const verified = await verifiedFileForRead(
    providerFor(c, deps),
    c.env,
    admitted.mount,
    fileId,
    c.req.raw.signal,
    deps.oauthProvider,
    {
      tokenSource: tokenSourceFor(c, c.env),
      timing: timingFor(c.req.raw),
      shared: sharedVerdictStoreFor(c),
      identities: admitted.identities,
      metaCache: metaCacheFor(c),
      writeBehind: (work) => defer(c, work),
    },
  );
  return { mount: admitted.mount, verified, principal: admitted.principal };
}

// ---------------------------------------------------------------------------
// Streaming + cancellation. The upstream AbortSignal is bound to the
// provider call; the downstream body is wrapped so a client disconnect or
// reader cancel aborts the upstream fetch — a partially-sent response is
// never stitched to another identity or request (spec §7.2).
// ---------------------------------------------------------------------------

export function downstreamAbortableBody(
  upstream: ReadableStream<Uint8Array>,
  abort: () => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      if (cancelled) return;
      cancelled = true;
      try {
        abort();
      } finally {
        await reader.cancel(reason).catch(() => undefined);
      }
    },
  });
}

export function linkRequestSignal(
  request: Request,
  controller: AbortController,
): void {
  const signal = request.signal;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return;
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), {
    once: true,
  });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DriveError('aborted', 'content: request cancelled');
  }
}
