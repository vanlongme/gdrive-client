/**
 * Single-owner resumable initial setup (architecture §9.1, wave-2 track A).
 *
 * POST /api/v1/setup accepts {token, name, email, password, canonicalOrigin}.
 * The claim protocol guarantees exactly one initial admin across retries and
 * races:
 *
 * 1. The app_settings singleton is claimed atomically by
 *    `UPDATE ... WHERE setup_state = 'uninitialized'` — D1 serializes it, so
 *    exactly one request transitions the row to 'in_progress'. The claim
 *    stores setup_owner (SHA-256 of the presented token) and the pending
 *    admin identity, so a later request holding the same SETUP_TOKEN resumes
 *    the SAME admin identity instead of minting a second one.
 * 2. Admin creation is idempotent: an existing user with the pending email is
 *    converged (role 'admin', presented credential VERIFIED against the
 *    persisted one — never overwritten) instead of duplicated, and credential
 *    insertion is fenced by the unique (providerId, accountId) index.
 * 3. Completion is a guarded UPDATE (`setup_state='in_progress' AND
 *    setup_owner=<claimant>`); once 'complete' the setup token is consumed
 *    permanently — SETUP_TOKEN remaining in Worker Secrets cannot reopen
 *    setup.
 * 4. A failed token check is counted in setup_throttle and backs the endpoint
 *    off linearly (5s per failed attempt: 5s, 10s, 15s, ... capped at
 *    300s), keeping token guessing bounded.
 */

import type { ApiErrorCode } from '../../shared/contracts/common';
import type { SetupStatusView } from '../../shared/contracts/admin';
import type { AppAuth } from './better-auth';
import { getAuth } from './better-auth';
import { getBootstrapConfig } from '../security/bootstrap-config';

const SETUP_LOCK_BASE_MS = 5_000;
const SETUP_LOCK_MAX_MS = 300_000;

export interface SetupInput {
  token: string;
  name: string;
  email: string;
  password: string;
  canonicalOrigin: string;
}

export interface SetupFailure {
  ok: false;
  status: 400 | 403 | 409 | 429 | 503;
  code: ApiErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

export type SetupOutcome = { ok: true; status: SetupStatusView } | SetupFailure;

function fail(
  status: 400 | 403 | 409 | 429 | 503,
  code: ApiErrorCode,
  message: string,
  retryAfterSeconds?: number,
): SetupFailure {
  return {
    ok: false,
    status,
    code,
    message,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

interface SettingsRow {
  setup_state: string;
  setup_owner: string | null;
  setup_pending_email: string | null;
  setup_pending_name: string | null;
  canonical_origin: string | null;
}

interface ThrottleRow {
  failed_attempts: number;
  locked_until: number | null;
}

/** Constant-time byte equality (workerd provides crypto.subtle.timingSafeEqual). */
export function secretsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?: (x: Uint8Array, y: Uint8Array) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Strict base64 decode; returns null for anything non-canonical. */
function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length === 0) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return btoa(binary) === text ? bytes : null;
}

/**
 * Normalize and validate the submitted canonical origin: must be a parseable
 * http(s) origin, and https everywhere except loopback development hosts.
 * Returns the normalized `url.origin` (scheme + host + port, no path).
 */
export function normalizeCanonicalOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname;
  const isLoopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1';
  if (url.protocol === 'http:' && !isLoopback) return null;
  return url.origin;
}

async function readSettings(db: D1Database): Promise<SettingsRow | null> {
  const row = await db
    .prepare(
      'SELECT setup_state, setup_owner, setup_pending_email, setup_pending_name, canonical_origin ' +
        'FROM app_settings WHERE id = 1',
    )
    .first<SettingsRow>();
  return row;
}

async function checkThrottle(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT failed_attempts, locked_until FROM setup_throttle WHERE id = 1')
    .first<ThrottleRow>();
  if (row === null || row.locked_until === null) return 0;
  const remaining = row.locked_until - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

async function recordThrottleFailure(db: D1Database): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO setup_throttle (id, failed_attempts, updated_at) ' +
        'VALUES (1, 1, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET ' +
        'failed_attempts = failed_attempts + 1, updated_at = ?',
    )
    .bind(now, now)
    .run();
  // Progressive backoff from the authoritative count: 5s,10s,... at 300s cap.
  const row = await db
    .prepare('SELECT failed_attempts FROM setup_throttle WHERE id = 1')
    .first<Pick<ThrottleRow, 'failed_attempts'>>();
  const attempts = row?.failed_attempts ?? 1;
  const lock = Math.min(SETUP_LOCK_BASE_MS * attempts, SETUP_LOCK_MAX_MS);
  await db
    .prepare('UPDATE setup_throttle SET locked_until = ?, updated_at = ? WHERE id = 1')
    .bind(now + lock, now)
    .run();
}

interface ClaimResult {
  kind: 'claimed' | 'resumed';
  email: string;
  name: string;
  canonicalOrigin: string;
}

