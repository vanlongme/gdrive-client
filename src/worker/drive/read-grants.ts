/**
 * Read-pool grants for My Drive folder mounts (wave 7, spec §5).
 *
 * A My Drive mount has no Shared Drive membership, so the app shares the
 * mount root folder with each pool service account through OAuth
 * `permissions.*` and records its progress in `mount_drive_permissions`.
 * `syncReadGrants` converges Drive toward the pool, resumably:
 *
 *   - at most GRANT_SYNC_MAX_MUTATIONS Drive mutations per call; `remaining`
 *     tells the client to call again;
 *   - a sharing rate limit stops the call (the affected row stays pending
 *     with `grant:rate_limited`) and reports `retryAfterSeconds`;
 *   - a pool SA that already holds a permission is ADOPTED, never granted
 *     twice;
 *   - only permissions whose id this app recorded are ever deleted. A
 *     permission found on Drive without app intent (a pre-existing share, or
 *     one from another tool) is adopted without an id, so removing the SA
 *     from the pool forgets it but leaves the permission in place.
 *
 * `permission_id` is therefore set only when this app created the
 * permission, or when a `pending` row (created intent, answer lost to a crash
 * or a rate limit) finds its permission on Drive.
 */

import {
  READ_GRANT_ERROR_CODES,
  READ_GRANT_STATES,
  type ReadGrantEntry,
  type ReadGrantErrorCode,
  type ReadGrantState,
  type ReadGrantsSyncResponse,
} from '../../shared/contracts/read-grants';
import { DriveError } from './errors';
import { listReadPool, type MountRecord } from './mounts';
import {
  GRANT_SYNC_MAX_MUTATIONS,
  grantErrorCodeOf,
  isConnectionLevelGrantError,
  retryAfterSecondsOf,
  type DrivePermission,
  type DrivePermissionsProvider,
} from './permissions';
import type { ResolvedWriter } from './types';

// ---------------------------------------------------------------------------
// Repository: mount_drive_permissions
// ---------------------------------------------------------------------------

export interface GrantRow {
  readonly serviceAccountId: string;
  /** Stored service-account address (the only value ever sent to Drive). */
  readonly email: string;
  /** Drive permission id; null unless this app created the permission. */
  readonly permissionId: string | null;
  readonly state: ReadGrantState;
  readonly errorCode: ReadGrantErrorCode | null;
}

interface GrantRecord {
  service_account_id: string;
  email: string;
  permission_id: string | null;
  state: string;
  last_error_code: string | null;
}

const STATES: ReadonlySet<string> = new Set(READ_GRANT_STATES);
const ERROR_CODES: ReadonlySet<string> = new Set(READ_GRANT_ERROR_CODES);

function toGrantRow(r: GrantRecord): GrantRow {
  return {
    serviceAccountId: r.service_account_id,
    email: r.email,
    permissionId: r.permission_id,
    state: STATES.has(r.state) ? (r.state as ReadGrantState) : 'failed',
    errorCode:
      r.last_error_code !== null && ERROR_CODES.has(r.last_error_code)
        ? (r.last_error_code as ReadGrantErrorCode)
        : null,
  };
}

export async function listGrantRows(
  db: D1Database,
  mountId: string,
): Promise<GrantRow[]> {
  const rows = await db
    .prepare(
      'SELECT p.service_account_id AS service_account_id, sa.email AS email, ' +
        'p.permission_id AS permission_id, p.state AS state, p.last_error_code AS last_error_code ' +
        'FROM mount_drive_permissions p JOIN service_accounts sa ON sa.id = p.service_account_id ' +
        'WHERE p.mount_id = ? ORDER BY p.service_account_id',
    )
    .bind(mountId)
    .all<GrantRecord>();
  return (rows.results ?? []).map(toGrantRow);
}

export interface GrantFields {
  readonly permissionId: string | null;
  readonly state: ReadGrantState;
  readonly errorCode: ReadGrantErrorCode | null;
}

function putGrantStatement(
  db: D1Database,
  mountId: string,
  serviceAccountId: string,
  fields: GrantFields,
  nowMs: number,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO mount_drive_permissions ' +
        '(mount_id, service_account_id, permission_id, state, last_error_code, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (mount_id, service_account_id) DO UPDATE SET ' +
        'permission_id = excluded.permission_id, state = excluded.state, ' +
        'last_error_code = excluded.last_error_code, updated_at = excluded.updated_at',
    )
    .bind(
      mountId,
      serviceAccountId,
      fields.permissionId,
      fields.state,
      fields.errorCode,
      nowMs,
    );
}

function removeGrantStatement(
  db: D1Database,
  mountId: string,
  serviceAccountId: string,
): D1PreparedStatement {
  return db
    .prepare(
      'DELETE FROM mount_drive_permissions WHERE mount_id = ? AND service_account_id = ?',
    )
    .bind(mountId, serviceAccountId);
}

