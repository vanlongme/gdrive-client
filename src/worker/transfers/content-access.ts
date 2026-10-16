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
import { DriveError, type DriveFailureReason } from '../drive/errors';
import {
  ApiRequestError,
  failureFromError,
  getMount,
  listReadPool,
  resolveActor,
  type MountRecord,
} from '../drive/mounts';
import { SHORTCUT_MIME_TYPE } from '../drive/providers/common';
import { createServiceAccountReadProvider } from '../drive/providers/service-account-read';
import { validateDriveId } from '../drive/transport';
import type {
  CoordinatorTokenSource,
  DriveFileMeta,
  DriveResourceRef,
  ReadIdentity,
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
  readonly tokenSource?: CoordinatorTokenSource;
  readonly now?: () => number;
}

export type RouterContext = Context<{
  Bindings: Env;
  Variables: { requestId?: string };
}>;

export function providerFor(
  c: RouterContext,
  deps: ContentRouteDeps,
): ServiceAccountContentReadProvider {
  return (
    deps.readProvider ??
    createServiceAccountReadProvider({
      tokenSource: deps.tokenSource ?? createCoordinatorTokenSource(c.env),
    })
  );
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
    const access = await authorizeMount(env.DB, actor, mount.id);
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
const NON_FAILOVER_REASONS = new Set<DriveFailureReason>([
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
}

/**
 * File-level facts an SA metadata read must prove before bytes are served:
 * canonical id match, not trashed, inside the mount's drive, and not
 * explicitly download-restricted. These fail closed (missing driveId
 * denies) and never consult OAuth data. Shortcuts are rejected rather than
 * traversed (coordinator F8 decision): content addresses literal file ids
 * only — the client resolves a shortcut target through the catalog, which
 * does the same scoped hop checks under OAuth.
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
  if (
    meta.trashed === true ||
    meta.driveId === undefined ||
    meta.driveId !== mount.driveId
  ) {
    throw new ApiRequestError(
      404,
      'FILE_NOT_ACCESSIBLE',
      'The file is trashed or outside the mount drive.',
    );
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

export async function verifiedFileForRead(
  provider: ServiceAccountContentReadProvider,
  env: Env,
  mount: MountRecord,
  fileId: string,
  signal?: AbortSignal,
): Promise<VerifiedFileRead> {
  const identities = await listReadIdentities(env.DB, mount.id);
  if (identities.length === 0) {
    throw new DriveError(
      'upstream-unavailable',
      'content: the mount read pool has no enabled service account',
    );
  }
  const { meta, identity } = await withReadIdentity(
    identities,
    async (identity) => {
      const meta = await provider.getReadMetadata({
        identity,
        ref: { id: fileId },
        ...(signal === undefined ? {} : { signal }),
      });
      // Scope checks inside the failover loop: an identity that answers
      // for the wrong object or cannot affirm the capability fails over;
      // objective scope verdicts (outside drive, trashed, shortcut,
      // canDownload=false) are ApiRequestError and never rotate.
      checkFileMeta(meta, mount, fileId);
      return { identity, meta };
    },
  );
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

export async function admitFileRead(
  c: RouterContext,
  deps: ContentRouteDeps,
  options: { readonly revisionId?: string } = {},
): Promise<AdmittedRead> {
  const mountId = requireParam(c, 'mountId');
  const fileId = requireDriveId(requireParam(c, 'fileId'), 'fileId');
  const now = (deps.now ?? Date.now)();
  const mount = await (deps.getMount ?? getMount)(c.env.DB, mountId);
  if (mount === null) {
    throw new ApiRequestError(404, 'NOT_FOUND', 'Mount not found.');
  }
  const resolved = await resolveRequestActor(deps, {
    request: c.req.raw,
    env: c.env,
    resource: { kind: 'file', mountId, fileId },
    now,
  });
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
  const verified = await verifiedFileForRead(
    providerFor(c, deps),
    c.env,
    mount,
    fileId,
    c.req.raw.signal,
  );
  return { mount, verified, principal: admission.principal };
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
