/**
 * Admin Google OAuth lifecycle routes (architecture §5.5), exported as
 * createOAuthRouter() with paths relative to /api/v1/admin/google.
 *
 * Flow invariants enforced here:
 * - every handler independently resolves the admin session; no handler trusts
 *   browser-supplied principal, token or session claims;
 * - state is random, one-use (atomic consume), TTL-bound and tied to the
 *   admin session, installation, OAuth client row version and connect/
 *   reconnect purpose; PKCE S256 verifier stays sealed until exchange;
 * - the callback verifies the request landed on the exact redirect URI
 *   recorded when the transaction was created;
 * - reconnect updates the existing connection by CAS on its version and
 *   never replaces the stored refresh token with an empty response;
 * - local disconnect is distinct from an explicit Google grant revocation.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { requireAdmin as realRequireAdmin } from '../../auth/session';
import {
  API_ERROR_CODES,
  apiError as buildApiError,
  type ApiErrorCode,
  type ConnectionView,
  type OAuthClientView,
} from '../../../shared/contracts';
import {
  createSecretKeyring,
  createVaultKeyring,
  decodeEnvelope,
  encodeEnvelope,
} from '../../security/vault';
import {
  oauthClientSecretContext,
  oauthPkceVerifierContext,
  oauthRefreshTokenContext,
  resolveGoogleFetch,
  type FetchLike,
} from '../tokens';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchAboutUser,
  GOOGLE_DRIVE_SCOPE,
  revokeToken,
  type GoogleEndpointResult,
} from './google';
import {
  generatePkceVerifier,
  hashOAuthState,
  pkceS256Challenge,
  randomBase64Url,
} from './crypto';
import {
  casUpdateConnection,
  clearConnectionRefreshEnvelope,
  disableConnection,
  findConnectionByClientPrincipal,
  insertConnection,
  insertOAuthTransaction,
  consumeOAuthTransaction,
  listConnections,
  readAppSettings,
  readConnection,
  readOAuthClient,
  type ConnectionRow,
  type OAuthClientRow,
} from './transactions';

/** State TTL: 10 minutes (plan global constraints). */
const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** Fixed callback path; the full redirect URI is canonicalOrigin + this. */
export const OAUTH_CALLBACK_PATH = '/api/v1/admin/google/oauth/callback';

const REQUIRED_SCOPES = [GOOGLE_DRIVE_SCOPE] as const;

/** Resolved admin identity; A's requireAdmin satisfies this frozen contract. */
export interface AdminIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Frozen wave-2 auth contract: resolves the admin identity or throws
 * `AuthError` carrying `{status: 401|403|503, code: ApiErrorCode}`. The
 * default wiring uses A's `requireAdmin` from `../../auth/session`; tests
 * inject a fixture instead.
 */
export type RequireAdminFn = (request: Request, env: Env) => Promise<AdminIdentity>;

