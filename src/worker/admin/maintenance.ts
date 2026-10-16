/**
 * Admin maintenance routes (architecture §9.1/§9.2/§13, plan T14; wave-4
 * worker E), exported as createMaintenanceRouter() with paths relative to
 * /api/v1/admin/maintenance.
 *
 * Surface:
 *   GET  /status            — maintenance mode + rotation progress.
 *   POST /cleanup           — bounded retention cleanup (audit >30d,
 *                             completed-upload detail >7d when terminal
 *                             AND the tombstone is durable). `dryRun`
 *                             counts without writing.
 *   POST /mode              — explicit admission-gate toggle
 *                             ({enabled} → maintenance 'drain' style gate
 *                             without a rotation).
 *   POST /rotation/start    — enter maintenance + begin re-encryption.
 *   POST /rotation/step     — advance one bounded batch (resumable).
 *   POST /rotation/verify   — prove every envelope opens under NEXT.
 *   POST /rotation/complete — revoke app sessions, lift the gate.
 *   POST /rotation/abort    — only before any envelope was rewritten.
 *   POST /recovery/claim    — one-use owner-issued recovery token; resets
 *                             an admin credential. Deliberately NOT
 *                             admin-session gated: the token is the
 *                             credential. It never touches setup state.
 *
 * Invariants:
 *   - every handler except /recovery/claim independently resolves the
 *     admin session (requireAdmin); /recovery/claim authenticates by the
 *     one-use token hash and consumes it atomically;
 *   - retention cleanup never deletes tombstone rows: it clears only the
 *     transient `summary` blob and stamps `detail_purged_at`, and only for
 *     terminal operations whose durable `result` exists — unknown outcomes
 *     are kept for reconciliation;
 *   - no handler ever returns envelopes, keys, tokens or remote URIs.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import {
  requireAdmin as realRequireAdmin,
  getAuthInstance,
} from '../auth/session';
import type { AdminIdentity, RequireAdminFn } from './routes';
import {
  abortRotation,
  completeRotation,
  getRotationStatus,
  isMaintenanceActive,
  readMaintenanceState,
  startRotation,
  stepRotation,
  verifyRotation,
  type RotationEnv,
} from '../security/rotation';
import { sha256Hex } from '../transfers/operations';

// ---------------------------------------------------------------------------
// Tunables (spec §13 retention defaults).
// ---------------------------------------------------------------------------

export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const UPLOAD_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLEANUP_BATCH = 200;
export const MAX_CLEANUP_BATCH = 1000;
/** Recovery tokens are one-use and short-lived (owner runbook flow). */
export const RECOVERY_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;
/** Bounded claim guessing: after this many failed claims on the SAME
 * token-hash bucket in an hour the endpoint backs off — the same
 * throttle posture as setup's token check, scoped so a handful of wild
 * guesses can never lock out the legitimate owner (W4-R1 #6). */
export const RECOVERY_CLAIM_MAX_FAILURES_PER_HOUR = 10;
/** Global backstop across ALL buckets — much higher than the per-bucket
 * cap so it bounds total attempts without punishing one honest token. */
export const RECOVERY_CLAIM_GLOBAL_MAX_FAILURES_PER_HOUR = 100;
/** Window and bucket width for the claim throttle. */
const RECOVERY_CLAIM_THROTTLE_WINDOW_MS = 60 * 60 * 1000;
const RECOVERY_CLAIM_BUCKET_CHARS = 12;
export const RECOVERY_TOKEN_PATTERN = /^grt_[A-Za-z0-9_-]{32,128}$/;

/**
 * States where an operation's remote outcome is final. `cleanup_pending`
 * is deliberately excluded: it still holds unresolved remote writes that
 * reconciliation may need the detail blob for.
 */
const PURGEABLE_STATES = ['completed', 'cancelled', 'expired', 'conflict'] as const;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const CleanupRequestSchema = z
  .object({
    dryRun: z.boolean().default(false),
    batchSize: z.number().int().min(1).max(MAX_CLEANUP_BATCH).default(DEFAULT_CLEANUP_BATCH),
  })
  .strict();

const ModeRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

const RotationStartSchema = z.object({}).strict();

const RotationStepSchema = z
  .object({
    batchSize: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const RecoveryClaimSchema = z
  .object({
    token: z.string().min(1).max(256).regex(RECOVERY_TOKEN_PATTERN),
    email: z.string().email().max(320),
    newPassword: z.string().min(8).max(128),
  })
  .strict();

// ---------------------------------------------------------------------------
// Router plumbing (same conventions as ./routes.ts)
// ---------------------------------------------------------------------------

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

function errorResponse(c: RouterContext, err: unknown): Response {
  if (err instanceof MaintenanceHttpError) {
    return fail(c, err.status, err.code, err.message);
  }
  if (err instanceof Error && 'status' in err && 'code' in err) {
    const e = err as { status: number; code: ApiErrorCode; message: string };
    if (typeof e.status === 'number' && typeof e.code === 'string') {
      return fail(
        c,
        e.status as ContentfulStatusCode,
        e.code,
        e.message,
      );
    }
  }
  return fail(c, 500, 'INTERNAL_ERROR', 'Internal error.');
}

class MaintenanceHttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MaintenanceHttpError';
  }
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

async function parseBody<T>(
  c: RouterContext,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
): Promise<{ data: T } | { response: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      response: fail(c, 400, 'VALIDATION_FAILED', 'Request body must be JSON.'),
    };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      response: fail(c, 400, 'VALIDATION_FAILED', 'Request body is invalid.'),
    };
  }
  return { data: parsed.data };
}

async function recordAudit(
  db: D1Database,
  fields: {
    requestId: string;
    actorKind: 'user' | 'system';
    actorUserId?: string;
    operation: string;
    targetType?: string;
    targetId?: string;
    result: 'ok' | 'error';
    nowMs: number;
  },
): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO audit_events ' +
          '(id, actor_kind, actor_user_id, operation, target_type, target_id, result, request_id, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        crypto.randomUUID(),
        fields.actorKind,
        fields.actorUserId ?? null,
        fields.operation,
        fields.targetType ?? null,
        fields.targetId ?? null,
        fields.result,
        fields.requestId,
        fields.nowMs,
      )
      .run();
  } catch {
    // Audit must never mask the operation's real outcome.
  }
}

// ---------------------------------------------------------------------------
// Retention cleanup (spec §13)
// ---------------------------------------------------------------------------

export interface CleanupResult {
  readonly dryRun: boolean;
  readonly auditEvents: { readonly eligible: number; readonly deleted: number };
  readonly uploadDetails: {
    readonly eligible: number;
    readonly purged: number;
    /** Terminal rows kept because their tombstone is not durable yet. */
    readonly keptWithoutTombstone: number;
  };
  readonly truncated: boolean;
}

/**
 * One bounded cleanup pass.
 *
 * - audit_events: hard-delete rows older than AUDIT_RETENTION_MS, capped
 *   at `batchSize` per pass — callers repeat until `eligible` is 0.
 * - upload_operations: never deleted. For terminal rows whose durable
 *   result exists and whose completion is older than
 *   UPLOAD_DETAIL_RETENTION_MS, only the transient `summary` progress blob
 *   is cleared and `detail_purged_at` stamped. Terminal rows with no
 *   result (tombstone not yet durable) and every non-terminal/unknown
 *   outcome are kept.
 */
