/**
 * Site branding routes (wave 8 Phase B1).
 *
 * Anonymous surface (mounted at /api/v1/site, outside the setup gate):
 *   GET /api/v1/site       -> SiteBrandingView; defaults before setup
 *   GET /api/v1/site/logo  -> stored logo bytes; 404 when none
 *
 * Admin surface (mounted at /api/v1/admin):
 *   PUT    /site           -> upsert singleton + app_settings.defaultLocale
 *   PUT    /site/logo      -> raw image body, magic-byte/SVG validation
 *   DELETE /site/logo      -> clear the logo
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { apiError as buildApiError, type ApiErrorCode } from '../../shared/contracts/common';
import {
  SiteBrandingViewSchema,
  UpdateSiteBrandingRequestSchema,
  type SiteBrandingView,
  type SiteLocale,
} from '../../shared/contracts/site';
import { requireAdmin as realRequireAdmin } from '../auth/session';
import type { RequireAdminFn } from '../security/shares';
import { recordAudit } from '../admin/routes';

export const SITE_LOGO_MAX_BYTES = 512 * 1024;
const LOGO_MIMES = new Set(['image/png', 'image/webp', 'image/svg+xml']);

interface BrandingRow {
  title: string;
  tagline: string;
  welcome: string;
  support_email: string | null;
  logo_mime: string | null;
  logo_data: Uint8Array | null;
  logo_version: number;
}

type RouterContext = Context<{ Bindings: Env; Variables: { requestId?: string } }>;

function fail(c: RouterContext, status: ContentfulStatusCode, code: ApiErrorCode, message: string): Response {
  return c.json(buildApiError(code, message, c.get('requestId') ?? crypto.randomUUID()), status);
}

async function readBrandingRow(db: D1Database): Promise<BrandingRow | null> {
  const row = await db
    .prepare('SELECT title, tagline, welcome, support_email, logo_mime, logo_data, logo_version FROM site_branding WHERE id = 1')
    .first<BrandingRow>();
  return row ?? null;
}

async function readDefaultLocale(db: D1Database): Promise<SiteLocale> {
  try {
    const row = await db
      .prepare('SELECT default_locale FROM app_settings WHERE id = 1')
      .first<{ default_locale: string }>();
    return row?.default_locale === 'en' ? 'en' : 'vi';
  } catch {
    return 'vi';
  }
}

async function siteView(db: D1Database): Promise<SiteBrandingView> {
  const row = await readBrandingRow(db);
  const defaultLocale = await readDefaultLocale(db);
  return SiteBrandingViewSchema.parse({
    title: row?.title ?? 'Drive Worker',
    tagline: row?.tagline ?? '',
    welcome: row?.welcome ?? '',
    supportEmail: row?.support_email ?? null,
    defaultLocale,
    logoUrl: row !== null && row.logo_mime !== null && row.logo_data !== null
      ? `/api/v1/site/logo?v=${row.logo_version}`
      : null,
  });
}

async function adminOrResponse(
  c: RouterContext,
  requireAdmin: RequireAdminFn,
): Promise<{ admin: { userId: string } } | { response: Response }> {
  try {
    const admin = await requireAdmin(c.req.raw, c.env);
    return { admin };
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    const status = e.status === 401 || e.status === 403 || e.status === 503 ? e.status : 500;
    const code: ApiErrorCode =
      status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN'
      : status === 503 ? ((e.code as ApiErrorCode) ?? 'AUTH_UNAVAILABLE') : 'INTERNAL_ERROR';
    return {
      response: fail(c, status as ContentfulStatusCode, code, typeof e.message === 'string' ? e.message : 'Authorization failed.'),
    };
  }
}

// ---------------------------------------------------------------------------
// Logo validation
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.byteLength < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  );
}

/** Decode XML entities + numeric character references so an attacker
 * cannot hide `javascript:` or tags inside them (review L1). Runs twice to
 * collapse a double-encoded layer. */
function decodeXmlEntities(text: string): string {
  let out = text;
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
      .replace(/&(lt|gt|amp|quot|apos);/g, (m, e: string) =>
        ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[e] ?? m);
  }
  return out;
}

