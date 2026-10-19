/**
 * Anonymous public-link router (wave 8 Phase B2), mounted at /api/v1/p.
 *
 * Security contract:
 *   - No session lookup anywhere: a logged-in admin's cookie gains nothing.
 *   - Every resource access proves (a) the link row is valid (revoked,
 *     expiry, mount policy version), (b) the link root still sits inside
 *     its mount, and (c) the requested folder/file is the root or a
 *     descendant — the OAuth parent walk in containment.ts. Anything
 *     outside answers 404 like a missing resource; shortcuts never appear.
 *   - Catalog listing runs through the mount's OAuth connection; content
 *     bytes run through the SA read pool via content-access.ts. No
 *     cross-provider fallback, no whole-file buffering.
 *   - Locked links require the MACed unlock cookie on every route except
 *     GET /:slug (meta + `locked` flag) and POST /:slug/unlock.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { apiError as buildApiError, type ApiErrorCode } from '../../shared/contracts/common';
import {
  PublicChildrenPageSchema,
  PublicFolderMetaSchema,
  UnlockPublicLinkRequestSchema,
  type PublicBreadcrumb,
} from '../../shared/contracts/public-links';
import { DriveError } from '../drive/errors';
import {
  assertInMount,
  isWithinFolder,
  mountScopeOf,
  oauthParentLookup,
  type MountScope,
} from '../drive/containment';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { createGoogleOAuthProvider } from '../drive/providers/google-oauth';
import { createServiceAccountReadProvider } from '../drive/providers/service-account-read';
import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE } from '../drive/providers/common';
import { validateDriveId } from '../drive/transport';
import {
  ApiRequestError,
  failureFromError,
  getMount,
  requireUsableOAuthWriter,
  type MountRecord,
} from '../drive/mounts';
import type {
  CatalogPage,
  CoordinatorTokenSource,
  DriveFileMeta,
  OAuthCatalogWriteProvider,
  ResolvedWriter,
  ServiceAccountContentReadProvider,
} from '../drive/types';
import {
  downstreamAbortableBody,
  linkRequestSignal,
  openWithFailover,
  verifiedFileForRead,
} from '../transfers/content-access';
import { buildContentDisposition, resolveDisposition } from '../transfers/content-disposition';
import { parseSingleRange } from '../transfers/range';
import {
  PUBLIC_LINK_COOKIE_MAX_AGE_SECONDS,
  openPublicLinkCookie,
  publicLinkCookieHeader,
  readPublicLinkCookie,
  sealPublicLinkCookie,
  verifyPublicLinkPassword,
} from './crypto';
import {
  UNLOCK_AGGREGATE_MAX_ATTEMPTS,
  checkPublicLinkValid,
  clearUnlockFailures,
  bumpPublicLinkCounter,
  getPublicLinkBySlug,
  refundUnlockAttempt,
  reserveUnlockAttempt,
  unlockAggregateKey,
  unlockAttemptKey,
  type PublicLinkRow,
} from './links';
import { createZipStream, sanitizeZipName, type ZipEntrySpec } from './zip';

// Archive bounds (review M1, revised R3): the Workers subrequest budget is
// ~1000 per invocation and EVERY provider call costs two — a coordinator
// DO /admit fetch plus the Google fetch — so one archived file costs 4
// (SA getReadMetadata + SA openContent) and one OAuth listing page costs
// 2. Worst case with these caps: 150*4 files + 50*2 pages + up to
// (ARCHIVE_MAX_DIRS + 32 link-root chain) cached OAuth ancestor lookups *2
// on My Drive mounts = 600 + 100 + 264 ≈ 964 < 1000. Shared Drive mounts
// skip ancestor walks entirely (driveId gate) and stay ≈ 700.
export const ARCHIVE_MAX_FILES = 150;
export const ARCHIVE_MAX_BYTES = 2n * 1024n * 1024n * 1024n; // 2 GiB, no ZIP64
export const ARCHIVE_MAX_DIRS = 100;
export const ARCHIVE_MAX_ENTRIES = 5_000;
export const ARCHIVE_MAX_PAGES = 50;
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

export interface PublicLinkRouterDeps {
  readonly oauthProvider?: OAuthCatalogWriteProvider;
  readonly readProvider?: ServiceAccountContentReadProvider;
  readonly tokenSource?: CoordinatorTokenSource;
  readonly getMount?: (db: D1Database, id: string) => Promise<MountRecord | null>;
  readonly now?: () => number;
  readonly archiveMaxFiles?: number;
  readonly archiveMaxBytes?: bigint;
  readonly archiveMaxDirs?: number;
  readonly archiveMaxEntries?: number;
  readonly archiveMaxPages?: number;
  readonly unlockAggregateMaxAttempts?: number;
}

type RC = Context<{ Bindings: Env; Variables: { requestId?: string } }>;

function fail(c: RC, status: ContentfulStatusCode, code: ApiErrorCode, message: string, retryAfterSeconds?: number): Response {
  return c.json(buildApiError(code, message, c.get('requestId') ?? crypto.randomUUID(), retryAfterSeconds), status);
}

// Anonymous callers must never learn OAuth connection state (review L5):
// disabled/reauth/downgrade/unusable-writer errors collapse to a generic
// 503 instead of their diagnostic codes.
const CONNECTION_STATE_CODES = new Set<ApiErrorCode>([
  'GOOGLE_REAUTH_REQUIRED',
  'GOOGLE_CONNECTION_DISABLED',
]);

function errRes(
  c: RC,
  err: unknown,
  context: { provider: 'google_oauth' | 'service_account'; surface: 'catalog' | 'content' } = { provider: 'google_oauth', surface: 'catalog' },
): Response {
  const failure = failureFromError(err, context);
  if (CONNECTION_STATE_CODES.has(failure.code)) {
    return fail(c, 503, 'AUTH_UNAVAILABLE', 'This link is temporarily unavailable.');
  }
  return fail(c, failure.status as ContentfulStatusCode, failure.code, failure.message, failure.retryAfterSeconds);
}

/**
 * Pull-driven relay that bumps download_count when the FIRST chunk is
 * actually pulled — never on stream construction, so a failed open or an
 * abandoned response cannot inflate the counter (reviews R1/R7). Unlike an
 * eager start() copier, upstream bytes move only while the consumer reads,
 * so a stalled client cannot drag a whole file into the isolate.
 */
