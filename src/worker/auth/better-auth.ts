/**
 * Better Auth instance factory (T03 / wave-2 track A).
 *
 * The pinned better-auth@1.7.7 ships a native D1 dialect (detected by the
 * `batch`/`exec`/`prepare` surface), so `database: env.DB` is the real adapter
 * path — no custom schema or password format is invented here.
 *
 * Security posture (architecture §9.1/§9.3):
 * - Public sign-up is disabled; the only credential creation path outside an
 *   existing admin session is the single-owner setup flow in ./setup.ts.
 * - `secret` is an HKDF-SHA256 derivation of APP_MASTER_KEY under the 'auth'
 *   purpose (same convention as ../security/vault.ts); the raw master key is
 *   never handed to the library.
 * - `baseURL` and `trustedOrigins` are exactly the canonical origin pinned at
 *   setup — the request Host/URL is never trusted. Before setup completes the
 *   browser-facing auth routes are unreachable (setup gate in app.ts), and a
 *   placeholder base keeps the server-side adapter usable for the setup flow
 *   itself.
 * - Cookies are always Secure + HttpOnly + SameSite=Lax
 *   (advanced.useSecureCookies). Localhost is a trustworthy origin in real
 *   browsers, so this does not break local dev/E2E — production is never
 *   relaxed.
 * - Rate limiting uses the `rateLimit` table (migration 0002) so limits hold
 *   across isolate lifetimes.
 */

import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';

const textEncoder = new TextEncoder();

/** HKDF key id for the auth-purpose derivation (vault conventions). */
const AUTH_KEY_ID = 'auth-v1';

async function deriveAuthSecret(masterKey: Uint8Array): Promise<string> {
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    masterKey as Uint8Array<ArrayBuffer>,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode(`gdrive/v1/key-id/${AUTH_KEY_ID}`),
      info: textEncoder.encode('gdrive/v1/purpose/auth'),
    },
    hkdfKey,
    256,
  );
  const derived = new Uint8Array(bits);
  let binary = '';
  for (const byte of derived) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface AuthFactoryEnv {
  DB: D1Database;
  APP_MASTER_KEY?: string;
}

/**
 * Placeholder base used only when setup has not pinned a canonical origin
 * yet. It is deliberately unreachable: trustedOrigins resolves to this
 * placeholder, so no browser request can satisfy the CSRF origin check while
 * setup is incomplete (the setup gate also keeps /api/auth unmounted). The
 * server-side adapter calls used by setup do not consult it.
 */
const PRE_SETUP_BASE_URL = 'https://auth.invalid';

/**
 * Build the Better Auth instance bound to the given D1 binding. When
 * `canonicalOrigin` is null the instance is only usable for server-side
 * adapter calls (setup user creation) — browser traffic must not reach it.
 */
export async function createAuth(
  env: AuthFactoryEnv,
  canonicalOrigin: string | null,
) {
  if (env.APP_MASTER_KEY === undefined || env.APP_MASTER_KEY === '') {
    throw new Error('APP_MASTER_KEY is required to build the auth instance');
  }
  const secret = await deriveAuthSecret(
    Uint8Array.from(atob(env.APP_MASTER_KEY), (c) => c.charCodeAt(0)),
  );
  return betterAuth({
    appName: 'gdrive-client',
    baseURL: canonicalOrigin ?? PRE_SETUP_BASE_URL,
    basePath: '/api/auth',
    secret,
    database: env.DB,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    account: { accountLinking: { enabled: false } },
    plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] })],
    // Only the setup-pinned canonical origin is trusted. The request URL/Host
    // is never consulted for CSRF or redirect validation.
    trustedOrigins: canonicalOrigin === null ? [] : [canonicalOrigin],
    rateLimit: { enabled: true, storage: 'database' },
    advanced: {
      cookiePrefix: 'gdrive',
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    telemetry: { enabled: false },
  });
}

export type AppAuth = Awaited<ReturnType<typeof createAuth>>;

/**
 * Read the pinned canonical origin from app_settings. Returns null before
 * setup completes (or when the settings row is missing/corrupt — callers must
 * treat null as fail-closed for browser-facing auth routes).
 */
export async function readCanonicalOrigin(
  db: D1Database,
): Promise<string | null> {
  try {
    const row = await db
      .prepare(
        "SELECT canonical_origin FROM app_settings WHERE id = 1 AND setup_state = 'complete'",
      )
      .first<{ canonical_origin: string | null }>();
    return row?.canonical_origin ?? null;
  } catch {
    return null;
  }
}

const authCache = new WeakMap<AuthFactoryEnv, Map<string, Promise<AppAuth>>>();

/**
 * Memoized auth instance per env + canonical origin. A fresh read of the
 * origin happens on every call, so post-setup requests build a correctly
 * pinned instance even inside a warm isolate that served pre-setup traffic.
 */
export function getAuth(env: AuthFactoryEnv): Promise<AppAuth> {
  return (async () => {
    const canonicalOrigin = await readCanonicalOrigin(env.DB);
    let byOrigin = authCache.get(env);
    if (byOrigin === undefined) {
      byOrigin = new Map();
      authCache.set(env, byOrigin);
    }
    const key = canonicalOrigin ?? '';
    let instance = byOrigin.get(key);
    if (instance === undefined) {
      instance = createAuth(env, canonicalOrigin);
      byOrigin.set(key, instance);
    }
    return instance;
  })();
}
