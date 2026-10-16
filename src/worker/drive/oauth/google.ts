/**
 * Typed clients for the fixed Google auth endpoints used by the admin OAuth
 * lifecycle and coordinator token acquisition (architecture §5.5).
 *
 * Endpoint URLs are compile-time constants: nothing in this module accepts a
 * caller-supplied URL, and the SA JWT audience is pinned to the documented
 * token endpoint regardless of whatever `token_uri` a key JSON carries.
 * Every credential-bearing request forbids redirects (`redirect: 'manual'`,
 * plus an explicit 3xx rejection) so a bearer/assertion can never be
 * forwarded to an upstream-chosen destination. workerd rejects
 * `redirect: 'error'` with a TypeError, so `manual` + `redirectRejection` is
 * the edge-supported equivalent. Fetch is injected so tests
 * substitute a local fixture transport.
 */

import { base64UrlEncode } from './crypto';
import type { FetchLike } from '../tokens';

export const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_ABOUT_ENDPOINT = 'https://www.googleapis.com/drive/v3/about';

/** Operator catalog/write scope chosen by the architecture (§5.2). */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
/** The only scope a service account may request (§5.5). */
export const SA_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const SA_TOKEN_LIFETIME_SEC = 3600;

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Result plumbing shared by every endpoint call. No failure path throws and
// none manufactures fields: malformed upstream bodies produce the typed
// 'malformed_response' kind.
// ---------------------------------------------------------------------------

export type GoogleEndpointResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: 'oauth_error';
      readonly error: string;
      readonly description?: string;
      readonly status: number;
    }
  | { readonly ok: false; readonly kind: 'http_error'; readonly status: number }
  | { readonly ok: false; readonly kind: 'redirect'; readonly status: number }
  | { readonly ok: false; readonly kind: 'malformed_response'; readonly status?: number }
  | { readonly ok: false; readonly kind: 'transport_error' };

function oauthError<T>(
  status: number,
  error: string,
  description?: string,
): GoogleEndpointResult<T> {
  return { ok: false, kind: 'oauth_error', error, description, status };
}

async function parseJsonObject(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** A 3xx on a credential-bearing call is a typed rejection, never followed. */
function redirectRejection<T>(res: Response): GoogleEndpointResult<T> | undefined {
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, kind: 'redirect', status: res.status };
  }
  return undefined;
}

async function postForm<T>(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
  interpret: (body: Record<string, unknown>) => T | undefined,
): Promise<GoogleEndpointResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      redirect: 'manual',
    });
  } catch {
    return { ok: false, kind: 'transport_error' };
  }
  const redirect = redirectRejection<T>(res);
  if (redirect !== undefined) return redirect;
  const body = await parseJsonObject(res);
  if (body !== undefined && typeof body.error === 'string') {
    return oauthError(
      res.status,
      body.error,
      typeof body.error_description === 'string' ? body.error_description : undefined,
    );
  }
  if (!res.ok) return { ok: false, kind: 'http_error', status: res.status };
  if (body === undefined) {
    return { ok: false, kind: 'malformed_response', status: res.status };
  }
  const value = interpret(body);
  if (value === undefined) {
    return { ok: false, kind: 'malformed_response', status: res.status };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Authorization URL (step 1 of the admin connect/reconnect flow).
// ---------------------------------------------------------------------------

export interface AuthorizationUrlInput {
  readonly clientId: string;
  /** Exact callback URL; stored on the transaction and verified byte-exact. */
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
}

export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scopes.join(' '));
  // Offline access + explicit consent gives Google the best chance to return
  // a refresh token on both first connect and deliberate re-consent.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint grants.
// ---------------------------------------------------------------------------

export interface GoogleTokenGrant {
  readonly accessToken: string;
  readonly expiresInSec: number;
  readonly refreshToken?: string;
  readonly grantedScopes: readonly string[];
  readonly tokenType: string;
}

function interpretTokenGrant(body: Record<string, unknown>): GoogleTokenGrant | undefined {
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    return undefined;
  }
  // expires_in must be a real number — never manufacture a lifetime.
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in)) {
    return undefined;
  }
  return {
    accessToken: body.access_token,
    expiresInSec: Math.max(0, Math.floor(body.expires_in)),
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token.length > 0
        ? body.refresh_token
        : undefined,
    grantedScopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
    tokenType: typeof body.token_type === 'string' ? body.token_type : '',
  };
}

export interface AuthorizationCodeExchangeInput {
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly codeVerifier: string;
}

export function exchangeAuthorizationCode(
  input: AuthorizationCodeExchangeInput,
  fetchImpl: FetchLike,
): Promise<GoogleEndpointResult<GoogleTokenGrant>> {
  return postForm(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  }, interpretTokenGrant);
}