function countedDownloadBody(
  db: D1Database,
  linkId: string,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let counted = false;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          ctl.close();
          return;
        }
        if (!counted) {
          counted = true;
          await bumpPublicLinkCounter(db, linkId, 'download_count');
        }
        ctl.enqueue(value);
      } catch (err) {
        ctl.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

interface ResolvedLink {
  readonly link: PublicLinkRow;
  readonly mount: MountRecord;
  readonly scope: MountScope;
}

/** Link row + mount + validity; every failure maps to 404 or 410. */
async function resolveLink(c: RC, deps: PublicLinkRouterDeps): Promise<ResolvedLink | { response: Response }> {
  const slug = c.req.param('slug') ?? '';
  const link = await getPublicLinkBySlug(c.env.DB, slug);
  if (link === null) return { response: fail(c, 404, 'NOT_FOUND', 'Not found.') };
  const mount = await (deps.getMount ?? getMount)(c.env.DB, link.mountId);
  const validity = checkPublicLinkValid(link, mount === null ? null : mount.policyVersion, (deps.now ?? Date.now)());
  if (validity !== 'ok') {
    return { response: fail(c, 410, 'PUBLIC_LINK_EXPIRED', 'This link is no longer available.') };
  }
  return { link, mount: mount as MountRecord, scope: mountScopeOf(mount as MountRecord) };
}

/** When the link is locked, require a valid bound unlock cookie. */
async function admitLocked(
  c: RC,
  deps: PublicLinkRouterDeps,
  link: PublicLinkRow,
): Promise<Response | null> {
  if (link.passwordHash === null) return null;
  const presented = readPublicLinkCookie(c.req.raw);
  if (presented !== null) {
    try {
      const payload = await openPublicLinkCookie(c.env, presented);
      if (
        payload !== null &&
        payload.linkId === link.id &&
        payload.credentialVersion === link.credentialVersion &&
        payload.exp > (deps.now ?? Date.now)()
      ) {
        return null;
      }
    } catch {
      // MAC key unavailable: fall through to the locked response.
    }
  }
  return fail(c, 403, 'PUBLIC_LINK_PASSWORD_REQUIRED', 'This link requires a password.');
}

/** Proves meta is inside the mount AND the link root still is; both throw on failure. */
async function assertLinkScope(
  resolved: ResolvedLink,
  meta: DriveFileMeta,
  lookup: ReturnType<typeof oauthParentLookup>,
): Promise<void> {
  await assertInMount(resolved.scope, meta, lookup); // resource inside the mount
  const proof = await isWithinFolder(resolved.scope, resolved.link.folderId, meta, lookup);
  if (!proof.inside) {
    throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', 'The resource is not accessible.');
  }
  // The link ROOT must stay inside its mount: walk the root itself.
  const rootMeta = await lookup(resolved.link.folderId);
  await assertInMount(resolved.scope, rootMeta, lookup);
}

/** Descendant proof that also yields breadcrumbs (root-first, root included). */
async function proveFolderForChildren(
  resolved: ResolvedLink,
  meta: DriveFileMeta,
  lookup: ReturnType<typeof oauthParentLookup>,
): Promise<PublicBreadcrumb[]> {
  if (meta.mimeType !== FOLDER_MIME_TYPE) {
    throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', 'The resource is not accessible.');
  }
  await assertInMount(resolved.scope, meta, lookup);
  const proof = await isWithinFolder(resolved.scope, resolved.link.folderId, meta, lookup);
  if (!proof.inside) {
    throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', 'The resource is not accessible.');
  }
  const rootMeta = await lookup(resolved.link.folderId);
  await assertInMount(resolved.scope, rootMeta, lookup);
  return [
    { id: resolved.link.folderId, name: rootMeta.name ?? resolved.link.folderName },
    ...proof.path.slice().reverse().map((p) => ({ id: p.id, name: p.name })),
    { id: meta.id, name: meta.name },
  ].filter((b, i, a) => i === 0 || b.id !== a[0]!.id);
}

interface WriterCtx {
  readonly writer: ResolvedWriter;
  readonly provider: OAuthCatalogWriteProvider;
  readonly lookup: ReturnType<typeof oauthParentLookup>;
}

async function writerCtx(
  c: RC,
  deps: PublicLinkRouterDeps,
  mount: MountRecord,
): Promise<WriterCtx> {
  const writer = (await requireUsableOAuthWriter(c.env.DB, mount.catalogConnectionId, 'catalog')).writer;
  const provider =
    deps.oauthProvider ?? createGoogleOAuthProvider({ tokenSource: deps.tokenSource ?? createCoordinatorTokenSource(c.env) });
  return { writer, provider, lookup: oauthParentLookup({ provider, writer, signal: c.req.raw.signal }) };
}

async function fetchMeta(ctx: WriterCtx, id: string): Promise<DriveFileMeta> {
  try {
    return await ctx.provider.getMetadata({ writer: ctx.writer, ref: { id } });
  } catch (err) {
    if (err instanceof DriveError && (err.reason === 'not-found' || err.reason === 'gone' || err.reason === 'permission-denied')) {
      throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', 'The resource is not accessible.');
    }
    throw err;
  }
}

const FALLBACK_MTIME = '1970-01-01T00:00:00.000Z';

export function createPublicLinkRouter(deps: PublicLinkRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const now = deps.now ?? Date.now;
  const readProviderFor = (env: Env): ServiceAccountContentReadProvider =>
    deps.readProvider ?? createServiceAccountReadProvider({ tokenSource: deps.tokenSource ?? createCoordinatorTokenSource(env) });

  // GET /:slug — public metadata; view_count++ on success.
  app.get('/:slug', async (c) => {
    const resolved = await resolveLink(c, deps);
    if ('response' in resolved) return resolved.response;
    const { link } = resolved;
    // Hono routes HEAD to the GET handler: answer headers only and never
    // count it as a view (review L7).
    if (c.req.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
    }
    await bumpPublicLinkCounter(c.env.DB, link.id, 'view_count');
    return c.json(PublicFolderMetaSchema.parse({
      slug: link.slug,
      folderName: link.folderName,
      rootFolderId: link.folderId,
      sharedByName: link.createdByName ?? 'A workspace member',
      expiresAt: link.expiresAt === null ? null : new Date(link.expiresAt).toISOString(),
      allowZip: link.allowZip,
      locked: link.passwordHash !== null,
    }));
  });

  // POST /:slug/unlock — throttled PBKDF2 verify -> MACed cookie.
  app.post('/:slug/unlock', async (c) => {
    const resolved = await resolveLink(c, deps);
    if ('response' in resolved) return resolved.response;
    const { link } = resolved;
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
    }
    const parsed = UnlockPublicLinkRequestSchema.safeParse(body);
    if (!parsed.success) return fail(c, 400, 'VALIDATION_FAILED', 'Invalid unlock request.');
    const ip = c.req.header('cf-connecting-ip') ?? '';
    const key = await unlockAttemptKey(link.slug, ip);
    const aggregateKey = await unlockAggregateKey(link.id);
    // Reserve the attempt atomically before verifying — a race cannot
    // grant extra guesses. Per-(slug,ip) limit, then the per-link
    // aggregate that defeats IP rotation.
    const gate = await reserveUnlockAttempt(c.env.DB, key, now());
    if (!gate.allowed) {
      return fail(c, 429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.', gate.retryAfterSeconds);
    }
    const aggregate = await reserveUnlockAttempt(
      c.env.DB, aggregateKey, now(),
      deps.unlockAggregateMaxAttempts ?? UNLOCK_AGGREGATE_MAX_ATTEMPTS,
    );
    if (!aggregate.allowed) {
      return fail(c, 429, 'RATE_LIMITED', 'Too many failed attempts. Try again later.', aggregate.retryAfterSeconds);
    }
    if (link.passwordHash !== null && !(await verifyPublicLinkPassword(parsed.data.password, link.passwordHash))) {
      return fail(c, 403, 'PUBLIC_LINK_INVALID_PASSWORD', 'The password is incorrect.');
    }
    // Success (review R2b): the per-(slug,ip) row is cleared and the
    // aggregate reservation is refunded, so the aggregate counts FAILED
    // attempts only — heavy legitimate unlock traffic can no longer lock
    // the link out for everyone.
    await clearUnlockFailures(c.env.DB, key);
    await refundUnlockAttempt(c.env.DB, aggregateKey, now());
    const exp = Math.min(link.expiresAt ?? Number.MAX_SAFE_INTEGER, now() + PUBLIC_LINK_COOKIE_MAX_AGE_SECONDS * 1000);
    const value = await sealPublicLinkCookie(c.env, {
      v: 1, linkId: link.id, credentialVersion: link.credentialVersion, exp,
    });
    return new Response(null, {
      status: 204,
      headers: { 'Set-Cookie': publicLinkCookieHeader(link.slug, value, Math.ceil((exp - now()) / 1000)) },
    });
  });

  // GET /:slug/children — descendant-proven OAuth listing, shortcuts hidden.
  app.get('/:slug/children', async (c) => {
    const resolved = await resolveLink(c, deps);
    if ('response' in resolved) return resolved.response;
    const locked = await admitLocked(c, deps, resolved.link);
    if (locked !== null) return locked;
    try {
      const ctx = await writerCtx(c, deps, resolved.mount);
      const folderId = validateDriveId(c.req.query('folderId') ?? resolved.link.folderId, 'public.children');
      const meta = await fetchMeta(ctx, folderId);
      const breadcrumbs = await proveFolderForChildren(resolved, meta, ctx.lookup);
      const pageToken = c.req.query('pageToken');
      const page: CatalogPage = await ctx.provider.listChildren({
        writer: ctx.writer,
        scope: resolved.scope,
        parentFolderId: folderId,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      return c.json(PublicChildrenPageSchema.parse({
        folderId: meta.id,
        folderName: meta.name,
        breadcrumbs,
        entries: page.entries
          .filter((e) => e.kind !== 'shortcut')
          .map((e) => ({
            id: e.id,
            kind: e.kind === 'folder' ? 'folder' : 'file',
            name: e.name,
            mimeType: e.mimeType,
            size: e.kind === 'folder' ? null : e.size,
            modifiedTime: e.modifiedTime ?? FALLBACK_MTIME,
            hasThumbnail: e.hasThumbnail,
          })),
        nextPageToken: page.nextPageToken ?? null,
      }));
    } catch (err) {
      return errRes(c, err);
    }
  });

  // GET|HEAD /:slug/files/:fileId/content — SA-pool stream, Range support.
  app.on(['GET', 'HEAD'], '/:slug/files/:fileId/content', async (c) => {
    const resolved = await resolveLink(c, deps);
    if ('response' in resolved) return resolved.response;
    const locked = await admitLocked(c, deps, resolved.link);
    if (locked !== null) return locked;
    try {
      const fileId = validateDriveId(c.req.param('fileId'), 'public.content');
      const ctx = await writerCtx(c, deps, resolved.mount);
      const meta = await fetchMeta(ctx, fileId);
      if (meta.mimeType === FOLDER_MIME_TYPE || meta.mimeType === SHORTCUT_MIME_TYPE) {
        throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', 'The resource is not accessible.');
      }
      await assertLinkScope(resolved, meta, ctx.lookup);
      const provider = readProviderFor(c.env);
      const verified = await verifiedFileForRead(provider, c.env, resolved.mount, fileId, c.req.raw.signal, deps.oauthProvider);

      const isHead = c.req.method === 'HEAD';
      const size = verified.meta.size !== undefined ? BigInt(verified.meta.size) : undefined;
      const download = c.req.query('download') === '1';
      const headers = new Headers();
      const deliveredType = verified.meta.mimeType;
      headers.set('Content-Type', deliveredType);
      headers.set('Content-Disposition', buildContentDisposition(resolveDisposition(deliveredType, download ? 'attachment' : 'inline'), verified.meta.name));
      if (verified.meta.modifiedTime !== undefined && Number.isFinite(Date.parse(verified.meta.modifiedTime))) {
        headers.set('Last-Modified', new Date(verified.meta.modifiedTime).toUTCString());
      }
      if (size !== undefined) headers.set('Accept-Ranges', 'bytes');
      if (isHead) {
        if (size !== undefined) headers.set('Content-Length', size.toString(10));
        return new Response(null, { status: 200, headers });
      }
      let upstreamRange: { start: bigint; end: bigint } | undefined;
      const rangeHeader = c.req.raw.headers.get('range');
      if (rangeHeader !== null && size !== undefined) {
        const parsed = parseSingleRange(rangeHeader, size);
        if (parsed.type === 'satisfiable') upstreamRange = { start: parsed.start, end: parsed.end };
        else if (parsed.type === 'unsatisfiable') {
          return new Response(JSON.stringify(buildApiError('VALIDATION_FAILED', 'The requested range cannot be satisfied.', c.get('requestId') ?? crypto.randomUUID())), {
            status: 416,
            headers: new Headers({ 'Content-Range': `bytes */${size.toString(10)}`, 'Content-Type': 'application/json; charset=UTF-8' }),
          });
        }
      }
      const controller = new AbortController();
      linkRequestSignal(c.req.raw, controller);
      const upstream = await openWithFailover(provider, resolved.mount, fileId, verified, controller.signal, (identity, ref) =>
        provider.openContent({ identity, ref, ...(upstreamRange === undefined ? {} : { range: upstreamRange }), signal: controller.signal }),
      );
      if (upstream.contentType !== undefined) headers.set('Content-Type', upstream.contentType);
      if (upstream.status === 206 && upstream.contentRange !== undefined) {
        headers.set('Content-Range', upstream.contentRange);
        headers.set('Accept-Ranges', 'bytes');
      }
      const length = upstream.contentLength ?? (upstream.status === 200 ? size : undefined);
      if (length !== undefined) headers.set('Content-Length', length.toString(10));
      headers.set('Content-Disposition', buildContentDisposition(resolveDisposition(upstream.contentType ?? deliveredType, download ? 'attachment' : 'inline'), verified.meta.name));
      const relay = downstreamAbortableBody(upstream.body, () => controller.abort());
      const body = download ? countedDownloadBody(c.env.DB, resolved.link.id, relay) : relay;
      return new Response(body, { status: upstream.status, headers });
    } catch (err) {
      // Same anonymous collapse as errRes elsewhere (review R6): a disabled
      // or reauth-pending connection must surface as a generic 503, never
      // its diagnostic code.
      return errRes(c, err, { provider: 'service_account', surface: 'content' });
    }
  });

  // GET /:slug/archive — streaming STORE zip over the SA read pipeline.
  app.get('/:slug/archive', async (c) => {
    const resolved = await resolveLink(c, deps);
    if ('response' in resolved) return resolved.response;
    const locked = await admitLocked(c, deps, resolved.link);
    if (locked !== null) return locked;
    if (!resolved.link.allowZip) {
      return fail(c, 403, 'PUBLIC_LINK_ARCHIVE_DISABLED', 'Folder download is not enabled for this link.');
    }
    try {
      const ctx = await writerCtx(c, deps, resolved.mount);
      const folderId = validateDriveId(c.req.query('folderId') ?? resolved.link.folderId, 'public.archive');
      const rootMeta = await fetchMeta(ctx, folderId);
      if (rootMeta.mimeType !== FOLDER_MIME_TYPE) {
        throw new ApiRequestError(404, 'FILE_NOT_ACCESSIBLE', 'The resource is not accessible.');
      }
      await assertLinkScope(resolved, rootMeta, ctx.lookup);
      // Caps (review M1): files/bytes bound the payload; dirs, listed
      // entries and list pages bound the OAuth subrequest budget so the
      // pre-walk itself stays under the Workers per-invocation limit.
      const maxFiles = deps.archiveMaxFiles ?? ARCHIVE_MAX_FILES;
      const maxBytes = deps.archiveMaxBytes ?? ARCHIVE_MAX_BYTES;
      const maxDirs = deps.archiveMaxDirs ?? ARCHIVE_MAX_DIRS;
      const maxEntries = deps.archiveMaxEntries ?? ARCHIVE_MAX_ENTRIES;
      const maxPages = deps.archiveMaxPages ?? ARCHIVE_MAX_PAGES;
      const tooLarge = () => fail(c, 413, 'PUBLIC_LINK_TOO_LARGE', 'The folder exceeds the archive size limit.');

      // Pre-walk: enumerate the whole subtree once, enforcing caps and
      // recording skipped (Google-native / unsized) entries.
      interface FileItem { path: string; fileId: string; mime: string; size: bigint; modifiedTime?: string }
      const items: FileItem[] = [];
      const dirs: { path: string; modifiedTime?: string }[] = [];
      const skipped: string[] = [];
      let totalBytes = 0n;
      const usedNames = new Map<string, number>();
      const dedupe = (dir: string, name: string): string => {
        const safe = sanitizeZipName(name);
        const key = `${dir}\x00${safe}`;
        const seen = usedNames.get(key) ?? 0;
        usedNames.set(key, seen + 1);
        if (seen === 0) return safe;
        const dot = safe.lastIndexOf('.');
        const bumped = dot > 0 ? `${safe.slice(0, dot)} (${seen + 1})${safe.slice(dot)}` : `${safe} (${seen + 1})`;
        return bumped === '..' || bumped === '.' ? '_' : bumped;
      };
      let dirsVisited = 0;
      let listedEntries = 0;
      let listPages = 0;
      const queue: { id: string; path: string }[] = [{ id: folderId, path: '' }];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.id)) continue;
        visited.add(current.id);
        let pageToken: string | undefined;
        do {
          const page = await ctx.provider.listChildren({
            writer: ctx.writer, scope: resolved.scope, parentFolderId: current.id,
            ...(pageToken === undefined ? {} : { pageToken }),
          });
          pageToken = page.nextPageToken;
          listPages += 1;
          if (listPages > maxPages) return tooLarge();
          for (const entry of page.entries) {
            listedEntries += 1;
            if (listedEntries > maxEntries) return tooLarge();
            if (entry.kind === 'shortcut') { skipped.push(`${current.path}${entry.name} (shortcut)`); continue; }
            if (entry.kind === 'folder') {
              dirsVisited += 1;
              if (dirsVisited > maxDirs) return tooLarge();
              const p = `${current.path}${dedupe(current.path, entry.name)}/`;
              dirs.push({ path: p, modifiedTime: entry.modifiedTime });
              queue.push({ id: entry.id, path: p });
              continue;
            }
            if (entry.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
              skipped.push(`${current.path}${entry.name} (Google-native file)`);
              continue;
            }
            const size = entry.size === undefined ? null : BigInt(entry.size);
            if (size === null) { skipped.push(`${current.path}${entry.name} (no reported size)`); continue; }
            items.push({ path: `${current.path}${dedupe(current.path, entry.name)}`, fileId: entry.id, mime: entry.mimeType, size, modifiedTime: entry.modifiedTime });
            totalBytes += size;
            if (items.length > maxFiles || totalBytes > maxBytes) return tooLarge();
          }
        } while (pageToken !== undefined);
      }

      const provider = readProviderFor(c.env);
      const specs: ZipEntrySpec[] = [];
      for (const d of dirs) specs.push({ name: d.path, modifiedTime: d.modifiedTime });
      for (const item of items) {
        specs.push({
          name: item.path,
          size: item.size,
          modifiedTime: item.modifiedTime,
          open: async () => {
            const verified = await verifiedFileForRead(provider, c.env, resolved.mount, item.fileId, c.req.raw.signal, deps.oauthProvider);
            const upstream = await openWithFailover(provider, resolved.mount, item.fileId, verified, c.req.raw.signal, (identity, ref) =>
              provider.openContent({ identity, ref, signal: c.req.raw.signal }),
            );
            return upstream.body;
          },
        });
      }
      if (skipped.length > 0) {
        const text = `The following entries were skipped:\n${skipped.map((s) => `- ${s}`).join('\n')}\n`;
        const bytes = new TextEncoder().encode(text);
        specs.push({
          name: 'skipped-files.txt',
          open: async () => new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(bytes); ctl.close(); } }),
        });
      }
      const headers = new Headers({
        'Content-Type': 'application/zip',
        'Content-Disposition': buildContentDisposition('attachment', `${rootMeta.name}.zip`),
      });
      return new Response(
        countedDownloadBody(c.env.DB, resolved.link.id, createZipStream(specs)),
        { status: 200, headers },
      );
    } catch (err) {
      return errRes(c, err);
    }
  });

  return app;
}
