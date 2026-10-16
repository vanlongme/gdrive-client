/**
 * Application-level secret vault (architecture §9.2).
 *
 * Seals SA private material, OAuth client secrets and Google refresh tokens
 * with AES-256-GCM: a fresh random nonce per record, an envelope carrying
 * version + keyId, and AAD bound to provider/recordId/projectId/kind so an
 * envelope cannot be transplanted between providers, records or projects.
 *
 * The raw APP_MASTER_KEY is never used directly: a per-purpose AES key is
 * derived with HKDF-SHA256 (salt binds the keyId, info binds the purpose),
 * so 'vault', 'upload-session', 'auth' and 'media-ticket' envelopes are
 * cryptographically separated even under the same master key.
 *
 * This module keeps no state beyond the derived key promise, never logs
 * secret material, and contains no password handling. It deliberately has
 * no route/auth integration; T03 wires it behind D1 persistence.
 */

const textEncoder = new TextEncoder();

/** Envelope format version written into every sealed record. */
export const VAULT_ENVELOPE_VERSION = 1;

const MASTER_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const GCM_TAG_BITS = 128;
const MAX_KEY_ID_CHARS = 256;
const MAX_CONTEXT_FIELD_CHARS = 512;
const MAX_PLAINTEXT_BYTES = 1024 * 1024;

/** Credential categories the vault is allowed to seal. */
export type VaultSecretKind =
  | 'service-account-key'
  | 'oauth-client-secret'
  | 'oauth-refresh-token';

const VAULT_SECRET_KINDS: readonly VaultSecretKind[] = [
  'service-account-key',
  'oauth-client-secret',
  'oauth-refresh-token',
];

/**
 * HKDF purposes. Each consumer domain derives an independent AES key from
 * the same master key, so a 'vault' box can never open an 'upload-session'
 * envelope (and vice versa).
 */
export type SecretPurpose = 'vault' | 'upload-session' | 'auth' | 'media-ticket';

const SECRET_PURPOSES: readonly SecretPurpose[] = [
  'vault',
  'upload-session',
  'auth',
  'media-ticket',
];

/**
 * Fields bound into AES-GCM AAD. Decrypting with any field different fails
 * closed, which prevents swapping envelopes across providers, credential
 * records or Google projects.
 */
export interface SecretContext<K extends string = string> {
  /** Provider domain, e.g. 'service-account' or 'google-oauth'. */
  readonly provider: string;
  /** Credential/connection/client record ID the secret belongs to. */
  readonly recordId: string;
  /** Google project ID the credential lives in. */
  readonly projectId: string;
  /** Secret category; vault use is restricted to VaultSecretKind. */
  readonly kind: K;
}

/** Vault context is a SecretContext narrowed to credential kinds. */
export type VaultContext = SecretContext<VaultSecretKind>;

/**
 * Serialized form stored in D1. `nonce` and `ciphertext` are canonical
 * standard base64; the GCM tag travels inside `ciphertext`. AAD context is
 * NOT stored: callers supply it from the owning record when opening.
 */
