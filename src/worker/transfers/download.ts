/**
 * Content download/streaming routes (architecture §7, plan T06; wave-3 B).
 *
 * `createContentRouter()` is mounted under /api/v1/mounts and serves:
 *
 *   GET|HEAD /:mountId/files/:fileId/content
 *     ?mode=revision&revision=<id>        pinned-revision read (default current)
 *     ?disposition=attachment|inline    download naming (active types force attachment)
 *     ?share=<token> | ?ticket=<token>  scoped capability admission
 *   GET      /:mountId/files/:fileId/thumbnail      (src/worker/media/thumbnail.ts)
 *   GET      /:mountId/files/:fileId/export?format=pdf (src/worker/media/export.ts)
 *   POST     /:mountId/files/:fileId/readiness   SA read probe -> file_readiness
 *   POST     /:mountId/files/:fileId/tickets    mint scoped GET/HEAD ticket
 *
 * HTTP contract: single closed/open/suffix Range with 200/206/416 honesty
 * (never a fabricated 206), HEAD without a body fetch, If-Range honoured
 * only when its validator is verifiable, pinned revisions require
 * keepForever and never fall back to head, and downstream cancellation
 * aborts the upstream stream. Shared admission/SA-selection lives in
 * content-access.ts.
 */

import { Hono } from 'hono';
import { apiError as buildApiError } from '../../shared/contracts/common';
import {
  CreateMediaTicketRequestSchema,
  MEDIA_TICKET_DEFAULT_TTL_SECONDS,
  MEDIA_TICKET_MAX_TTL_SECONDS,
  ReadinessViewSchema,
  type MediaTicket,
  type ReadinessView,
} from '../../shared/contracts/media';
import { authorizeMount } from '../auth/grants';
import { DriveError, isDriveError } from '../drive/errors';
import { ApiRequestError, getMount } from '../drive/mounts';
import type { DriveFileMeta, UpstreamContent } from '../drive/types';
import { handleExport } from '../media/export';
import { handleThumbnail } from '../media/thumbnail';
import { mintMediaTicket } from '../security/tickets';
import {
  admitFileAccess,
  admitFileRead,
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
  type ContentRouteDeps,
  type RouterContext,
} from './content-access';
import {
  buildContentDisposition,
  resolveDisposition,
  type DispositionMode,
} from './content-disposition';
import { parseSingleRange } from './range';
import {
  countedDownloadBody,
  recordContentRequest,
  recordReaderBlocked,
} from '../admin/metrics';

// ---------------------------------------------------------------------------
// Content mode + disposition parameters (validated; unknown values reject).
// ---------------------------------------------------------------------------

export type ContentMode =
  | { readonly kind: 'current' }
  | { readonly kind: 'revision'; readonly revisionId: string };

function parseContentMode(c: RouterContext): ContentMode {
  const mode = c.req.query('mode');
  const revision = c.req.query('revision');
  if (mode === undefined || mode === 'current') {
    if (revision !== undefined) {
      throw new ApiRequestError(
        400,
        'VALIDATION_FAILED',
        "The 'revision' parameter requires mode=revision.",
      );
    }
    return { kind: 'current' };
  }
  if (mode === 'revision') {
    if (revision === undefined || revision === '') {
      throw new ApiRequestError(
        400,
        'VALIDATION_FAILED',
        "mode=revision requires a 'revision' parameter.",
      );
    }
    return { kind: 'revision', revisionId: revision };
  }
  throw new ApiRequestError(
    400,
    'VALIDATION_FAILED',
    `Unknown content mode '${mode}'.`,
  );
}

function parseDispositionParam(
  c: RouterContext,
): DispositionMode | undefined {
  const raw = c.req.query('disposition');
  if (raw === undefined) return undefined;
  if (raw === 'attachment' || raw === 'inline') return raw;
  throw new ApiRequestError(
    400,
    'VALIDATION_FAILED',
    "The 'disposition' parameter must be 'attachment' or 'inline'.",
  );
}

// ---------------------------------------------------------------------------
// Content GET/HEAD
// ---------------------------------------------------------------------------