export async function runRetentionCleanup(
  db: D1Database,
  options: { dryRun?: boolean; batchSize?: number; now?: () => number } = {},
): Promise<CleanupResult> {
  const now = (options.now ?? Date.now)();
  const batchSize = Math.min(
    Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_CLEANUP_BATCH)),
    MAX_CLEANUP_BATCH,
  );
  const auditCutoff = now - AUDIT_RETENTION_MS;
  const detailCutoff = now - UPLOAD_DETAIL_RETENTION_MS;

  const auditEligibleRow = await db
    .prepare('SELECT COUNT(*) AS n FROM audit_events WHERE created_at < ?')
    .bind(auditCutoff)
    .first<{ n: number }>();
  const auditEligible = auditEligibleRow?.n ?? 0;

  const detailEligibleRow = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM upload_operations ' +
        'WHERE detail_purged_at IS NULL AND summary IS NOT NULL ' +
        `AND state IN (${PURGEABLE_STATES.map(() => '?').join(',')}) ` +
        'AND result IS NOT NULL ' +
        'AND COALESCE(completed_at, updated_at) < ?',
    )
    .bind(...PURGEABLE_STATES, detailCutoff)
    .first<{ n: number }>();
  const detailEligible = detailEligibleRow?.n ?? 0;

  // Terminal rows whose tombstone is not durable yet are counted and KEPT.
  const keptRow = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM upload_operations ' +
        'WHERE detail_purged_at IS NULL ' +
        `AND state IN (${PURGEABLE_STATES.map(() => '?').join(',')}) ` +
        'AND result IS NULL ' +
        'AND COALESCE(completed_at, updated_at) < ?',
    )
    .bind(...PURGEABLE_STATES, detailCutoff)
    .first<{ n: number }>();
  const keptWithoutTombstone = keptRow?.n ?? 0;

  let auditDeleted = 0;
  let detailPurged = 0;
  if (options.dryRun !== true) {
    const auditRes = await db
      .prepare(
        'DELETE FROM audit_events WHERE id IN ' +
          '(SELECT id FROM audit_events WHERE created_at < ? ORDER BY created_at LIMIT ?)',
      )
      .bind(auditCutoff, batchSize)
      .run();
    auditDeleted = auditRes.meta.changes ?? 0;

    const purgeRes = await db
      .prepare(
        'UPDATE upload_operations SET summary = NULL, detail_purged_at = ?, updated_at = ? ' +
          'WHERE id IN (SELECT id FROM upload_operations ' +
          'WHERE detail_purged_at IS NULL AND summary IS NOT NULL ' +
          `AND state IN (${PURGEABLE_STATES.map(() => '?').join(',')}) ` +
          'AND result IS NOT NULL AND COALESCE(completed_at, updated_at) < ? ' +
          'ORDER BY COALESCE(completed_at, updated_at) LIMIT ?)',
      )
      .bind(now, now, ...PURGEABLE_STATES, detailCutoff, batchSize)
      .run();
    detailPurged = purgeRes.meta.changes ?? 0;
  }

  return {
    dryRun: options.dryRun === true,
    auditEvents: {
      eligible: auditEligible,
      deleted: auditDeleted,
    },
    uploadDetails: {
      eligible: detailEligible,
      purged: detailPurged,
      keptWithoutTombstone,
    },
    truncated: auditEligible > batchSize || detailEligible > batchSize,
  };
}

// ---------------------------------------------------------------------------
// Recovery token claim (spec §9.1: one-use, owner-issued, never reopens setup)
// ---------------------------------------------------------------------------

interface RecoveryTokenRow {
  id: string;
  token_hash: string;
  expires_at: number;
  consumed_at: number | null;
}

/**
 * NON-CONSUMING validity check (W4-R1 #5): the token row must exist, be
 * unconsumed and unexpired — but it is NOT burned here. The claim first
 * validates user/role and only then atomically consumes, so a bad email
 * no longer destroys a valid one-use token. The atomic UPDATE in
 * consumeRecoveryToken still guarantees single use.
 */
async function findRecoveryToken(
  db: D1Database,
  tokenHash: string,
  nowMs: number,
): Promise<RecoveryTokenRow | null> {
  const row = await db
    .prepare(
      'SELECT id, token_hash, expires_at, consumed_at FROM admin_recovery_tokens ' +
        'WHERE token_hash = ?',
    )
    .bind(tokenHash)
    .first<RecoveryTokenRow>();
  if (row === null || row.consumed_at !== null || row.expires_at <= nowMs) {
    return null;
  }
  return row;
}

