/**
 * Authorization primitives (architecture §9.3, plan T03, wave-2 track A).
 *
 * Actor is the resolved caller identity: an authenticated app user, a scoped
 * share-link capability (T06), or anonymous public access for mounts marked
 * public_read. Mount access is granted by user.role='admin', an explicit
 * mount_grants row (viewer | uploader), or public visibility — never inferred
 * from Google-side roles.
 */

import type { AuthUser } from './session';

export type Actor =
  | { kind: 'user'; user: AuthUser; sessionId: string }
  | { kind: 'share'; shareId: string; mountId: string }
  | { kind: 'public' };

/** Operations an app actor may attempt against a mount. */
export const MOUNT_OPERATIONS = [
  'read',
  'upload',
  'admin',
] as const;
export type MountOperation = (typeof MOUNT_OPERATIONS)[number];

export interface MountAccess {
  mountId: string;
  /** Highest app-level capability on this mount for the actor. */
  role: 'admin' | 'uploader' | 'viewer';
  operations: ReadonlySet<MountOperation>;
}

interface MountRow {
  id: string;
  visibility: string;
}

export type { MountRow };

const OPERATIONS_BY_ROLE: Record<MountAccess['role'], ReadonlySet<MountOperation>> = {
  admin: new Set<MountOperation>(['read', 'upload', 'admin']),
  uploader: new Set<MountOperation>(['read', 'upload']),
  viewer: new Set<MountOperation>(['read']),
};

const KNOWN_OPERATIONS = new Set<string>(MOUNT_OPERATIONS);

interface GrantRow {
  role: string;
  operations: string;
}

/**
 * Parse a mount_grants.operations JSON array. Malformed JSON, non-arrays and
 * unknown operation names fail closed (null); an explicit '[]' yields an
 * empty set — a grant that names no operations denies all of them.
 */
function parseGrantOperations(raw: string): Set<MountOperation> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const operations = new Set<MountOperation>();
  for (const value of parsed) {
    if (typeof value !== 'string' || !KNOWN_OPERATIONS.has(value)) {
      return null;
    }
    operations.add(value as MountOperation);
  }
  return operations;
}

/**
 * Resolve the actor's access on a mount. Returns null when the actor has no
 * rights or the mount does not exist — callers translate that into
 * FORBIDDEN/NOT_FOUND at the route boundary. Only this module interprets
 * grant rows; Google-side identities never enter the decision.
 *
 * A grant row's `operations` allowlist is intersected with the role ceiling:
 * the role can only narrow further, never widen. Malformed or empty
 * operation lists deny all operations.
 */
export async function authorizeMount(
  db: D1Database,
  actor: Actor,
  mountId: string,
  knownMount?: MountRow,
): Promise<MountAccess | null> {
  // The caller that already fetched the mount row passes it through so a
  // request never reads the same row twice.
  const mount =
    knownMount ??
    (await db
      .prepare('SELECT id, visibility FROM mounts WHERE id = ?')
      .bind(mountId)
      .first<MountRow>());
  if (mount === null) return null;

  if (actor.kind === 'user') {
    if (actor.user.disabled) return null;
    if (actor.user.role === 'admin') {
      return { mountId, role: 'admin', operations: OPERATIONS_BY_ROLE.admin };
    }
    const grant = await db
      .prepare(
        'SELECT role, operations FROM mount_grants WHERE user_id = ? AND mount_id = ?',
      )
      .bind(actor.user.id, mountId)
      .first<GrantRow>();
    if (grant !== null) {
      const role = grant.role === 'uploader' ? 'uploader' : 'viewer';
      const allowed = parseGrantOperations(grant.operations);
      if (allowed === null) return null;
      const ceiling = OPERATIONS_BY_ROLE[role];
      const effective = new Set(
        [...allowed].filter((operation) => ceiling.has(operation)),
      );
      if (effective.size === 0) return null;
      return { mountId, role, operations: effective };
    }
  }

  if (actor.kind === 'share') {
    // Share actors are resolved and scoped by the share route (T06); until
    // then they receive no operations.
    return null;
  }

  // Anonymous public access: read-only, only on mounts opened by an admin.
  if (mount.visibility === 'public_read') {
    return { mountId, role: 'viewer', operations: OPERATIONS_BY_ROLE.viewer };
  }
  return null;
}

/** Convenience check: does the actor hold `operation` on `mountId`? */
export async function canAccessMount(
  db: D1Database,
  actor: Actor,
  mountId: string,
  operation: MountOperation,
): Promise<boolean> {
  const access = await authorizeMount(db, actor, mountId);
  return access !== null && access.operations.has(operation);
}
