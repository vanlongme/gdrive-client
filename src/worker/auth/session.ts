/**
 * Server-only session resolution and authorization helpers (T03 / wave-2
 * track A). Frozen contract (coordinator decision, wave-2 ledger):
 *
 *   requireAdmin(request, env): Promise<{ userId: string; sessionId: string }>
 *
 * throws the exported AuthError. `AuthError.status` is 401 | 403 | 503 and
 * `code` is a shared-contract ApiErrorCode: AUTH_REQUIRED when
 * unauthenticated, FORBIDDEN when the account is disabled or not an admin,
 * and 503 codes (SETUP_REQUIRED / AUTH_UNAVAILABLE /
 * BOOTSTRAP_SECRETS_INVALID) for fail-closed infrastructure states. A caller
 * (e.g. C's OAuth router) may inject this helper in focused tests, but the
 * production wiring uses the real one — callbacks never trust a
 * browser-supplied principal.
 *
 * `AuthSession.user.role` is the application role ('admin' | 'user');
 * `disabled` mirrors the admin-plugin `banned` flag and rejects even when a
 * session cookie still exists.
 */

import type { ApiErrorCode, AppRole } from '../../shared/contracts/index';
import { getBootstrapConfig } from '../security/bootstrap-config';
import { getAuth, readCanonicalOrigin } from './better-auth';
import type { AppAuth } from './better-auth';
import { getRequestHints } from '../timing';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  disabled: boolean;
  /** ISO-8601 account creation time. */
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  /** Better Auth session row id. Used by oauth_transactions binding. */
  sessionId: string;
  /** ISO-8601 session expiry. */
  expiresAt: string;
}

/** Typed auth failure; carries everything needed to build an ApiErrorBody. */
export class AuthError extends Error {
  readonly status: 401 | 403 | 503;
  readonly code: ApiErrorCode;

  constructor(
    status: 401 | 403 | 503,
    code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

interface AuthFactoryEnvWithSecrets {
  DB: D1Database;
  APP_MASTER_KEY?: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * Resolve the caller's Better Auth session into the internal AuthSession
 * view, or null when there is no valid session. Does not check the
 * disabled flag — use requireUser/requireAdmin for enforcement.
 */
export async function getAuthSession(
  request: Request,
  env: AuthFactoryEnvWithSecrets,
): Promise<AuthSession | null> {
  const auth = await getAuth(env, getRequestHints(request)?.canonicalOrigin);
  const result = await auth.api.getSession({ headers: request.headers });
  if (result === null || result === undefined) return null;
  const { user, session } = result;
  const role: AppRole = user.role === 'admin' ? 'admin' : 'user';
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role,
      disabled: user.banned === true,
      createdAt: toIso(user.createdAt),
    },
    sessionId: session.id,
    expiresAt: toIso(session.expiresAt),
  };
}

/**
 * Resolve an authenticated, non-disabled user or throw AuthError. Fails
 * closed on missing bootstrap secrets (503 BOOTSTRAP_SECRETS_INVALID),
 * unreadable/incomplete setup state (503 SETUP_REQUIRED) and internal auth
 * failures (503 AUTH_UNAVAILABLE).
 */
export async function requireUser(
  request: Request,
  env: AuthFactoryEnvWithSecrets,
): Promise<AuthSession> {
  const bootstrap = getBootstrapConfig(env);
  if (!bootstrap.ok) {
    throw new AuthError(
      503,
      'BOOTSTRAP_SECRETS_INVALID',
      'Worker bootstrap secrets are missing or malformed.',
    );
  }
  // A readable canonical origin proves setup completed and settings are
  // intact; auth must fail closed otherwise. The app middleware may have
  // resolved both once already for this request (wave-9 request hints).
  const hints = getRequestHints(request);
  const canonicalOrigin =
    hints === undefined ? await readCanonicalOrigin(env.DB) : hints.canonicalOrigin;
  if (canonicalOrigin === null) {
    throw new AuthError(
      503,
      'SETUP_REQUIRED',
      'Initial setup has not completed.',
    );
  }
  let auth: AuthSession | null;
  if (hints !== undefined) {
    if (hints.session === 'error') {
      throw new AuthError(
        503,
        'AUTH_UNAVAILABLE',
        'Authentication is unavailable.',
      );
    }
    auth = hints.session;
  } else {
    try {
      auth = await getAuthSession(request, env);
    } catch {
      throw new AuthError(
        503,
        'AUTH_UNAVAILABLE',
        'Authentication is unavailable.',
      );
    }
  }
  if (auth === null) {
    throw new AuthError(401, 'AUTH_REQUIRED', 'A valid session is required.');
  }
  if (auth.user.disabled) {
    throw new AuthError(403, 'FORBIDDEN', 'This account is disabled.');
  }
  return auth;
}

/**
 * Frozen contract for C (wave-2 ledger): resolves the caller's admin session
 * or throws AuthError. Returns only the two identifiers a route needs to bind
 * OAuth transactions to (admin user + session row).
 */
export async function requireAdmin(
  request: Request,
  env: AuthFactoryEnvWithSecrets,
): Promise<{ userId: string; sessionId: string }> {
  const auth = await requireUser(request, env);
  if (auth.user.role !== 'admin') {
    throw new AuthError(403, 'FORBIDDEN', 'Administrator role is required.');
  }
  return { userId: auth.user.id, sessionId: auth.sessionId };
}

/**
 * Convenience accessor for the auth instance itself (e.g. forwarding a
 * request into `auth.handler`). Never exposed to the client surface.
 */
export function getAuthInstance(
  env: AuthFactoryEnvWithSecrets,
): Promise<AppAuth> {
  return getAuth(env);
}