/** First-element check + the plan's rejection list for SVG uploads. */
export function isSafeSvg(bytes: Uint8Array): boolean {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const text = decodeXmlEntities(raw);
  // Skip BOM, whitespace, XML prologs, comments and DOCTYPE to find the root.
  let rest = text.replace(/^﻿/, '').trimStart();
  for (;;) {
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end < 0) return false;
      rest = rest.slice(end + 2).trimStart();
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) return false;
      rest = rest.slice(end + 3).trimStart();
      continue;
    }
    break;
  }
  if (/^<!DOCTYPE/i.test(rest)) return false;
  if (!/^<svg[\s/>]/i.test(rest)) return false;
  const lower = text.toLowerCase();
  // Control characters (tab, CR, LF, NUL…) can smuggle a scheme or CSS
  // escape past substring checks once entities are decoded — e.g.
  // `java&#9;script:` — so those checks run on a control-stripped copy
  // (review R4).
  const squashed = lower.replace(/[\x00-\x20]/g, '');
  if (squashed.includes('javascript:') || squashed.includes('<!entity')) return false;
  // Active/dynamic constructs match by element LOCAL name so a namespace
  // prefix cannot hide them: <s:script>, <s:set>, <s:foreignObject>,
  // <s:style> all count (review R4). The prefix class is [^\s>/]+ rather
  // than [\w.-]+ so a non-ASCII namespace (<é:script>) cannot slip past
  // (review L-a). <set>/<animate*> (SMIL injection), <style> and embedded
  // content elements can reach out of the document even under nosniff, so
  // the upload is refused outright.
  if (/<\/?(?:[^\s>/]+:)?(script|set|animate\w*|style|foreignobject|iframe|embed|object)\b/i.test(lower)) {
    return false;
  }
  if (/url\s*\(/i.test(squashed) || /@import/i.test(squashed)) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  // CSS escapes (u\72l -> url) decode inside style and presentation
  // attributes, so a backslash inside ANY attribute value is refused
  // (review L-b). The scan stays inside tag markup so element text like
  // `a=b\c` in <text> is not mistaken for an attribute.
  for (const tag of text.match(/<[^<>]*>/g) ?? []) {
    for (const m of tag.matchAll(/[^\s=/>"'<]+\s*=\s*(?:(['"])([\s\S]*?)\1|([^\s>]+))/gi)) {
      if ((m[2] ?? m[3] ?? '').includes('\\')) return false;
    }
  }
  // href/xlink:href values (quoted or unquoted) must be same-document "#"
  // fragments; [\s\S] so a newline cannot hide a non-fragment value.
  for (const m of text.matchAll(/(?:xlink:)?href\s*=\s*(?:(['"])([\s\S]*?)\1|([^\s>]+))/gi)) {
    const value = (m[2] ?? m[3] ?? '').trim();
    if (!value.startsWith('#')) return false;
  }
  return true;
}

/** Read a request body with a hard cap, counting while streaming. */
export async function readLogoBody(request: Request, cap: number): Promise<Uint8Array | 'too-large'> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > cap) return 'too-large';
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return 'too-large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

export interface SiteRouterDeps {
  readonly requireAdmin?: RequireAdminFn;
  readonly now?: () => number;
}

export function createSiteRouter(deps: SiteRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  void deps;

  // Anonymous — must answer defaults before setup, so no session or
  // setup-state lookup can block it. Everything is a D1 read.
  app.get('/', async (c) => c.json(await siteView(c.env.DB)));

  app.get('/logo', async (c) => {
    const row = await readBrandingRow(c.env.DB);
    if (row === null || row.logo_mime === null || row.logo_data === null) {
      return fail(c, 404, 'NOT_FOUND', 'No site logo is configured.');
    }
    const headers = new Headers({ 'Content-Type': row.logo_mime });
    // D1 blob reads come back as ArrayBuffer (production), Uint8Array, or a
    // plain number[] (miniflare test env) — normalize to bytes.
    const raw = row.logo_data as unknown;
    const data = raw instanceof Uint8Array
      ? raw
      : Array.isArray(raw)
        ? new Uint8Array(raw)
        : new Uint8Array(raw as ArrayBuffer);
    return new Response(data as Uint8Array<ArrayBuffer>, { status: 200, headers });
  });

  return app;
}

export function createSiteAdminRouter(deps: SiteRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const now = deps.now ?? Date.now;

  app.put('/site', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
    }
    const parsed = UpdateSiteBrandingRequestSchema.safeParse(body);
    if (!parsed.success) return fail(c, 400, 'VALIDATION_FAILED', 'Site branding request is invalid.');
    const t = parsed.data;
    const ts = now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO site_branding (id, title, tagline, welcome, support_email, updated_at, updated_by) ' +
          'VALUES (1, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET title = excluded.title, tagline = excluded.tagline, ' +
          'welcome = excluded.welcome, support_email = excluded.support_email, ' +
          'updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      ).bind(t.title, t.tagline, t.welcome, t.supportEmail, ts, auth.admin.userId),
      c.env.DB.prepare('UPDATE app_settings SET default_locale = ?, updated_at = ? WHERE id = 1')
        .bind(t.defaultLocale, ts),
    ]);
    await recordAudit(c.env.DB, {
      requestId: c.get('requestId') ?? crypto.randomUUID(),
      actorUserId: auth.admin.userId,
      operation: 'site.branding.update',
      targetType: 'site_branding',
      targetId: '1',
      result: 'ok',
      nowMs: ts,
    });
    return c.json(await siteView(c.env.DB));
  });

  app.put('/site/logo', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const mime = (c.req.header('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (!LOGO_MIMES.has(mime)) {
      return fail(c, 400, 'VALIDATION_FAILED', 'Logo must be image/png, image/webp or image/svg+xml.');
    }
    const bytes = await readLogoBody(c.req.raw, SITE_LOGO_MAX_BYTES);
    if (bytes === 'too-large') {
      return fail(c, 413, 'VALIDATION_FAILED', 'Logo exceeds the 512 KiB limit.');
    }
    if (mime === 'image/png' && !hasMagic(bytes, PNG_MAGIC)) {
      return fail(c, 400, 'VALIDATION_FAILED', 'PNG logo failed magic-byte validation.');
    }
    if (mime === 'image/webp' && !isWebp(bytes)) {
      return fail(c, 400, 'VALIDATION_FAILED', 'WebP logo failed magic-byte validation.');
    }
    if (mime === 'image/svg+xml' && !isSafeSvg(bytes)) {
      return fail(c, 400, 'VALIDATION_FAILED', 'SVG logo failed validation.');
    }
    const ts = now();
    await c.env.DB.prepare(
      'INSERT INTO site_branding (id, logo_mime, logo_data, logo_version, updated_at, updated_by) ' +
        'VALUES (1, ?, ?, 1, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET logo_mime = excluded.logo_mime, ' +
        'logo_data = excluded.logo_data, logo_version = site_branding.logo_version + 1, ' +
        'updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    ).bind(mime, bytes, ts, auth.admin.userId).run();
    await recordAudit(c.env.DB, {
      requestId: c.get('requestId') ?? crypto.randomUUID(),
      actorUserId: auth.admin.userId,
      operation: 'site.logo.update',
      targetType: 'site_branding',
      targetId: '1',
      result: 'ok',
      nowMs: ts,
    });
    return c.json(await siteView(c.env.DB));
  });

  app.delete('/site/logo', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const ts = now();
    await c.env.DB.prepare(
      'UPDATE site_branding SET logo_mime = NULL, logo_data = NULL, updated_at = ?, updated_by = ? WHERE id = 1',
    ).bind(ts, auth.admin.userId).run();
    await recordAudit(c.env.DB, {
      requestId: c.get('requestId') ?? crypto.randomUUID(),
      actorUserId: auth.admin.userId,
      operation: 'site.logo.delete',
      targetType: 'site_branding',
      targetId: '1',
      result: 'ok',
      nowMs: ts,
    });
    return c.json(await siteView(c.env.DB));
  });

  return app;
}