export interface OAuthRouterDeps {
  readonly requireAdmin?: RequireAdminFn;
  /** Google endpoint transport (fixture in tests, real fetch in production). */
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

type RouterContext = Context<{ Bindings: Env; Variables: { requestId?: string } }>;

function fail(
  c: RouterContext,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): Response {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  return c.json(buildApiError(code, message, requestId), status);
}

const KNOWN_API_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

interface AuthErrorLike {
  readonly status: number;
  readonly code: string;
  readonly message?: string;
}

function isAuthErrorLike(err: unknown): err is AuthErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

function safeMessage(err: AuthErrorLike, fallback: string): string {
  return typeof err.message === 'string' && err.message.length > 0 && err.message.length <= 300
    ? err.message
    : fallback;
}

async function adminOrResponse(
  c: RouterContext,
  requireAdmin: RequireAdminFn,
): Promise<{ admin: AdminIdentity } | { response: Response }> {
  try {
    return { admin: await requireAdmin(c.req.raw, c.env) };
  } catch (err) {
    if (
      isAuthErrorLike(err) &&
      (err.status === 401 || err.status === 403 || err.status === 503)
    ) {
      const fallback: ApiErrorCode =
        err.status === 401
          ? 'AUTH_REQUIRED'
          : err.status === 403
            ? 'FORBIDDEN'
            : 'AUTH_UNAVAILABLE';
      const code: ApiErrorCode = KNOWN_API_CODES.has(err.code)
        ? (err.code as ApiErrorCode)
        : fallback;
      const fallbackMessage =
        err.status === 401
          ? 'Authentication is required.'
          : err.status === 403
            ? 'Forbidden.'
            : 'Authentication is unavailable.';
      return {
        response: fail(
          c,
          err.status as ContentfulStatusCode,
          code,
          safeMessage(err, fallbackMessage),
        ),
      };
    }
    return { response: fail(c, 500, 'INTERNAL_ERROR', 'Internal error.') };
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function connectionView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    displayEmail: row.displayEmail,
    state: row.state,
    enabled: row.enabled,
    grantedScopes: row.grantedScopes.split(' ').filter(Boolean),
    oauthClientId: row.oauthClientId,
    connectedBy: row.connectedBy,
    version: row.version,
    createdAt: iso(row.createdAt),
  };
}

function clientView(row: OAuthClientRow): OAuthClientView {
  return {
    id: row.id,
    projectId: row.projectId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    enabled: row.enabled,
    version: row.version,
    createdAt: iso(row.createdAt),
  };
}

interface CallbackError {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly message: string;
}

function callbackFailure(
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): CallbackError {
  return { status, code, message };
}

const startBodySchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('connect'), oauthClientId: z.string().min(1).max(256) }).strict(),
  z
    .object({ purpose: z.literal('reconnect'), connectionId: z.string().min(1).max(256) })
    .strict(),
]);

const callbackQuerySchema = z
  .object({
    state: z.string().min(1).max(512).optional(),
    code: z.string().min(1).max(2048).optional(),
    error: z.string().min(1).max(128).optional(),
  })
  .strict();

