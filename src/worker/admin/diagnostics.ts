/**
 * Admin diagnostics routes (architecture §13, plan T14; wave-4 worker E),
 * exported as createDiagnosticsRouter() with paths relative to
 * /api/v1/admin/diagnostics.
 *
 * GET / returns a single redacted view that strictly separates the two
 * credential planes (spec §13: a needs_reauth OAuth connection must not
 * mark downloads down, and a readable SA pool must not imply uploads work):
 *
 *   oauth.connections  — catalog/write plane: per-connection state,
 *                        enabled flag, active cooldowns and failure counts
 *                        reported by the project coordinators.
 *   serviceAccounts    — content-read plane: per-SA enabled flag,
 *                        cooldown and accumulated failure count.
 *   uploads            — D1 projection aggregates: per-state counts,
 *                        confirmed bytes and completed-but-reader-blocked.
 *   readers            — file_readiness state counts.
 *   audit              — error events per operation over the last 24 h.
 *   maintenance        — maintenance_state snapshot (mode/phase).
 *
 * Redaction contract: every field is an id, enum, count or bounded timing
 * — no envelope, token, key, credential URI or request body ever appears.
 * Coordinator `/health` cooldown rows are the only DO data pulled, and only
 * per-project, on admin demand — nothing here refreshes the token pool or
 * contacts Google.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  API_ERROR_CODES,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import { requireAdmin as realRequireAdmin } from '../auth/session';
import type { AdminIdentity, RequireAdminFn } from './routes';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { listConnections } from '../drive/oauth/transactions';
import { listServiceAccounts } from './credentials';
import {
  readMaintenanceState,
  uploadSessionProgress,
} from '../security/rotation';
import { parseResult, parseSummary } from '../transfers/operations';
import { metricsSnapshot } from './metrics';

const AUDIT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPLOAD_CONFIRMED_SCAN_CAP = 5000;

type RouterContext = Context<{
  Bindings: Env;
  Variables: { requestId?: string };
}>;

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

function isAuthErrorLike(
  err: unknown,
): err is { status: number; code: string; message?: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

function safeMessage(err: { message?: string }, fallback: string): string {
  return typeof err.message === 'string' &&
    err.message.length > 0 &&
    err.message.length <= 300
    ? err.message
    : fallback;
}

/**
 * Same contract as oauth/routes.ts: only auth-shaped failures (401/403/503)
 * carry a client-visible code, the code must be a known ApiErrorCode, and
 * the message is bounded to 300 chars — an Error's message is never echoed
 * unbounded. Everything else collapses to a closed 500.
 */
function errorResponse(c: RouterContext, err: unknown): Response {
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
    return fail(
      c,
      err.status as ContentfulStatusCode,
      code,
      safeMessage(err, fallbackMessage),
    );
  }
  return fail(c, 500, 'INTERNAL_ERROR', 'Internal error.');
}

async function adminOrResponse(
  c: RouterContext,
  requireAdmin: RequireAdminFn,
): Promise<{ admin: AdminIdentity } | { response: Response }> {
  try {
    return { admin: await requireAdmin(c.req.raw, c.env) };
  } catch (err) {
    return { response: errorResponse(c, err) };
  }
}

// ---------------------------------------------------------------------------
// Cooldown rows from each project coordinator, decoded into a safe shape.
// scope_key formats (project-coordinator.ts): cred:<provider>:<credentialId>
// and file:<provider>:<credentialId>:<fileId>.
// ---------------------------------------------------------------------------

interface CooldownView {
  readonly scope: 'credential' | 'file';
  readonly provider: 'google_oauth' | 'service_account' | 'unknown';
  readonly credentialId: string;
  readonly fileId?: string;
  readonly reason: string;
  readonly failures: number;
  readonly retryAfterMs: number;
}

function decodeScopeKey(scopeKey: string): {
  scope: 'credential' | 'file';
  provider: CooldownView['provider'];
  credentialId: string;
  fileId?: string;
} {
  const parts = scopeKey.split(':');
  const scope = parts[0] === 'file' ? 'file' : 'credential';
  const provider =
    parts[1] === 'google_oauth' || parts[1] === 'service_account'
      ? parts[1]
      : 'unknown';
  return {
    scope,
    provider,
    credentialId: parts[2] ?? '',
    ...(scope === 'file' && parts[3] !== undefined ? { fileId: parts[3] } : {}),
  };
}

export interface DiagnosticsDeps {
  readonly requireAdmin?: RequireAdminFn;
  readonly now?: () => number;
}

