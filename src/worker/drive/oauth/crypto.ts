/**
 * Small Web Crypto helpers for the OAuth transaction lifecycle: opaque
 * one-use state values, their storage hash and PKCE S256 challenges.
 * Everything here is deterministic given its input; nothing is logged.
 */

const textEncoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(text));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Storage hash for OAuth state values: D1 rows never hold the raw state. */
export async function hashOAuthState(state: string): Promise<string> {
  return sha256Base64Url(`gdrive/oauth-state/v1:${state}`);
}

/**
 * PKCE verifier: 64 url-safe characters (48 random bytes), inside the
 * RFC 7636 length window. The S256 challenge goes to Google; the verifier
 * stays sealed server-side until code exchange.
 */
export function generatePkceVerifier(): string {
  return randomBase64Url(48);
}

export async function pkceS256Challenge(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}
