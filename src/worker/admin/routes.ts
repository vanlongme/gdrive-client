/**
 * Admin routes (architecture §10.2; wave-3 worker A), exported as
 * createAdminRouter() with paths relative to /api/v1/admin.
 *
 * Surface: OAuth client + service-account credential import/lifecycle,
 * mount CRUD with separate catalog/write connection mapping and SA read
 * pool, mount grants, app user administration and provider health.
 *
 * Invariants:
 *   - every handler independently resolves the admin session (requireAdmin);
 *   - secrets only ever travel INTO the vault — response DTOs are the strict
 *     admin view schemas and cannot carry envelopes, keys or tokens;
 *   - credential identity rules are enforced: same SA (project_id, email)
 *     rotates the key with version+1, a different SA is a new credential id;
 *     the same OAuth client_id updates in place, a new client_id is a new row;
 *   - mount writes validate the root through the OAuth catalog and write
 *     connections (Shared Drive root, or an owned non-root My Drive folder,
 *     plus writer canAddChildren) before any row is persisted — the SA pool
 *     is never consulted for writes;
 *   - disabling is a version bump so in-flight admissions fail closed.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import {
  CreateAdminUserRequestSchema,
  CreateMountRequestSchema,
  ImportOAuthClientRequestSchema,
  ImportServiceAccountRequestSchema,
  SetReadPoolRequestSchema,
  UpdateMountRequestSchema,
  UpsertMountGrantRequestSchema,
  type MountAdminView,
  type MountGrantView,
  type OAuthClientView,
  type ProviderHealthView,
  type ServiceAccountView,
  type UserView,
} from '../../shared/contracts/admin';
import type { AppRole } from '../../shared/contracts/admin';
import {
  requireAdmin as realRequireAdmin,
  getAuthInstance,
} from '../auth/session';
import { createVaultKeyring, encodeEnvelope } from '../security/vault';
import {
  oauthClientSecretContext,
  serviceAccountKeyContext,
} from '../drive/tokens';
import {
  listConnections,
  readOAuthClient,
  type OAuthClientRow,
} from '../drive/oauth/transactions';
import { OAUTH_CALLBACK_PATH } from '../drive/oauth/routes';
import { readCanonicalOrigin } from '../auth/better-auth';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import {
  createGoogleOAuthProvider,
  type SharedDriveLister,
} from '../drive/providers/google-oauth';
import { FOLDER_MIME_TYPE } from '../drive/providers/common';
import { validateDriveId } from '../drive/transport';
import {
  ApiRequestError,
  failureFromError,
  getMount,
  requireUsableOAuthWriter,
  type MountKind,
  type MountRecord,
} from '../drive/mounts';
import type { DriveFileMeta, OAuthCatalogWriteProvider } from '../drive/types';
import { mountKindOf, mountScopeOf } from '../drive/containment';
import { readGrantCounts } from '../drive/read-grants';
import {
  clientProjectFromClientId,
  listServiceAccounts,
  parseServiceAccountKeyJson,
  readServiceAccount,
  readServiceAccountByIdentity,
  serviceAccountEnvelopeMaterial,
  serviceAccountView,
  validatePkcs8RsaPrivateKey,
} from './credentials';

export interface AdminIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

export type RequireAdminFn = (
  request: Request,
  env: Env,
) => Promise<AdminIdentity>;

export interface AdminRouterDeps {
  readonly requireAdmin?: RequireAdminFn;
  /** OAuth catalog provider used for Shared Drive validation (fixture in tests). */
  readonly oauthProvider?: OAuthCatalogWriteProvider;
  /** OAuth Shared Drive lister for the mount chooser (fixture in tests). */
  readonly sharedDriveLister?: SharedDriveLister;
  readonly now?: () => number;
}

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
  const failure = failureFromError(err, {
    provider: 'google_oauth',
    surface: 'catalog',
  });
  return fail(
    c,
    failure.status as ContentfulStatusCode,
    failure.code,
    failure.message,
  );
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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Audit: mutations record the app actor, operation, target and result
// (spec §10.1 audit_events). Never carries secret material.
// ---------------------------------------------------------------------------

