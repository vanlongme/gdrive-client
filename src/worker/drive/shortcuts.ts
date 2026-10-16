/**
 * Resource scope resolution (spec §5.1, §7.1, §9; wave-3 worker A).
 *
 * Every file/folder id an actor presents must be proven inside the mount's
 * Shared Drive before it can drive a catalog or content operation — names
 * never identify resources, and a Drive id that merely exists is not enough.
 * resolveResource walks shortcut chains (bounded) through the OAuth catalog
 * identity and re-verifies `driveId === mount.driveId` at every hop, so a
 * shortcut can never smuggle an out-of-mount target into an authorized
 * request.
 */

import { SHORTCUT_MIME_TYPE } from './providers/common';
import type { MountAccess } from '../auth/grants';
import type { MountRecord } from './mounts';
import type {
  DriveFileMeta,
  DriveResourceRef,
  OAuthCatalogWriteProvider,
  ResolvedWriter,
} from './types';

/** Why a resource was refused scope into a mount operation. */
export type ResourceScopeReason =
  /** driveId absent or different from the mount's Shared Drive. */
  | 'outside-mount'
  /** The resource is trashed upstream. */
  | 'trashed'
  /** Shortcut chain exceeded the bound or revisited a node. */
  | 'shortcut-cycle'
  /** A shortcut whose target could not be determined/loaded. */
  | 'shortcut-unresolvable';

export class ResourceScopeError extends Error {
  readonly reason: ResourceScopeReason;
  constructor(reason: ResourceScopeReason, message: string) {
    super(message);
    this.name = 'ResourceScopeError';
    this.reason = reason;
  }
}

export interface ResolveResourceContext {
  /** Caller mount access — retained for scoped actors (T06 narrows it). */
  readonly access: MountAccess;
  readonly mount: MountRecord;
  /** Catalog OAuth writer resolved for this mount. */
  readonly writer: ResolvedWriter;
  readonly provider: OAuthCatalogWriteProvider;
  readonly signal?: AbortSignal;
}

export interface ResolvedResource {
  /** The final (post-shortcut) resource reference for downstream calls. */
  readonly ref: DriveResourceRef;
  readonly meta: DriveFileMeta;
}

const MAX_SHORTCUT_DEPTH = 4;

function assertInMount(meta: DriveFileMeta, mount: MountRecord): void {
  if (meta.trashed === true) {
    throw new ResourceScopeError('trashed', 'resource is trashed');
  }
  if (meta.driveId !== mount.driveId) {
    throw new ResourceScopeError(
      'outside-mount',
      'resource is outside the mount drive',
    );
  }
}

/**
 * Resolve `ref` to a concrete Drive resource inside `mount`, following
 * shortcuts. Throws DriveError for upstream failures and ResourceScopeError
 * for scope violations — the route layer maps both to FILE_NOT_ACCESSIBLE so
 * an out-of-mount id is indistinguishable from a missing one.
 *
 * Shortcut handling: targets are resolved hop-by-hop with the catalog writer
 * (never the SA provider — catalog identity decides catalog scope) and every
 * hop must remain inside mount.driveId. A shortcut targeting outside the
 * drive, a cycle, or a depth beyond MAX_SHORTCUT_DEPTH fails closed.
 */
export async function resolveResource(
  ctx: ResolveResourceContext,
  ref: DriveResourceRef,
): Promise<ResolvedResource> {
  const visited = new Set<string>();
  let current: DriveResourceRef = ref;
  for (let depth = 0; depth <= MAX_SHORTCUT_DEPTH; depth++) {
    const meta = await ctx.provider.getMetadata({
      writer: ctx.writer,
      ref: current,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    assertInMount(meta, ctx.mount);
    if (visited.has(meta.id)) {
      throw new ResourceScopeError(
        'shortcut-cycle',
        'shortcut resolution revisited a resource',
      );
    }
    visited.add(meta.id);
    if (meta.mimeType !== SHORTCUT_MIME_TYPE) {
      return {
        ref: {
          id: meta.id,
          ...(meta.resourceKey === undefined
            ? {}
            : { resourceKey: meta.resourceKey }),
        },
        meta,
      };
    }
    const targetId = meta.shortcutTargetId;
    if (targetId === undefined || targetId === '') {
      throw new ResourceScopeError(
        'shortcut-unresolvable',
        'shortcut target is unavailable',
      );
    }
    current = {
      id: targetId,
      // Google may require the target's own resource key to address it.
      ...(meta.shortcutTargetResourceKey === undefined
        ? {}
        : { resourceKey: meta.shortcutTargetResourceKey }),
    };
  }
  throw new ResourceScopeError(
    'shortcut-cycle',
    'shortcut chain exceeded the resolution bound',
  );
}
