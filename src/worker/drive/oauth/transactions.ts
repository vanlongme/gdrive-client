/**
 * D1 persistence for the admin OAuth lifecycle: one-use state transactions
 * and Google connection rows (architecture §5.5).
 *
 * State values are stored only as SHA-256 hashes; consumption is an atomic
 * `UPDATE ... WHERE consumed_at IS NULL` so a replayed callback can never
 * pass the one-use check. Connection writes after reconnect are guarded by
 * compare-and-swap on the row version so a stale callback cannot overwrite a
 * newer connection.
 */

import type { GoogleConnectionState } from '../../../db/schema';

// ---------------------------------------------------------------------------
// Rows (snake_case mirrors the D1 columns).
// ---------------------------------------------------------------------------

export interface AppSettingsSnapshot {
  readonly installationId: string | null;
  readonly canonicalOrigin: string | null;
  readonly setupState: string;
}

export interface OAuthClientRow {
  readonly id: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly secretEnvelope: string;
  readonly redirectUri: string;
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: number;
}

export interface ConnectionRow {
  readonly id: string;
  readonly oauthClientId: string;
  readonly principalId: string;
  readonly displayEmail: string | null;
  readonly refreshEnvelope: string | null;
  readonly grantedScopes: string;
  readonly state: GoogleConnectionState;
  readonly enabled: boolean;
  readonly version: number;
  readonly connectedBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type OAuthTransactionPurpose = 'connect' | 'reconnect';

export interface OAuthTransactionRow {
  readonly id: string;
  readonly stateHash: string;
  readonly adminSessionId: string;
  readonly installationId: string;
  readonly oauthClientId: string;
  readonly clientVersion: number;
  readonly purpose: OAuthTransactionPurpose;
  readonly targetConnectionId: string | null;
  readonly redirectUri: string;
  readonly pkceEnvelope: string | null;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export async function readAppSettings(db: D1Database): Promise<AppSettingsSnapshot | null> {
  const row = await db
    .prepare(
      'SELECT installation_id, canonical_origin, setup_state FROM app_settings WHERE id = 1',
    )
    .first<{ installation_id: string | null; canonical_origin: string | null; setup_state: string }>();
  if (row === null) return null;
  return {
    installationId: row.installation_id,
    canonicalOrigin: row.canonical_origin,
    setupState: row.setup_state,
  };
}

interface OAuthClientRecord {
  id: string;
  project_id: string;
  client_id: string;
  secret_envelope: string;
  redirect_uri: string;
  enabled: number;
  version: number;
  created_at: number;
}

function toOAuthClientRow(r: OAuthClientRecord): OAuthClientRow {
  return {
    id: r.id,
    projectId: r.project_id,
    clientId: r.client_id,
    secretEnvelope: r.secret_envelope,
    redirectUri: r.redirect_uri,
    enabled: r.enabled === 1,
    version: r.version,
    createdAt: r.created_at,
  };
}

export async function readOAuthClient(
  db: D1Database,
  id: string,
): Promise<OAuthClientRow | null> {
  const row = await db
    .prepare(
      'SELECT id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at ' +
        'FROM google_oauth_clients WHERE id = ?',
    )
    .bind(id)
    .first<OAuthClientRecord>();
  return row === null ? null : toOAuthClientRow(row);
}

interface ConnectionRecord {
  id: string;
  oauth_client_id: string;
  principal_id: string;
  display_email: string | null;
  refresh_envelope: string | null;
  granted_scopes: string;
  state: string;
  enabled: number;
  version: number;
  connected_by: string | null;
  created_at: number;
  updated_at: number;
}

const CONNECTION_COLUMNS =
  'id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, ' +
  'state, enabled, version, connected_by, created_at, updated_at';

function toConnectionRow(r: ConnectionRecord): ConnectionRow {
  return {
    id: r.id,
    oauthClientId: r.oauth_client_id,
    principalId: r.principal_id,
    displayEmail: r.display_email,
    refreshEnvelope: r.refresh_envelope,
    grantedScopes: r.granted_scopes,
    state: r.state as GoogleConnectionState,
    enabled: r.enabled === 1,
    version: r.version,
    connectedBy: r.connected_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function readConnection(
  db: D1Database,
  id: string,
): Promise<ConnectionRow | null> {
  const row = await db
    .prepare(`SELECT ${CONNECTION_COLUMNS} FROM google_connections WHERE id = ?`)
    .bind(id)
    .first<ConnectionRecord>();
  return row === null ? null : toConnectionRow(row);
}

export async function findConnectionByClientPrincipal(
  db: D1Database,
  oauthClientId: string,
  principalId: string,
): Promise<ConnectionRow | null> {
  const row = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS} FROM google_connections ` +
        'WHERE oauth_client_id = ? AND principal_id = ?',
    )
    .bind(oauthClientId, principalId)
    .first<ConnectionRecord>();
  return row === null ? null : toConnectionRow(row);
}

export async function listConnections(db: D1Database): Promise<ConnectionRow[]> {
  const result = await db
    .prepare(`SELECT ${CONNECTION_COLUMNS} FROM google_connections ORDER BY created_at, id`)
    .all<ConnectionRecord>();
  return (result.results ?? []).map(toConnectionRow);
}

// ---------------------------------------------------------------------------
// Transactions: insert + atomic one-use consume.
// ---------------------------------------------------------------------------

export interface NewOAuthTransaction {
  readonly id: string;
  readonly stateHash: string;
  readonly adminSessionId: string;
  readonly installationId: string;
  readonly oauthClientId: string;
  readonly clientVersion: number;
  readonly purpose: OAuthTransactionPurpose;
  readonly targetConnectionId: string | null;
  readonly redirectUri: string;
  readonly pkceEnvelope: string | null;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
}

export async function insertOAuthTransaction(
  db: D1Database,
  tx: NewOAuthTransaction,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO oauth_transactions ' +
        '(id, state_hash, admin_session_id, installation_id, oauth_client_id, client_version, ' +
        'purpose, target_connection_id, redirect_uri, pkce_envelope, expires_at, consumed_at, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    )
    .bind(
      tx.id,
      tx.stateHash,
      tx.adminSessionId,
      tx.installationId,
      tx.oauthClientId,
      tx.clientVersion,
      tx.purpose,
      tx.targetConnectionId,
      tx.redirectUri,
      tx.pkceEnvelope,
      tx.expiresAtMs,
      tx.createdAtMs,
    )
    .run();
}

interface OAuthTransactionRecord {
  id: string;
  state_hash: string;
  admin_session_id: string;
  installation_id: string;
  oauth_client_id: string;
  client_version: number;
  purpose: string;
  target_connection_id: string | null;
  redirect_uri: string;
  pkce_envelope: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

function toTransactionRow(r: OAuthTransactionRecord): OAuthTransactionRow {
  return {
    id: r.id,
    stateHash: r.state_hash,
    adminSessionId: r.admin_session_id,
    installationId: r.installation_id,
    oauthClientId: r.oauth_client_id,
    clientVersion: r.client_version,
    purpose: r.purpose as OAuthTransactionPurpose,
    targetConnectionId: r.target_connection_id,
    redirectUri: r.redirect_uri,
    pkceEnvelope: r.pkce_envelope,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at,
    createdAt: r.created_at,
  };
}

export type ConsumeResult =
  | { readonly status: 'consumed'; readonly transaction: OAuthTransactionRow }
  | { readonly status: 'unknown' }
  | { readonly status: 'already_used' }
  | { readonly status: 'expired'; readonly transaction: OAuthTransactionRow };

/**
 * Atomically consumes the transaction identified by the raw state's hash.
 * The UPDATE's `consumed_at IS NULL` predicate makes concurrent replays
 * single-use; the expiry check happens after the claim so an expired row is
 * still burned and cannot be replayed.
 */
export async function consumeOAuthTransaction(
  db: D1Database,
  stateHash: string,
  nowMs: number,
): Promise<ConsumeResult> {
  const update = await db
    .prepare(
      'UPDATE oauth_transactions SET consumed_at = ? ' +
        'WHERE state_hash = ? AND consumed_at IS NULL',
    )
    .bind(nowMs, stateHash)
    .run();
  const row = await db
    .prepare(
      'SELECT id, state_hash, admin_session_id, installation_id, oauth_client_id, client_version, ' +
        'purpose, target_connection_id, redirect_uri, pkce_envelope, expires_at, consumed_at, created_at ' +
        'FROM oauth_transactions WHERE state_hash = ?',
    )
    .bind(stateHash)
    .first<OAuthTransactionRecord>();
  if (row === null) return { status: 'unknown' };
  const transaction = toTransactionRow(row);
  if (update.meta.changes === 0) return { status: 'already_used' };
  if (transaction.expiresAt <= nowMs) return { status: 'expired', transaction };
  return { status: 'consumed', transaction };
}

// ---------------------------------------------------------------------------
// Connection writes: insert, CAS update, local disable.
// ---------------------------------------------------------------------------

export interface NewConnection {
  readonly id: string;
  readonly oauthClientId: string;
  readonly principalId: string;
  readonly displayEmail: string | null;
  readonly refreshEnvelope: string | null;
  readonly grantedScopes: string;
  readonly state: GoogleConnectionState;
  readonly connectedBy: string;
  readonly nowMs: number;
}

/**
 * Insert a new connection guarded in the same statement by the OAuth client
 * row still being enabled at the frozen version (INSERT ... SELECT with
 * EXISTS). Returns false when the client changed between snapshot and write —
 * a late callback never lands a row under a moved credential.
 */
export async function insertConnection(
  db: D1Database,
  connection: NewConnection,
  clientGuard: { id: string; version: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      'INSERT INTO google_connections ' +
        '(id, oauth_client_id, principal_id, display_email, refresh_envelope, granted_scopes, ' +
        'state, enabled, version, connected_by, created_at, updated_at) ' +
        'SELECT ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ? ' +
        'WHERE EXISTS (SELECT 1 FROM google_oauth_clients ' +
        'WHERE id = ? AND version = ? AND enabled = 1)',
    )
    .bind(
      connection.id,
      connection.oauthClientId,
      connection.principalId,
      connection.displayEmail,
      connection.refreshEnvelope,
      connection.grantedScopes,
      connection.state,
      connection.connectedBy,
      connection.nowMs,
      connection.nowMs,
      clientGuard.id,
      clientGuard.version,
    )
    .run();
  return result.meta.changes === 1;
}

export interface ConnectionCasUpdate {
  /** null leaves the stored refresh envelope untouched (missing-refresh rule). */
  readonly refreshEnvelope: string | null | undefined;
  readonly grantedScopes: string;
  readonly displayEmail: string | null;
  readonly state: GoogleConnectionState;
  readonly nowMs: number;
}

/**
 * Compare-and-swap update on a connection row, fenced on the frozen version
 * AND the row still being enabled. Returns false when the row changed
 * underneath the caller (concurrent reconnect/disable) — the caller must
 * re-read and decide instead of overwriting the newer identity. A single
 * fenced CAS is the whole write: callers never rebase a stale OAuth result
 * onto a newer row.
 */
export async function casUpdateConnection(
  db: D1Database,
  id: string,
  expectedVersion: number,
  update: ConnectionCasUpdate,
  clientGuard: { id: string; version: number },
): Promise<boolean> {
  const setRefresh =
    update.refreshEnvelope === undefined || update.refreshEnvelope === null
      ? ''
      : 'refresh_envelope = ?, ';
  const binds: (string | number | null)[] = [];
  if (setRefresh !== '') binds.push(update.refreshEnvelope as string);
  binds.push(
    update.grantedScopes,
    update.displayEmail,
    update.state,
    update.nowMs,
    id,
    expectedVersion,
    clientGuard.id,
    clientGuard.version,
  );
  const result = await db
    .prepare(
      `UPDATE google_connections SET ${setRefresh}` +
        'granted_scopes = ?, display_email = ?, state = ?, version = version + 1, updated_at = ? ' +
        'WHERE id = ? AND version = ? AND enabled = 1 ' +
        'AND EXISTS (SELECT 1 FROM google_oauth_clients ' +
        'WHERE id = ? AND version = ? AND enabled = 1)',
    )
    .bind(...binds)
    .run();
  return result.meta.changes === 1;
}

/**
 * Marks a connection needs_reauth after invalid_grant. Guarded by the caller's
 * version so a successful reconnect that already bumped the row is not
 * regressed by a late upstream failure.
 */
export async function markConnectionNeedsReauth(
  db: D1Database,
  id: string,
  expectedVersion: number,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE google_connections SET state = 'needs_reauth', " +
        'version = version + 1, updated_at = ? ' +
        "WHERE id = ? AND version = ? AND state != 'disabled'",
    )
    .bind(nowMs, id, expectedVersion)
    .run();
  return result.meta.changes === 1;
}

/**
 * Rotates the sealed refresh token after a refresh grant returned a new one.
 * Same CAS rule: a stale refresh response must not overwrite newer material.
 */
export async function casRotateRefreshEnvelope(
  db: D1Database,
  id: string,
  expectedVersion: number,
  refreshEnvelope: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE google_connections SET refresh_envelope = ?, ' +
        'version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
    )
    .bind(refreshEnvelope, nowMs, id, expectedVersion)
    .run();
  return result.meta.changes === 1;
}

/** Local disable is distinct from upstream grant revocation (§5.5). */
export async function disableConnection(
  db: D1Database,
  id: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE google_connections SET enabled = 0, state = 'disabled', " +
        'version = version + 1, updated_at = ? WHERE id = ? AND enabled = 1',
    )
    .bind(nowMs, id)
    .run();
  return result.meta.changes === 1;
}

/** Clears the stored refresh token after a confirmed disconnect/revoke. */
export async function clearConnectionRefreshEnvelope(
  db: D1Database,
  id: string,
  expectedVersion: number,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE google_connections SET refresh_envelope = NULL, ' +
        'version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
    )
    .bind(nowMs, id, expectedVersion)
    .run();
  return result.meta.changes === 1;
}