export function createOAuthRouter(deps: OAuthRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const fetchImpl = deps.fetchImpl ?? resolveGoogleFetch();
  const now = deps.now ?? Date.now;

  // -------------------------------------------------------------------------
  // GET /clients — admin picks which Google OAuth client to connect through.
  // -------------------------------------------------------------------------
  app.get('/clients', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const rows = await c.env.DB
      .prepare(
        'SELECT id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at ' +
          'FROM google_oauth_clients ORDER BY created_at, id',
      )
      .all<{
        id: string;
        project_id: string;
        client_id: string;
        secret_envelope: string;
        redirect_uri: string;
        enabled: number;
        version: number;
        created_at: number;
      }>();
    const clients: OAuthClientView[] = (rows.results ?? []).map((r) =>
      clientView({
        id: r.id,
        projectId: r.project_id,
        clientId: r.client_id,
        secretEnvelope: r.secret_envelope,
        redirectUri: r.redirect_uri,
        enabled: r.enabled === 1,
        version: r.version,
        createdAt: r.created_at,
      }),
    );
    return c.json({ clients });
  });

  // -------------------------------------------------------------------------
  // GET /connections — admin-safe connection list (no envelopes, no tokens).
  // -------------------------------------------------------------------------
  app.get('/connections', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const connections = (await listConnections(c.env.DB)).map(connectionView);
    return c.json({ connections });
  });

  // -------------------------------------------------------------------------
  // POST /oauth/start — begin connect or reconnect; returns the Google URL.
  // -------------------------------------------------------------------------
  app.post('/oauth/start', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.');
    }
    const parsed = startBodySchema.safeParse(body);
    if (!parsed.success) {
      return fail(c, 400, 'VALIDATION_FAILED', 'Invalid OAuth start request.');
    }
    const input = parsed.data;

    const settings = await readAppSettings(c.env.DB);
    if (
      settings === null ||
      settings.setupState !== 'complete' ||
      settings.installationId === null ||
      settings.canonicalOrigin === null
    ) {
      return fail(c, 503, 'SETUP_REQUIRED', 'Initial setup has not completed.');
    }

    // Resolve the OAuth client and (for reconnect) the target connection.
    let client: OAuthClientRow | null;
    let targetConnectionId: string | null = null;
    if (input.purpose === 'connect') {
      client = await readOAuthClient(c.env.DB, input.oauthClientId);
      if (client === null) return fail(c, 404, 'NOT_FOUND', 'OAuth client not found.');
    } else {
      const target = await readConnection(c.env.DB, input.connectionId);
      if (target === null) return fail(c, 404, 'NOT_FOUND', 'Connection not found.');
      if (!target.enabled || target.state === 'disabled') {
        return fail(
          c,
          409,
          'GOOGLE_CONNECTION_DISABLED',
          'Connection is disabled; create a new connection instead.',
        );
      }
      client = await readOAuthClient(c.env.DB, target.oauthClientId);
      if (client === null) {
        return fail(c, 409, 'GOOGLE_CONNECTION_DISABLED', 'OAuth client is no longer available.');
      }
      targetConnectionId = target.id;
    }
    if (!client.enabled) {
      return fail(c, 409, 'GOOGLE_CONNECTION_DISABLED', 'OAuth client is disabled.');
    }

    const redirectUri = new URL(OAUTH_CALLBACK_PATH, settings.canonicalOrigin).toString();
    const state = randomBase64Url(32);
    const transactionId = crypto.randomUUID();
    const verifier = generatePkceVerifier();
    const challenge = await pkceS256Challenge(verifier);

    const box = createSecretKeyring<string>(c.env, 'vault');
    const pkceEnvelope = encodeEnvelope(
      await box.sealSecret(
        new TextEncoder().encode(verifier),
        oauthPkceVerifierContext(transactionId, client.projectId),
      ),
    );

    await insertOAuthTransaction(c.env.DB, {
      id: transactionId,
      stateHash: await hashOAuthState(state),
      adminSessionId: auth.admin.sessionId,
      installationId: settings.installationId,
      oauthClientId: client.id,
      clientVersion: client.version,
      purpose: input.purpose,
      targetConnectionId,
      redirectUri,
      pkceEnvelope,
      expiresAtMs: now() + OAUTH_STATE_TTL_MS,
      createdAtMs: now(),
    });

    return c.json({
      authorizationUrl: buildAuthorizationUrl({
        clientId: client.clientId,
        redirectUri,
        state,
        codeChallenge: challenge,
        scopes: REQUIRED_SCOPES,
      }),
    });
  });

  // -------------------------------------------------------------------------
  // GET /oauth/callback — Google redirect target (exact URI, one-use state).
  // -------------------------------------------------------------------------
  app.get('/oauth/callback', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;

    const query = callbackQuerySchema.safeParse({
      state: c.req.query('state'),
      code: c.req.query('code'),
      error: c.req.query('error'),
    });
    if (!query.success) {
      return fail(c, 400, 'VALIDATION_FAILED', 'Malformed OAuth callback.');
    }
    if (query.data.error !== undefined) {
      // Google echoed an authorization failure (e.g. access_denied).
      return fail(
        c,
        400,
        'GOOGLE_REAUTH_REQUIRED',
        'Google authorization did not complete; start the connection again.',
      );
    }
    if (query.data.state === undefined || query.data.code === undefined) {
      return fail(c, 400, 'VALIDATION_FAILED', 'OAuth callback requires state and code.');
    }

    const consume = await consumeOAuthTransaction(
      c.env.DB,
      await hashOAuthState(query.data.state),
      now(),
    );
    if (consume.status !== 'consumed') {
      return fail(
        c,
        400,
        'VALIDATION_FAILED',
        'OAuth state is unknown, expired or already used.',
      );
    }
    const tx = consume.transaction;

    // Binding checks: same admin session, same installation, same client row
    // version, and the request arrived on the exact recorded redirect URI.
    if (tx.adminSessionId !== auth.admin.sessionId) {
      return fail(c, 403, 'FORBIDDEN', 'OAuth state belongs to a different admin session.');
    }
    const settings = await readAppSettings(c.env.DB);
    if (settings === null || settings.installationId !== tx.installationId) {
      return fail(c, 403, 'FORBIDDEN', 'OAuth state belongs to a different installation.');
    }
    const requestUrl = new URL(c.req.url);
    if (`${requestUrl.origin}${requestUrl.pathname}` !== tx.redirectUri) {
      return fail(c, 400, 'VALIDATION_FAILED', 'OAuth redirect URI does not match.');
    }

    const client = await readOAuthClient(c.env.DB, tx.oauthClientId);
    if (client === null || !client.enabled || client.version !== tx.clientVersion) {
      return fail(
        c,
        409,
        'GOOGLE_CONNECTION_DISABLED',
        'OAuth client changed during the flow; start again.',
      );
    }
    if (tx.pkceEnvelope === null) {
      return fail(c, 400, 'VALIDATION_FAILED', 'OAuth transaction is missing its verifier.');
    }

    // R11: freeze the reconnect target BEFORE any Google network call. The
    // post-exchange persist CASes exactly this version — a mid-flight
    // disconnect or competing reconnect bumps the row and fences the write.
    let reconnectTarget: ConnectionRow | null = null;
    if (tx.purpose === 'reconnect') {
      if (tx.targetConnectionId === null) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'Reconnect transaction is missing its target connection.',
        );
      }
      reconnectTarget = await readConnection(c.env.DB, tx.targetConnectionId);
      if (reconnectTarget === null) {
        return fail(c, 404, 'NOT_FOUND', 'Reconnect target no longer exists.');
      }
      if (!reconnectTarget.enabled || reconnectTarget.state === 'disabled') {
        return fail(
          c,
          409,
          'GOOGLE_CONNECTION_DISABLED',
          'The target connection was disabled; start a new connect instead.',
        );
      }
      if (reconnectTarget.oauthClientId !== tx.oauthClientId) {
        return fail(
          c,
          409,
          'GOOGLE_CONNECTION_DISABLED',
          'Reconnect target moved to a different OAuth client.',
        );
      }
    }

    const vault = createVaultKeyring(c.env);
    const box = createSecretKeyring<string>(c.env, 'vault');
    let verifier: string;
    let clientSecret: string;
    try {
      verifier = new TextDecoder().decode(
        await box.openSecret(
          decodeEnvelope(tx.pkceEnvelope),
          oauthPkceVerifierContext(tx.id, client.projectId),
        ),
      );
      clientSecret = new TextDecoder().decode(
        await vault.openSecret(
          decodeEnvelope(client.secretEnvelope),
          oauthClientSecretContext(client.id, client.projectId),
        ),
      );
    } catch {
      return fail(c, 500, 'INTERNAL_ERROR', 'Could not open OAuth credential envelopes.');
    }
    if (verifier.length === 0) {
      return fail(c, 400, 'VALIDATION_FAILED', 'OAuth transaction verifier is invalid.');
    }

    const exchange = await exchangeAuthorizationCode(
      {
        code: query.data.code,
        redirectUri: tx.redirectUri,
        clientId: client.clientId,
        clientSecret,
        codeVerifier: verifier,
      },
      fetchImpl,
    );
    if (!exchange.ok) {
      return fail(
        c,
        exchange.kind === 'transport_error' ? 502 : 400,
        exchange.kind === 'oauth_error' && exchange.error === 'invalid_grant'
          ? 'GOOGLE_REAUTH_REQUIRED'
          : 'DRIVE_UNAVAILABLE',
        'Google token exchange failed; start the connection again.',
      );
    }
    const grant = exchange.value;

    // Required scope and Drive principal identity must both be present before
    // the connection can serve catalog/write operations.
    const hasRequiredScope = REQUIRED_SCOPES.every((scope) =>
      grant.grantedScopes.includes(scope),
    );
    const about = await fetchAboutUser(grant.accessToken, fetchImpl);
    if (!about.ok) {
      return fail(c, 502, 'DRIVE_UNAVAILABLE', 'Could not resolve the Google account identity.');
    }
    const principal = about.value;

    const outcome = await persistConnection(
      c.env,
      tx,
      client,
      reconnectTarget,
      grant.refreshToken,
      {
        principalId: principal.permissionId,
        displayEmail: principal.emailAddress ?? null,
        grantedScopes: grant.grantedScopes.join(' '),
        hasRequiredScope,
        adminUserId: auth.admin.userId,
        nowMs: now(),
      },
    );
    if ('error' in outcome) {
      return fail(c, outcome.error.status, outcome.error.code, outcome.error.message);
    }
    return c.json({ connection: connectionView(outcome.connection) });
  });

  // -------------------------------------------------------------------------
  // POST /connections/:id/disconnect — local disable + token removal only.
  // -------------------------------------------------------------------------
  app.post('/connections/:id/disconnect', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const connection = await readConnection(c.env.DB, c.req.param('id'));
    if (connection === null) return fail(c, 404, 'NOT_FOUND', 'Connection not found.');
    if (connection.enabled) {
      await disableConnection(c.env.DB, connection.id, now());
      const updated = await readConnection(c.env.DB, connection.id);
      if (updated !== null && updated.refreshEnvelope !== null) {
        await clearConnectionRefreshEnvelope(
          c.env.DB,
          connection.id,
          updated.version,
          now(),
        );
      }
    }
    const row = await readConnection(c.env.DB, connection.id);
    return c.json({ connection: connectionView(row ?? connection) });
  });

  // -------------------------------------------------------------------------
  // POST /connections/:id/revoke — explicit Google grant revocation, then the
  // same local disable. The upstream outcome is reported truthfully.
  // -------------------------------------------------------------------------
  app.post('/connections/:id/revoke', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const connection = await readConnection(c.env.DB, c.req.param('id'));
    if (connection === null) return fail(c, 404, 'NOT_FOUND', 'Connection not found.');

    let revokedUpstream = false;
    if (connection.refreshEnvelope !== null) {
      const client = await readOAuthClient(c.env.DB, connection.oauthClientId);
      const vault = createVaultKeyring(c.env);
      try {
        const refreshToken = new TextDecoder().decode(
          await vault.openSecret(
            decodeEnvelope(connection.refreshEnvelope),
            oauthRefreshTokenContext(
              connection.id,
              client?.projectId ?? '',
            ),
          ),
        );
        const revoked: GoogleEndpointResult<true> = await revokeToken(refreshToken, fetchImpl);
        revokedUpstream = revoked.ok;
      } catch {
        revokedUpstream = false;
      }
    }

    await disableConnection(c.env.DB, connection.id, now());
    const updated = await readConnection(c.env.DB, connection.id);
    if (updated !== null && updated.refreshEnvelope !== null) {
      await clearConnectionRefreshEnvelope(c.env.DB, connection.id, updated.version, now());
    }
    const row = await readConnection(c.env.DB, connection.id);
    return c.json({
      revokedUpstream,
      connection: connectionView(row ?? connection),
    });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Persist the exchanged grant onto a connection row (connect insert or
// reconnect CAS update).
// ---------------------------------------------------------------------------

interface PersistedIdentity {
  readonly principalId: string;
  readonly displayEmail: string | null;
  readonly grantedScopes: string;
  readonly hasRequiredScope: boolean;
  readonly adminUserId: string;
  readonly nowMs: number;
}

async function persistConnection(
  env: Env,
  tx: {
    readonly id: string;
    readonly oauthClientId: string;
    readonly clientVersion: number;
    readonly purpose: 'connect' | 'reconnect';
    readonly targetConnectionId: string | null;
  },
  client: OAuthClientRow,
  reconnectTarget: ConnectionRow | null,
  refreshToken: string | undefined,
  identity: PersistedIdentity,
): Promise<{ connection: ConnectionRow } | { error: CallbackError }> {
  const db = env.DB;
  const vault = createVaultKeyring(env);

  const conflict = (): { error: CallbackError } => ({
    error: callbackFailure(
      409,
      'VALIDATION_FAILED',
      'Google connection state changed during the flow; nothing was updated — start the connection again.',
    ),
  });

  // R11: the OAuth client row is re-read immediately before persisting; any
  // mid-flight client disable/version change rejects the callback outright.
  const currentClient = await readOAuthClient(db, tx.oauthClientId);
  if (
    currentClient === null ||
    !currentClient.enabled ||
    currentClient.version !== tx.clientVersion
  ) {
    return conflict();
  }

  // State derived from what Google actually returned: a missing refresh token
  // means the connection is not durable yet (re-consent required), missing
  // scope means it is connected but cannot serve catalog/write.
  const deriveState = (hasRefresh: boolean): 'connected' | 'degraded' | 'needs_reauth' => {
    if (!hasRefresh) return 'needs_reauth';
    if (!identity.hasRequiredScope) return 'degraded';
    return 'connected';
  };

  const sealRefresh = async (connectionId: string): Promise<string | null> => {
    if (refreshToken === undefined) return null;
    return encodeEnvelope(
      await vault.sealSecret(
        new TextEncoder().encode(refreshToken),
        oauthRefreshTokenContext(connectionId, client.projectId),
      ),
    );
  };

  // Reconnect must land on its target row with the same Google principal and
  // client; a different principal/client can only ever create a new
  // connection, so the pin of in-flight uploads is never moved. The CAS uses
  // the version frozen before the Google network calls — one fenced write,
  // never a rebase of a stale result onto a newer row.
  if (tx.purpose === 'reconnect') {
    if (
      reconnectTarget === null ||
      reconnectTarget.principalId !== identity.principalId ||
      reconnectTarget.oauthClientId !== tx.oauthClientId
    ) {
      return {
        error: callbackFailure(
          403,
          'FORBIDDEN',
          'Reconnect returned a different Google identity; the connection was not updated.',
        ),
      };
    }
    const sealedEnvelope = await sealRefresh(reconnectTarget.id);
    const applied = await casUpdateConnection(
      db,
      reconnectTarget.id,
      reconnectTarget.version,
      {
        refreshEnvelope: sealedEnvelope ?? undefined,
        grantedScopes: identity.grantedScopes,
        displayEmail: identity.displayEmail,
        state: deriveState(
          sealedEnvelope !== null || reconnectTarget.refreshEnvelope !== null,
        ),
        nowMs: identity.nowMs,
      },
      { id: tx.oauthClientId, version: tx.clientVersion },
    );
    if (!applied) return conflict();
    const refreshed = await readConnection(db, reconnectTarget.id);
    if (refreshed === null) return conflict();
    return { connection: refreshed };
  }

  // Connect must never mutate an existing (client, principal) row: a stale
  // connect response could otherwise clobber a newer reconnect. The admin is
  // directed to the explicit reconnect path instead.
  const existing = await findConnectionByClientPrincipal(
    db,
    tx.oauthClientId,
    identity.principalId,
  );
  if (existing !== null) {
    return {
      error: callbackFailure(
        409,
        'VALIDATION_FAILED',
        'A connection already exists for this Google identity and client; start an explicit reconnect.',
      ),
    };
  }

  const connectionId = crypto.randomUUID();
  const sealed = await sealRefresh(connectionId);
  const inserted = await insertConnection(
    db,
    {
      id: connectionId,
      oauthClientId: tx.oauthClientId,
      principalId: identity.principalId,
      displayEmail: identity.displayEmail,
      refreshEnvelope: sealed,
      grantedScopes: identity.grantedScopes,
      state: deriveState(sealed !== null),
      connectedBy: identity.adminUserId,
      nowMs: identity.nowMs,
    },
    { id: tx.oauthClientId, version: tx.clientVersion },
  );
  if (!inserted) return conflict();
  const created = await readConnection(db, connectionId);
  if (created === null) {
    return { error: callbackFailure(500, 'INTERNAL_ERROR', 'Connection was not persisted.') };
  }
  return { connection: created };
}