/** Atomic one-use consume: a racing claim loses the UPDATE and is rejected. */
async function consumeRecoveryToken(
  db: D1Database,
  tokenId: string,
  nowMs: number,
): Promise<boolean> {
  const consumed = await db
    .prepare(
      'UPDATE admin_recovery_tokens SET consumed_at = ? ' +
        'WHERE id = ? AND consumed_at IS NULL',
    )
    .bind(nowMs, tokenId)
    .run();
  return (consumed.meta.changes ?? 0) === 1;
}

/**
 * Throttle bookkeeping IS the security mechanism here: a failure audit
 * that silently fails to write would allow unlimited guesses (W4-R1 #6),
 * so this insert deliberately throws instead of swallowing like
 * recordAudit. Callers turn the throw into a denied (5xx) response.
 */
async function recordClaimFailure(
  db: D1Database,
  fields: {
    requestId: string;
    bucket: string;
    nowMs: number;
  },
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_events ' +
        '(id, actor_kind, actor_user_id, operation, target_type, target_id, result, request_id, created_at) ' +
        "VALUES (?, 'system', NULL, 'admin.recovery.claim', 'recovery-token-bucket', ?, 'error', ?, ?)",
    )
    .bind(crypto.randomUUID(), fields.bucket, fields.requestId, fields.nowMs)
    .run();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface MaintenanceRouterDeps {
  readonly requireAdmin?: RequireAdminFn;
  readonly now?: () => number;
}

