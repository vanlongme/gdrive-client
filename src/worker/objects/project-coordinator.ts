import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { createVaultKeyring, decodeEnvelope } from '../security/vault';
import {
  normalizeScopes,
  oauthClientSecretContext,
  oauthRefreshTokenContext,
  serviceAccountKeyContext,
  resolveGoogleFetch,
  SingleFlight,
  TokenCache,
  tokenFail,
  tokenIdentityKey,
  tokenOk,
  type FetchLike,
  type OAuthTokenIdentity,
  type ServiceAccountTokenIdentity,
  type TokenIdentity,
  type TokenResult,
  type TokenFailureKind,
} from '../drive/tokens';
import {
  exchangeServiceAccountJwt,
  refreshAccessToken,
  SA_READ_SCOPE,
  signServiceAccountJwt,
  type GoogleEndpointResult,
  type GoogleTokenGrant,
} from '../drive/oauth/google';
import {
  casRotateRefreshEnvelope,
  markConnectionNeedsReauth,
  readConnection,
  readOAuthClient,
  type ConnectionRow,
  type OAuthClientRow,
} from '../drive/oauth/transactions';
import { isMaintenanceActive } from '../security/rotation';

/**
 * ProjectCoordinator — one SQLite Durable Object per Google Cloud project
 * (architecture §5.4). It is the only place access tokens are acquired:
 *
 * - every admission re-reads the credential row from D1 and verifies each
 *   supplied identity field against the current row — the caller's version
 *   pin is a claim to check, never the authority;
 * - access tokens live in a bounded in-memory cache keyed by the full
 *   identity tuple (provider/credential+version/client+version/project/
 *   principal/scopes); nothing token-shaped is persisted;
 * - refresh is single-flighted per identity key so concurrent admissions
 *   share exactly one upstream grant;
 * - cooldown and failure counters are the only durable state and live in DO
 *   SQLite storage; file-scoped cooldowns never cause an alternate-identity
 *   retry because admission only ever vends the pinned identity.
 *
 * The DO answers an internal JSON protocol over fetch(); it is reachable
 * only through the PROJECT_COORDINATOR binding.
 */

const textDecoder = new TextDecoder();

/**
 * Pinned origin for the internal protocol — the same constant the
 * Worker-side client uses (coordinator-client.ts). Every request from any
 * other origin is rejected before a command runs, matching the
 * UploadSession.fetch contract.
 */
const DO_ORIGIN = 'https://project-coordinator.internal';

const COOLDOWN_BASE_MS: Record<TokenFailureKind, number> = {
  rate_limit: 30_000,
  upstream_5xx: 15_000,
  auth: 300_000,
  file_limited: 120_000,
};
const COOLDOWN_CAP_MS = 15 * 60_000;

const identityBaseSchema = z.object({
  credentialId: z.string().min(1).max(256),
  credentialVersion: z.number().int().min(1),
  projectId: z.string().min(1).max(256),
  principalId: z.string().min(1).max(512),
  scopes: z.array(z.string().min(1).max(256)).max(32),
});

const identitySchema = z.discriminatedUnion('provider', [
  identityBaseSchema.extend({
    provider: z.literal('google_oauth'),
    oauthClientId: z.string().min(1).max(256),
    oauthClientVersion: z.number().int().min(1),
  }),
  identityBaseSchema.extend({ provider: z.literal('service_account') }),
]);

const admitBodySchema = z
  .object({
    identity: identitySchema,
    fileId: z.string().min(1).max(256).optional(),
  })
  .strict();

const reportBodySchema = z
  .object({
    identity: identitySchema,
    report: z
      .object({
        kind: z.enum(['rate_limit', 'upstream_5xx', 'auth', 'file_limited']),
        fileId: z.string().min(1).max(256).optional(),
        retryAfterMs: z.number().int().min(0).max(COOLDOWN_CAP_MS).optional(),
      })
      .strict(),
  })
  .strict();

interface CooldownRow {
  scope_key: string;
  failures: number;
  until_ms: number;
  reason: string;
  updated_ms: number;
}