const CONTENT_QUERY_PARAMS = [
  'mode',
  'revision',
  'disposition',
  'share',
  'ticket',
] as const;

function pinnedRevisionEtag(fileId: string, revisionId: string): string {
  return `"gdrev-${fileId}-${revisionId}"`;
}

/**
 * If-Range verification (spec §7.3, coordinator R5 decision): in
 * current-content mode no If-Range validator can prove the byte
 * representation — the metadata mtime and the body are separate fetches,
 * so ANY If-Range presence (date, strong tag, weak tag, even blank) drops
 * the Range and the whole representation goes out as 200. In
 * pinned-revision mode the exact strong ETag we emit verifies, but only
 * after the revision itself has been validated (kept + readable) upstream.
 */
function ifRangeAllows(
  header: string | null,
  mode: ContentMode,
  fileId: string,
): boolean {
  if (header === null) return true;
  if (mode.kind === 'revision') {
    return header.trim() === pinnedRevisionEtag(fileId, mode.revisionId);
  }
  return false;
}

interface RangePlan {
  /** Exact inclusive range to send upstream. */
  readonly upstream?: { readonly start: bigint; readonly end: bigint };
  /** Set when the client range is unsatisfiable: emit 416. */
  readonly unsatisfiableSize?: bigint;
}

function planRange(
  rangeHeader: string | null,
  ifRange: string | null,
  size: bigint | undefined,
  mode: ContentMode,
  fileId: string,
): RangePlan {
  if (rangeHeader === null) return {};
  if (!ifRangeAllows(ifRange, mode, fileId)) return {};
  if (size !== undefined) {
    const parsed = parseSingleRange(rangeHeader, size);
    switch (parsed.type) {
      case 'absent':
        return {};
      case 'satisfiable':
        return { upstream: { start: parsed.start, end: parsed.end } };
      case 'unsatisfiable':
        return { unsatisfiableSize: parsed.size };
      case 'invalid':
        // RFC permits ignoring an unusable Range; serve the whole body.
        return {};
    }
  }
  // Unknown representation size: a Range cannot be evaluated honestly —
  // satisfiability needs the size, and forwarding an open-ended Range turns
  // an upstream 416 into a misleading 500 (reviewer F10). Ignore the Range
  // and serve the whole body.
  return {};
}

function baseContentHeaders(
  meta: DriveFileMeta,
  mode: ContentMode,
  revisionModifiedTime: string | undefined,
  contentType: string | undefined,
  disposition: DispositionMode | undefined,
): Headers {
  const headers = new Headers();
  const type = contentType ?? meta.mimeType;
  headers.set('Content-Type', type);
  headers.set(
    'Content-Disposition',
    buildContentDisposition(resolveDisposition(type, disposition), meta.name),
  );
  headers.set('Cache-Control', 'private, no-store');
  const modified = revisionModifiedTime ?? meta.modifiedTime;
  if (modified !== undefined && Number.isFinite(Date.parse(modified))) {
    headers.set('Last-Modified', new Date(modified).toUTCString());
  }
  if (mode.kind === 'revision') {
    headers.set('ETag', pinnedRevisionEtag(meta.id, mode.revisionId));
  }
  return headers;
}