type ClaimOutcome =
  | { ok: true; claim: ClaimResult }
  | { ok: false; failure: SetupFailure };

/**
 * Atomically claim or resume the setup singleton. `tokenHash` is the
 * claimant's proof: the same SETUP_TOKEN resumes an in-progress claim; a
 * different pending identity or a completed setup is rejected.
 */
async function claimSetup(
  db: D1Database,
  input: { email: string; name: string; canonicalOrigin: string },
  tokenHash: string,
): Promise<ClaimOutcome> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT OR IGNORE INTO app_settings (id, setup_state, created_at, updated_at) " +
        "VALUES (1, 'uninitialized', ?, ?)",
    )
    .bind(now, now)
    .run();
  const claimed = await db
    .prepare(
      "UPDATE app_settings SET setup_state = 'in_progress', setup_owner = ?, " +
        'setup_pending_email = ?, setup_pending_name = ?, canonical_origin = ?, ' +
        'installation_id = COALESCE(installation_id, ?), version = version + 1, ' +
        'updated_at = ? WHERE id = 1 AND setup_state = \'uninitialized\'',
    )
    .bind(
      tokenHash,
      input.email,
      input.name,
      input.canonicalOrigin,
      crypto.randomUUID(),
      now,
    )
    .run();
  if ((claimed.meta.changes ?? 0) === 1) {
    return {
      ok: true,
      claim: {
        kind: 'claimed',
        email: input.email,
        name: input.name,
        canonicalOrigin: input.canonicalOrigin,
      },
    };
  }

  const row = await readSettings(db);
  if (row === null || row.setup_state === 'uninitialized') {
    return {
      ok: false,
      failure: fail(
        503,
        'SETUP_STATUS_UNAVAILABLE',
        'Setup state could not be claimed.',
      ),
    };
  }
  if (row.setup_state === 'complete') {
    return {
      ok: false,
      failure: fail(
        409,
        'SETUP_ALREADY_COMPLETED',
        'Initial setup has already completed.',
      ),
    };
  }
  if (row.setup_owner !== tokenHash) {
    return {
      ok: false,
      failure: fail(
        409,
        'SETUP_IN_PROGRESS',
        'Initial setup is in progress under a different setup owner.',
      ),
    };
  }
  if (
    row.setup_pending_email === null ||
    row.setup_pending_name === null ||
    row.canonical_origin === null
  ) {
    return {
      ok: false,
      failure: fail(
        503,
        'SETUP_STATUS_UNAVAILABLE',
        'Setup state is incomplete and cannot be resumed.',
      ),
    };
  }
  if (row.setup_pending_email !== input.email) {
    return {
      ok: false,
      failure: fail(
        409,
        'SETUP_IN_PROGRESS',
        'Setup is already in progress for a different admin email; retry with the original identity.',
      ),
    };
  }
  return {
    ok: true,
    claim: {
      kind: 'resumed',
      email: row.setup_pending_email,
      name: row.setup_pending_name,
      canonicalOrigin: row.canonical_origin,
    },
  };
}

/**
 * Thrown when a resumable claim presents a credential that conflicts with the
 * one already persisted for the pending admin — e.g. a delayed racing request
 * carrying the same setup token and email but a different password. The
 * persisted credential is authoritative and is never overwritten.
 */
class SetupConflictError extends Error {}

/**
 * Idempotent admin creation/convergence through Better Auth itself — no
 * custom hashing or schema. A fresh claim goes through the admin plugin's
 * server-side createUser (no session needed when called without request
 * context); a resume must PRESENT THE SAME password — the persisted
 * credential is verified, never overwritten, so a slow racing request cannot
 * change the winning claim's admin password after the fact.
 */
