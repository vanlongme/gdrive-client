/**
 * API security headers and mutation origin/CSRF checks (architecture §9.3,
 * wave-2 track A).
 *
 * The API never serves active content, so the CSP is fully closed; nosniff,
 * no-referrer and no-store apply to every /api response including errors.
 * Mutations additionally pass an origin check: Fetch Metadata `cross-site`
 * is always rejected, and a present Origin/Referer must match the canonical
 * origin pinned at setup (the request's own origin is only a stand-in before
 * setup completes). Better Auth's own CSRF middleware covers /api/auth/*;
 * this guard covers /api/v1/* mutations.
 */

import type { Context } from 'hono';

export function applyApiSecurityHeaders(c: Context): void {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Cache-Control', 'no-store');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Validate a state-changing request's origin. Rules:
 * - Safe methods always pass.
 * - `Sec-Fetch-Site: cross-site` is rejected outright.
 * - A present Origin (or Referer fallback) must equal the canonical origin
 *   pinned at setup. Only before setup completes (canonicalOrigin === null)
 *   may the request's own origin stand in — at that point the origin the app
 *   is served on is the origin being configured.
 * - A missing Origin+Referer pair is allowed: browsers always send Origin on
 *   cross-site POSTs, so an absent header means a non-browser client whose
 *   requests carry no ambient authority anyway.
 */
export function isMutationOriginAllowed(
  request: Request,
  canonicalOrigin: string | null,
): boolean {
  if (SAFE_METHODS.has(request.method)) return true;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return false;

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const presented =
    origin ?? (referer === null ? null : requestOrigin(referer));
  if (presented === null || presented === 'null') {
    return origin === null && referer === null;
  }
  const allowed = new Set<string>();
  if (canonicalOrigin !== null) {
    allowed.add(canonicalOrigin);
  } else {
    const own = requestOrigin(request.url);
    if (own !== null) allowed.add(own);
  }
  return allowed.has(presented);
}
