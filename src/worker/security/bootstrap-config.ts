/**
 * Bootstrap secret validation.
 *
 * Both Worker secrets must be present and decode to exactly 32 bytes before any
 * protected API serves data. Validation is strict: the value must be canonical
 * base64 (no whitespace, correct padding) so that malformed secrets fail closed
 * instead of silently producing a different key.
 */

export const BOOTSTRAP_SECRET_BYTE_LENGTH = 32;

const BASE64_32_BYTES_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export interface BootstrapSecrets {
  masterKey: Uint8Array;
  setupToken: Uint8Array;
}

export type BootstrapConfig =
  | { ok: true; secrets: BootstrapSecrets }
  | { ok: false; missing: string[]; invalid: string[] };

export interface BootstrapEnv {
  APP_MASTER_KEY?: string;
  SETUP_TOKEN?: string;
}

type SecretRead =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "invalid" };

function decodeStrictBase64(value: string): Uint8Array | null {
  if (!BASE64_32_BYTES_PATTERN.test(value)) return null;
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  // Canonical form only: reject encodings whose padding bits are nonzero even
  // though atob() would accept them.
  if (btoa(binary) !== value) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.length === BOOTSTRAP_SECRET_BYTE_LENGTH ? bytes : null;
}

function readSecret(value: string | undefined): SecretRead {
  if (value === undefined || value === "") return { kind: "missing" };
  const bytes = decodeStrictBase64(value);
  return bytes === null ? { kind: "invalid" } : { kind: "ok", bytes };
}

export function getBootstrapConfig(env: BootstrapEnv): BootstrapConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  const masterKey = readSecret(env.APP_MASTER_KEY);
  if (masterKey.kind === "missing") missing.push("APP_MASTER_KEY");
  if (masterKey.kind === "invalid") invalid.push("APP_MASTER_KEY");

  const setupToken = readSecret(env.SETUP_TOKEN);
  if (setupToken.kind === "missing") missing.push("SETUP_TOKEN");
  if (setupToken.kind === "invalid") invalid.push("SETUP_TOKEN");

  if (masterKey.kind !== "ok" || setupToken.kind !== "ok") {
    return { ok: false, missing, invalid };
  }
  return { ok: true, secrets: { masterKey: masterKey.bytes, setupToken: setupToken.bytes } };
}