export interface VaultEnvelope {
  readonly version: number;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export type VaultErrorCode =
  | 'VAULT_KEY_INVALID'
  | 'VAULT_CONTEXT_INVALID'
  | 'VAULT_PLAINTEXT_INVALID'
  | 'VAULT_ENVELOPE_MALFORMED'
  | 'VAULT_ENVELOPE_VERSION_UNSUPPORTED'
  | 'VAULT_KEY_ID_MISMATCH'
  | 'VAULT_DECRYPT_FAILED';

/** Typed failure; messages never carry secret or key material. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/**
 * Typed seal/open surface for one HKDF purpose. `K` narrows which context
 * kinds compile against the box; vault boxes only accept VaultSecretKind.
 */
export interface SecretBox<K extends string = string> {
  readonly keyId: string;
  readonly purpose: SecretPurpose;
  sealSecret(plaintext: Uint8Array, context: SecretContext<K>): Promise<VaultEnvelope>;
  openSecret(envelope: VaultEnvelope, context: SecretContext<K>): Promise<Uint8Array>;
}

/** Credential vault for §9.2 records (HKDF purpose 'vault'). */
export type Vault = SecretBox<VaultSecretKind>;

/**
 * Create the credential vault. Validates `masterKeyBase64` eagerly and
 * throws VaultError(VAULT_KEY_INVALID) on anything but canonical standard
 * base64 decoding to exactly 32 bytes. Key derivation is deferred to the
 * first seal/open so construction stays synchronous and cheap.
 */
export function createVault(masterKeyBase64: string, keyId: string): Vault {
  return createBox(masterKeyBase64, keyId, 'vault', VAULT_SECRET_KINDS);
}

/**
 * Create a sealed box for another HKDF purpose (upload-session, auth,
 * media-ticket). Kind validation only requires a non-empty token; each
 * purpose is responsible for its own kind vocabulary.
 */
export function createSecretBox<K extends string = string>(
  masterKeyBase64: string,
  keyId: string,
  purpose: SecretPurpose,
): SecretBox<K> {
  return createBox(masterKeyBase64, keyId, purpose, undefined);
}

/** Canonical JSON serialization of an envelope for D1 text columns. */
export function encodeEnvelope(envelope: VaultEnvelope): string {
  const checked = checkEnvelopeShape(envelope);
  return JSON.stringify({
    version: checked.version,
    keyId: checked.keyId,
    nonce: checked.nonce,
    ciphertext: checked.ciphertext,
  });
}

/**
 * Parse a serialized envelope back into typed form. Validates structure,
 * field types and canonical base64 lengths, but NOT version/keyId — those
 * belong to the opening box, which may legitimately reject them.
 */
export function decodeEnvelope(serialized: string): VaultEnvelope {
  if (typeof serialized !== 'string') {
    throw new VaultError('VAULT_ENVELOPE_MALFORMED', 'envelope must be a JSON string');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new VaultError('VAULT_ENVELOPE_MALFORMED', 'envelope is not valid JSON');
  }
  const checked = checkEnvelopeShape(parsed);
  return {
    version: checked.version,
    keyId: checked.keyId,
    nonce: checked.nonce,
    ciphertext: checked.ciphertext,
  };
}

function createBox<K extends string>(
  masterKeyBase64: string,
  keyId: string,
  purpose: SecretPurpose,
  allowedKinds: readonly string[] | undefined,
): SecretBox<K> {
  const masterKey = decodeMasterKey(masterKeyBase64);
  const checkedKeyId = checkKeyId(keyId);
  const checkedPurpose = checkPurpose(purpose);

  let keyPromise: Promise<CryptoKey> | undefined;
  const dataKey = () => (keyPromise ??= deriveDataKey(masterKey, checkedKeyId, checkedPurpose));

  return {
    keyId: checkedKeyId,
    purpose: checkedPurpose,

    async sealSecret(plaintext, context) {
      const aad = encodeAad(context, allowedKinds);
      if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new VaultError(
          'VAULT_PLAINTEXT_INVALID',
          'plaintext must be a Uint8Array of at most 1 MiB',
        );
      }
      const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: GCM_TAG_BITS },
        await dataKey(),
        // WebCrypto accepts any view; callers may hold wider buffer types.
        plaintext as Uint8Array<ArrayBuffer>,
      );
      return {
        version: VAULT_ENVELOPE_VERSION,
        keyId: checkedKeyId,
        nonce: base64Encode(nonce),
        ciphertext: base64Encode(new Uint8Array(sealed)),
      };
    },

    async openSecret(envelope, context) {
      const checked = checkEnvelopeForOpen(envelope, checkedKeyId);
      const aad = encodeAad(context, allowedKinds);
      try {
        const plain = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: checked.nonceBytes,
            additionalData: aad,
            tagLength: GCM_TAG_BITS,
          },
          await dataKey(),
          checked.ciphertextBytes,
        );
        return new Uint8Array(plain);
      } catch {
        throw new VaultError(
          'VAULT_DECRYPT_FAILED',
          'envelope failed authentication for this key and context',
        );
      }
    },
  };
}

