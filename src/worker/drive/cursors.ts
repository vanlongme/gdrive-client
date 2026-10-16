/**
 * Signed AND encrypted pagination cursors for the catalog surface
 * (architecture §9.4, wave-3 contract + coordinator review 2026-10-12).
 *
 * A cursor is an opaque token: `v1.<base64url(nonce || aes256gcm(json))>`.
 * The payload is encrypted, not merely signed — it carries internal identity
 * (catalog connection, OAuth client, principal, session-bound actor key) and
 * the upstream page token, none of which may be readable by clients.
 *
 * The key is HKDF-SHA256(APP_MASTER_KEY, salt 'gdrive-cursor-v1', info
 * 'catalog-cursor') — a purpose-separated derivation that can never open a
 * vault/upload/auth envelope or vice versa. A fresh random nonce per cursor
 * and GCM authentication give confidentiality plus tamper evidence.
 *
 * Binding (checked on every continuation): actor key including the app
 * session, the mount, the catalog connection AND OAuth client versions plus
 * principal, the mount policy version and the exact query spec. Any change
 * forces a clean pagination restart; an expired cursor does the same.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Signed cursor lifetime (spec: expiry forces a bounded restart). */
export const CURSOR_TTL_MS = 15 * 60 * 1000;
const MAX_CURSOR_CHARS = 8192;
const CURSOR_VERSION = 'v1';
const HKDF_SALT = 'gdrive-cursor-v1';
const HKDF_INFO = 'catalog-cursor';
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BITS = 128;

export type CursorErrorReason = 'malformed' | 'signature' | 'expired';

