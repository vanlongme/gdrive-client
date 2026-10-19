/**
 * Resource scope resolution (spec §5.1, §7.1, §9; wave-3 worker A).
 *
 * Every file/folder id an actor presents must be proven inside the mount
 * before it can drive a catalog or content operation — names never
 * identify resources, and a Drive id that merely exists is not enough.
 * resolveResource walks shortcut chains (bounded) through the OAuth catalog
 * identity and re-proves containment (containment.ts assertInMount: the
 * Shared Drive driveId rule or the My Drive ancestor walk) at every hop, so
 * a shortcut can never smuggle an out-of-mount target into an authorized
 * request.
 */

import { SHORTCUT_MIME_TYPE } from './providers/common';
import type { MountAccess } from '../auth/grants';
import type { MountRecord } from './mounts';
import {
  assertInMount,
  mountScopeOf,
  oauthParentLookup,
  ResourceScopeError,
  type SharedVerdictStore,
} from './containment';
import type {
  DriveFileMeta,
  DriveResourceRef,
  OAuthCatalogWriteProvider,
  ResolvedWriter,
} from './types';

// Moved to containment.ts (wave 7); re-exported for existing importers.
export { ResourceScopeError, type ResourceScopeReason } from './containment';

export interface ResolveResourceContext {
  /** Caller mount access — retained for scoped actors (T06 narrows it). */
  readonly access: MountAccess;
  readonly mount: MountRecord;
  /** Catalog OAuth writer resolved for this mount. */
  readonly writer: ResolvedWriter;
  readonly provider: OAuthCatalogWriteProvider;
  readonly signal?: AbortSignal;
  /** Cross-isolate containment verdicts (wave-9 step 2b); optional. */
  readonly shared?: SharedVerdictStore;
}

export interface ResolvedResource {
  /** The final (post-shortcut) resource reference for downstream calls. */
  readonly ref: DriveResourceRef;
  readonly meta: DriveFileMeta;
}

const MAX_SHORTCUT_DEPTH = 4;

/**
 * Resolve `ref` to a concrete Drive resource inside `mount`, following
 * shortcuts. Throws DriveError for upstream failures and ResourceScopeError
 * for scope violations — the route layer maps both to FILE_NOT_ACCESSIBLE so
 * an out-of-mount id is indistinguishable from a missing one.
 *
 * Shortcut handling: targets are resolved hop-by-hop with the catalog writer
 * (never the SA provider — catalog identity decides catalog scope) and every
 * hop must remain inside the mount. A shortcut targeting outside the
 * mount, a cycle, or a depth beyond MAX_SHORTCUT_DEPTH fails closed.
 */
export async function resolveResource(
  ctx: ResolveResourceContext,
  ref: DriveResourceRef,
): Promise<ResolvedResource> {
  const visited = new Set<string>();
  const scope = mountScopeOf(ctx.mount);
  const lookup = oauthParentLookup({
    provider: ctx.provider,
    writer: ctx.writer,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  let current: DriveResourceRef = ref;
  for (let depth = 0; depth <= MAX_SHORTCUT_DEPTH; depth++) {
    const meta = await ctx.provider.getMetadata({
      writer: ctx.writer,
      ref: current,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    await assertInMount(scope, meta, lookup, ctx.shared);
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
