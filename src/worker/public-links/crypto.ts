/**
 * Public-link credentials (wave 8 Phase B2): folder passwords, unlock
 * cookies and slugs.
 *
 * Passwords are PHC-style `pbkdf2-sha256$iter$salt$hash` records derived
 * through WebCrypto. ITERATIONS = 100_000 is the maximum the Workers
 * WebCrypto implementation accepts for PBKDF2 — the work factor is pushed
 * to the platform ceiling because unlock is rare (once per cookie lifetime
 * per link) and the (slug, IP) failure throttle bounds how much CPU an
 * attacker can burn through it.
 *
 * The unlock cookie is a MACed payload, not an encrypted one: it carries no
 * secret, only {v, linkId, credentialVersion, exp}. The HMAC key is
 * HKDF-SHA256-derived from APP_MASTER_KEY under a dedicated info label
 * ('gdrive/v1/purpose/public-link-cookie'), cryptographically separate from
 * the vault/upload-session/auth/media-ticket purposes. The cookie itself is
 * bound to the link row id plus credentialVersion, so a password change
 * invalidates every issued cookie without touching the signing key.
 */

import { base64UrlEncode, randomBase64Url } from '../drive/oauth/crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Password hashing (PBKDF2-SHA256, WebCrypto platform cap = 100_000)
// ---------------------------------------------------------------------------

export const PUBLIC_LINK_PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;
const PASSWORD_FORMAT = 'pbkdf2-sha256';

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const max = Math.max(a.byteLength, b.byteLength);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < max; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password) as Uint8Array<ArrayBuffer>,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations },
    key,
    PBKDF2_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPublicLinkPassword(
  password: string,
  iterations = PUBLIC_LINK_PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2(password, salt, iterations);
  return `${PASSWORD_FORMAT}$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

export async function verifyPublicLinkPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_FORMAT) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PUBLIC_LINK_PBKDF2_ITERATIONS) {
    return false;
  }
  const salt = base64UrlDecode(parts[2]!);
  const expected = base64UrlDecode(parts[3]!);
  if (salt === null || expected === null || expected.byteLength !== PBKDF2_HASH_BYTES) {
    return false;
  }
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqualBytes(actual, expected);
}

function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Unlock cookie (HMAC-SHA256 over a bound payload)
// ---------------------------------------------------------------------------

export const PUBLIC_LINK_COOKIE_NAME = 'gdrive_pub_link';
export const PUBLIC_LINK_COOKIE_MAX_AGE_SECONDS = 12 * 3600;

interface MasterKeyEnv {
  readonly APP_MASTER_KEY?: string;
}

export interface PublicLinkCookiePayload {
  readonly v: 1;
  readonly linkId: string;
  readonly credentialVersion: number;
  /** unix-ms expiry; = min(link expiry, issue + 12h). */
  readonly exp: number;
}

function decodeMasterKey(env: MasterKeyEnv): Uint8Array<ArrayBuffer> {
  const text = env.APP_MASTER_KEY;
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new Error('public-link cookie: APP_MASTER_KEY is missing or malformed');
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (out.byteLength !== 32) {
    throw new Error('public-link cookie: APP_MASTER_KEY is missing or malformed');
  }
  return out as Uint8Array<ArrayBuffer>;
}

let macKeyPromise: Promise<CryptoKey> | undefined;
let macKeySource: string | undefined;

function macKey(env: MasterKeyEnv): Promise<CryptoKey> {
  // Keyed on the env STRING (review L2): the previous version compared a
  // freshly decoded byte array by reference, so the cache never hit.
  const text = env.APP_MASTER_KEY;
  if (macKeyPromise === undefined || macKeySource !== text) {
    macKeySource = text;
    const bytes = decodeMasterKey(env);
    macKeyPromise = (async () => {
      const hkdf = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('gdrive/v1/public-link-cookie/v1'),
          info: encoder.encode('gdrive/v1/purpose/public-link-cookie'),
        },
        hkdf,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
    })();
  }
  return macKeyPromise;
}

export function resetPublicLinkMacKeyForTests(): void {
  macKeyPromise = undefined;
  macKeySource = undefined;
}

export async function sealPublicLinkCookie(
  env: MasterKeyEnv,
  payload: PublicLinkCookiePayload,
): Promise<string> {
  const data = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await macKey(env);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`pl1.${data}`) as Uint8Array<ArrayBuffer>,
  );
  return `${data}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function openPublicLinkCookie(
  env: MasterKeyEnv,
  value: string,
): Promise<PublicLinkCookiePayload | null> {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const data = value.slice(0, dot);
  const presented = base64UrlDecode(value.slice(dot + 1));
  if (presented === null || presented.byteLength !== 32) return null;
  const key = await macKey(env);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    presented as Uint8Array<ArrayBuffer>,
    encoder.encode(`pl1.${data}`) as Uint8Array<ArrayBuffer>,
  );
  if (!ok) return null;
  const decoded = base64UrlDecode(data);
  if (decoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(decoded));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const c = parsed as Record<string, unknown>;
  if (
    c.v !== 1 ||
    typeof c.linkId !== 'string' ||
    c.linkId === '' ||
    typeof c.credentialVersion !== 'number' ||
    !Number.isInteger(c.credentialVersion) ||
    typeof c.exp !== 'number'
  ) {
    return null;
  }
  return {
    v: 1,
    linkId: c.linkId,
    credentialVersion: c.credentialVersion,
    exp: c.exp,
  };
}

/** Cookie header value for an admitted unlock; Path-scoped to the slug. */
export function publicLinkCookieHeader(
  slug: string,
  value: string,
  maxAgeSeconds: number,
): string {
  const age = Math.max(1, Math.floor(maxAgeSeconds));
  return (
    `${PUBLIC_LINK_COOKIE_NAME}=${value}; Path=/api/v1/p/${slug}; ` +
    `HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`
  );
}

/** Extract our cookie from a request Cookie header (no session parsing). */
export function readPublicLinkCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === PUBLIC_LINK_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slugs: ascii-folded folder name (<=32) + '-' + 26 base32 chars (130 bits).
// The name is cosmetic; the suffix is the capability for links without a
// password, so it must not be guessable.
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase ASCII fold: NFD strip diacritics, non-alnum runs -> '-'. */
export function asciiFoldName(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-');
  const clipped = folded.slice(0, 32).replace(/-+$/, '');
  return clipped === '' ? 'folder' : clipped;
}

function base32Suffix(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += BASE32_ALPHABET[byte & 31];
  return out;
}

export function generatePublicLinkSlug(folderName: string): string {
  return `${asciiFoldName(folderName)}-${base32Suffix(26)}`;
}

/** Fresh random id for a link row. */
export function generatePublicLinkId(): string {
  return `pl_${randomBase64Url(24)}`;
}
