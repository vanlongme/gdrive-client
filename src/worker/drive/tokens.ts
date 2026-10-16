/**
 * Internal Google credential/token machinery (architecture §5.4–§5.5).
 *
 * The frozen wave-2 contract — `TokenIdentity`, `TokenResult`,
 * `CoordinatorTokenSource.getToken/reportFailure`, `tokenIdentityKey` — is
 * owned by track B in `./types` and imported (re-exported) here, never
 * redefined. This module adds what only the coordinator needs: the RAM token
 * cache, the acquisition single-flight, the canonical vault envelope
 * contexts, concrete admission options and the fetch seam used by local
 * fixtures.
 *
 * Nothing in this module is a public DTO: these types stay server-side.
 */

import type { SecretContext, VaultSecretKind } from '../security/vault';
import type {
  CoordinatorTokenSource,
  TokenIdentity,
  TokenResult,
} from './types';

export type {
  TokenIdentity,
  TokenResult,
  TokenFailureKind,
  CoordinatorTokenSource,
  GetTokenOptions,
} from './types';
export { tokenIdentityKey } from './types';

/** Derived member aliases of the frozen TokenIdentity union (not new types). */
export type OAuthTokenIdentity = Extract<TokenIdentity, { provider: 'google_oauth' }>;
export type ServiceAccountTokenIdentity = Extract<TokenIdentity, { provider: 'service_account' }>;

/** Extra diagnostics the DO attaches to failures (additive, internal only). */
export interface TokenFailureDetail {
  readonly detail?: string;
}

export function tokenOk(accessToken: string, expiresAtMs: number): TokenResult {
  return { ok: true, accessToken, expiresAtMs };
}

export function tokenFail(
  code:
    | 'CREDENTIAL_DISABLED'
    | 'CREDENTIAL_VERSION_CHANGED'
    | 'OAUTH_NEEDS_REAUTH'
    | 'UPSTREAM_AUTH_FAILED'
    | 'UPSTREAM_UNAVAILABLE'
    | 'COOLDOWN',
  options?: { retryAfterMs?: number; detail?: string },
): TokenResult & TokenFailureDetail {
  return {
    ok: false,
    code,
    ...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options?.detail === undefined ? {} : { detail: options.detail }),
  };
}

/** Failure report a caller may send back to the coordinator (frozen info shape). */
export type UpstreamFailureReport = Parameters<CoordinatorTokenSource['reportFailure']>[1];

// ---------------------------------------------------------------------------
// Scope normalization helper (dedupe/trim; callers pass normalized lists).
// ---------------------------------------------------------------------------

export function normalizeScopes(scopes: readonly string[]): string[] {
  return Array.from(
    new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0)),
  ).sort();
}

// ---------------------------------------------------------------------------
// RAM-only token cache with expiry safety margin.
// ---------------------------------------------------------------------------

export interface CachedGrant {
  readonly accessToken: string;
  /** Unix-ms instant the upstream token stops being usable. */
  readonly expiresAtMs: number;
}

export const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;
const TOKEN_CACHE_MAX_ENTRIES = 256;

export class TokenCache {
  private readonly entries = new Map<string, CachedGrant>();

  constructor(
    private readonly marginMs: number = TOKEN_EXPIRY_SAFETY_MARGIN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns a grant only while it is still valid beyond the safety margin. */
  get(key: string): CachedGrant | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs - this.marginMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Caches a grant; grants already inside the safety margin are not stored.
   * Oldest-inserted entries are evicted first once the cap is reached.
   */
  set(key: string, grant: CachedGrant): void {
    if (grant.expiresAtMs - this.marginMs <= this.now()) return;
    if (!this.entries.has(key) && this.entries.size >= TOKEN_CACHE_MAX_ENTRIES) {
      this.evictExpired();
      if (this.entries.size >= TOKEN_CACHE_MAX_ENTRIES) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, grant);
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  private evictExpired(): void {
    const cutoff = this.now() + this.marginMs;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= cutoff) this.entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Single-flight: one upstream acquisition per identity key at a time.
// ---------------------------------------------------------------------------

export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const promise = (async () => fn())().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }
}

// ---------------------------------------------------------------------------
// Vault envelope contexts. AAD binds provider/record/project/kind; these
// builders are the single convention used when sealing (OAuth connect,
// credential import) and when opening (coordinator token acquisition).
// ---------------------------------------------------------------------------

/** Fixed HKDF key id for the credential vault of this deployment. */
export const VAULT_KEY_ID = 'v1';

export function oauthClientSecretContext(
  oauthClientRecordId: string,
  projectId: string,
): SecretContext<'oauth-client-secret'> {
  return {
    provider: 'google-oauth',
    recordId: oauthClientRecordId,
    projectId,
    kind: 'oauth-client-secret',
  };
}

export function oauthRefreshTokenContext(
  connectionId: string,
  projectId: string,
): SecretContext<'oauth-refresh-token'> {
  return {
    provider: 'google-oauth',
    recordId: connectionId,
    projectId,
    kind: 'oauth-refresh-token',
  };
}

export function serviceAccountKeyContext(
  serviceAccountId: string,
  projectId: string,
): SecretContext<'service-account-key'> {
  return {
    provider: 'service-account',
    recordId: serviceAccountId,
    projectId,
    kind: 'service-account-key',
  };
}

export type OAuthPkceVerifierKind = 'oauth-pkce-verifier';

export function oauthPkceVerifierContext(
  transactionId: string,
  projectId: string,
): SecretContext<OAuthPkceVerifierKind> {
  return {
    provider: 'google-oauth',
    recordId: transactionId,
    projectId,
    kind: 'oauth-pkce-verifier',
  };
}

export type { VaultSecretKind };

// ---------------------------------------------------------------------------
// Fetch seam. Google endpoints are fixed by the endpoint modules; tests
// substitute the fetch implementation through this override rather than
// widening the URL surface.
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchOverride: FetchLike | undefined;

/** Test-only seam; production code never calls this. */
export function setGoogleFetchForTests(fetchImpl: FetchLike | undefined): void {
  fetchOverride = fetchImpl;
}

export function resolveGoogleFetch(): FetchLike {
  return fetchOverride ?? fetch;
}