export async function recordAudit(
  db: D1Database,
  fields: {
    requestId: string;
    actorUserId: string;
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
          "VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        fields.actorUserId,
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
// Row → view helpers (admin DTOs: metadata only, never envelopes).
// ---------------------------------------------------------------------------

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

interface ServiceAccountRecord {
  id: string;
  project_id: string;
  email: string;
  key_id: string;
  enabled: number;
  version: number;
  created_at: number;
}

interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: number | null;
  createdAt: string;
}

function userView(row: UserRecord): UserView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === 'admin' ? 'admin' : 'user',
    disabled: row.banned === 1,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

async function readUser(
  db: D1Database,
  id: string,
): Promise<UserRecord | null> {
  return db
    .prepare('SELECT id, name, email, role, banned, "createdAt" FROM "user" WHERE id = ?')
    .bind(id)
    .first<UserRecord>();
}

async function mountAdminView(
  db: D1Database,
  mount: MountRecord,
): Promise<MountAdminView> {
  const rows = await db
    .prepare(
      'SELECT sa.id, sa.project_id, sa.email, sa.key_id, sa.enabled, sa.version, sa.created_at ' +
        'FROM mount_read_credentials m JOIN service_accounts sa ON sa.id = m.service_account_id ' +
        'WHERE m.mount_id = ? ORDER BY m.priority DESC, m.weight DESC, sa.id',
    )
    .bind(mount.id)
    .all<ServiceAccountRecord>();
  const readPool: ServiceAccountView[] = (rows.results ?? []).map((r) =>
    serviceAccountView({
      id: r.id,
      projectId: r.project_id,
      email: r.email,
      keyId: r.key_id,
      enabled: r.enabled === 1,
      version: r.version,
      createdAt: r.created_at,
    }),
  );
  const kind = mountKindOf(mountScopeOf(mount));
  // Only My Drive folder mounts keep grant rows (spec section 5).
  const readGrants =
    kind === 'my_drive_folder' ? await readGrantCounts(db, mount.id) : undefined;
  return {
    id: mount.id,
    label: mount.label,
    kind,
    rootFolderId: mount.rootFolderId,
    driveId: mount.driveId,
    catalogConnectionId: mount.catalogConnectionId,
    writeConnectionId: mount.writeConnectionId,
    readPoolVersion: mount.readPoolVersion,
    visibility: mount.visibility,
    policyVersion: mount.policyVersion,
    readPool,
    ...(readGrants === undefined ? {} : { readGrants }),
  };
}

interface GrantRecord {
  user_id: string;
  mount_id: string;
  role: string;
  operations: string;
  granted_by: string | null;
  created_at: number;
}

const GRANT_OPS_BY_ROLE: Record<'viewer' | 'uploader', readonly string[]> = {
  viewer: ['read'],
  uploader: ['read', 'upload'],
};

function grantView(row: GrantRecord): MountGrantView {
  let operations: ('read' | 'upload' | 'admin')[] = [];
  try {
    const parsed = JSON.parse(row.operations) as unknown;
    if (Array.isArray(parsed)) {
      operations = parsed.filter(
        (v): v is 'read' | 'upload' | 'admin' =>
          v === 'read' || v === 'upload' || v === 'admin',
      );
    }
  } catch {
    operations = [];
  }
  return {
    userId: row.user_id,
    mountId: row.mount_id,
    role: row.role === 'uploader' ? 'uploader' : 'viewer',
    operations,
    grantedBy: row.granted_by,
    createdAt: iso(row.created_at),
  };
}

async function listGrantViews(
  db: D1Database,
  mountId: string,
): Promise<MountGrantView[]> {
  const rows = await db
    .prepare(
      'SELECT user_id, mount_id, role, operations, granted_by, created_at ' +
        'FROM mount_grants WHERE mount_id = ? ORDER BY created_at, user_id',
    )
    .bind(mountId)
    .all<GrantRecord>();
  return (rows.results ?? []).map(grantView);
}

function isSharedDriveRoot(
  meta: { id: string; driveId?: string; mimeType: string; trashed?: boolean },
  driveId: string,
): boolean {
  return (
    meta.id === driveId &&
    meta.driveId === driveId &&
    meta.mimeType === FOLDER_MIME_TYPE &&
    meta.trashed !== true
  );
}

/** Outcome of mount target validation: the server decides the kind. */
export interface MountTarget {
  readonly kind: MountKind;
  readonly rootFolderId: string;
  /** Shared Drive: equals rootFolderId; My Drive folder: null. */
  readonly driveId: string | null;
}

function mountTargetError(code: Extract<ApiErrorCode, `MOUNT_${string}`>, message: string): ApiRequestError {
  return new ApiRequestError(400, code, message);
}

/** Same owned, non-trashed My Drive folder as seen by the write identity. */
function isSameOwnedMyDriveFolder(meta: DriveFileMeta, rootFolderId: string): boolean {
  return (
    meta.id === rootFolderId &&
    meta.driveId === undefined &&
    meta.mimeType === FOLDER_MIME_TYPE &&
    meta.trashed !== true &&
    meta.ownedByMe === true
  );
}

/**
 * Affirmatively validate the mount root (coordinator review R10; spec
 * 2026-10-18 §6) through OAuth only — the SA pool is never consulted.
 *
 * - The catalog connection fetches the root. It must be a folder
 *   (MOUNT_ROOT_NOT_FOLDER) and not trashed (MOUNT_ROOT_TRASHED).
 * - Shared Drive (root carries a driveId): the root must be the drive root
 *   itself — a folder inside a Shared Drive is MOUNT_ROOT_NOT_OWNED. The
 *   write connection must resolve the same root (MOUNT_WRITER_MISMATCH).
 * - My Drive folder (no driveId): ownedByMe for the catalog principal
 *   (MOUNT_ROOT_NOT_OWNED), not the account root (no parents =>
 *   MOUNT_ROOT_IS_MY_DRIVE), and the write connection must be the same
 *   Google principal and also see an owned folder (MOUNT_WRITER_MISMATCH).
 * - Both kinds: the write identity must report canAddChildren === true
 *   (MOUNT_ROOT_NOT_WRITABLE) — a missing capability is not permission.
 */
async function validateMountTargets(
  db: D1Database,
  provider: OAuthCatalogWriteProvider,
  rootFolderId: string,
  catalogConnectionId: string,
  writeConnectionId: string,
): Promise<MountTarget> {
  const catalogState = await requireUsableOAuthWriter(db, catalogConnectionId, 'catalog');
  const writeState = await requireUsableOAuthWriter(db, writeConnectionId, 'write');
  const id = validateDriveId(rootFolderId, 'admin.mounts');
  const root = await provider.getMetadata({ writer: catalogState.writer, ref: { id } });
  if (root.mimeType !== FOLDER_MIME_TYPE) {
    throw mountTargetError('MOUNT_ROOT_NOT_FOLDER', 'The mount root is not a folder.');
  }
  if (root.trashed === true) {
    throw mountTargetError('MOUNT_ROOT_TRASHED', 'The mount root is in the trash.');
  }
  const sameConnection = writeConnectionId === catalogConnectionId;
  const writerRoot = async (): Promise<DriveFileMeta> =>
    sameConnection ? root : provider.getMetadata({ writer: writeState.writer, ref: { id } });

  if (root.driveId !== undefined) {
    if (!isSharedDriveRoot(root, id)) {
      throw mountTargetError('MOUNT_ROOT_NOT_OWNED', 'A Shared Drive mount must name the Shared Drive root itself.');
    }
    const writeRoot = await writerRoot();
    if (!isSharedDriveRoot(writeRoot, id)) {
      throw mountTargetError('MOUNT_WRITER_MISMATCH', 'The write connection does not resolve the same Shared Drive root.');
    }
    if (writeRoot.capabilities?.canAddChildren !== true) {
      throw mountTargetError('MOUNT_ROOT_NOT_WRITABLE', 'The write connection has not proven canAddChildren on this Shared Drive.');
    }
    return { kind: 'shared_drive', rootFolderId: id, driveId: id };
  }

  if (root.ownedByMe !== true) {
    throw mountTargetError('MOUNT_ROOT_NOT_OWNED', 'The folder is not owned by the catalog connection account.');
  }
  if (root.parents === undefined || root.parents.length === 0) {
    throw mountTargetError('MOUNT_ROOT_IS_MY_DRIVE', 'The My Drive root itself cannot be mounted; choose a folder inside it.');
  }
  if (root.id !== id) {
    throw new ApiRequestError(400, 'VALIDATION_FAILED', 'The folder id did not resolve to the same folder.');
  }
  if (writeState.writer.principalId !== catalogState.writer.principalId) {
    throw mountTargetError('MOUNT_WRITER_MISMATCH', 'A My Drive mount needs catalog and write connections of the same Google account.');
  }
  const writeRoot = await writerRoot();
  if (!isSameOwnedMyDriveFolder(writeRoot, id)) {
    throw mountTargetError('MOUNT_WRITER_MISMATCH', 'The write connection does not see the same owned folder.');
  }
  if (writeRoot.capabilities?.canAddChildren !== true) {
    throw mountTargetError('MOUNT_ROOT_NOT_WRITABLE', 'The write connection has not proven canAddChildren on this folder.');
  }
  return { kind: 'my_drive_folder', rootFolderId: id, driveId: null };
}

/**
 * Bump read_pool_version on every mount that reads through this SA so
 * readiness projections and token admissions re-check after the credential
 * changes. Intended for use inside the same D1 batch as the credential
 * update (atomic version + invalidation per coordinator review R6).
 */
function bumpReadPoolVersion(
  db: D1Database,
  serviceAccountId: string,
  nowMs: number,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE mounts SET read_pool_version = read_pool_version + 1, updated_at = ? ' +
        'WHERE id IN (SELECT mount_id FROM mount_read_credentials WHERE service_account_id = ?)',
    )
    .bind(nowMs, serviceAccountId);
}