async function ensureAdminUser(
  auth: AppAuth,
  input: { email: string; name: string; password: string },
): Promise<void> {
  const ctx = await auth.$context;
  const normalizedEmail = input.email.toLowerCase();
  let existing = await ctx.internalAdapter.findUserByEmail(normalizedEmail);
  if (!existing?.user) {
    try {
      await auth.api.createUser({
        body: {
          email: normalizedEmail,
          name: input.name,
          password: input.password,
          role: 'admin',
          data: { emailVerified: true },
        },
      });
      return;
    } catch {
      // A concurrent claim holding the same setup token can win the
      // createUser race; re-read and converge below.
      existing = await ctx.internalAdapter.findUserByEmail(normalizedEmail);
      if (!existing?.user) throw new Error('admin user creation failed');
    }
  }
  if (existing?.user) {
    // The admin plugin extends user rows with `role`; the base User type does
    // not declare it.
    if ((existing.user as { role?: string }).role !== 'admin') {
      await ctx.internalAdapter.updateUser(existing.user.id, { role: 'admin' });
    }
    const credential = await ctx.internalAdapter.findCredentialAccount(
      existing.user.id,
    );
    if (credential !== null && typeof credential.password === 'string') {
      // Verify the presented password against the persisted credential —
      // identical claim → converge; divergent claim → conflict.
      const matches = await ctx.password.verify({
        hash: credential.password,
        password: input.password,
      });
      if (!matches) {
        throw new SetupConflictError(
          'The pending admin was already created with a different credential.',
        );
      }
      return;
    }
    // Crash between user row creation and credential link: finish the claim.
    // The (providerId, accountId) UNIQUE index fences duplicate credential
    // creation when two resumes both observe no account — the loser's insert
    // fails, and it re-reads + verifies the winner's credential.
    const hashed = await ctx.password.hash(input.password);
    try {
      await ctx.internalAdapter.createAccount({
        userId: existing.user.id,
        providerId: 'credential',
        accountId: existing.user.id,
        password: hashed,
      });
      return;
    } catch {
      const reloaded = await ctx.internalAdapter.findCredentialAccount(
        existing.user.id,
      );
      if (reloaded !== null && typeof reloaded.password === 'string') {
        const matches = await ctx.password.verify({
          hash: reloaded.password,
          password: input.password,
        });
        if (matches) return;
      }
      throw new SetupConflictError(
        'The pending admin was already created with a different credential.',
      );
    }
  }
  await auth.api.createUser({
    body: {
      email: normalizedEmail,
      name: input.name,
      password: input.password,
      role: 'admin',
      data: { emailVerified: true },
    },
  });
}

/**
 * Run the setup flow. Throws nothing for expected rejections; returns a
 * typed SetupOutcome the route maps onto ApiErrorBody / SetupStatusView.
 */
export async function runSetup(
  env: { DB: D1Database; APP_MASTER_KEY?: string; SETUP_TOKEN?: string },
  input: SetupInput,
): Promise<SetupOutcome> {
  const bootstrap = getBootstrapConfig(env);
  if (!bootstrap.ok) {
    return fail(
      503,
      'BOOTSTRAP_SECRETS_INVALID',
      'Worker bootstrap secrets are missing or malformed.',
    );
  }
  const canonicalOrigin = normalizeCanonicalOrigin(input.canonicalOrigin);
  if (canonicalOrigin === null) {
    return fail(
      400,
      'VALIDATION_FAILED',
      'canonicalOrigin must be a valid http(s) origin; https is required outside loopback hosts.',
    );
  }
  const email = input.email.toLowerCase();

  const db = env.DB;
  let settings: SettingsRow | null;
  try {
    settings = await readSettings(db);
  } catch {
    return fail(
      503,
      'SETUP_STATUS_UNAVAILABLE',
      'Setup status could not be read.',
    );
  }
  if (settings?.setup_state === 'complete') {
    return fail(
      409,
      'SETUP_ALREADY_COMPLETED',
      'Initial setup has already completed.',
    );
  }

  const lockedSeconds = await checkThrottle(db);
  if (lockedSeconds > 0) {
    return fail(
      429,
      'RATE_LIMITED',
      'Too many failed setup attempts; retry later.',
      lockedSeconds,
    );
  }

  const presentedToken = decodeBase64(input.token);
  if (
    presentedToken === null ||
    !secretsEqual(presentedToken, bootstrap.secrets.setupToken)
  ) {
    await recordThrottleFailure(db);
    return fail(403, 'SETUP_TOKEN_INVALID', 'The setup token is invalid.');
  }
  const tokenHash = await sha256Hex(presentedToken);

  const claimOutcome = await claimSetup(
    db,
    { email, name: input.name, canonicalOrigin },
    tokenHash,
  );
  if (!claimOutcome.ok) return claimOutcome.failure;
  const claim = claimOutcome.claim;

  try {
    const auth = await getAuth(env);
    await ensureAdminUser(auth, {
      email: claim.email,
      name: claim.name,
      password: input.password,
    });
  } catch (err) {
    if (err instanceof SetupConflictError) {
      return fail(
        409,
        'SETUP_IN_PROGRESS',
        'A setup claim is in progress with a different admin credential.',
      );
    }
    return fail(
      503,
      'SETUP_STATUS_UNAVAILABLE',
      'Admin account could not be created; setup may be retried.',
    );
  }

  const completed = await db
    .prepare(
      "UPDATE app_settings SET setup_state = 'complete', setup_pending_email = NULL, " +
        'setup_pending_name = NULL, version = version + 1, updated_at = ? ' +
        "WHERE id = 1 AND setup_state = 'in_progress' AND setup_owner = ?",
    )
    .bind(Date.now(), tokenHash)
    .run();
  if ((completed.meta.changes ?? 0) !== 1) {
    const final = await readSettings(db);
    if (final?.setup_state !== 'complete') {
      return fail(
        503,
        'SETUP_STATUS_UNAVAILABLE',
        'Setup completion could not be confirmed.',
      );
    }
  }
  return {
    ok: true,
    status: { setupState: 'complete', canonicalOrigin: claim.canonicalOrigin },
  };
}
