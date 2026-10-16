import { describe, expect, it } from 'vitest';

import {
  createSecretBox,
  createVault,
  decodeEnvelope,
  encodeEnvelope,
  VaultError,
  type VaultContext,
  type VaultEnvelope,
} from '../../src/worker/security/vault';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Deterministic 32-byte keys; only their encoding and length matter.
const MASTER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const MASTER_KEY_B64 = base64(MASTER_KEY);
const OTHER_MASTER_KEY_B64 = base64(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
const SLASHY_MASTER_KEY_B64 = base64(new Uint8Array(32).fill(0xff)); // contains '/'

function ctx(overrides: Partial<VaultContext> = {}): VaultContext {
  return {
    provider: 'service-account',
    recordId: 'sa-record-1',
    projectId: 'project-1',
    kind: 'service-account-key',
    ...overrides,
  };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected synchronous throw');
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise rejection');
}

function expectVaultError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(VaultError);
  expect((error as VaultError).code).toBe(code);
}

describe('createVault master key validation', () => {
  it('accepts canonical standard base64 for exactly 32 bytes', () => {
    const vault = createVault(MASTER_KEY_B64, 'key-2026-10');
    expect(vault.keyId).toBe('key-2026-10');
    expect(vault.purpose).toBe('vault');
  });

  it('rejects malformed or wrong-length keys', () => {
    const bad: unknown[] = [
      '',
      'not-base64!!!',
      base64(new Uint8Array(16)),
      base64(new Uint8Array(31)),
      base64(new Uint8Array(33)),
      base64(new Uint8Array(64)),
      MASTER_KEY_B64.slice(0, -1), // padding stripped -> non-canonical
      ` ${MASTER_KEY_B64}`, // whitespace -> non-canonical
      `${MASTER_KEY_B64} `, // trailing whitespace
      `${MASTER_KEY_B64.slice(0, 8)} ${MASTER_KEY_B64.slice(8)}`, // inner space
      SLASHY_MASTER_KEY_B64.replaceAll('/', '_'), // base64url alphabet
      '====',
      null,
      undefined,
      42,
    ];
    for (const candidate of bad) {
      const error = thrown(() => createVault(candidate as string, 'k'));
      expectVaultError(error, 'VAULT_KEY_INVALID');
    }
  });

  it('rejects empty or control-character keyIds', () => {
    for (const keyId of ['', 'a'.repeat(257), 'bad\u0000id', 'bad\u001fid']) {
      const error = thrown(() => createVault(MASTER_KEY_B64, keyId));
      expectVaultError(error, 'VAULT_KEY_INVALID');
    }
  });

  it('rejects unknown HKDF purposes', () => {
    const error = thrown(() => createSecretBox(MASTER_KEY_B64, 'k', 'vault-ish' as never));
    expectVaultError(error, 'VAULT_KEY_INVALID');
  });
});

describe('seal/open round-trip', () => {
  it('round-trips every vault secret kind', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    for (const kind of ['service-account-key', 'oauth-client-secret', 'oauth-refresh-token'] as const) {
      const plaintext = encoder.encode(`secret-material-for-${kind}`);
      const envelope = await vault.sealSecret(plaintext, ctx({ kind }));
      expect(envelope.version).toBe(1);
      expect(envelope.keyId).toBe('k1');
      const opened = await vault.openSecret(envelope, ctx({ kind }));
      expect(opened).toEqual(plaintext);
    }
  });

  it('emits version/keyId/nonce/ciphertext envelope fields', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const envelope = await vault.sealSecret(encoder.encode('x'), ctx());
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'keyId', 'nonce', 'version']);
  });

  it('gives every record an independent random nonce and ciphertext', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const plaintext = encoder.encode('same plaintext under same context');
    const envelopes: VaultEnvelope[] = [];
    for (let i = 0; i < 256; i++) {
      envelopes.push(await vault.sealSecret(plaintext, ctx()));
    }
    expect(new Set(envelopes.map((e) => e.nonce)).size).toBe(256);
    expect(new Set(envelopes.map((e) => e.ciphertext)).size).toBe(256);
    for (const nonce of envelopes.map((e) => e.nonce)) {
      expect(unbase64(nonce).byteLength).toBe(12);
    }
    // And every one still opens correctly.
    for (const envelope of envelopes.slice(0, 8)) {
      expect(await vault.openSecret(envelope, ctx())).toEqual(plaintext);
    }
  });

  it('never places plaintext bytes in the envelope', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const secret = 'refresh-token-1/very-secret-material';
    const envelope = await vault.sealSecret(encoder.encode(secret), ctx({ kind: 'oauth-refresh-token' }));
    const cipherBytes = unbase64(envelope.ciphertext);
    expect(decoder.decode(cipherBytes)).not.toContain(secret);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(encodeEnvelope(envelope)).not.toContain(secret);
  });

  it('serializes envelopes canonically for storage', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const envelope = await vault.sealSecret(encoder.encode('payload'), ctx());
    const restored = decodeEnvelope(encodeEnvelope(envelope));
    expect(restored).toEqual(envelope);
    expect(await vault.openSecret(restored, ctx())).toEqual(encoder.encode('payload'));
    // Field order is fixed so D1 comparisons stay byte-stable.
    expect(encodeEnvelope(envelope)).toBe(encodeEnvelope(envelope));
  });

  it('allows independent boxes with identical key material to interoperate', async () => {
    const a = createVault(MASTER_KEY_B64, 'k1');
    const b = createVault(MASTER_KEY_B64, 'k1');
    const plaintext = encoder.encode('shared');
    expect(await b.openSecret(await a.sealSecret(plaintext, ctx()), ctx())).toEqual(plaintext);
  });
});