/** `ready` = pool SAs with a granted row; `total` = pool size. */
export async function readGrantCounts(
  db: D1Database,
  mountId: string,
): Promise<{ ready: number; total: number }> {
  const row = await db
    .prepare(
      'SELECT ' +
        '(SELECT COUNT(*) FROM mount_read_credentials WHERE mount_id = ?1) AS total, ' +
        '(SELECT COUNT(*) FROM mount_drive_permissions p ' +
        'JOIN mount_read_credentials c ON c.mount_id = p.mount_id AND c.service_account_id = p.service_account_id ' +
        "WHERE p.mount_id = ?1 AND p.state = 'granted') AS ready",
    )
    .bind(mountId)
    .first<{ total: number; ready: number }>();
  return { ready: row?.ready ?? 0, total: row?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncReadGrantsDeps {
  readonly db: D1Database;
  readonly permissions: DrivePermissionsProvider;
  readonly now: () => number;
  readonly signal?: AbortSignal;
}

export interface SyncReadGrantsInput {
  readonly mount: MountRecord;
  /** The mount's WRITE connection writer; permissions.* never uses the catalog one. */
  readonly writer: ResolvedWriter;
}

/** Roles that already let an SA read the folder. Owners are never matched. */
const READABLE_ROLES: ReadonlySet<string> = new Set(['reader', 'commenter', 'writer']);
/** 100 permissions per page: 50 pages is far beyond any realistic pool. */
const MAX_LIST_PAGES = 50;

type WorkItem =
  | { readonly kind: 'delete'; readonly row: GrantRow; readonly permissionId: string }
  | {
      readonly kind: 'create';
      readonly serviceAccountId: string;
      readonly email: string;
      /** A previous attempt failed: retried only after all fresh work. */
      readonly retry: boolean;
    };

export async function syncReadGrants(
  deps: SyncReadGrantsDeps,
  input: SyncReadGrantsInput,
): Promise<ReadGrantsSyncResponse> {
  const { db, permissions, now, signal } = deps;
  const { mount, writer } = input;
  const signalPart = signal === undefined ? {} : { signal };

  const pool = await listReadPool(db, mount.id);
  const desired = new Map<string, string>(
    pool.map((entry) => [entry.identity.serviceAccountId, entry.identity.email]),
  );
  const current = new Map<string, GrantRow>(
    (await listGrantRows(db, mount.id)).map((row) => [row.serviceAccountId, row]),
  );
  if (desired.size === 0 && current.size === 0) {
    return { remaining: 0, ready: 0, total: 0, grants: [] };
  }

  // 1. What Drive says right now (paged).
  const live: DrivePermission[] = [];
  let pageToken: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_LIST_PAGES) {
      throw new DriveError(
        'unexpected-response',
        'oauth.permissions.list: permission list exceeds the page bound',
        { operation: 'oauth.permissions.list' },
      );
    }
    const result = await permissions.listPermissions({
      writer,
      fileId: mount.rootFolderId,
      ...(pageToken === undefined ? {} : { pageToken }),
      ...signalPart,
    });
    live.push(...result.permissions);
    if (result.nextPageToken === undefined) break;
    pageToken = result.nextPageToken;
  }
  const liveById = new Map(live.map((p) => [p.id, p]));
  const liveByEmail = new Map<string, DrivePermission>();
  for (const perm of live) {
    if (perm.type !== 'user' || perm.emailAddress === undefined) continue;
    if (!READABLE_ROLES.has(perm.role)) continue;
    const key = perm.emailAddress.toLowerCase();
    if (!liveByEmail.has(key)) liveByEmail.set(key, perm);
  }

  // Every state change goes through here so `current` mirrors D1.
  const persist = async (
    serviceAccountId: string,
    email: string,
    fields: GrantFields,
  ): Promise<void> => {
    await putGrantStatement(db, mount.id, serviceAccountId, fields, now()).run();
    current.set(serviceAccountId, { serviceAccountId, email, ...fields });
  };
  const forget = async (serviceAccountId: string): Promise<void> => {
    await removeGrantStatement(db, mount.id, serviceAccountId).run();
    current.delete(serviceAccountId);
  };

  // 2. Diff (no Drive mutation yet). Adoptions and clean-ups are D1-only.
  const bookkeeping: D1PreparedStatement[] = [];
  const creates: WorkItem[] = [];
  const deletes: WorkItem[] = [];

  for (const [serviceAccountId, email] of desired) {
    const row = current.get(serviceAccountId);
    const present = liveByEmail.get(email.toLowerCase());
    if (present === undefined) {
      creates.push({
        kind: 'create',
        serviceAccountId,
        email,
        retry: row?.state === 'failed',
      });
      continue;
    }
    // Already shared on Drive: adopt instead of creating a duplicate.
    let permissionId: string | null;
    if (row === undefined || row.state === 'failed') {
      permissionId = null; // no app intent on record: a foreign share
    } else if (row.state === 'pending') {
      permissionId = present.id; // app intent whose answer was lost
    } else {
      // Keep a recorded app-created id while it is still live on Drive: the
      // email lookup may have picked a foreign share for the same address,
      // and only the recorded id may ever be deleted.
      permissionId =
        row.permissionId !== null && liveById.has(row.permissionId)
          ? row.permissionId
          : null;
    }
    if (
      row === undefined ||
      row.state !== 'granted' ||
      row.permissionId !== permissionId ||
      row.errorCode !== null
    ) {
      const fields: GrantFields = { permissionId, state: 'granted', errorCode: null };
      bookkeeping.push(putGrantStatement(db, mount.id, serviceAccountId, fields, now()));
      current.set(serviceAccountId, { serviceAccountId, email, ...fields });
    }
  }

  for (const row of [...current.values()]) {
    if (desired.has(row.serviceAccountId)) continue;
    if (row.permissionId !== null && liveById.has(row.permissionId)) {
      deletes.push({ kind: 'delete', row, permissionId: row.permissionId });
    } else {
      // Nothing this app created remains on Drive: just forget the row.
      bookkeeping.push(removeGrantStatement(db, mount.id, row.serviceAccountId));
      current.delete(row.serviceAccountId);
    }
  }
  if (bookkeeping.length > 0) await db.batch(bookkeeping);

  // 3. Mutate, bounded. Fresh work first; retries of failed grants last.
  const work: WorkItem[] = [
    ...deletes,
    ...creates.filter((item) => item.kind === 'create' && !item.retry),
    ...creates.filter((item) => item.kind === 'create' && item.retry),
  ];
  let mutations = 0;
  let remaining = 0;
  let retryAfterSeconds: number | undefined;
  let stopped = false;

  for (let index = 0; index < work.length; index++) {
    if (stopped || mutations >= GRANT_SYNC_MAX_MUTATIONS) {
      remaining += work.length - index;
      break;
    }
    const item = work[index];
    if (item === undefined) break;
    mutations++;
    const serviceAccountId =
      item.kind === 'delete' ? item.row.serviceAccountId : item.serviceAccountId;
    const email = item.kind === 'delete' ? item.row.email : item.email;
    try {
      if (item.kind === 'delete') {
        await persist(serviceAccountId, email, {
          permissionId: item.permissionId,
          state: 'revoking',
          errorCode: null,
        });
        await permissions.deletePermission({
          writer,
          fileId: mount.rootFolderId,
          permissionId: item.permissionId,
          ...signalPart,
        });
        await forget(serviceAccountId);
      } else {
        // Record the intent first: if the answer is lost, the next sync finds
        // the permission on Drive and adopts it with its id.
        await persist(serviceAccountId, email, {
          permissionId: null,
          state: 'pending',
          errorCode: null,
        });
        const created = await permissions.createReaderPermission({
          writer,
          fileId: mount.rootFolderId,
          emailAddress: email,
          ...signalPart,
        });
        await persist(serviceAccountId, email, {
          permissionId: created.id,
          state: 'granted',
          errorCode: null,
        });
      }
    } catch (err) {
      if (!(err instanceof DriveError)) throw err;
      // The writer connection itself is unusable: nothing row-specific to record.
      if (isConnectionLevelGrantError(err)) throw err;
      if (item.kind === 'delete' && err.reason === 'not-found') {
        await forget(serviceAccountId); // already gone upstream
        continue;
      }
      const errorCode = grantErrorCodeOf(err);
      const keepId = item.kind === 'delete' ? item.permissionId : null;
      if (errorCode === 'grant:rate_limited') {
        await persist(serviceAccountId, email, {
          permissionId: keepId,
          state: item.kind === 'delete' ? 'revoking' : 'pending',
          errorCode,
        });
        retryAfterSeconds = retryAfterSecondsOf(err);
        stopped = true;
        remaining += 1; // this item is still outstanding
        continue;
      }
      await persist(serviceAccountId, email, {
        permissionId: keepId,
        state: 'failed',
        errorCode,
      });
    }
  }

  // 4. Report.
  const grants: ReadGrantEntry[] = [];
  let ready = 0;
  for (const serviceAccountId of desired.keys()) {
    const row = current.get(serviceAccountId);
    if (row === undefined) {
      grants.push({ serviceAccountId, state: 'pending' });
      continue;
    }
    if (row.state === 'granted') ready++;
    grants.push({
      serviceAccountId,
      state: row.state,
      ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    });
  }
  for (const row of current.values()) {
    if (desired.has(row.serviceAccountId)) continue;
    grants.push({
      serviceAccountId: row.serviceAccountId,
      state: row.state,
      ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    });
  }
  return {
    remaining,
    ready,
    total: desired.size,
    grants,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}
