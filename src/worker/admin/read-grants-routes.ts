/**
 * Read-pool grant routes for My Drive folder mounts (wave 7, spec §5),
 * exported as createReadGrantsRouter() with paths relative to /api/v1/admin:
 *
 *   POST /mounts/:id/read-grants/sync
 *   POST /mounts/:id/read-grants/:serviceAccountId/probe
 *
 * Both are admin-only (the app-level mutation origin check in app.ts runs
 * first, exactly as for the other admin mutations) and answer 409
 * MOUNT_KIND_UNSUPPORTED for Shared Drive mounts, whose membership stays
 * operator-managed. Sync issues OAuth permissions.* with the mount's WRITE
 * connection; the probe is an SA metadata read, so it stays inside the
 * provider split (SAs read, OAuth mutates).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  apiError as buildApiError,
  type ApiErrorCode,
} from '../../shared/contracts/common';
import {
  ReadGrantProbeResponseSchema,
  ReadGrantsSyncResponseSchema,
} from '../../shared/contracts/read-grants';
import { requireAdmin as realRequireAdmin } from '../auth/session';
import { mountKindOf } from '../drive/containment';
import { createCoordinatorTokenSource } from '../drive/coordinator-client';
import { DriveError } from '../drive/errors';
import {
  failureFromError,
  getMount,
  listReadPool,
  requireUsableOAuthWriter,
} from '../drive/mounts';
import {
  createDrivePermissionsProvider,
  type DrivePermissionsProvider,
} from '../drive/permissions';
import { createServiceAccountReadProvider } from '../drive/providers/service-account-read';
import { syncReadGrants } from '../drive/read-grants';
import type { ServiceAccountContentReadProvider } from '../drive/types';
import { recordAudit, type RequireAdminFn } from './routes';

export interface ReadGrantsRouterDeps {
  readonly requireAdmin?: RequireAdminFn;
  /** OAuth permissions adapter (fixture in tests). */
  readonly permissions?: DrivePermissionsProvider;
  /** SA read provider used by the probe (fixture in tests). */
  readonly serviceAccountProvider?: ServiceAccountContentReadProvider;
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

function failureResponse(
  c: RouterContext,
  err: unknown,
  provider: 'google_oauth' | 'service_account',
): Response {
  const failure = failureFromError(err, {
    provider,
    surface: provider === 'google_oauth' ? 'catalog' : 'content',
  });
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  return c.json(
    buildApiError(failure.code, failure.message, requestId, failure.retryAfterSeconds),
    failure.status as ContentfulStatusCode,
  );
}

export function createReadGrantsRouter(deps: ReadGrantsRouterDeps = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  const requireAdmin = deps.requireAdmin ?? realRequireAdmin;
  const now = deps.now ?? Date.now;

  const permissionsFor = (env: Env): DrivePermissionsProvider =>
    deps.permissions ??
    createDrivePermissionsProvider({ tokenSource: createCoordinatorTokenSource(env) });
  const serviceAccountProviderFor = (env: Env): ServiceAccountContentReadProvider =>
    deps.serviceAccountProvider ??
    createServiceAccountReadProvider({ tokenSource: createCoordinatorTokenSource(env) });

  const KIND_MESSAGE =
    'Read grants apply to My Drive folder mounts; Shared Drive membership is managed in Google.';

  // POST /mounts/:id/read-grants/sync: converge Drive toward the read pool,
  // at most GRANT_SYNC_MAX_MUTATIONS Drive mutations per call.
  app.post('/mounts/:id/read-grants/sync', async (c) => {
    let admin: { userId: string };
    try {
      admin = await requireAdmin(c.req.raw, c.env);
    } catch (err) {
      return failureResponse(c, err, 'google_oauth');
    }
    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      if (mountKindOf(mount) !== 'my_drive_folder') {
        return fail(c, 409, 'MOUNT_KIND_UNSUPPORTED', KIND_MESSAGE);
      }
      const { writer } = await requireUsableOAuthWriter(
        c.env.DB,
        mount.writeConnectionId,
        'write',
      );
      const nowMs = now();
      const result = await syncReadGrants(
        {
          db: c.env.DB,
          permissions: permissionsFor(c.env),
          now,
          signal: c.req.raw.signal,
        },
        { mount, writer },
      );
      await recordAudit(c.env.DB, {
        requestId: c.get('requestId') ?? crypto.randomUUID(),
        actorUserId: admin.userId,
        operation: 'admin.mount.read-grants.sync',
        targetType: 'mount',
        targetId: mount.id,
        result: 'ok',
        nowMs,
      });
      return c.json(ReadGrantsSyncResponseSchema.parse(result));
    } catch (err) {
      return failureResponse(c, err, 'google_oauth');
    }
  });

  // POST /mounts/:id/read-grants/:serviceAccountId/probe: can this pool SA
  // see the mount root? An SA metadata read, reported as ok | grant:not_visible.
  app.post('/mounts/:id/read-grants/:serviceAccountId/probe', async (c) => {
    try {
      await requireAdmin(c.req.raw, c.env);
    } catch (err) {
      return failureResponse(c, err, 'google_oauth');
    }
    try {
      const mount = await getMount(c.env.DB, c.req.param('id'));
      if (mount === null) return fail(c, 404, 'NOT_FOUND', 'Mount not found.');
      if (mountKindOf(mount) !== 'my_drive_folder') {
        return fail(c, 409, 'MOUNT_KIND_UNSUPPORTED', KIND_MESSAGE);
      }
      const serviceAccountId = c.req.param('serviceAccountId');
      const entry = (await listReadPool(c.env.DB, mount.id)).find(
        (candidate) => candidate.identity.serviceAccountId === serviceAccountId,
      );
      if (entry === undefined) {
        return fail(c, 404, 'NOT_FOUND', 'Service account is not in this mount read pool.');
      }
      try {
        await serviceAccountProviderFor(c.env).getReadMetadata({
          identity: entry.identity,
          ref: { id: mount.rootFolderId },
          signal: c.req.raw.signal,
        });
      } catch (err) {
        if (
          err instanceof DriveError &&
          (err.reason === 'not-found' || err.reason === 'permission-denied')
        ) {
          return c.json(
            ReadGrantProbeResponseSchema.parse({
              serviceAccountId,
              result: 'grant:not_visible',
            }),
          );
        }
        return failureResponse(c, err, 'service_account');
      }
      return c.json(
        ReadGrantProbeResponseSchema.parse({ serviceAccountId, result: 'ok' }),
      );
    } catch (err) {
      return failureResponse(c, err, 'google_oauth');
    }
  });

  return app;
}
