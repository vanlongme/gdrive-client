/**
 * /api/auth/* wiring (T03 / wave-2 track A).
 *
 * Requests are forwarded to the real Better Auth handler, then every JSON
 * response passes through a credential scrub: raw session tokens and any
 * other credential-shaped fields are removed before the body reaches the
 * browser (wave-2 contract: session/user views contain no credentials; the
 * HttpOnly Set-Cookie is the credential channel and is preserved verbatim).
 * GET /api/auth/get-session therefore returns null or a safe
 * {session,user} projection — never a raw token.
 */

import { getAuth } from './better-auth';

interface AuthRouteEnv {
  DB: D1Database;
  APP_MASTER_KEY?: string;
}

/**
 * Credential material that must never leave the Worker inside a JSON DTO.
 * Anything else Better Auth returns (user fields, session expiry, metadata)
 * is passed through so clients keep the documented surface.
 */
const CREDENTIAL_KEYS = new Set([
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'password',
]);

function scrubCredentials(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) scrubCredentials(item);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (CREDENTIAL_KEYS.has(key)) {
        delete (value as Record<string, unknown>)[key];
      } else {
        scrubCredentials(nested);
      }
    }
  }
}

/**
 * Rebuild a JSON response with credential fields removed. Status, statusText
 * and all headers — including every Set-Cookie — are preserved; only the body
 * changes, so content-length is recomputed by the runtime.
 */
async function sanitizeAuthResponse(res: Response): Promise<Response> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return res;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return res;
  }
  scrubCredentials(body);
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key !== 'content-length' && key !== 'set-cookie' && key !== 'content-type') {
      headers.set(key, value);
    }
  });
  for (const cookie of res.headers.getSetCookie()) {
    headers.append('set-cookie', cookie);
  }
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Forward an /api/auth/* request to Better Auth. The caller (app.ts) must
 * have already enforced bootstrap secrets, setup completion and the API
 * gates — Better Auth's own Origin/Fetch-Metadata checks bound CSRF to the
 * canonical origin inside the handler.
 */
export async function handleAuthRequest(
  request: Request,
  env: AuthRouteEnv,
): Promise<Response> {
  const auth = await getAuth(env);
  const res = await auth.handler(request);
  return sanitizeAuthResponse(res);
}