export function createMaintenanceRouter(deps: MaintenanceRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const now = deps.now ?? Date.now;

  const rotationEnv = (env: Env): RotationEnv => ({
    DB: env.DB,
    APP_MASTER_KEY: env.APP_MASTER_KEY,
    APP_MASTER_KEY_NEXT: env.APP_MASTER_KEY_NEXT,
    UPLOAD_SESSION: env.UPLOAD_SESSION,
  });

  // GET /status — maintenance mode, phase and rotation progress.
  app.get('/status', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const rotation = await getRotationStatus(rotationEnv(c.env));
      return c.json({ rotation });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /cleanup — bounded retention pass.
  app.post('/cleanup', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, CleanupRequestSchema);
    if ('response' in parsed) return parsed.response;
    try {
      const result = await runRetentionCleanup(c.env.DB, {
        dryRun: parsed.data.dryRun,
        batchSize: parsed.data.batchSize,
        now,
      });
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'user',
        actorUserId: auth.admin.userId,
        operation: 'admin.maintenance.cleanup',
        result: 'ok',
        nowMs: now(),
      });
      return c.json({ cleanup: result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /mode — explicit admission-gate toggle (mode 'drain' blocks new
  // token admissions without re-encrypting anything).
  app.post('/mode', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, ModeRequestSchema);
    if ('response' in parsed) return parsed.response;
    try {
      const nowMs = now();
      if (parsed.data.enabled) {
        await c.env.DB
          .prepare(
            'INSERT INTO maintenance_state ' +
              "(id, mode, phase, checkpoint, processed_count, verified_count, created_at, updated_at) " +
              "VALUES (1, 'drain', 'idle', '{}', 0, 0, ?, ?) " +
              'ON CONFLICT(id) DO UPDATE SET ' +
              "mode = CASE WHEN maintenance_state.mode = 'off' THEN 'drain' ELSE maintenance_state.mode END, " +
              'updated_at = excluded.updated_at',
          )
          .bind(nowMs, nowMs)
          .run();
      } else {
        // Lifting the gate is only allowed when no rotation is in flight.
        const state = await readMaintenanceState(c.env.DB);
        if (state.mode === 'key-rotation') {
          return fail(
            c,
            409,
            'IDEMPOTENCY_CONFLICT',
            'A key rotation is active; complete or abort it before lifting maintenance mode.',
          );
        }
        await c.env.DB
          .prepare(
            "UPDATE maintenance_state SET mode = 'off', updated_at = ? WHERE id = 1",
          )
          .bind(nowMs)
          .run();
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'user',
        actorUserId: auth.admin.userId,
        operation: parsed.data.enabled
          ? 'admin.maintenance.enter'
          : 'admin.maintenance.exit',
        result: 'ok',
        nowMs,
      });
      const state = await readMaintenanceState(c.env.DB);
      return c.json({ mode: state.mode, active: await isMaintenanceActive(c.env.DB) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // Key rotation
  // ---------------------------------------------------------------------

  app.post('/rotation/start', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, RotationStartSchema);
    if ('response' in parsed) return parsed.response;
    try {
      const result = await startRotation(rotationEnv(c.env), { now });
      if (isRotationError(result)) {
        return fail(c, rotationErrorStatus(result.code), rotationErrorCode(result.code), result.message);
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'user',
        actorUserId: auth.admin.userId,
        operation: 'admin.maintenance.rotation.start',
        result: 'ok',
        nowMs: now(),
      });
      return c.json({ rotation: await getRotationStatus(rotationEnv(c.env)) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/rotation/step', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, RotationStepSchema);
    if ('response' in parsed) return parsed.response;
    try {
      const result = await stepRotation(rotationEnv(c.env), {
        batchSize: parsed.data.batchSize,
        now,
      });
      if (isRotationError(result)) {
        return fail(c, rotationErrorStatus(result.code), rotationErrorCode(result.code), result.message);
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'user',
        actorUserId: auth.admin.userId,
        operation: 'admin.maintenance.rotation.step',
        result: 'ok',
        nowMs: now(),
      });
      return c.json({ step: result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/rotation/verify', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const result = await verifyRotation(rotationEnv(c.env), { now });
      if (isRotationError(result)) {
        return fail(c, rotationErrorStatus(result.code), rotationErrorCode(result.code), result.message);
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'user',
        actorUserId: auth.admin.userId,
        operation: 'admin.maintenance.rotation.verify',
        result: result.ok ? 'ok' : 'error',
        nowMs: now(),
      });
      return c.json({ verify: result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/rotation/complete', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const result = await completeRotation(rotationEnv(c.env), { now });
      if (isRotationError(result)) {
        return fail(c, rotationErrorStatus(result.code), rotationErrorCode(result.code), result.message);
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'user',
        actorUserId: auth.admin.userId,
        operation: 'admin.maintenance.rotation.complete',
        result: 'ok',
        nowMs: now(),
      });
      return c.json({ complete: result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/rotation/abort', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const result = await abortRotation(rotationEnv(c.env), { now });
      if (isRotationError(result)) {
        return fail(c, rotationErrorStatus(result.code), rotationErrorCode(result.code), result.message);
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'user',
        actorUserId: auth.admin.userId,
        operation: 'admin.maintenance.rotation.abort',
        result: 'ok',
        nowMs: now(),
      });
      return c.json({ aborted: true });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ---------------------------------------------------------------------
  // POST /recovery/claim — one-use owner-issued token. NOT session gated:
  // recovery exists for when the admin cannot sign in. The token hash is
  // consumed atomically; a claimed token resets the named admin's password
  // through Better Auth's own hashing and drops that user's sessions.
  // Setup state is never touched.
  // ---------------------------------------------------------------------
  app.post('/recovery/claim', async (c) => {
    const parsed = await parseBody(c, RecoveryClaimSchema);
    if ('response' in parsed) return parsed.response;
    const input = parsed.data;
    const nowMs = now();
    try {
      // Scoped claim throttle (W4-R1 #6): failures are counted per
      // token-hash bucket AND globally. The per-bucket cap keeps a handful
      // of wild guesses from locking out the legitimate owner (their
      // token's bucket is untouched); the higher global cap still bounds
      // total attempts. The failure audit that feeds these counts is
      // written STRICTLY — a swallowed write would mean unlimited
      // guesses, so a failed write denies the attempt (5xx).
      const tokenHash = await sha256Hex(`admin-recovery:${input.token}`);
      const bucket = tokenHash.slice(0, RECOVERY_CLAIM_BUCKET_CHARS);
      const throttle = await c.env.DB
        .prepare(
          "SELECT COUNT(*) AS global_count, " +
            'SUM(CASE WHEN target_id = ? THEN 1 ELSE 0 END) AS bucket_count ' +
            'FROM audit_events ' +
            "WHERE operation = 'admin.recovery.claim' AND result = 'error' " +
            'AND created_at > ?',
        )
        .bind(bucket, nowMs - RECOVERY_CLAIM_THROTTLE_WINDOW_MS)
        .first<{ global_count: number; bucket_count: number | null }>();
      if (
        (throttle?.global_count ?? 0) >=
          RECOVERY_CLAIM_GLOBAL_MAX_FAILURES_PER_HOUR ||
        (throttle?.bucket_count ?? 0) >= RECOVERY_CLAIM_MAX_FAILURES_PER_HOUR
      ) {
        return fail(
          c,
          429,
          'RATE_LIMITED',
          'Too many failed recovery attempts; retry later.',
        );
      }
      const deny = async (
        status: ContentfulStatusCode,
        code: ApiErrorCode,
        message: string,
      ): Promise<Response> => {
        await recordClaimFailure(c.env.DB, {
          requestId: c.get('requestId') ?? crypto.randomUUID(),
          bucket,
          nowMs,
        });
        return fail(c, status, code, message);
      };
      // Validity first WITHOUT consuming (W4-R1 #5): an invalid/expired/
      // spent token is rejected before any user lookup — never burned and
      // never leaking email existence for free.
      const token = await findRecoveryToken(c.env.DB, tokenHash, nowMs);
      if (token === null) {
        return deny(
          403,
          'FORBIDDEN',
          'The recovery token is invalid, expired or already used.',
        );
      }
      const auth = await getAuthInstance(c.env);
      const ctx = await auth.$context;
      const email = input.email.toLowerCase();
      const found = await ctx.internalAdapter.findUserByEmail(email);
      const user = found?.user;
      if (user === undefined || user === null) {
        return deny(404, 'NOT_FOUND', 'No admin account exists for that email.');
      }
      const role = (user as { role?: string }).role;
      if (role !== 'admin') {
        return deny(403, 'FORBIDDEN', 'Recovery applies to admin accounts only.');
      }
      // Only now is the one-use token consumed — after user/role checks.
      if (!(await consumeRecoveryToken(c.env.DB, token.id, nowMs))) {
        return deny(
          403,
          'FORBIDDEN',
          'The recovery token is invalid, expired or already used.',
        );
      }
      const hashed = await ctx.password.hash(input.newPassword);
      const credential = await ctx.internalAdapter.findCredentialAccount(user.id);
      if (credential !== null) {
        await ctx.internalAdapter.updatePassword(user.id, hashed);
      } else {
        await ctx.internalAdapter.createAccount({
          userId: user.id,
          providerId: 'credential',
          accountId: user.id,
          password: hashed,
        });
      }
      // Recovery supersedes every existing session for the account.
      await ctx.internalAdapter.deleteUserSessions(user.id);
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorKind: 'system',
        operation: 'admin.recovery.claim',
        targetType: 'user',
        targetId: user.id,
        result: 'ok',
        nowMs,
      });
      return c.json({ ok: true });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}

function isRotationError(
  result: unknown,
): result is { ok: false; code: string; message: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'ok' in result &&
    (result as { ok: unknown }).ok === false &&
    'code' in result &&
    'message' in result
  );
}

function rotationErrorStatus(code: string): ContentfulStatusCode {
  switch (code) {
    case 'NEXT_KEY_MISSING':
    case 'NEXT_KEY_INVALID':
      return 400;
    case 'ROTATION_NOT_ABORTABLE':
    case 'ROTATION_IN_WRONG_PHASE':
    case 'ROTATION_BLOCKED_BY_ACTIVE_UPLOADS':
      return 409;
    default:
      return 500;
  }
}

function rotationErrorCode(code: string): ApiErrorCode {
  switch (code) {
    case 'NEXT_KEY_MISSING':
    case 'NEXT_KEY_INVALID':
      return 'VALIDATION_FAILED';
    case 'ROTATION_NOT_ABORTABLE':
    case 'ROTATION_IN_WRONG_PHASE':
      return 'IDEMPOTENCY_CONFLICT';
    default:
      return 'INTERNAL_ERROR';
  }
}