interface ServiceAccountRecord {
  id: string;
  project_id: string;
  email: string;
  key_id: string;
  envelope: string;
  enabled: number;
  version: number;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export class ProjectCoordinator extends DurableObject<Env> {
  private readonly tokenCache = new TokenCache();
  private readonly singleFlight = new SingleFlight();
  private storageInitialized = false;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== DO_ORIGIN) {
      return errorResponse(400, 'INVALID_COMMAND', 'unexpected origin');
    }
    if (request.method === 'POST' && url.pathname === '/admit') {
      const body = await this.readJson(request);
      const parsed = admitBodySchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(400, 'ADMIT_INVALID', 'admission request is malformed');
      }
      const result = await this.admit(parsed.data.identity, parsed.data.fileId);
      return Response.json(result);
    }
    if (request.method === 'POST' && url.pathname === '/report-failure') {
      const body = await this.readJson(request);
      const parsed = reportBodySchema.safeParse(body);
      if (!parsed.success) {
        return errorResponse(400, 'REPORT_INVALID', 'failure report is malformed');
      }
      if (parsed.data.report.kind === 'file_limited' && parsed.data.report.fileId === undefined) {
        return errorResponse(400, 'REPORT_INVALID', 'file_limited reports require fileId');
      }
      if (parsed.data.report.kind === 'auth') {
        // Frozen contract: a reported auth failure invalidates the cached
        // grant so the caller's single fresh admission retry re-acquires.
        this.tokenCache.invalidate(this.cacheKey(parsed.data.identity));
      } else {
        this.recordFailure(parsed.data.identity, parsed.data.report);
      }
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ cooldowns: this.activeCooldowns() });
    }
    return errorResponse(404, 'NOT_FOUND', 'not found');
  }

  private async readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Durable cooldown state (DO SQLite storage — the only persisted state).
  // -------------------------------------------------------------------------

  private ensureStorage(): void {
    if (this.storageInitialized) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS cooldowns (' +
        'scope_key TEXT PRIMARY KEY, ' +
        'failures INTEGER NOT NULL, ' +
        'until_ms INTEGER NOT NULL, ' +
        'reason TEXT NOT NULL, ' +
        'updated_ms INTEGER NOT NULL)',
    );
    this.storageInitialized = true;
  }

  private credentialScopeKey(identity: TokenIdentity): string {
    return `cred:${identity.provider}:${identity.credentialId}`;
  }

  private fileScopeKey(identity: TokenIdentity, fileId: string): string {
    return `file:${identity.provider}:${identity.credentialId}:${fileId}`;
  }

  private readCooldownRow(scopeKey: string): CooldownRow | undefined {
    this.ensureStorage();
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT scope_key, failures, until_ms, reason, updated_ms FROM cooldowns WHERE scope_key = ?',
        scopeKey,
      )
      .toArray() as unknown as CooldownRow[];
    return rows[0];
  }

  private activeCooldown(
    scopeKey: string,
    nowMs: number,
  ): { retryAfterMs: number; reason: string } | undefined {
    const row = this.readCooldownRow(scopeKey);
    if (row === undefined) return undefined;
    if (row.until_ms <= nowMs) {
      // Cooldown lapsed: keep the failure counter but clear the hold.
      this.ctx.storage.sql.exec(
        'UPDATE cooldowns SET until_ms = 0, updated_ms = ? WHERE scope_key = ?',
        nowMs,
        scopeKey,
      );
      return undefined;
    }
    return { retryAfterMs: row.until_ms - nowMs, reason: row.reason };
  }

  private recordFailure(
    identity: TokenIdentity,
    report: { kind: TokenFailureKind; fileId?: string; retryAfterMs?: number },
  ): void {
    const nowMs = Date.now();
    const scopeKey =
      report.kind === 'file_limited' && report.fileId !== undefined
        ? this.fileScopeKey(identity, report.fileId)
        : this.credentialScopeKey(identity);
    const existing = this.readCooldownRow(scopeKey);
    const failures = (existing?.failures ?? 0) + 1;
    const base = COOLDOWN_BASE_MS[report.kind];
    const backoff = Math.min(COOLDOWN_CAP_MS, base * 2 ** (failures - 1));
    const jitter = Math.floor(Math.random() * backoff * 0.2);
    const hinted =
      report.retryAfterMs === undefined ? 0 : Math.min(report.retryAfterMs, COOLDOWN_CAP_MS);
    const untilMs = nowMs + Math.max(backoff + jitter, hinted);
    this.ctx.storage.sql.exec(
      'INSERT INTO cooldowns (scope_key, failures, until_ms, reason, updated_ms) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(scope_key) DO UPDATE SET failures = excluded.failures, ' +
        'until_ms = excluded.until_ms, reason = excluded.reason, updated_ms = excluded.updated_ms',
      scopeKey,
      failures,
      untilMs,
      report.kind,
      nowMs,
    );
  }

  private activeCooldowns(): CooldownRow[] {
    this.ensureStorage();
    return this.ctx.storage.sql
      .exec(
        'SELECT scope_key, failures, until_ms, reason, updated_ms FROM cooldowns ' +
          'WHERE until_ms > 0 ORDER BY scope_key',
      )
      .toArray() as unknown as CooldownRow[];
  }

  // -------------------------------------------------------------------------
  // Admission.
  // -------------------------------------------------------------------------

  private cacheKey(identity: TokenIdentity): string {
    // Scopes are normalized first so an unsanitized caller cannot mint a
    // second cache key for the same scope set.
    return tokenIdentityKey({ ...identity, scopes: normalizeScopes(identity.scopes) });
  }

  private async admit(
    identity: TokenIdentity,
    fileId: string | undefined,
  ): Promise<TokenResult> {
    const nowMs = Date.now();

    // 0. Maintenance gate (wave-4 T14, spec §9.2): while the
    //    maintenance_state singleton holds an active mode (drain or
    //    key-rotation), no new token is issued — rotation re-seals the very
    //    envelopes a grant would consume, so admission must pause. The
    //    check runs before identity verification and the RAM cache; a D1
    //    read error fails closed rather than racing a rotation.
    let maintenance: boolean;
    try {
      maintenance = await isMaintenanceActive(this.env.DB);
    } catch {
      maintenance = true;
    }
    if (maintenance) {
      return tokenFail('UPSTREAM_UNAVAILABLE', {
        retryAfterMs: 60_000,
        detail: 'maintenance_mode',
      });
    }

    // 1. Re-read the authoritative identity row and verify every supplied
    //    field. A stale pin never gets a token under the new row's authority.
    const check = await this.verifyIdentity(identity);
    if (!check.ok) return check.result;

    // 2. Cooldowns: credential scope, then file scope when the caller named a
    //    file. Both return COOLDOWN; there is no alternate identity to try.
    const credentialCooldown = this.activeCooldown(this.credentialScopeKey(identity), nowMs);
    if (credentialCooldown !== undefined) {
      return tokenFail('COOLDOWN', {
        retryAfterMs: credentialCooldown.retryAfterMs,
        detail: `credential cooling down (${credentialCooldown.reason})`,
      });
    }
    if (fileId !== undefined) {
      const fileCooldown = this.activeCooldown(this.fileScopeKey(identity, fileId), nowMs);
      if (fileCooldown !== undefined) {
        return tokenFail('COOLDOWN', {
          retryAfterMs: fileCooldown.retryAfterMs,
          detail: `file cooling down (${fileCooldown.reason})`,
        });
      }
    }

    // 3. RAM cache keyed by the full identity/version/scope tuple.
    const key = this.cacheKey(identity);
    const cached = this.tokenCache.get(key);
    if (cached !== undefined) return tokenOk(cached.accessToken, cached.expiresAtMs);

    // 4. Single-flight acquisition so N concurrent admissions share one
    //    upstream grant. The row re-read happens AFTER the await on every
    //    waiter — no cached or in-flight short-circuit may vend a token minted
    //    against credentials that changed while the grant was outstanding.
    const flight = await this.singleFlight.run(key, () => this.acquire(identity, check.record));
    if (!flight.result.ok) return flight.result;
    // The only tolerated version drift is exactly the +1 caused by our own
    // rotation CAS (flight.rotated); every other change fails the vend.
    const recheck = await this.recheckAfterGrant(check.record, flight.rotated);
    if (recheck !== null) return recheck;
    this.tokenCache.set(key, flight.result);
    return flight.result;
  }

  /**
   * Post-grant row re-read executed by every waiter after the single-flight
   * await. `rotated` is true when our own refresh-token rotation CAS bumped
   * the connection version during the grant.
   */
  private async recheckAfterGrant(
    record: VerifiedIdentity,
    rotated: boolean,
  ): Promise<TokenResult | null> {
    if (record.kind === 'oauth') {
      const row = await readConnection(this.env.DB, record.connection.id);
      if (row === null || !row.enabled || row.state === 'disabled') {
        return tokenFail('CREDENTIAL_DISABLED');
      }
      if (row.state === 'needs_reauth') {
        return tokenFail('OAUTH_NEEDS_REAUTH');
      }
      const expectedVersion = record.connection.version + (rotated ? 1 : 0);
      if (
        row.version !== expectedVersion ||
        row.principalId !== record.connection.principalId ||
        row.oauthClientId !== record.connection.oauthClientId
      ) {
        return tokenFail('CREDENTIAL_VERSION_CHANGED');
      }
      // The OAuth client row is part of the issued token's authority too:
      // a disable or client rotation during the grant rejects the vend.
      const client = await readOAuthClient(this.env.DB, record.client.id);
      if (client === null || !client.enabled) {
        return tokenFail('CREDENTIAL_DISABLED');
      }
      if (
        client.version !== record.client.version ||
        client.projectId !== record.client.projectId ||
        client.clientId !== record.client.clientId
      ) {
        return tokenFail('CREDENTIAL_VERSION_CHANGED');
      }
      return null;
    }
    const row = await this.env.DB
      .prepare(
        'SELECT enabled, version, email, project_id FROM service_accounts WHERE id = ?',
      )
      .bind(record.row.id)
      .first<{ enabled: number; version: number; email: string; project_id: string }>();
    if (row === null || row.enabled !== 1) return tokenFail('CREDENTIAL_DISABLED');
    if (
      row.version !== record.row.version ||
      row.email !== record.row.email ||
      row.project_id !== record.row.project_id
    ) {
      return tokenFail('CREDENTIAL_VERSION_CHANGED');
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Identity verification against the current D1 rows.
  // -------------------------------------------------------------------------

  private async verifyIdentity(
    identity: TokenIdentity,
  ): Promise<
    | { ok: true; record: VerifiedIdentity }
    | { ok: false; result: TokenResult }
  > {
    if (identity.provider === 'google_oauth') {
      return this.verifyOAuthIdentity(identity);
    }
    return this.verifyServiceAccountIdentity(identity);
  }

  private async verifyOAuthIdentity(
    identity: OAuthTokenIdentity,
  ): Promise<
    | { ok: true; record: VerifiedIdentity }
    | { ok: false; result: TokenResult }
  > {
    const db = this.env.DB;
    const connection = await readConnection(db, identity.credentialId);
    if (connection === null || !connection.enabled || connection.state === 'disabled') {
      return { ok: false, result: tokenFail('CREDENTIAL_DISABLED') };
    }
    if (connection.state === 'needs_reauth') {
      return { ok: false, result: tokenFail('OAUTH_NEEDS_REAUTH') };
    }
    if (
      connection.oauthClientId !== identity.oauthClientId ||
      connection.principalId !== identity.principalId ||
      connection.version !== identity.credentialVersion
    ) {
      return { ok: false, result: tokenFail('CREDENTIAL_VERSION_CHANGED') };
    }
    const client = await readOAuthClient(db, identity.oauthClientId);
    if (client === null || !client.enabled) {
      return { ok: false, result: tokenFail('CREDENTIAL_DISABLED') };
    }
    if (
      client.version !== identity.oauthClientVersion ||
      client.projectId !== identity.projectId
    ) {
      return { ok: false, result: tokenFail('CREDENTIAL_VERSION_CHANGED') };
    }
    // Requested scopes must be a subset of what the grant actually carries.
    const granted = new Set(connection.grantedScopes.split(' ').filter(Boolean));
    const missing = identity.scopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      return {
        ok: false,
        result: tokenFail('OAUTH_NEEDS_REAUTH', { detail: 'scope_not_granted' }),
      };
    }
    return { ok: true, record: { kind: 'oauth', connection, client } };
  }

  private async verifyServiceAccountIdentity(
    identity: ServiceAccountTokenIdentity,
  ): Promise<
    | { ok: true; record: VerifiedIdentity }
    | { ok: false; result: TokenResult }
  > {
    const row = await this.env.DB
      .prepare(
        'SELECT id, project_id, email, key_id, envelope, enabled, version ' +
          'FROM service_accounts WHERE id = ?',
      )
      .bind(identity.credentialId)
      .first<ServiceAccountRecord>();
    if (row === null || row.enabled !== 1) {
      return { ok: false, result: tokenFail('CREDENTIAL_DISABLED') };
    }
    if (
      row.version !== identity.credentialVersion ||
      row.project_id !== identity.projectId ||
      row.email !== identity.principalId
    ) {
      return { ok: false, result: tokenFail('CREDENTIAL_VERSION_CHANGED') };
    }
    // SA scope allowlist: drive.readonly only, regardless of caller input.
    const denied = identity.scopes
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0 && scope !== SA_READ_SCOPE);
    if (denied.length > 0) {
      return {
        ok: false,
        result: tokenFail('UPSTREAM_AUTH_FAILED', { detail: 'sa_scope_denied' }),
      };
    }
    return { ok: true, record: { kind: 'service_account', row } };
  }

  // -------------------------------------------------------------------------
  // Upstream acquisition (runs inside the single-flight).
  // -------------------------------------------------------------------------

  private async acquire(
    identity: TokenIdentity,
    record: VerifiedIdentity,
  ): Promise<{ result: TokenResult; rotated: boolean }> {
    const fetchImpl = resolveGoogleFetch();
    if (identity.provider === 'google_oauth' && record.kind === 'oauth') {
      return this.acquireOAuth(identity, record, fetchImpl);
    }
    if (identity.provider === 'service_account' && record.kind === 'service_account') {
      const result = await this.acquireServiceAccount(identity, record.row, fetchImpl);
      return { result, rotated: false };
    }
    return { result: tokenFail('CREDENTIAL_VERSION_CHANGED'), rotated: false };
  }

  private async acquireOAuth(
    identity: OAuthTokenIdentity,
    record: Extract<VerifiedIdentity, { kind: 'oauth' }>,
    fetchImpl: FetchLike,
  ): Promise<{ result: TokenResult; rotated: boolean }> {
    const { connection, client } = record;
    if (connection.refreshEnvelope === null) {
      return {
        result: tokenFail('OAUTH_NEEDS_REAUTH', { detail: 'missing_refresh_token' }),
        rotated: false,
      };
    }
    const vault = createVaultKeyring(this.env);
    let refreshToken: string;
    let clientSecret: string;
    try {
      refreshToken = textDecoder.decode(
        await vault.openSecret(
          decodeEnvelope(connection.refreshEnvelope),
          oauthRefreshTokenContext(connection.id, client.projectId),
        ),
      );
      clientSecret = textDecoder.decode(
        await vault.openSecret(
          decodeEnvelope(client.secretEnvelope),
          oauthClientSecretContext(client.id, client.projectId),
        ),
      );
    } catch {
      return {
        result: tokenFail('UPSTREAM_AUTH_FAILED', { detail: 'credential_envelope_invalid' }),
        rotated: false,
      };
    }
    const grant = await refreshAccessToken(
      { refreshToken, clientId: client.clientId, clientSecret },
      fetchImpl,
    );
    return this.finishOAuthGrant(identity, record, grant);
  }

  private async finishOAuthGrant(
    identity: OAuthTokenIdentity,
    record: Extract<VerifiedIdentity, { kind: 'oauth' }>,
    grant: GoogleEndpointResult<GoogleTokenGrant>,
  ): Promise<{ result: TokenResult; rotated: boolean }> {
    const { connection } = record;
    if (grant.ok) {
      const { value } = grant;
      let rotated = false;
      if (value.refreshToken !== undefined) {
        // Google rotated the refresh token: persist it under CAS so a stale
        // refresh response can never overwrite newer material. A successful
        // CAS is the legitimate +1 version drift recheckAfterGrant tolerates.
        try {
          const vault = createVaultKeyring(this.env);
          const sealed = await vault.sealSecret(
            new TextEncoder().encode(value.refreshToken),
            oauthRefreshTokenContext(connection.id, record.client.projectId),
          );
          rotated = await casRotateRefreshEnvelope(
            this.env.DB,
            connection.id,
            connection.version,
            JSON.stringify(sealed),
            Date.now(),
          );
        } catch {
          // Rotation persistence is best-effort; the old token may still work.
        }
      }
      return {
        result: tokenOk(value.accessToken, Date.now() + value.expiresInSec * 1000),
        rotated,
      };
    }
    if (grant.kind === 'oauth_error' && grant.error === 'invalid_grant') {
      await markConnectionNeedsReauth(this.env.DB, connection.id, connection.version, Date.now());
      return { result: tokenFail('OAUTH_NEEDS_REAUTH', { detail: 'invalid_grant' }), rotated: false };
    }
    if (grant.kind === 'oauth_error') {
      return { result: tokenFail('UPSTREAM_AUTH_FAILED', { detail: grant.error }), rotated: false };
    }
    this.recordFailure(identity, { kind: 'upstream_5xx' });
    return {
      result: tokenFail('UPSTREAM_UNAVAILABLE', { retryAfterMs: COOLDOWN_BASE_MS.upstream_5xx }),
      rotated: false,
    };
  }

  private async acquireServiceAccount(
    identity: ServiceAccountTokenIdentity,
    row: ServiceAccountRecord,
    fetchImpl: FetchLike,
  ): Promise<TokenResult> {
    const vault = createVaultKeyring(this.env);
    let material: { client_email?: unknown; private_key?: unknown; private_key_id?: unknown };
    try {
      const opened = await vault.openSecret(
        decodeEnvelope(row.envelope),
        serviceAccountKeyContext(row.id, row.project_id),
      );
      material = JSON.parse(textDecoder.decode(opened)) as typeof material;
    } catch {
      return tokenFail('UPSTREAM_AUTH_FAILED', { detail: 'credential_envelope_invalid' });
    }
    if (
      typeof material.client_email !== 'string' ||
      typeof material.private_key !== 'string' ||
      material.client_email !== row.email
    ) {
      // Envelope content disagrees with the authoritative row: quarantine.
      this.recordFailure(identity, { kind: 'auth' });
      return tokenFail('UPSTREAM_AUTH_FAILED', { detail: 'sa_material_mismatch' });
    }
    const scopes = identity.scopes.map((scope) => scope.trim()).filter(Boolean);
    let assertion: string;
    try {
      // signServiceAccountJwt itself enforces the drive.readonly allowlist.
      assertion = await signServiceAccountJwt(
        {
          clientEmail: material.client_email,
          privateKeyPem: material.private_key,
          privateKeyId:
            typeof material.private_key_id === 'string' ? material.private_key_id : undefined,
        },
        scopes,
      );
    } catch {
      this.recordFailure(identity, { kind: 'auth' });
      return tokenFail('UPSTREAM_AUTH_FAILED', { detail: 'sa_key_unusable' });
    }
    const grant = await exchangeServiceAccountJwt(assertion, fetchImpl);
    if (grant.ok) {
      return tokenOk(grant.value.accessToken, Date.now() + grant.value.expiresInSec * 1000);
    }
    if (grant.kind === 'oauth_error') {
      this.recordFailure(identity, { kind: 'auth' });
      return tokenFail('UPSTREAM_AUTH_FAILED', { detail: grant.error });
    }
    this.recordFailure(identity, { kind: 'upstream_5xx' });
    return tokenFail('UPSTREAM_UNAVAILABLE', { retryAfterMs: COOLDOWN_BASE_MS.upstream_5xx });
  }
}

type VerifiedIdentity =
  | { readonly kind: 'oauth'; readonly connection: ConnectionRow; readonly client: OAuthClientRow }
  | { readonly kind: 'service_account'; readonly row: ServiceAccountRecord };