async function handleContent(c: RouterContext, deps: ContentRouteDeps) {
  const requestStartedMs = Date.now();
  try {
    assertQueryParams(c, CONTENT_QUERY_PARAMS);
    const mode = parseContentMode(c);
    const requestedDisposition = parseDispositionParam(c);

    const admitted = await admitFileRead(c, deps, {
      revisionId: mode.kind === 'revision' ? mode.revisionId : undefined,
    });
    const { verified } = admitted;
    const provider = providerFor(c, deps);
    const isHead = c.req.method === 'HEAD';
    const fileId = requireDriveId(requireParam(c, 'fileId'), 'fileId');

    let size: bigint | undefined;
    let revisionId: string | undefined;
    let revisionModifiedTime: string | undefined;
    if (mode.kind === 'revision') {
      // Strict snapshot: the revision must exist, be readable and be marked
      // keepForever. A missing/unreadable revision is SNAPSHOT_UNAVAILABLE —
      // never a silent fallback to head (spec §7.3).
      if (verified.meta.capabilities?.canReadRevisions === false) {
        throw new ApiRequestError(
          409,
          'SNAPSHOT_UNAVAILABLE',
          'Revisions cannot be read for this file.',
        );
      }
      let revision;
      try {
        revision = await provider.getRevision({
          identity: verified.identity,
          ref: verified.ref,
          revisionId: mode.revisionId,
          signal: c.req.raw.signal,
        });
      } catch (err) {
        if (
          isDriveError(err) &&
          (err.reason === 'not-found' ||
            err.reason === 'gone' ||
            err.reason === 'permission-denied')
        ) {
          throw new ApiRequestError(
            409,
            'SNAPSHOT_UNAVAILABLE',
            'The pinned revision is no longer available.',
          );
        }
        throw err;
      }
      if (!revision.keepForever) {
        throw new ApiRequestError(
          409,
          'SNAPSHOT_UNAVAILABLE',
          'The requested revision is not kept forever.',
        );
      }
      revisionId = mode.revisionId;
      size =
        revision.size !== undefined ? BigInt(revision.size) : undefined;
      revisionModifiedTime = revision.modifiedTime;
    } else {
      size =
        verified.meta.size !== undefined
          ? BigInt(verified.meta.size)
          : undefined;
    }

    const headers = baseContentHeaders(
      verified.meta,
      mode,
      revisionModifiedTime,
      undefined,
      requestedDisposition,
    );
    if (size !== undefined) headers.set('Accept-Ranges', 'bytes');

    if (isHead) {
      // HEAD answers the headers of a GET on the full representation:
      // Range/If-Range are GET semantics and are ignored here (RFC 9110
      // §13.1.5/§14.2) — no body is ever fetched.
      if (size !== undefined) {
        headers.set('Content-Length', size.toString(10));
      }
      return new Response(null, { status: 200, headers });
    }

    const plan = planRange(
      c.req.raw.headers.get('range'),
      c.req.raw.headers.get('if-range'),
      size,
      mode,
      fileId,
    );

    if (plan.unsatisfiableSize !== undefined) {
      // RFC 9110 §14.2: 416 carries Content-Range with the complete size.
      // A JSON error envelope is honest about its own content type rather
      // than reusing the file's media headers.
      const rangeHeaders = new Headers();
      rangeHeaders.set(
        'Content-Range',
        `bytes */${plan.unsatisfiableSize.toString(10)}`,
      );
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

    const upstreamRange = plan.upstream;

    const controller = new AbortController();
    linkRequestSignal(c.req.raw, controller);
    const upstream = await openWithFailover(
      provider,
      admitted.mount,
      fileId,
      verified,
      controller.signal,
      (identity, ref) =>
        provider.openContent({
          identity,
          ref,
          ...(upstreamRange === undefined ? {} : { range: upstreamRange }),
          ...(revisionId === undefined ? {} : { revisionId }),
          signal: controller.signal,
        }),
    );
    relayContentHeaders(headers, upstream, size);
    // Disposition is computed against the DELIVERED type (reviewer F3): the
    // upstream can answer a different Content-Type than metadata promised —
    // e.g. an error page or an HTML/SVG variant — and the active-type
    // attachment rule must apply to what is actually served.
    const deliveredType = upstream.contentType ?? verified.meta.mimeType;
    headers.set(
      'Content-Disposition',
      buildContentDisposition(
        resolveDisposition(deliveredType, requestedDisposition),
        verified.meta.name,
      ),
    );
    recordContentRequest();
    const counted = countedDownloadBody(upstream.body, requestStartedMs);
    const body = downstreamAbortableBody(counted, () =>
      controller.abort(),
    );
    return new Response(body, { status: upstream.status, headers });
  } catch (err) {
    return contentErrorResponse(c, err);
  }
}

function relayContentHeaders(
  headers: Headers,
  upstream: UpstreamContent,
  size: bigint | undefined,
): void {
  if (upstream.contentType !== undefined) {
    headers.set('Content-Type', upstream.contentType);
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
}

// ---------------------------------------------------------------------------
// Readiness probe: bounded SA read check recorded into file_readiness
// (spec §6.5/§10.2). Session users with read access only — share/ticket
// capabilities never probe readiness.
// ---------------------------------------------------------------------------

async function handleReadiness(c: RouterContext, deps: ContentRouteDeps) {
  try {
    assertQueryParams(c, ['share']);
    const mountId = requireParam(c, 'mountId');
    const fileId = requireDriveId(requireParam(c, 'fileId'), 'fileId');
    const now = (deps.now ?? Date.now)();
    const mount = await (deps.getMount ?? getMount)(c.env.DB, mountId);
    if (mount === null) {
      return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
    }
    const resolved = await resolveRequestActor(deps, {
      request: c.req.raw,
      env: c.env,
      resource: { kind: 'file', mountId, fileId },
      now,
    });
    if (resolved.kind !== 'session' || resolved.actor.kind !== 'user') {
      return fail(
        c,
        403,
        'FORBIDDEN',
        'Readiness checks require an app user session.',
      );
    }
    const access = await authorizeMount(c.env.DB, resolved.actor, mountId);
    if (access === null || !access.operations.has('read')) {
      return fail(c, 403, 'FORBIDDEN', 'Read access is required.');
    }

    const provider = providerFor(c, deps);
    let state: ReadinessView['readerAccessState'] = 'blocked';
    let reason: string | undefined;
    try {
      await verifiedFileForRead(provider, c.env, mount, fileId, c.req.raw.signal);
      state = 'readable';
    } catch (err) {
      const verdict = readinessFailure(err);
      if (verdict === null) throw err;
      state = verdict;
      reason = readinessReason(err);
    }
    if (state === 'blocked') recordReaderBlocked();

    await c.env.DB
      .prepare(
        'INSERT INTO file_readiness (mount_id, file_id, reader_access_state, ' +
          'read_pool_version, policy_version, checked_at, reason, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(mount_id, file_id) DO UPDATE SET ' +
          'reader_access_state = excluded.reader_access_state, ' +
          'read_pool_version = excluded.read_pool_version, ' +
          'policy_version = excluded.policy_version, ' +
          'checked_at = excluded.checked_at, ' +
          'reason = excluded.reason, updated_at = excluded.updated_at',
      )
      .bind(
        mountId,
        fileId,
        state,
        mount.readPoolVersion,
        mount.policyVersion,
        now,
        reason ?? null,
        now,
      )
      .run();

    const view: ReadinessView = ReadinessViewSchema.parse({
      fileId,
      readerAccessState: state,
      checkedAt: new Date(now).toISOString(),
      ...(reason === undefined ? {} : { reason }),
    });
    return c.json(view);
  } catch (err) {
    return contentErrorResponse(c, err);
  }
}

/**
 * Readiness classification (reviewer F2): only a definitive SA-side verdict
 * persists 'blocked'; transient/credential/upstream failures persist
 * 'pending' so a cooldown does not permanently mark the file; and
 * caller-abort/local refusal failures persist nothing — they are not a
 * readability verdict at all.
 */
const READINESS_BLOCKED_REASONS = new Set([
  'not-found',
  'gone',
  'permission-denied',
  'download-restricted',
]);
const READINESS_NO_PERSIST_REASONS = new Set([
  'aborted',
  'invalid-input',
  'operation-not-allowed',
  'destination-refused',
  'unexpected-response',
]);

function readinessFailure(err: unknown): 'blocked' | 'pending' | null {
  // checkFileMeta verdicts (outside drive / trashed / canDownload=false) are
  // definitive facts about the file, not transient conditions.
  if (err instanceof ApiRequestError) return 'blocked';
  if (err instanceof DriveError) {
    if (READINESS_NO_PERSIST_REASONS.has(err.reason)) return null;
    if (READINESS_BLOCKED_REASONS.has(err.reason)) return 'blocked';
    return 'pending';
  }
  return null;
}

function readinessReason(err: unknown): string {
  if (err instanceof DriveError) return `sa:${err.reason}`;
  if (err instanceof ApiRequestError) return `app:${err.code}`;
  return 'internal';
}

// ---------------------------------------------------------------------------
// Ticket mint: POST /:mountId/files/:fileId/tickets. Session users and share
// actors may mint; the ticket is bound to this file (optionally a pinned
// revision) and to the minting principal, which is rechecked on use.
// ---------------------------------------------------------------------------

async function handleMintTicket(c: RouterContext, deps: ContentRouteDeps) {
  try {
    assertQueryParams(c, ['share']);
    const mountId = requireParam(c, 'mountId');
    const fileId = requireDriveId(requireParam(c, 'fileId'), 'fileId');
    const now = (deps.now ?? Date.now)();
    const mount = await (deps.getMount ?? getMount)(c.env.DB, mountId);
    if (mount === null) {
      return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
    }
    const parsed = CreateMediaTicketRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail(c, 400, 'VALIDATION_FAILED', 'Invalid ticket request.');
    }

    const resolved = await resolveRequestActor(deps, {
      request: c.req.raw,
      env: c.env,
      resource: { kind: 'file', mountId, fileId },
      now,
    });
    // A ticket is itself only a GET/HEAD capability; it cannot mint others.
    if (resolved.kind === 'ticket') {
      return fail(
        c,
        403,
        'FORBIDDEN',
        'Media tickets cannot mint further tickets.',
      );
    }
    const target = {
      fileId,
      ...(parsed.data.revisionId === undefined
        ? {}
        : { revisionId: parsed.data.revisionId }),
    };
    const admission = await admitFileAccess(
      c.env,
      resolved,
      mount,
      target,
      now,
      'GET',
    );
    if (!admission.ok) {
      const status = admission.reason === 'auth-required' ? 401 : 403;
      const code =
        admission.reason === 'auth-required' ? 'AUTH_REQUIRED' : 'FORBIDDEN';
      return fail(c, status, code, 'Access to this content is denied.');
    }

    // Coordinator decision: non-admin principals cannot extend a ticket past
    // the 60-minute default; the 24-hour ceiling is admin-only.
    const isAdmin =
      resolved.kind === 'session' &&
      resolved.actor.kind === 'user' &&
      resolved.actor.user.role === 'admin';
    const ttlCap = isAdmin
      ? MEDIA_TICKET_MAX_TTL_SECONDS
      : MEDIA_TICKET_DEFAULT_TTL_SECONDS;
    const requested = parsed.data.ttlSeconds ?? MEDIA_TICKET_DEFAULT_TTL_SECONDS;
    if (requested > ttlCap) {
      return fail(
        c,
        400,
        'VALIDATION_FAILED',
        'Requested ticket lifetime exceeds the allowed maximum.',
      );
    }

    const minted = await mintMediaTicket(c.env, {
      scope: {
        kind: 'file',
        mountId,
        fileId,
        ...(parsed.data.revisionId === undefined
          ? {}
          : { revisionId: parsed.data.revisionId }),
      },
      principal: admission.principal,
      ttlSeconds: requested,
      now,
    });
    const view: MediaTicket = {
      ticket: minted.token,
      expiresAt: new Date(minted.expiresAtMs).toISOString(),
    };
    return c.json(view, 201);
  } catch (err) {
    return contentErrorResponse(c, err);
  }
}

// ---------------------------------------------------------------------------
// Router assembly
// ---------------------------------------------------------------------------

/**
 * Mounted under /api/v1/mounts. Thumbnail and export handlers live in
 * src/worker/media/ and share the content-access pipeline — same SA
 * identity, same scope checks, same fail-closed behaviour.
 */
export function createContentRouter(deps: ContentRouteDeps = {}) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { requestId?: string };
  }>();

  app.on(['GET', 'HEAD'], '/:mountId/files/:fileId/content', (c) =>
    handleContent(c, deps),
  );
  app.get('/:mountId/files/:fileId/thumbnail', (c) =>
    handleThumbnail(c, deps),
  );
  app.get('/:mountId/files/:fileId/export', (c) => handleExport(c, deps));
  app.post('/:mountId/files/:fileId/readiness', (c) =>
    handleReadiness(c, deps),
  );
  app.post('/:mountId/files/:fileId/tickets', (c) =>
    handleMintTicket(c, deps),
  );

  return app;
}
