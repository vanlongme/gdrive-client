/**
 * public_folder_links persistence + lifecycle (wave 8 Phase B2). Mirrors
 * the shares.ts pattern: rows are read fresh on every request so revoke,
 * expiry and policy-version changes take effect immediately; views are
 * strict DTOs and never expose password_hash or credential_version.
 */

import {
  PublicFolderLinkViewSchema,
  type PublicFolderLinkView,
  type PublicLinkStatus,
} from '../../shared/contracts/public-links';
import type { MountRecord } from '../drive/mounts';

export interface PublicLinkRow {
  readonly id: string;
  readonly slug: string;
  readonly mountId: string;
  readonly folderId: string;
  readonly folderName: string;
  readonly passwordHash: string | null;
  readonly credentialVersion: number;
  readonly allowZip: boolean;
  readonly expiresAt: number | null;
  readonly policyVersion: number;
  readonly createdBy: string;
  readonly createdByEmail: string | null;
  readonly createdByName: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
  readonly viewCount: number;
  readonly downloadCount: number;
}

interface DbRow {
  id: string;
  slug: string;
  mount_id: string;
  folder_id: string;
  folder_name: string;
  password_hash: string | null;
  credential_version: number;
  allow_zip: number;
  expires_at: number | null;
  policy_version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  view_count: number;
  download_count: number;
  creator_email: string | null;
  creator_name: string | null;
}

const COLUMNS =
  'l.id, l.slug, l.mount_id, l.folder_id, l.folder_name, l.password_hash, ' +
  'l.credential_version, l.allow_zip, l.expires_at, l.policy_version, ' +
  'l.created_by, l.created_at, l.updated_at, l.revoked_at, l.view_count, ' +
  'l.download_count, u.email AS creator_email, u.name AS creator_name';

const FROM =
  'FROM public_folder_links l LEFT JOIN "user" u ON u.id = l.created_by';

function toRow(r: DbRow): PublicLinkRow {
  return {
    id: r.id,
    slug: r.slug,
    mountId: r.mount_id,
    folderId: r.folder_id,
    folderName: r.folder_name,
    passwordHash: r.password_hash,
    credentialVersion: r.credential_version,
    allowZip: r.allow_zip === 1,
    expiresAt: r.expires_at,
    policyVersion: r.policy_version,
    createdBy: r.created_by,
    createdByEmail: r.creator_email,
    createdByName: r.creator_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revokedAt: r.revoked_at,
    viewCount: r.view_count,
    downloadCount: r.download_count,
  };
}

export async function getPublicLinkById(db: D1Database, id: string): Promise<PublicLinkRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE l.id = ?`).bind(id).first<DbRow>();
  return row === null ? null : toRow(row);
}

export async function getPublicLinkBySlug(db: D1Database, slug: string): Promise<PublicLinkRow | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE l.slug = ?`).bind(slug).first<DbRow>();
  return row === null ? null : toRow(row);
}

export async function listPublicLinks(db: D1Database, mountId?: string): Promise<PublicLinkRow[]> {
  const rows = mountId === undefined
    ? await db.prepare(`SELECT ${COLUMNS} ${FROM} ORDER BY l.created_at DESC, l.id DESC`).all<DbRow>()
    : await db
        .prepare(`SELECT ${COLUMNS} ${FROM} WHERE l.mount_id = ? ORDER BY l.created_at DESC, l.id DESC`)
        .bind(mountId)
        .all<DbRow>();
  return (rows.results ?? []).map(toRow);
}

export type PublicLinkValidity =
  | 'ok'
  | 'revoked'
  | 'expired'
  | 'policy-changed'
  | 'mount-missing';

export function checkPublicLinkValid(
  link: PublicLinkRow,
  mountPolicyVersion: number | null,
  now: number,
): PublicLinkValidity {
  if (mountPolicyVersion === null) return 'mount-missing';
  if (link.revokedAt !== null) return 'revoked';
  if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
  if (link.policyVersion !== mountPolicyVersion) return 'policy-changed';
  return 'ok';
}