export function createDiagnosticsRouter(deps: DiagnosticsDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const now = deps.now ?? Date.now;

  app.get('/', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const db = c.env.DB;
      const nowMs = now();

      const [connections, serviceAccounts, clientProjects] = await Promise.all([
        listConnections(db),
        listServiceAccounts(db),
        db
          .prepare('SELECT DISTINCT project_id FROM google_oauth_clients')
          .all<{ project_id: string }>(),
      ]);

      // One health call per project that actually holds credentials — never
      // a pool refresh, never an upstream call.
      const projects = new Set<string>([
        ...serviceAccounts.map((sa) => sa.projectId),
        ...(clientProjects.results ?? []).map((r) => r.project_id),
      ]);
      const coordinator = createCoordinatorTokenSource(c.env);
      const cooldowns: CooldownView[] = [];
      for (const projectId of projects) {
        const health = await coordinator.health(projectId);
        for (const row of health.cooldowns) {
          if (row.until_ms <= nowMs && row.failures <= 0) continue;
          const decoded = decodeScopeKey(row.scope_key);
          cooldowns.push({
            scope: decoded.scope,
            provider: decoded.provider,
            credentialId: decoded.credentialId,
            ...(decoded.fileId === undefined ? {} : { fileId: decoded.fileId }),
            reason: row.reason,
            failures: row.failures,
            retryAfterMs: Math.max(0, row.until_ms - nowMs),
          });
        }
      }
      const failuresByCredential = new Map<string, number>();
      const coolingDown = new Set<string>();
      for (const cd of cooldowns) {
        failuresByCredential.set(
          cd.credentialId,
          (failuresByCredential.get(cd.credentialId) ?? 0) + cd.failures,
        );
        if (cd.retryAfterMs > 0 && cd.scope === 'credential') {
          coolingDown.add(cd.credentialId);
        }
      }

      // D1 aggregates: upload states, confirmed bytes (bounded scan of the
      // permanent result view — never the transient summary), reader
      // readiness, and audit errors over the last 24 h.
      const stateRows = await db
        .prepare('SELECT state, COUNT(*) AS n FROM upload_operations GROUP BY state')
        .all<{ state: string; n: number }>();
      const uploadsByState: Record<string, number> = {};
      for (const row of stateRows.results ?? []) {
        uploadsByState[row.state] = row.n;
      }

      const completedRows = await db
        .prepare(
          "SELECT id, result, summary FROM upload_operations " +
            "WHERE state = 'completed' ORDER BY completed_at DESC LIMIT ?",
        )
        .bind(UPLOAD_CONFIRMED_SCAN_CAP)
        .all<{ id: string; result: string | null; summary: string | null }>();
      let confirmedBytes = 0n;
      for (const row of completedRows.results ?? []) {
        const view =
          parseResult(row.result)?.view ?? parseSummary(row.summary) ?? null;
        const value = view?.confirmedOffset;
        if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
          confirmedBytes += BigInt(value);
        }
      }
      const confirmedTruncated =
        (completedRows.results ?? []).length >= UPLOAD_CONFIRMED_SCAN_CAP;

      const blockedCompletedRow = await db
        .prepare(
          'SELECT COUNT(*) AS n FROM upload_operations ' +
            "WHERE state = 'completed' AND " +
            "(result LIKE '%\"readerAccessState\":\"blocked\"%' " +
            "OR summary LIKE '%\"readerAccessState\":\"blocked\"%')",
        )
        .first<{ n: number }>();
      const readinessRows = await db
        .prepare(
          'SELECT reader_access_state AS state, COUNT(*) AS n FROM file_readiness GROUP BY reader_access_state',
        )
        .all<{ state: string; n: number }>();
      const readers: Record<string, number> = {};
      for (const row of readinessRows.results ?? []) {
        readers[row.state] = row.n;
      }

      const auditRows = await db
        .prepare(
          "SELECT operation, COUNT(*) AS n FROM audit_events " +
            "WHERE result = 'error' AND created_at > ? GROUP BY operation " +
            'ORDER BY n DESC LIMIT 50',
        )
        .bind(nowMs - AUDIT_ERROR_WINDOW_MS)
        .all<{ operation: string; n: number }>();
      const auditErrors: Record<string, number> = {};
      for (const row of auditRows.results ?? []) {
        auditErrors[row.operation] = row.n;
      }

      const maintenance = await readMaintenanceState(db);

      const oauthConnections = connections.map((conn) => ({
        connectionId: conn.id,
        state: conn.state,
        enabled: conn.enabled,
        coolingDown: coolingDown.has(conn.id),
        recentFailures: failuresByCredential.get(conn.id) ?? 0,
      }));
      const saViews = serviceAccounts.map((sa) => ({
        serviceAccountId: sa.id,
        projectId: sa.projectId,
        enabled: sa.enabled,
        coolingDown: coolingDown.has(sa.id),
        recentFailures: failuresByCredential.get(sa.id) ?? 0,
      }));

      return c.json({
        generatedAt: new Date(nowMs).toISOString(),
        oauth: {
          connections: oauthConnections,
          totals: {
            connections: oauthConnections.length,
            needsReauth: oauthConnections.filter((x) => x.state === 'needs_reauth').length,
            disabled: oauthConnections.filter((x) => !x.enabled).length,
            coolingDown: oauthConnections.filter((x) => x.coolingDown).length,
          },
        },
        serviceAccounts: {
          accounts: saViews,
          totals: {
            accounts: saViews.length,
            disabled: saViews.filter((x) => !x.enabled).length,
            coolingDown: saViews.filter((x) => x.coolingDown).length,
          },
        },
        uploads: {
          byState: uploadsByState,
          confirmedBytes: confirmedBytes.toString(10),
          confirmedBytesTruncated: confirmedTruncated,
          completedWithBlockedReader: blockedCompletedRow?.n ?? 0,
        },
        readers,
        auditErrors24h: auditErrors,
        cooldowns,
        maintenance: {
          mode: maintenance.mode,
          phase: maintenance.phase,
          toKeyLabel: maintenance.toKeyLabel,
          processedCount: maintenance.processedCount,
          verifiedCount: maintenance.verifiedCount,
          uploadSessions: uploadSessionProgress(maintenance),
        },
        metrics: metricsSnapshot(),
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}
