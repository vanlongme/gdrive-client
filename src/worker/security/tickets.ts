/**
 * Scoped media tickets (architecture §9.3, plan T06; wave-3 track B).
 *
 * A ticket is a short-lived, app-level bearer capability that lets an
 * external player issue GET/HEAD against one bound resource — a file (and
 * optionally one pinned revision) or a media package generation. It is never
 * a Google token and carries no credential material.
 *
 * Tickets are sealed envelopes: the payload (scope, principal, iat/exp) is
 * AES-256-GCM encrypted under the HKDF 'media-ticket' purpose, with the
 * resource identity bound into the AAD context — a ticket minted for one
 * file cannot even be decrypted under another file's context. The token
 * itself is `mtk_` + base64url(envelope JSON).
 *
 * Sealing rides the vault keyring (W6-F finding 2, same rule as the
 * upload-session session-URI envelopes): while APP_MASTER_KEY_NEXT is
 * staged, new tickets seal under it and carry its fingerprint keyId; opens
 * select the key by the envelope's own keyId so tickets minted before a
 * rotation keep verifying while the sealing key stays configured, and fail
 * closed once it is absent.
 *
 * Validation always rechecks the underlying authority: the payload records
 * which principal (app user, share link or public mount visibility) the
 * ticket was minted under, and the route layer re-verifies that principal
 * — user account/grant state, share row revocation/expiry/policy version —
 * on every request, so a revoke takes effect before the ticket expires.
 */

import {
  MEDIA_TICKET_DEFAULT_TTL_SECONDS,
  MEDIA_TICKET_MAX_TTL_SECONDS,
} from '../../shared/contracts/media';
import {
  createSecretKeyring,
  decodeEnvelope,
  encodeEnvelope,
  VaultError,
  type KeyringBox,
  type KeyringEnv,
} from './vault';

export {
  MEDIA_TICKET_DEFAULT_TTL_SECONDS,
  MEDIA_TICKET_MAX_TTL_SECONDS,
};

export const MEDIA_TICKET_TOKEN_PREFIX = 'mtk_';

/** Non-admin callers may not extend a ticket past the default TTL. */
export const MEDIA_TICKET_USER_MAX_TTL_SECONDS = MEDIA_TICKET_DEFAULT_TTL_SECONDS;

/** Resource a ticket admits GET/HEAD for. */
export type MediaTicketScope =
  | {
      readonly kind: 'file';
      readonly mountId: string;
      readonly fileId: string;
      /** When set, the ticket admits only mode=revision with this id. */
      readonly revisionId?: string;
    }
  | {
      readonly kind: 'package';
      readonly mountId: string;
      readonly packageId: string;
      readonly indexGeneration?: number;
    };

/** The authority the ticket was minted under; rechecked at every use. */
export type TicketPrincipal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'share'; readonly shareId: string }
  | { readonly kind: 'public' };

export interface MediaTicketPayload {
  readonly v: 1;
  readonly scope: MediaTicketScope;
  readonly principal: TicketPrincipal;
  readonly iat: number;
  readonly exp: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/**
 * AAD context binding: the ticket can only be opened under the exact
 * resource identity (mount + file/package) it was minted for. `kind`
 * namespaces tickets inside the media-ticket purpose.
 */
function ticketContext(scope: MediaTicketScope): {
  provider: string;
  recordId: string;
  projectId: string;
  kind: string;
} {
  const recordId =
    scope.kind === 'file'
      ? `ticket/file/${scope.mountId}/${scope.fileId}`
      : `ticket/package/${scope.mountId}/${scope.packageId}`;
  return {
    provider: 'gdrive-app',
    recordId,
    projectId: scope.mountId,
    kind: 'media-ticket',
  };
}

export interface MintTicketInput {
  readonly scope: MediaTicketScope;
  readonly principal: TicketPrincipal;
  /** Absolute cap is enforced by the caller against the actor class. */
  readonly ttlSeconds: number;
  readonly now: number;
}

export interface MintedTicket {
  readonly token: string;
  readonly expiresAtMs: number;
}

function ticketBox(env: KeyringEnv): KeyringBox<string> {
  return createSecretKeyring<string>(env, 'media-ticket');
}

export async function mintMediaTicket(
  env: KeyringEnv,
  input: MintTicketInput,
): Promise<MintedTicket> {
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds > MEDIA_TICKET_MAX_TTL_SECONDS
  ) {
    throw new RangeError('ticket ttlSeconds outside the allowed window');
  }
  const box = ticketBox(env);
  const payload: MediaTicketPayload = {
    v: 1,
    scope: input.scope,
    principal: input.principal,
    iat: input.now,
    exp: input.now + input.ttlSeconds * 1000,
  };
  const envelope = await box.sealSecret(
    textEncoder.encode(JSON.stringify(payload)),
    ticketContext(input.scope),
  );
  return {
    token: `${MEDIA_TICKET_TOKEN_PREFIX}${base64UrlEncode(textEncoder.encode(encodeEnvelope(envelope)))}`,
    expiresAtMs: payload.exp,
  };
}