/** Typed cursor failure; never leaks payload contents. */
export class CursorError extends Error {
  readonly reason: CursorErrorReason;
  constructor(reason: CursorErrorReason, message: string) {
    super(message);
    this.name = 'CursorError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Subject — the binding a cursor proves for every page of one pagination run.
// ---------------------------------------------------------------------------

/** Direct-children listing spec. */
export interface ChildrenCursorSpec {
  readonly folderId: string;
}

/** Search spec: q text, scope, and the folder id when scope=folder. */
export interface SearchCursorSpec {
  readonly q: string;
  readonly scope: 'folder' | 'drive';
  readonly folderId?: string;
}

export type CursorSpec = ChildrenCursorSpec | SearchCursorSpec;

/**
 * The catalog-writer identity bound into the cursor: connection AND OAuth
 * client versions plus the Google principal. A reconnect or client change
 * restarts pagination — a stale pageToken never crosses identities.
 */
export interface CursorWriterBinding {
  readonly connectionId: string;
  readonly connectionVersion: number;
  readonly oauthClientId: string;
  readonly oauthClientVersion: number;
  readonly principalId: string;
}

export interface CursorSubject {
  readonly kind: 'children' | 'search';
  readonly mountId: string;
  /** actorKey() from mounts.ts — user binding includes the app session. */
  readonly actorKey: string;
  readonly writer: CursorWriterBinding;
  readonly policyVersion: number;
  readonly spec: CursorSpec;
}

interface CursorPayload extends CursorSubject {
  readonly pt: string;
  readonly iat: number;
  readonly exp: number;
}

// ---------------------------------------------------------------------------
// Key derivation + base64url helpers (HKDF purposes stay distinct — this key
// can never validate a vault/upload/auth envelope or vice versa).
// ---------------------------------------------------------------------------

const keyCache = new Map<string, Promise<CryptoKey>>();

function decodeMasterKey(masterKeyBase64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(masterKeyBase64);
  } catch {
    throw new CursorError('malformed', 'cursor key material is not valid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength !== 32) {
    throw new CursorError('malformed', 'cursor key material must decode to 32 bytes');
  }
  return bytes;
}

function cursorKey(masterKeyBase64: string): Promise<CryptoKey> {
  let cached = keyCache.get(masterKeyBase64);
  if (cached === undefined) {
    cached = (async () => {
      const master = decodeMasterKey(masterKeyBase64);
      const hkdfKey = await crypto.subtle.importKey(
        'raw',
        master as Uint8Array<ArrayBuffer>,
        'HKDF',
        false,
        ['deriveKey'],
      );
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode(HKDF_SALT),
          info: encoder.encode(HKDF_INFO),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    keyCache.set(masterKeyBase64, cached);
  }
  return cached;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new CursorError('malformed', 'cursor is not valid base64url');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Seal / open
// ---------------------------------------------------------------------------

/**
 * Mint the cursor for the next page of a pagination run. `pageToken` is the
 * raw upstream token — it is encrypted, never returned bare.
 */
export async function signCursor(
  subject: CursorSubject,
  pageToken: string,
  masterKeyBase64: string,
  nowMs: number,
): Promise<string> {
  const payload: CursorPayload = {
    ...subject,
    pt: pageToken,
    iat: nowMs,
    exp: nowMs + CURSOR_TTL_MS,
  };
  const body = encoder.encode(JSON.stringify(payload));
  const key = await cursorKey(masterKeyBase64);
  const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as Uint8Array<ArrayBuffer>,
      additionalData: encoder.encode(CURSOR_VERSION),
      tagLength: GCM_TAG_BITS,
    },
    key,
    body as Uint8Array<ArrayBuffer>,
  );
  const blob = new Uint8Array(GCM_NONCE_BYTES + sealed.byteLength);
  blob.set(nonce, 0);
  blob.set(new Uint8Array(sealed), GCM_NONCE_BYTES);
  return `${CURSOR_VERSION}.${base64UrlEncode(blob)}`;
}

export interface OpenedCursor {
  readonly subject: CursorSubject;
  readonly pageToken: string;
  readonly expiresAtMs: number;
}

function subjectMatches(a: CursorSubject, b: CursorSubject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isWriterBinding(value: unknown): value is CursorWriterBinding {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.connectionId === 'string' &&
    typeof w.connectionVersion === 'number' &&
    typeof w.oauthClientId === 'string' &&
    typeof w.oauthClientVersion === 'number' &&
    typeof w.principalId === 'string'
  );
}

/**
 * Open and verify a presented cursor: shape, AEAD integrity and expiry. When
 * `expected` is supplied, the cursor's subject must deep-equal it — a cursor
 * minted for another actor/session/mount/connection/client/policy/query
 * never resolves. Throws CursorError for every failure class.
 */
export async function openCursor(
  token: string,
  masterKeyBase64: string,
  nowMs: number,
  expected?: CursorSubject,
): Promise<OpenedCursor> {
  if (token.length === 0 || token.length > MAX_CURSOR_CHARS) {
    throw new CursorError('malformed', 'cursor length is out of bounds');
  }
  const parts = token.split('.');
  const sealed = parts[1];
  if (parts.length !== 2 || parts[0] !== CURSOR_VERSION || sealed === undefined || sealed === '') {
    throw new CursorError('malformed', 'cursor is not in the v1 sealed form');
  }
  const blob = base64UrlDecode(sealed);
  if (blob.byteLength <= GCM_NONCE_BYTES + 16) {
    throw new CursorError('malformed', 'cursor payload is too short');
  }
  const nonce = blob.slice(0, GCM_NONCE_BYTES);
  const ciphertext = blob.slice(GCM_NONCE_BYTES);
  const key = await cursorKey(masterKeyBase64);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce as Uint8Array<ArrayBuffer>,
        additionalData: encoder.encode(CURSOR_VERSION),
        tagLength: GCM_TAG_BITS,
      },
      key,
      ciphertext as Uint8Array<ArrayBuffer>,
    );
  } catch {
    throw new CursorError('signature', 'cursor failed authenticated decryption');
  }
  let payload: CursorPayload;
  try {
    payload = JSON.parse(decoder.decode(plain)) as CursorPayload;
  } catch {
    throw new CursorError('malformed', 'cursor payload is not valid JSON');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    (payload.kind !== 'children' && payload.kind !== 'search') ||
    typeof payload.mountId !== 'string' ||
    typeof payload.actorKey !== 'string' ||
    !isWriterBinding(payload.writer) ||
    typeof payload.policyVersion !== 'number' ||
    typeof payload.pt !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    typeof payload.spec !== 'object' ||
    payload.spec === null
  ) {
    throw new CursorError('malformed', 'cursor payload is missing required fields');
  }
  if (payload.exp <= nowMs || payload.iat > payload.exp) {
    throw new CursorError('expired', 'cursor has expired; restart pagination');
  }
  const subject: CursorSubject = {
    kind: payload.kind,
    mountId: payload.mountId,
    actorKey: payload.actorKey,
    writer: payload.writer,
    policyVersion: payload.policyVersion,
    spec: payload.spec,
  };
  if (expected !== undefined && !subjectMatches(subject, expected)) {
    throw new CursorError(
      'signature',
      'cursor was not minted for this request context',
    );
  }
  return { subject, pageToken: payload.pt, expiresAtMs: payload.exp };
}
