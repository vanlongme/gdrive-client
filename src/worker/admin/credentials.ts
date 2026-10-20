/**
 * Admin credential helpers (wave-3 worker A): service-account key JSON
 * parsing/validation and OAuth-client derivation. Private material leaves
 * this module only inside a sealed vault envelope — views always project
 * the public metadata columns.
 */

import type { ServiceAccountView } from '../../shared/contracts/admin';

export interface ServiceAccountRow {
  readonly id: string;
  readonly projectId: string;
  readonly email: string;
  readonly keyId: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: number;
}

export interface ParsedServiceAccountKey {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string | null;
}

const PRIVATE_KEY_PATTERN =
  /-----BEGIN PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END PRIVATE KEY-----/;
const CLIENT_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/;

/**
 * Parse a Google service-account key JSON document. Returns null for any
 * malformed input — callers translate to VALIDATION_FAILED, never to a
 * partial credential. Only the fields the SA token flow needs are kept
 * (project_id, client_email, private_key, private_key_id); token_uri and
 * every other vendor field are ignored by design (fixed token endpoint).
 */
export function parseServiceAccountKeyJson(
  raw: string,
): ParsedServiceAccountKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== undefined && record.type !== 'service_account') {
    return null;
  }
  const projectId = record.project_id;
  const clientEmail = record.client_email;
  const privateKey = record.private_key;
  const privateKeyId = record.private_key_id;
  if (
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    projectId.length > 256 ||
    typeof clientEmail !== 'string' ||
    !CLIENT_EMAIL_PATTERN.test(clientEmail) ||
    typeof privateKey !== 'string' ||
    !PRIVATE_KEY_PATTERN.test(privateKey)
  ) {
    return null;
  }
  return {
    projectId,
    clientEmail,
    privateKey,
    privateKeyId:
      typeof privateKeyId === 'string' && privateKeyId.length > 0
        ? privateKeyId
        : null,
  };
}

/**
 * Locally validate the PKCS8 RSA private key with WebCrypto: the PEM must be
 * exactly one BEGIN/END PRIVATE KEY block (whitespace inside the body is
 * fine, trailing garbage is not) whose DER imports as RSASSA-PKCS1-v1_5
 * SHA-256. Wrong algorithm (EC/Ed25519), corrupt DER and broken base64 all
 * fail — no Google request is needed (coordinator review, R6).
 */
export async function validatePkcs8RsaPrivateKey(
  pem: string,
): Promise<boolean> {
  const match =
    /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\r\n]+?)\s*-----END PRIVATE KEY-----\s*$/.exec(
      pem,
    );
  const body = match?.[1];
  if (body === undefined) return false;
  let der: Uint8Array;
  try {
    const binary = atob(body.replace(/\s+/g, ''));
    der = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  } catch {
    return false;
  }
  if (der.byteLength === 0) return false;
  try {
    await crypto.subtle.importKey(
      'pkcs8',
      der as Uint8Array<ArrayBuffer>,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The JSON material sealed into the SA envelope — exactly what the
 * coordinator's signServiceAccountJwt path consumes (client_email,
 * private_key, private_key_id).
 */
export function serviceAccountEnvelopeMaterial(
  parsed: ParsedServiceAccountKey,
): string {
  return JSON.stringify({
    client_email: parsed.clientEmail,
    private_key: parsed.privateKey,
    ...(parsed.privateKeyId === null
      ? {}
      : { private_key_id: parsed.privateKeyId }),
  });
}

/**
 * SHA-256 fingerprint of the PKCS8 body (hex), whitespace-insensitive. Used
 * by duplicate detection when private_key_id is missing on either side —
 * an empty key id can never prove two imports carry the same key.
 */
export async function serviceAccountKeyFingerprint(
  privateKeyPem: string,
): Promise<string> {
  const match =
    /-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\r\n]+?)\s*-----END PRIVATE KEY-----/.exec(
      privateKeyPem,
    );
  const body = (match?.[1] ?? privateKeyPem).replace(/\s+/g, '');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Google OAuth Web client ids embed the owning project number:
 * `<project-number>-<random>.apps.googleusercontent.com`. Used when the
 * admin does not supply projectId explicitly; anything else returns null
 * and the import requires an explicit projectId.
 */
export function clientProjectFromClientId(clientId: string): string | null {
  const match = /^([0-9]+)-[A-Za-z0-9]+\.apps\.googleusercontent\.com$/.exec(
    clientId.trim(),
  );
  return match === null || match[1] === undefined ? null : match[1];
}

interface ServiceAccountRecord {
  id: string;
  project_id: string;
  email: string;
  key_id: string;
  enabled: number;
  version: number;
  created_at: number;
}

function toServiceAccountRow(r: ServiceAccountRecord): ServiceAccountRow {
  return {
    id: r.id,
    projectId: r.project_id,
    email: r.email,
    keyId: r.key_id,
    enabled: r.enabled === 1,
    version: r.version,
    createdAt: r.created_at,
  };
}

const SA_COLUMNS =
  'id, project_id, email, key_id, enabled, version, created_at';

export async function readServiceAccount(
  db: D1Database,
  id: string,
): Promise<ServiceAccountRow | null> {
  const row = await db
    .prepare(`SELECT ${SA_COLUMNS} FROM service_accounts WHERE id = ?`)
    .bind(id)
    .first<ServiceAccountRecord>();
  return row === null ? null : toServiceAccountRow(row);
}

export async function readServiceAccountByIdentity(
  db: D1Database,
  projectId: string,
  email: string,
): Promise<ServiceAccountRow | null> {
  const row = await db
    .prepare(
      `SELECT ${SA_COLUMNS} FROM service_accounts WHERE project_id = ? AND email = ?`,
    )
    .bind(projectId, email)
    .first<ServiceAccountRecord>();
  return row === null ? null : toServiceAccountRow(row);
}

export async function listServiceAccounts(
  db: D1Database,
): Promise<ServiceAccountRow[]> {
  const rows = await db
    .prepare(`SELECT ${SA_COLUMNS} FROM service_accounts ORDER BY created_at, id`)
    .all<ServiceAccountRecord>();
  return (rows.results ?? []).map(toServiceAccountRow);
}

/**
 * Fetch many service accounts by id with IN() chunks (D1 binds at most ~100
 * parameters per query), so bulk operations never run a per-id lookup loop.
 * Rows come back keyed by id in a Map — request order is the caller's.
 */
export async function listServiceAccountsByIds(
  db: D1Database,
  ids: readonly string[],
): Promise<Map<string, ServiceAccountRow>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, ServiceAccountRow>();
  for (let offset = 0; offset < unique.length; offset += 90) {
    const chunk = unique.slice(offset, offset + 90);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(`SELECT ${SA_COLUMNS} FROM service_accounts WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<ServiceAccountRecord>();
    for (const row of rows.results ?? []) {
      found.set(row.id, toServiceAccountRow(row));
    }
  }
  return found;
}

export function serviceAccountView(row: ServiceAccountRow): ServiceAccountView {
  return {
    id: row.id,
    projectId: row.projectId,
    email: row.email,
    keyId: row.keyId,
    enabled: row.enabled,
    version: row.version,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