export type TicketVerification =
  | { readonly ok: true; readonly payload: MediaTicketPayload }
  | { readonly ok: false };

function isScopeShape(scope: unknown): scope is MediaTicketScope {
  if (typeof scope !== 'object' || scope === null) return false;
  const candidate = scope as Record<string, unknown>;
  if (typeof candidate.mountId !== 'string' || candidate.mountId === '') {
    return false;
  }
  if (candidate.kind === 'file') {
    return (
      typeof candidate.fileId === 'string' &&
      candidate.fileId !== '' &&
      (candidate.revisionId === undefined ||
        typeof candidate.revisionId === 'string')
    );
  }
  if (candidate.kind === 'package') {
    return (
      typeof candidate.packageId === 'string' &&
      candidate.packageId !== '' &&
      (candidate.indexGeneration === undefined ||
        (typeof candidate.indexGeneration === 'number' &&
          Number.isInteger(candidate.indexGeneration)))
    );
  }
  return false;
}

function isPrincipalShape(principal: unknown): principal is TicketPrincipal {
  if (typeof principal !== 'object' || principal === null) return false;
  const candidate = principal as Record<string, unknown>;
  if (candidate.kind === 'user') {
    return typeof candidate.userId === 'string' && candidate.userId !== '';
  }
  if (candidate.kind === 'share') {
    return typeof candidate.shareId === 'string' && candidate.shareId !== '';
  }
  return candidate.kind === 'public';
}

/**
 * Open and validate a ticket for an expected resource. `resource` names the
 * mount + file/package from the request route — the AAD check alone proves
 * the ticket belongs to it; the payload scope is additionally compared for
 * the revision/generation pin. Any structural, cryptographic or expiry
 * failure is `ok: false` — callers map it to a closed auth error.
 */
export async function verifyMediaTicket(
  env: KeyringEnv,
  token: string,
  resource:
    | { readonly kind: 'file'; readonly mountId: string; readonly fileId: string }
    | {
        readonly kind: 'package';
        readonly mountId: string;
        readonly packageId: string;
      },
  now: number,
): Promise<TicketVerification> {
  if (!token.startsWith(MEDIA_TICKET_TOKEN_PREFIX)) return { ok: false };
  const encoded = base64UrlDecode(token.slice(MEDIA_TICKET_TOKEN_PREFIX.length));
  if (encoded === null) return { ok: false };
  let envelope;
  try {
    envelope = decodeEnvelope(textDecoder.decode(encoded));
  } catch {
    return { ok: false };
  }
  const contextScope: MediaTicketScope =
    resource.kind === 'file'
      ? { kind: 'file', mountId: resource.mountId, fileId: resource.fileId }
      : {
          kind: 'package',
          mountId: resource.mountId,
          packageId: resource.packageId,
        };
  let plaintext: Uint8Array;
  try {
    plaintext = await ticketBox(env).openSecret(envelope, ticketContext(contextScope));
  } catch (err) {
    // Misconfiguration (absent/invalid master key) is a bootstrap failure,
    // not a ticket verdict: propagate it so callers keep the closed 503.
    if (err instanceof VaultError && err.code === 'VAULT_KEY_INVALID') {
      throw err;
    }
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(plaintext));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false };
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    typeof candidate.iat !== 'number' ||
    typeof candidate.exp !== 'number' ||
    !isScopeShape(candidate.scope) ||
    !isPrincipalShape(candidate.principal)
  ) {
    return { ok: false };
  }
  const payload = candidate as unknown as MediaTicketPayload;
  // Route params prove the resource; the payload must agree on every field.
  const scope = payload.scope;
  const scopeMatches =
    scope.kind === 'file' && resource.kind === 'file'
      ? scope.mountId === resource.mountId && scope.fileId === resource.fileId
      : scope.kind === 'package' && resource.kind === 'package'
        ? scope.mountId === resource.mountId &&
          scope.packageId === resource.packageId
        : false;
  if (!scopeMatches) return { ok: false };
  if (payload.exp <= now) return { ok: false };
  return { ok: true, payload };
}

/**
 * Whether the ticket's scope admits the requested content mode. A ticket
 * without a revision pin admits current content and any revision of the
 * file; a pinned ticket admits only that exact revision read.
 */
export function ticketScopeCovers(
  scope: MediaTicketScope,
  target: { revisionId?: string; packageGeneration?: number },
): boolean {
  if (scope.kind === 'file') {
    if (scope.revisionId === undefined) return true;
    return target.revisionId === scope.revisionId;
  }
  if (scope.indexGeneration === undefined) return true;
  return target.packageGeneration === scope.indexGeneration;
}