/** D1/SQLite UNIQUE violation detection for concurrent same-identity imports. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

async function assertServiceAccountsExist(
  db: D1Database,
  ids: readonly string[],
): Promise<void> {
  for (const id of new Set(ids)) {
    if ((await readServiceAccount(db, id)) === null) {
      throw new ApiRequestError(
        400,
        'VALIDATION_FAILED',
        `Service account ${id} does not exist.`,
      );
    }
  }
}

async function replaceReadPool(
  db: D1Database,
  mountId: string,
  entries: readonly {
    serviceAccountId: string;
    priority: number;
    weight: number;
  }[],
  nowMs: number,
): Promise<void> {
  const statements = [
    db
      .prepare('DELETE FROM mount_read_credentials WHERE mount_id = ?')
      .bind(mountId),
    ...entries.map((entry) =>
      db
        .prepare(
          'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) ' +
            'VALUES (?, ?, ?, ?, ?)',
        )
        .bind(mountId, entry.serviceAccountId, entry.priority, entry.weight, nowMs),
    ),
    db
      .prepare(
        'UPDATE mounts SET read_pool_version = read_pool_version + 1, updated_at = ? WHERE id = ?',
      )
      .bind(nowMs, mountId),
  ];
  await db.batch(statements);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAdminRouter(deps: AdminRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const now = deps.now ?? Date.now;

  const oauthProviderFor = (env: Env): OAuthCatalogWriteProvider =>
    deps.oauthProvider ??
    createGoogleOAuthProvider({
      tokenSource: createCoordinatorTokenSource(env),
    });

  const sharedDriveListerFor = (env: Env): SharedDriveLister =>
    deps.sharedDriveLister ??
    createGoogleOAuthProvider({
      tokenSource: createCoordinatorTokenSource(env),
    });

  // -------------------------------------------------------------------------
  // POST /google/clients — register an OAuth Web client (secret sealed).
  // -------------------------------------------------------------------------
  app.post('/google/clients', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, ImportOAuthClientRequestSchema);
    if ('response' in parsed) return parsed.response;
    const input = parsed.data;

    try {
      const canonicalOrigin = await readCanonicalOrigin(c.env.DB);
      if (canonicalOrigin === null) {
        return fail(c, 503, 'SETUP_REQUIRED', 'Initial setup has not completed.');
      }
      const redirectUri = new URL(OAUTH_CALLBACK_PATH, canonicalOrigin).toString();
      if (input.redirectUri !== undefined && input.redirectUri !== redirectUri) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'redirectUri must match the canonical OAuth callback for this installation.',
        );
      }
      const projectId =
        input.projectId ?? clientProjectFromClientId(input.clientId);
      if (projectId === null) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'projectId could not be derived from the client id; supply it explicitly.',
        );
      }

      const vault = createVaultKeyring(c.env);
      const existing = await c.env.DB
        .prepare(
          'SELECT id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at ' +
            'FROM google_oauth_clients WHERE client_id = ?',
        )
        .bind(input.clientId)
        .first<{
          id: string;
          project_id: string;
          client_id: string;
          secret_envelope: string;
          redirect_uri: string;
          enabled: number;
          version: number;
          created_at: number;
        }>();

      let clientId: string;
      if (existing !== null) {
        // Same Google client id: rotate the stored secret in place; a client
        // id cannot move between projects (spec §5.3 credential identity).
        if (existing.project_id !== projectId) {
          return fail(
            c,
            400,
            'VALIDATION_FAILED',
            'This client id is already registered under a different project.',
          );
        }
        clientId = existing.id;
        const envelope = encodeEnvelope(
          await vault.sealSecret(
            new TextEncoder().encode(input.clientSecret),
            oauthClientSecretContext(clientId, projectId),
          ),
        );
        await c.env.DB
          .prepare(
            'UPDATE google_oauth_clients SET secret_envelope = ?, redirect_uri = ?, ' +
              'version = version + 1, updated_at = ? WHERE id = ?',
          )
          .bind(envelope, redirectUri, now(), clientId)
          .run();
      } else {
        clientId = crypto.randomUUID();
        const envelope = encodeEnvelope(
          await vault.sealSecret(
            new TextEncoder().encode(input.clientSecret),
            oauthClientSecretContext(clientId, projectId),
          ),
        );
        try {
          await c.env.DB
            .prepare(
              'INSERT INTO google_oauth_clients ' +
                '(id, project_id, client_id, secret_envelope, redirect_uri, enabled, version, created_at, updated_at) ' +
                'VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)',
            )
            .bind(clientId, projectId, input.clientId, envelope, redirectUri, now(), now())
            .run();
        } catch (err) {
          // Concurrent same-identity import (reviewer F13): the read found no
          // row but a parallel request inserted it first. A retry takes the
          // in-place rotate path, so report a structured conflict rather
          // than a 500.
          if (isUniqueConstraintViolation(err)) {
            return fail(
              c,
              409,
              'IDEMPOTENCY_CONFLICT',
              'This OAuth client was imported concurrently; retry the request.',
            );
          }
          throw err;
        }
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation:
          existing === null ? 'admin.oauth-client.import' : 'admin.oauth-client.rotate',
        targetType: 'google_oauth_client',
        targetId: clientId,
        result: 'ok',
        nowMs: now(),
      });
      const row = await readOAuthClient(c.env.DB, clientId);
      if (row === null) {
        return fail(c, 500, 'INTERNAL_ERROR', 'OAuth client was not persisted.');
      }
      return c.json({ client: clientView(row) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /google/clients/:id/disable|enable — local lifecycle, version bump.
  // -------------------------------------------------------------------------
  for (const action of ['disable', 'enable'] as const) {
    app.post(`/google/clients/:id/${action}`, async (c) => {
      const auth = await adminOrResponse(c, requireAdmin);
      if ('response' in auth) return auth.response;
      try {
        const row = await readOAuthClient(c.env.DB, c.req.param('id'));
        if (row === null) return fail(c, 404, 'NOT_FOUND', 'OAuth client not found.');
        const enabled = action === 'enable';
        if (row.enabled !== enabled) {
          await c.env.DB
            .prepare(
              'UPDATE google_oauth_clients SET enabled = ?, version = version + 1, updated_at = ? WHERE id = ?',
            )
            .bind(enabled ? 1 : 0, now(), row.id)
            .run();
        }
        await recordAudit(c.env.DB, {
          requestId: c.get('requestId') ?? crypto.randomUUID(),
          actorUserId: auth.admin.userId,
          operation: `admin.oauth-client.${action}`,
          targetType: 'google_oauth_client',
          targetId: row.id,
          result: 'ok',
          nowMs: now(),
        });
        const updated = await readOAuthClient(c.env.DB, row.id);
        return c.json({ client: clientView(updated ?? row) });
      } catch (err) {
        return errorResponse(c, err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // POST /service-accounts — import an SA key JSON (sealed). Same
  // (project_id, email) rotates the key with a version bump; a different SA
  // is a new credential id (spec §5.3).
  // -------------------------------------------------------------------------
  app.post('/service-accounts', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, ImportServiceAccountRequestSchema);
    if ('response' in parsed) return parsed.response;

    try {
      const key = parseServiceAccountKeyJson(parsed.data.keyJson);
      if (key === null || !(await validatePkcs8RsaPrivateKey(key.privateKey))) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'The service-account key JSON is malformed or the private key is not a valid PKCS8 RSA key.',
        );
      }
      const vault = createVaultKeyring(c.env);
      const material = new TextEncoder().encode(
        serviceAccountEnvelopeMaterial(key),
      );
      const existing = await readServiceAccountByIdentity(
        c.env.DB,
        key.projectId,
        key.clientEmail,
      );
      let saId: string;
      if (existing !== null) {
        saId = existing.id;
        const envelope = encodeEnvelope(
          await vault.sealSecret(
            material,
            serviceAccountKeyContext(saId, key.projectId),
          ),
        );
        await c.env.DB.batch([
          c.env.DB
            .prepare(
              'UPDATE service_accounts SET envelope = ?, key_id = ?, ' +
                'version = version + 1, updated_at = ? WHERE id = ?',
            )
            .bind(envelope, key.privateKeyId ?? '', now(), saId),
          bumpReadPoolVersion(c.env.DB, saId, now()),
        ]);
      } else {
        saId = crypto.randomUUID();
        const envelope = encodeEnvelope(
          await vault.sealSecret(
            material,
            serviceAccountKeyContext(saId, key.projectId),
          ),
        );
        try {
          await c.env.DB.batch([
            c.env.DB
              .prepare(
                'INSERT INTO service_accounts ' +
                  '(id, project_id, email, key_id, envelope, enabled, version, created_at, updated_at) ' +
                  'VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)',
              )
              .bind(
                saId,
                key.projectId,
                key.clientEmail,
                key.privateKeyId ?? '',
                envelope,
                now(),
                now(),
              ),
            bumpReadPoolVersion(c.env.DB, saId, now()),
          ]);
        } catch (err) {
          // Concurrent same-identity import (reviewer F13): a parallel
          // request inserted the (project_id, email) row first; the batch
          // rolls back atomically and a retry takes the rotate path.
          if (isUniqueConstraintViolation(err)) {
            return fail(
              c,
              409,
              'IDEMPOTENCY_CONFLICT',
              'This service account was imported concurrently; retry the request.',
            );
          }
          throw err;
        }
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation:
          existing === null ? 'admin.service-account.import' : 'admin.service-account.rotate',
        targetType: 'service_account',
        targetId: saId,
        result: 'ok',
        nowMs: now(),
      });
      const row = await readServiceAccount(c.env.DB, saId);
      if (row === null) {
        return fail(c, 500, 'INTERNAL_ERROR', 'Service account was not persisted.');
      }
      return c.json({ serviceAccount: serviceAccountView(row) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /service-accounts — metadata list (no envelopes).
  app.get('/service-accounts', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const rows = await listServiceAccounts(c.env.DB);
      return c.json({ serviceAccounts: rows.map(serviceAccountView) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /service-accounts/:id/disable|enable — admission-affecting flag +
  // version bump so cached credentials fail closed immediately.
  for (const action of ['disable', 'enable'] as const) {
    app.post(`/service-accounts/:id/${action}`, async (c) => {
      const auth = await adminOrResponse(c, requireAdmin);
      if ('response' in auth) return auth.response;
      try {
        const row = await readServiceAccount(c.env.DB, c.req.param('id'));
        if (row === null) {
          return fail(c, 404, 'NOT_FOUND', 'Service account not found.');
        }
        const enabled = action === 'enable';
        if (row.enabled !== enabled) {
          await c.env.DB.batch([
            c.env.DB
              .prepare(
                'UPDATE service_accounts SET enabled = ?, version = version + 1, updated_at = ? WHERE id = ?',
              )
              .bind(enabled ? 1 : 0, now(), row.id),
            bumpReadPoolVersion(c.env.DB, row.id, now()),
          ]);
        }
        await recordAudit(c.env.DB, {
          requestId: c.get('requestId') ?? crypto.randomUUID(),
          actorUserId: auth.admin.userId,
          operation: `admin.service-account.${action}`,
          targetType: 'service_account',
          targetId: row.id,
          result: 'ok',
          nowMs: now(),
        });
        const updated = await readServiceAccount(c.env.DB, row.id);
        return c.json({ serviceAccount: serviceAccountView(updated ?? row) });
      } catch (err) {
        return errorResponse(c, err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Mounts.
  // -------------------------------------------------------------------------

  // GET /mounts — full admin view incl. read pool composition.
  app.get('/mounts', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const rows = await c.env.DB
        .prepare('SELECT id FROM mounts ORDER BY created_at, id')
        .all<{ id: string }>();
      const mounts: MountAdminView[] = [];
      for (const row of rows.results ?? []) {
        const mount = await getMount(c.env.DB, row.id);
        if (mount !== null) mounts.push(await mountAdminView(c.env.DB, mount));
      }
      return c.json({ mounts });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /mounts — create a mount over a Shared Drive or an owned My Drive
  // folder (kind decided by validateMountTargets): separate catalog/write
  // connections + optional initial SA read pool.
  app.post('/mounts', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, CreateMountRequestSchema);
    if ('response' in parsed) return parsed.response;
    const input = parsed.data;

    try {
      const target = await validateMountTargets(
        c.env.DB,
        oauthProviderFor(c.env),
        input.rootFolderId,
        input.catalogConnectionId,
        input.writeConnectionId,
      );
      await assertServiceAccountsExist(c.env.DB, input.serviceAccountIds);

      const mountId = crypto.randomUUID();
      const nowMs = now();
      const statements = [
        c.env.DB
          .prepare(
            'INSERT INTO mounts ' +
              '(id, label, drive_id, root_folder_id, catalog_connection_id, write_connection_id, read_pool_version, visibility, policy_version, created_at, updated_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)',
          )
          .bind(
            mountId,
            input.label,
            target.driveId,
            target.rootFolderId,
            input.catalogConnectionId,
            input.writeConnectionId,
            input.visibility,
            nowMs,
            nowMs,
          ),
        ...[...new Set(input.serviceAccountIds)].map((saId) =>
          c.env.DB
            .prepare(
              'INSERT INTO mount_read_credentials (mount_id, service_account_id, priority, weight, created_at) ' +
                'VALUES (?, ?, 0, 1, ?)',
            )
            .bind(mountId, saId, nowMs),
        ),
      ];
      await c.env.DB.batch(statements);
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation: 'admin.mount.create',
        targetType: 'mount',
        targetId: mountId,
        result: 'ok',
        nowMs,
      });
      const mount = await getMount(c.env.DB, mountId);
      if (mount === null) {
        return fail(c, 500, 'INTERNAL_ERROR', 'Mount was not persisted.');
      }
      return c.json({ mount: await mountAdminView(c.env.DB, mount) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /mounts/:id
  app.get('/mounts/:id', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      return c.json({ mount: await mountAdminView(c.env.DB, mount) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // PATCH /mounts/:id — label/visibility/connection changes. policyVersion
  // bumps only when authorization-relevant fields change.
  app.patch('/mounts/:id', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, UpdateMountRequestSchema);
    if ('response' in parsed) return parsed.response;
    const input = parsed.data;

    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      const catalogConnectionId = input.catalogConnectionId ?? mount.catalogConnectionId;
      const writeConnectionId = input.writeConnectionId ?? mount.writeConnectionId;
      const visibility = input.visibility ?? mount.visibility;
      const label = input.label ?? mount.label;

      // Connections changing must be currently usable identities.
      if (
        catalogConnectionId !== mount.catalogConnectionId ||
        writeConnectionId !== mount.writeConnectionId
      ) {
        const target = await validateMountTargets(
          c.env.DB,
          oauthProviderFor(c.env),
          mount.rootFolderId,
          catalogConnectionId,
          writeConnectionId,
        );
        // Root and kind are immutable: the new connections must prove the
        // same mount, never re-classify it.
        if (target.kind !== mountKindOf(mountScopeOf(mount))) {
          throw new ApiRequestError(400, 'MOUNT_WRITER_MISMATCH', 'The new connections do not resolve the same mount kind.');
        }
      }
      const policyChanged =
        visibility !== mount.visibility ||
        catalogConnectionId !== mount.catalogConnectionId ||
        writeConnectionId !== mount.writeConnectionId;
      const nowMs = now();
      await c.env.DB
        .prepare(
          'UPDATE mounts SET label = ?, visibility = ?, catalog_connection_id = ?, ' +
            'write_connection_id = ?, policy_version = policy_version + ?, updated_at = ? WHERE id = ?',
        )
        .bind(
          label,
          visibility,
          catalogConnectionId,
          writeConnectionId,
          policyChanged ? 1 : 0,
          nowMs,
          mount.id,
        )
        .run();
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation: 'admin.mount.update',
        targetType: 'mount',
        targetId: mount.id,
        result: 'ok',
        nowMs,
      });
      const updated = await getMount(c.env.DB, mount.id);
      return c.json({ mount: await mountAdminView(c.env.DB, updated ?? mount) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // PUT /mounts/:id/read-pool — replace the SA mapping atomically and bump
  // readPoolVersion so readiness projections and token admissions re-check.
  app.put('/mounts/:id/read-pool', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, SetReadPoolRequestSchema);
    if ('response' in parsed) return parsed.response;

    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      const entries = parsed.data.entries;
      await assertServiceAccountsExist(
        c.env.DB,
        entries.map((e) => e.serviceAccountId),
      );
      const deduped = new Map<string, { priority: number; weight: number }>();
      for (const entry of entries) {
        deduped.set(entry.serviceAccountId, {
          priority: entry.priority,
          weight: entry.weight,
        });
      }
      const nowMs = now();
      await replaceReadPool(
        c.env.DB,
        mount.id,
        [...deduped.entries()].map(([serviceAccountId, v]) => ({
          serviceAccountId,
          priority: v.priority,
          weight: v.weight,
        })),
        nowMs,
      );
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation: 'admin.mount.read-pool',
        targetType: 'mount',
        targetId: mount.id,
        result: 'ok',
        nowMs,
      });
      const updated = await getMount(c.env.DB, mount.id);
      return c.json({ mount: await mountAdminView(c.env.DB, updated ?? mount) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // -------------------------------------------------------------------------
  // Grants.
  // -------------------------------------------------------------------------

  // GET /mounts/:id/grants
  app.get('/mounts/:id/grants', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      return c.json({ grants: await listGrantViews(c.env.DB, mount.id) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /mounts/:id/grants — upsert a viewer/uploader grant.
  app.post('/mounts/:id/grants', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, UpsertMountGrantRequestSchema);
    if ('response' in parsed) return parsed.response;
    const input = parsed.data;

    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      const user = await readUser(c.env.DB, input.userId);
      if (user === null) return fail(c, 404, 'NOT_FOUND', 'User not found.');
      const ceiling = GRANT_OPS_BY_ROLE[input.role];
      const operations = input.operations ?? [...ceiling];
      if (
        operations.length === 0 ||
        operations.some((op) => !ceiling.includes(op))
      ) {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'operations must be a non-empty subset of the role ceiling.',
        );
      }
      const nowMs = now();
      await c.env.DB
        .prepare(
          'INSERT INTO mount_grants (user_id, mount_id, role, operations, granted_by, created_at, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(user_id, mount_id) DO UPDATE SET role = excluded.role, ' +
            'operations = excluded.operations, granted_by = excluded.granted_by, ' +
            'updated_at = excluded.updated_at',
        )
        .bind(
          input.userId,
          mount.id,
          input.role,
          JSON.stringify(operations),
          auth.admin.userId,
          nowMs,
          nowMs,
        )
        .run();
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation: 'admin.grant.upsert',
        targetType: 'mount',
        targetId: `${mount.id}:${input.userId}`,
        result: 'ok',
        nowMs,
      });
      return c.json({ grants: await listGrantViews(c.env.DB, mount.id) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // DELETE /mounts/:id/grants/:userId — revoke immediately (no cache reliance).
  app.delete('/mounts/:id/grants/:userId', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      const userId = c.req.param('userId');
      await c.env.DB
        .prepare('DELETE FROM mount_grants WHERE mount_id = ? AND user_id = ?')
        .bind(mount.id, userId)
        .run();
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation: 'admin.grant.revoke',
        targetType: 'mount',
        targetId: `${mount.id}:${userId}`,
        result: 'ok',
        nowMs: now(),
      });
      return c.json({ grants: await listGrantViews(c.env.DB, mount.id) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // -------------------------------------------------------------------------
  // Users.
  // -------------------------------------------------------------------------

  // GET /users — admin-safe user list.
  app.get('/users', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const rows = await c.env.DB
        .prepare('SELECT id, name, email, role, banned, "createdAt" FROM "user" ORDER BY "createdAt", id')
        .all<UserRecord>();
      return c.json({ users: (rows.results ?? []).map(userView) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /users — admin-provisioned user via the pinned Better Auth admin
  // API (password hashing stays library-owned; no hand-rolled schema).
  app.post('/users', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    const parsed = await parseBody(c, CreateAdminUserRequestSchema);
    if ('response' in parsed) return parsed.response;
    const input = parsed.data;

    try {
      const authInstance = await getAuthInstance(c.env);
      const created = await authInstance.api.createUser({
        body: {
          email: input.email,
          password: input.password,
          name: input.name,
          role: input.role as AppRole,
        },
      });
      const row = await readUser(c.env.DB, created.user.id);
      if (row === null) {
        return fail(c, 500, 'INTERNAL_ERROR', 'User was not persisted.');
      }
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: auth.admin.userId,
        operation: 'admin.user.create',
        targetType: 'user',
        targetId: row.id,
        result: 'ok',
        nowMs: now(),
      });
      return c.json({ user: userView(row) });
    } catch (err) {
      if (err instanceof ApiRequestError) return errorResponse(c, err);
      const message =
        err instanceof Error && err.message.length > 0 && err.message.length <= 200
          ? err.message
          : 'User creation failed.';
      return fail(c, 400, 'VALIDATION_FAILED', message);
    }
  });

  // POST /users/:id/disable|enable — local app ban/unban. Disable also
  // drops the user's sessions; our authz layer rechecks the flag on every
  // request either way. An admin cannot disable their own account.
  for (const action of ['disable', 'enable'] as const) {
    app.post(`/users/:id/${action}`, async (c) => {
      const auth = await adminOrResponse(c, requireAdmin);
      if ('response' in auth) return auth.response;
      try {
        const userId = c.req.param('id');
        const row = await readUser(c.env.DB, userId);
        if (row === null) return fail(c, 404, 'NOT_FOUND', 'User not found.');
        if (action === 'disable' && userId === auth.admin.userId) {
          return fail(
            c,
            400,
            'VALIDATION_FAILED',
            'You cannot disable your own account.',
          );
        }
        const banned = action === 'disable';
        if ((row.banned === 1) !== banned) {
          const statements = [
            c.env.DB
              .prepare('UPDATE "user" SET banned = ?, "updatedAt" = ? WHERE id = ?')
              .bind(banned ? 1 : 0, iso(now()), userId),
            ...(banned
              ? [
                  c.env.DB
                    .prepare('DELETE FROM session WHERE "userId" = ?')
                    .bind(userId),
                ]
              : []),
          ];
          await c.env.DB.batch(statements);
        }
        await recordAudit(c.env.DB, {
          requestId: c.get('requestId') ?? crypto.randomUUID(),
          actorUserId: auth.admin.userId,
          operation: `admin.user.${action}`,
          targetType: 'user',
          targetId: userId,
          result: 'ok',
          nowMs: now(),
        });
        const updated = await readUser(c.env.DB, userId);
        return c.json({ user: userView(updated ?? row) });
      } catch (err) {
        return errorResponse(c, err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // GET /shared-drives — paged listing of the Shared Drives visible to ONE
  // OAuth catalog connection (spec §11.3 step 6; wave-5 T11). drives.list
  // runs under the operator identity the caller names via connectionId;
  // useDomainAdminAccess=false is pinned by the transport so only drives the
  // operator can see are returned. No SA path and no fallback exists.
  // -------------------------------------------------------------------------
  app.get('/shared-drives', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const connectionId = c.req.query('connectionId');
      if (connectionId === undefined || connectionId.trim() === '') {
        return fail(
          c,
          400,
          'VALIDATION_FAILED',
          'The connectionId query parameter is required.',
        );
      }
      const pageSizeParam = c.req.query('pageSize');
      let pageSize: number | undefined;
      if (pageSizeParam !== undefined) {
        const parsed = Number(pageSizeParam);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
          return fail(
            c,
            400,
            'VALIDATION_FAILED',
            'pageSize must be an integer between 1 and 100.',
          );
        }
        pageSize = parsed;
      }
      const pageTokenParam = c.req.query('pageToken');
      const pageToken =
        pageTokenParam === undefined || pageTokenParam === ''
          ? undefined
          : pageTokenParam;
      const state = await requireUsableOAuthWriter(
        c.env.DB,
        connectionId,
        'catalog',
      );
      const page = await sharedDriveListerFor(c.env).listSharedDrives({
        writer: state.writer,
        ...(pageToken === undefined ? {} : { pageToken }),
        ...(pageSize === undefined ? {} : { pageSize }),
        signal: c.req.raw.signal,
      });
      return c.json({
        drives: page.drives.map((drive) => ({ id: drive.id, name: drive.name })),
        ...(page.nextPageToken === undefined
          ? {}
          : { nextPageToken: page.nextPageToken }),
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /provider-health — OAuth connection states vs SA read-pool health,
  // separated per spec §13. Cooldowns come from the project coordinators;
  // credential material never enters this view.
  // -------------------------------------------------------------------------
  app.get('/provider-health', async (c) => {
    const auth = await adminOrResponse(c, requireAdmin);
    if ('response' in auth) return auth.response;
    try {
      const connections = await listConnections(c.env.DB);
      const serviceAccounts = await listServiceAccounts(c.env.DB);
      const projects = new Set(serviceAccounts.map((sa) => sa.projectId));
      const coordinator = createCoordinatorTokenSource(c.env);
      const nowMs = now();
      const coolingDown = new Set<string>();
      for (const projectId of projects) {
        const health = await coordinator.health(projectId);
        for (const cooldown of health.cooldowns) {
          if (
            cooldown.until_ms > nowMs &&
            cooldown.scope_key.startsWith('cred:service_account:')
          ) {
            coolingDown.add(cooldown.scope_key.slice('cred:service_account:'.length));
          }
        }
      }
      const view: ProviderHealthView = {
        oauthConnections: connections.map((conn) => ({
          connectionId: conn.id,
          state: conn.state,
          enabled: conn.enabled,
        })),
        serviceAccounts: serviceAccounts.map((sa) => ({
          serviceAccountId: sa.id,
          enabled: sa.enabled,
          coolingDown: coolingDown.has(sa.id),
        })),
      };
      return c.json(view);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}