export function publicLinkStatus(link: PublicLinkRow, mountPolicyVersion: number | null, now: number): PublicLinkStatus {
  switch (checkPublicLinkValid(link, mountPolicyVersion, now)) {
    case 'revoked': return 'revoked';
    case 'expired': return 'expired';
    case 'mount-missing':
    case 'policy-changed': return 'invalidated';
    case 'ok': return 'active';
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function publicLinkView(
  link: PublicLinkRow,
  mount: Pick<MountRecord, 'policyVersion' | 'label'> | null,
  now: number,
): PublicFolderLinkView {
  return PublicFolderLinkViewSchema.parse({
    id: link.id,
    slug: link.slug,
    path: `/p/${link.slug}`,
    mountId: link.mountId,
    mountLabel: mount?.label ?? '(removed mount)',
    folderId: link.folderId,
    folderName: link.folderName,
    hasPassword: link.passwordHash !== null,
    allowZip: link.allowZip,
    expiresAt: link.expiresAt === null ? null : iso(link.expiresAt),
    createdAt: iso(link.createdAt),
    createdByEmail: link.createdByEmail,
    revokedAt: link.revokedAt === null ? null : iso(link.revokedAt),
    status: publicLinkStatus(link, mount === null ? null : mount.policyVersion, now),
    viewCount: link.viewCount,
    downloadCount: link.downloadCount,
  });
}

export async function bumpPublicLinkCounter(
  db: D1Database,
  linkId: string,
  column: 'view_count' | 'download_count',
): Promise<void> {
  await db
    .prepare(`UPDATE public_folder_links SET ${column} = ${column} + 1 WHERE id = ?`)
    .bind(linkId)
    .run();
}

// ---------------------------------------------------------------------------
// Unlock throttle: exactly 5 failed attempts inside a rolling 60s window per
// (slug, IP), then 429 until the window rolls (review R2a — the lock used to
// trip one attempt early). The key is a SHA-256 so no client address is
// persisted.
// ---------------------------------------------------------------------------

export const UNLOCK_WINDOW_MS = 60_000;
export const UNLOCK_MAX_FAILURES = 5;

export async function unlockAttemptKey(slug: string, clientIp: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`v1|${slug}|${clientIp}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type UnlockGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

// Per-link aggregate (review R2b): counts FAILED attempts only — a
// successful unlock refunds its reservation — and trips at 150 failures per
// rolling 60s window (~30 IPs hammering at the per-IP limit). The old
// 50-attempt counter included successes, so ~13 rotating IPs could hold a
// locked link at 429 for everyone, and a popular link locked itself out.
export const UNLOCK_AGGREGATE_MAX_ATTEMPTS = 150;

interface ReserveRow {
  failures: number;
  window_started_at: number;
  locked_until: number | null;
}

/**
 * Atomically reserve one unlock attempt BEFORE the password is verified —
 * a single INSERT..ON CONFLICT..RETURNING, so N concurrent requests can
 * never interleave a read-modify-write and bypass the limit (review H2).
 * The counter is attempt-based: a request that survives the gate and then
 * succeeds deletes the row.
 *
 * Also prunes rows whose window has fully expired so the table cannot
 * grow without bound (review M2).
 */
export async function reserveUnlockAttempt(
  db: D1Database,
  key: string,
  now: number,
  maxAttempts = UNLOCK_MAX_FAILURES,
): Promise<UnlockGate> {
  await db.prepare('DELETE FROM public_link_unlock_attempts WHERE updated_at < ?')
    .bind(now - UNLOCK_WINDOW_MS).run();
  const row = await db
    .prepare(
      'INSERT INTO public_link_unlock_attempts (key, failures, window_started_at, locked_until, updated_at) ' +
        'VALUES (?, 1, ?, NULL, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET ' +
        'failures = CASE WHEN ? - window_started_at >= ? THEN 1 ELSE failures + 1 END, ' +
        'window_started_at = CASE WHEN ? - window_started_at >= ? THEN ? ELSE window_started_at END, ' +
        'locked_until = CASE WHEN ? - window_started_at >= ? THEN NULL ' +
        // Review R2a: the lock must trip only once failures EXCEED the
        // limit, so exactly `maxAttempts` attempts verify before 429s.
        'ELSE CASE WHEN failures + 1 > ? THEN window_started_at + ? ELSE locked_until END END, ' +
        'updated_at = ? ' +
        'RETURNING failures, window_started_at, locked_until',
    )
    .bind(
      key, now, now,
      now, UNLOCK_WINDOW_MS,
      now, UNLOCK_WINDOW_MS, now,
      now, UNLOCK_WINDOW_MS, maxAttempts, UNLOCK_WINDOW_MS,
      now,
    )
    .first<ReserveRow>();
  if (row === null) return { allowed: true };
  const lockedUntil = row.locked_until ?? (row.failures > maxAttempts ? row.window_started_at + UNLOCK_WINDOW_MS : null);
  if (lockedUntil !== null && lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) };
  }
  return { allowed: true };
}

/** Aggregate key for the per-link limit (all IPs share it). */
export async function unlockAggregateKey(linkId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`agg|${linkId}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Success clears the per-(slug,ip) row; the aggregate row expires naturally. */
export async function clearUnlockFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM public_link_unlock_attempts WHERE key = ?').bind(key).run();
}

/**
 * Refund one throttle reservation after a successful unlock (review R2b):
 * the per-link aggregate counts FAILED attempts only, so legitimate unlock
 * volume can never push a popular link over the limit.
 */
export async function refundUnlockAttempt(db: D1Database, key: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE public_link_unlock_attempts SET failures = MAX(0, failures - 1), updated_at = ? WHERE key = ?')
    .bind(now, key)
    .run();
}