describe('fail-closed behavior', () => {
  it('rejects tampered ciphertext', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const envelope = await vault.sealSecret(encoder.encode('secret'), ctx());
    const cipher = unbase64(envelope.ciphertext);
    cipher[cipher.length - 1] = (cipher[cipher.length - 1] ?? 0) ^ 0x01; // inside the GCM tag
    cipher[0] = (cipher[0] ?? 0) ^ 0x01; // and a body byte
    const tampered = { ...envelope, ciphertext: base64(cipher) };
    expectVaultError(await rejected(vault.openSecret(tampered, ctx())), 'VAULT_DECRYPT_FAILED');
  });

  it('rejects tampered nonce', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const envelope = await vault.sealSecret(encoder.encode('secret'), ctx());
    const nonce = unbase64(envelope.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 0x01;
    expectVaultError(
      await rejected(vault.openSecret({ ...envelope, nonce: base64(nonce) }, ctx())),
      'VAULT_DECRYPT_FAILED',
    );
  });

  it('rejects every AAD context substitution', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const envelope = await vault.sealSecret(encoder.encode('secret'), ctx());
    const wrongContexts: VaultContext[] = [
      ctx({ provider: 'google-oauth' }),
      ctx({ recordId: 'sa-record-2' }),
      ctx({ projectId: 'project-2' }),
      ctx({ kind: 'oauth-client-secret' }),
      ctx({ provider: 'google-oauth', recordId: 'conn-9', projectId: 'other', kind: 'oauth-refresh-token' }),
    ];
    for (const wrong of wrongContexts) {
      expectVaultError(await rejected(vault.openSecret(envelope, wrong)), 'VAULT_DECRYPT_FAILED');
    }
  });

  it('rejects a swapped envelope between records', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const forA = await vault.sealSecret(encoder.encode('a'), ctx({ recordId: 'a' }));
    const forB = await vault.sealSecret(encoder.encode('b'), ctx({ recordId: 'b' }));
    // Transplanting the whole envelope across record IDs must fail closed.
    expectVaultError(
      await rejected(vault.openSecret(forA, ctx({ recordId: 'b' }))),
      'VAULT_DECRYPT_FAILED',
    );
    expectVaultError(
      await rejected(vault.openSecret(forB, ctx({ recordId: 'a' }))),
      'VAULT_DECRYPT_FAILED',
    );
  });

  it('rejects a different master key', async () => {
    const a = createVault(MASTER_KEY_B64, 'k1');
    const b = createVault(OTHER_MASTER_KEY_B64, 'k1');
    const envelope = await a.sealSecret(encoder.encode('secret'), ctx());
    expectVaultError(await rejected(b.openSecret(envelope, ctx())), 'VAULT_DECRYPT_FAILED');
  });

  it('rejects a different keyId even under the same master key', async () => {
    const a = createVault(MASTER_KEY_B64, 'k1');
    const b = createVault(MASTER_KEY_B64, 'k2');
    const envelope = await a.sealSecret(encoder.encode('secret'), ctx());
    expectVaultError(await rejected(b.openSecret(envelope, ctx())), 'VAULT_KEY_ID_MISMATCH');
    expectVaultError(
      await rejected(a.openSecret({ ...envelope, keyId: 'k2' }, ctx())),
      'VAULT_KEY_ID_MISMATCH',
    );
  });

  it('keeps HKDF purposes cryptographically separated', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const uploads = createSecretBox(MASTER_KEY_B64, 'k1', 'upload-session');
    const vaultEnvelope = await vault.sealSecret(encoder.encode('v'), ctx());
    const uploadContext = {
      provider: 'service-account',
      recordId: 'sa-record-1',
      projectId: 'project-1',
      kind: 'remote-upload-uri',
    };
    const uploadEnvelope = await uploads.sealSecret(encoder.encode('v'), uploadContext);
    // Same master key, same keyId, different purpose: both directions fail.
    expectVaultError(await rejected(uploads.openSecret(vaultEnvelope, uploadContext)), 'VAULT_DECRYPT_FAILED');
    expectVaultError(await rejected(vault.openSecret(uploadEnvelope, ctx())), 'VAULT_DECRYPT_FAILED');
  });

  it('rejects unsupported envelope versions', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const envelope = await vault.sealSecret(encoder.encode('secret'), ctx());
    for (const version of [0, 2, 99]) {
      expectVaultError(
        await rejected(vault.openSecret({ ...envelope, version }, ctx())),
        'VAULT_ENVELOPE_VERSION_UNSUPPORTED',
      );
    }
  });

  it('rejects structurally malformed envelopes', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const good = await vault.sealSecret(encoder.encode('secret'), ctx());
    const malformed: unknown[] = [
      null,
      undefined,
      'string',
      42,
      {},
      { ...good, version: 'one' },
      { ...good, keyId: '' },
      { ...good, keyId: 7 },
      { ...good, nonce: '!!!' },
      { ...good, nonce: base64(new Uint8Array(11)) }, // wrong nonce length
      { ...good, nonce: `${good.nonce} ` }, // non-canonical base64
      { ...good, ciphertext: '!!!' },
      { ...good, ciphertext: base64(new Uint8Array(15)) }, // shorter than GCM tag
      { ...good, ciphertext: 5 },
    ];
    for (const envelope of malformed) {
      expectVaultError(
        await rejected(vault.openSecret(envelope as VaultEnvelope, ctx())),
        'VAULT_ENVELOPE_MALFORMED',
      );
    }
  });

  it('rejects malformed serialized envelopes', () => {
    for (const text of ['not json', '{"a":1}', 'null', '[]', '{"version":1}', 5 as unknown as string]) {
      const error = thrown(() => decodeEnvelope(text));
      expectVaultError(error, 'VAULT_ENVELOPE_MALFORMED');
    }
  });

  it('rejects invalid contexts on seal and open', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const envelope = await vault.sealSecret(encoder.encode('secret'), ctx());
    const badContexts = [
      ctx({ provider: '' }),
      ctx({ recordId: '' }),
      ctx({ projectId: '' }),
      ctx({ kind: '' as never }),
      ctx({ kind: 'remote-upload-uri' as never }), // not a vault kind
      { provider: 'service-account', recordId: 'r', projectId: 'p' } as VaultContext, // missing kind
      null,
      'context',
    ];
    for (const bad of badContexts) {
      expectVaultError(
        await rejected(vault.sealSecret(encoder.encode('x'), bad as VaultContext)),
        'VAULT_CONTEXT_INVALID',
      );
      expectVaultError(
        await rejected(vault.openSecret(envelope, bad as VaultContext)),
        'VAULT_CONTEXT_INVALID',
      );
    }
  });

  it('rejects non-binary or oversized plaintext', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    for (const plaintext of ['text', 5, null, new Uint8Array(1024 * 1024 + 1)] as unknown[]) {
      expectVaultError(
        await rejected(vault.sealSecret(plaintext as Uint8Array, ctx())),
        'VAULT_PLAINTEXT_INVALID',
      );
    }
  });

  it('never leaks secret material through error messages', async () => {
    const vault = createVault(MASTER_KEY_B64, 'k1');
    const secret = 's3cr3t-refresh-token-value';
    const envelope = await vault.sealSecret(encoder.encode(secret), ctx());
    const error = await rejected(vault.openSecret(envelope, ctx({ recordId: 'other' })));
    expect(String(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });
});