export interface RefreshGrantInput {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export function refreshAccessToken(
  input: RefreshGrantInput,
  fetchImpl: FetchLike,
): Promise<GoogleEndpointResult<GoogleTokenGrant>> {
  return postForm(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  }, interpretTokenGrant);
}

// ---------------------------------------------------------------------------
// Service account JWT bearer grant (read-only, no impersonation).
// ---------------------------------------------------------------------------

/** Thrown when anything but drive.readonly reaches the SA signing boundary. */
export class ServiceAccountScopeError extends Error {
  constructor() {
    super('service account JWTs may only request drive.readonly scope');
    this.name = 'ServiceAccountScopeError';
  }
}

export interface ServiceAccountKeyMaterial {
  readonly clientEmail: string;
  readonly privateKeyPem: string;
  /** Google's key id; carried into the JWT header when present. */
  readonly privateKeyId?: string;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error('service account private_key is not valid base64 PEM');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Sign an RS256 JWT for the jwt-bearer grant. Two hard rules at this
 * boundary: the claim set has no `sub` (service accounts never impersonate
 * a user, §5.1) and the requested scope set is exactly drive.readonly — the
 * check lives here, not in callers, so no code path can mint a broader
 * assertion.
 */
export async function signServiceAccountJwt(
  key: ServiceAccountKeyMaterial,
  scopes: readonly string[],
  now: () => number = Date.now,
): Promise<string> {
  const normalized = Array.from(
    new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0)),
  );
  if (normalized.length === 0 || normalized.some((scope) => scope !== SA_READ_SCOPE)) {
    throw new ServiceAccountScopeError();
  }
  const issuedAt = Math.floor(now() / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.privateKeyId !== undefined && key.privateKeyId.length > 0) {
    header.kid = key.privateKeyId;
  }
  const claims = {
    iss: key.clientEmail,
    scope: normalized.join(' '),
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + SA_TOKEN_LIFETIME_SEC,
  };
  const signingInput = `${base64UrlEncode(textEncoder.encode(JSON.stringify(header)))}.${base64UrlEncode(
    textEncoder.encode(JSON.stringify(claims)),
  )}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.privateKeyPem) as Uint8Array<ArrayBuffer>,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    textEncoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export function exchangeServiceAccountJwt(
  assertion: string,
  fetchImpl: FetchLike,
): Promise<GoogleEndpointResult<GoogleTokenGrant>> {
  return postForm(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
    grant_type: JWT_BEARER_GRANT,
    assertion,
  }, interpretTokenGrant);
}

// ---------------------------------------------------------------------------
// about.get — resolves the Drive principal (permissionId) for a connection.
// ---------------------------------------------------------------------------

export interface AboutUser {
  readonly permissionId: string;
  readonly emailAddress?: string;
  readonly displayName?: string;
}

export async function fetchAboutUser(
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<GoogleEndpointResult<AboutUser>> {
  const url = new URL(GOOGLE_ABOUT_ENDPOINT);
  url.searchParams.set('fields', 'user');
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
    });
  } catch {
    return { ok: false, kind: 'transport_error' };
  }
  const redirect = redirectRejection<AboutUser>(res);
  if (redirect !== undefined) return redirect;
  const body = await parseJsonObject(res);
  if (body !== undefined && typeof body.error === 'object' && body.error !== null) {
    const message = (body.error as Record<string, unknown>).message;
    return oauthError(
      res.status,
      'google_api_error',
      typeof message === 'string' ? message : undefined,
    );
  }
  if (!res.ok) return { ok: false, kind: 'http_error', status: res.status };
  if (body === undefined) {
    return { ok: false, kind: 'malformed_response', status: res.status };
  }
  const user = body.user as Record<string, unknown> | null | undefined;
  if (typeof user !== 'object' || user === null) {
    return { ok: false, kind: 'malformed_response', status: res.status };
  }
  if (typeof user.permissionId !== 'string' || user.permissionId.length === 0) {
    return oauthError(res.status, 'missing_permission_id');
  }
  return {
    ok: true,
    value: {
      permissionId: user.permissionId,
      emailAddress: typeof user.emailAddress === 'string' ? user.emailAddress : undefined,
      displayName: typeof user.displayName === 'string' ? user.displayName : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Token revocation — only ever invoked by an explicit admin action.
// The token travels in the RFC 7009 form body, never the URL.
// ---------------------------------------------------------------------------

export async function revokeToken(
  token: string,
  fetchImpl: FetchLike,
): Promise<GoogleEndpointResult<true>> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'manual',
    });
  } catch {
    return { ok: false, kind: 'transport_error' };
  }
  const redirect = redirectRejection<true>(res);
  if (redirect !== undefined) return redirect;
  if (!res.ok) {
    const body = await parseJsonObject(res);
    if (body !== undefined && typeof body.error === 'string') {
      return oauthError(res.status, body.error);
    }
    return { ok: false, kind: 'http_error', status: res.status };
  }
  return { ok: true, value: true };
}