async function deriveDataKey(
  masterKey: Uint8Array<ArrayBuffer>,
  keyId: string,
  purpose: SecretPurpose,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode(`gdrive/v1/key-id/${keyId}`),
      info: textEncoder.encode(`gdrive/v1/purpose/${purpose}`),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function decodeMasterKey(masterKeyBase64: string): Uint8Array<ArrayBuffer> {
  if (typeof masterKeyBase64 !== 'string') {
    throw new VaultError('VAULT_KEY_INVALID', 'master key must be a base64 string');
  }
  const decoded = base64DecodeCanonical(masterKeyBase64);
  if (decoded === null || decoded.byteLength !== MASTER_KEY_BYTES) {
    throw new VaultError(
      'VAULT_KEY_INVALID',
      'master key must be canonical standard base64 decoding to exactly 32 bytes',
    );
  }
  return decoded;
}

function checkKeyId(keyId: string): string {
  if (
    typeof keyId !== 'string' ||
    keyId.length === 0 ||
    keyId.length > MAX_KEY_ID_CHARS ||
    // C0, DEL and C1 control characters have no place in a key identifier.
    [...keyId].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new VaultError(
      'VAULT_KEY_INVALID',
      'keyId must be a non-empty printable string of at most 256 characters',
    );
  }
  return keyId;
}

function checkPurpose(purpose: SecretPurpose): SecretPurpose {
  if (!SECRET_PURPOSES.includes(purpose)) {
    throw new VaultError('VAULT_KEY_INVALID', 'unknown HKDF purpose');
  }
  return purpose;
}

function encodeAad<K extends string>(
  context: SecretContext<K>,
  allowedKinds: readonly string[] | undefined,
): Uint8Array<ArrayBuffer> {
  const c = checkContext(context, allowedKinds);
  return textEncoder.encode(
    JSON.stringify(['gdrive-aad', VAULT_ENVELOPE_VERSION, c.provider, c.recordId, c.projectId, c.kind]),
  );
}

function checkContext<K extends string>(
  context: SecretContext<K>,
  allowedKinds: readonly string[] | undefined,
): SecretContext<K> {
  function fail(): never {
    throw new VaultError(
      'VAULT_CONTEXT_INVALID',
      'context requires non-empty provider, recordId, projectId and an allowed kind',
    );
  }
  if (typeof context !== 'object' || context === null) fail();
  for (const field of ['provider', 'recordId', 'projectId', 'kind'] as const) {
    const value = context[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CONTEXT_FIELD_CHARS) {
      fail();
    }
  }
  if (allowedKinds !== undefined && !allowedKinds.includes(context.kind)) fail();
  return context;
}

interface CheckedEnvelope {
  nonceBytes: Uint8Array<ArrayBuffer>;
  ciphertextBytes: Uint8Array<ArrayBuffer>;
}

function checkEnvelopeForOpen(envelope: VaultEnvelope, keyId: string): CheckedEnvelope {
  const checked = checkEnvelopeShape(envelope);
  if (checked.version !== VAULT_ENVELOPE_VERSION) {
    throw new VaultError(
      'VAULT_ENVELOPE_VERSION_UNSUPPORTED',
      `unsupported envelope version ${checked.version}`,
    );
  }
  if (checked.keyId !== keyId) {
    throw new VaultError('VAULT_KEY_ID_MISMATCH', 'envelope was sealed under a different keyId');
  }
  return checked;
}

function checkEnvelopeShape(envelope: unknown): {
  version: number;
  keyId: string;
  nonce: string;
  ciphertext: string;
  nonceBytes: Uint8Array<ArrayBuffer>;
  ciphertextBytes: Uint8Array<ArrayBuffer>;
} {
  function malformed(): never {
    throw new VaultError(
      'VAULT_ENVELOPE_MALFORMED',
      'envelope requires numeric version, string keyId, 12-byte nonce and >=16-byte ciphertext in canonical base64',
    );
  }
  if (typeof envelope !== 'object' || envelope === null) malformed();
  const candidate = envelope as Record<string, unknown>;
  if (
    typeof candidate.version !== 'number' ||
    !Number.isInteger(candidate.version) ||
    typeof candidate.keyId !== 'string' ||
    candidate.keyId.length === 0 ||
    typeof candidate.nonce !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    malformed();
  }
  const nonceBytes = base64DecodeCanonical(candidate.nonce as string);
  const ciphertextBytes = base64DecodeCanonical(candidate.ciphertext as string);
  if (
    nonceBytes === null ||
    nonceBytes.byteLength !== GCM_NONCE_BYTES ||
    ciphertextBytes === null ||
    ciphertextBytes.byteLength < GCM_TAG_BYTES
  ) {
    malformed();
  }
  return {
    version: candidate.version as number,
    keyId: candidate.keyId as string,
    nonce: candidate.nonce as string,
    ciphertext: candidate.ciphertext as string,
    nonceBytes,
    ciphertextBytes,
  };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decode only canonical standard base64: the alphabet is strict and the
 * re-encoded output must equal the input, so whitespace, base64url
 * alphabets and non-canonical padding are all rejected.
 */
function base64DecodeCanonical(text: string): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || text.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return base64Encode(out) === text ? out : null;
}

// ---------------------------------------------------------------------------
// Keyring (wave-4 T14): multi-key envelope access during master-key rotation.
// ---------------------------------------------------------------------------

/**
 * Non-secret label for a master key, used as the envelope `keyId` for keys
 * other than the legacy 'v1' id. Derived by SHA-256 over key bytes plus a
 * fixed domain string, truncated to 16 hex chars — deterministic so the same
 * key bytes always map to the same label whether they arrive as
 * APP_MASTER_KEY or APP_MASTER_KEY_NEXT (which is what makes the
 * promote-the-secret step safe). 16 hex chars of a hash is a label, not a
 * secret — it cannot be reversed into key material.
 */
export async function masterKeyLabel(masterKeyBase64: string): Promise<string> {
  const masterKey = decodeMasterKey(masterKeyBase64);
  const labelled = new Uint8Array(masterKey.byteLength + 20);
  labelled.set(masterKey, 0);
  labelled.set(textEncoder.encode('gdrive/v1/key-label'), masterKey.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', labelled);
  let hex = '';
  for (const byte of new Uint8Array(digest).slice(0, 8)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `k_${hex}`;
}

export interface KeyringEnv {
  readonly APP_MASTER_KEY?: string;
  readonly APP_MASTER_KEY_NEXT?: string;
}

/**
 * A box that selects the decryption key by the envelope's own keyId and
 * seals new envelopes under the next key while one is staged:
 *
 *   open: 'v1' → APP_MASTER_KEY (legacy label for the current key);
 *         k_<fp(APP_MASTER_KEY)> → APP_MASTER_KEY (post-promotion reads of
 *         NEXT-era envelopes keep working after NEXT is removed);
 *         k_<fp(APP_MASTER_KEY_NEXT)> → APP_MASTER_KEY_NEXT.
 *         An unknown keyId fails closed with VAULT_KEY_ID_MISMATCH.
 *   seal: APP_MASTER_KEY_NEXT present ⇒ seal under NEXT with its fingerprint
 *         label (rotation window, including verified-but-not-yet-promoted);
 *         otherwise seal under APP_MASTER_KEY with the legacy 'v1' label.
 */
export interface KeyringBox<K extends string = string> {
  readonly purpose: SecretPurpose;
  sealSecret(
    plaintext: Uint8Array,
    context: SecretContext<K>,
  ): Promise<VaultEnvelope>;
  openSecret(
    envelope: VaultEnvelope,
    context: SecretContext<K>,
  ): Promise<Uint8Array>;
}

function createKeyringBox<K extends string>(
  env: KeyringEnv,
  purpose: SecretPurpose,
  allowedKinds: readonly string[] | undefined,
): KeyringBox<K> {
  // Lazily built keyId → box map; boxes are created only for keyIds that
  // actually arrive so unknown labels fail cleanly.
  let ringPromise: Promise<Map<string, SecretBox<K>>> | undefined;
  let writePromise: Promise<{ keyId: string; box: SecretBox<K> }> | undefined;

  const build = (): Promise<Map<string, SecretBox<K>>> =>
    (ringPromise ??= (async () => {
      const ring = new Map<string, SecretBox<K>>();
      if (env.APP_MASTER_KEY !== undefined && env.APP_MASTER_KEY !== '') {
        ring.set('v1', createBox<K>(env.APP_MASTER_KEY, 'v1', purpose, allowedKinds));
        ring.set(
          await masterKeyLabel(env.APP_MASTER_KEY),
          createBox<K>(env.APP_MASTER_KEY, await masterKeyLabel(env.APP_MASTER_KEY), purpose, allowedKinds),
        );
      }
      if (env.APP_MASTER_KEY_NEXT !== undefined && env.APP_MASTER_KEY_NEXT !== '') {
        const label = await masterKeyLabel(env.APP_MASTER_KEY_NEXT);
        ring.set(label, createBox<K>(env.APP_MASTER_KEY_NEXT, label, purpose, allowedKinds));
      }
      if (ring.size === 0) {
        throw new VaultError('VAULT_KEY_INVALID', 'no master key configured');
      }
      return ring;
    })());

  const writeBox = (): Promise<{ keyId: string; box: SecretBox<K> }> =>
    (writePromise ??= (async () => {
      // NEXT present ⇒ the deployment is inside a rotation window (active or
      // completed-but-not-promoted): new envelopes must land on the new key.
      if (env.APP_MASTER_KEY_NEXT !== undefined && env.APP_MASTER_KEY_NEXT !== '') {
        const label = await masterKeyLabel(env.APP_MASTER_KEY_NEXT);
        return {
          keyId: label,
          box: createBox<K>(env.APP_MASTER_KEY_NEXT, label, purpose, allowedKinds),
        };
      }
      if (env.APP_MASTER_KEY === undefined || env.APP_MASTER_KEY === '') {
        throw new VaultError('VAULT_KEY_INVALID', 'APP_MASTER_KEY is missing');
      }
      return {
        keyId: 'v1',
        box: createBox<K>(env.APP_MASTER_KEY, 'v1', purpose, allowedKinds),
      };
    })());

  return {
    purpose,
    async sealSecret(plaintext, context) {
      const { box } = await writeBox();
      return box.sealSecret(plaintext, context);
    },
    async openSecret(envelope, context) {
      const checked = checkEnvelopeShape(envelope);
      const ring = await build();
      const box = ring.get(checked.keyId);
      if (box === undefined) {
        throw new VaultError(
          'VAULT_KEY_ID_MISMATCH',
          'no key in the keyring can open this envelope',
        );
      }
      return box.openSecret(envelope, context);
    },
  };
}

/**
 * Drop-in for `createVault(masterKey, VAULT_KEY_ID)` at call sites that must
 * keep working across a master-key rotation: opens select the key by
 * envelope keyId, seals follow the staged-next-key rule. Kind checking
 * matches createVault (vault credential kinds only).
 */
export function createVaultKeyring(env: KeyringEnv): KeyringBox<VaultSecretKind> {
  return createKeyringBox(env, 'vault', VAULT_SECRET_KINDS);
}

/** Drop-in for `createSecretBox(masterKey, VAULT_KEY_ID, purpose)`. */
export function createSecretKeyring<K extends string>(
  env: KeyringEnv,
  purpose: SecretPurpose,
): KeyringBox<K> {
  return createKeyringBox<K>(env, purpose, undefined);
}
