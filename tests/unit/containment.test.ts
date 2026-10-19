import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertInMount,
  CONTAINMENT_CACHE_MAX,
  CONTAINMENT_MAX_DEPTH,
  CONTAINMENT_TTL_MS,
  invalidateFolder,
  isInMount,
  mountKindOf,
  mountScopeOf,
  oauthParentLookup,
  requireSharedDriveId,
  resetContainmentCacheForTests,
  ResourceScopeError,
  type MountScope,
  type ParentLookup,
  type ParentMeta,
} from '../../src/worker/drive/containment';
import { ResourceScopeError as ReexportedScopeError } from '../../src/worker/drive/shortcuts';
import { DriveError } from '../../src/worker/drive/errors';
import type { DriveFileMeta, GetMetadataInput, OAuthCatalogWriteProvider, ResolvedWriter } from '../../src/worker/drive/types';

const ROOT = 'root-folder';
const MY: MountScope = { mountId: 'm-my', rootFolderId: ROOT, driveId: null };
const SHARED: MountScope = { mountId: 'm-sd', rootFolderId: '0AAAdrive', driveId: '0AAAdrive' };

/** Mutable in-memory folder tree (id -> ParentMeta) that records every lookup; unknown ids 404. */
function tree(folders: readonly ParentMeta[]) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const calls: string[] = [];
  const lookup: ParentLookup = async (id) => {
    calls.push(id);
    const found = byId.get(id);
    if (found === undefined) throw new DriveError('not-found', `${id} not found`, { status: 404 });
    return found;
  };
  return { lookup, calls, byId };
}

/** A chain f1 -> f2 -> ... -> fN -> ROOT. */
function chain(length: number): ParentMeta[] {
  return Array.from({ length }, (_, i) => ({ id: `f${i + 1}`, parents: [i + 1 === length ? ROOT : `f${i + 2}`] }));
}

/** Every folder resolves directly under ROOT. */
function flat(): { lookup: ParentLookup; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lookup: async (id) => {
      calls.push(id);
      return { id, parents: [ROOT] };
    },
  };
}

function file(parent: string, over: Partial<ParentMeta> = {}): ParentMeta {
  return { id: 'file-1', parents: [parent], ...over };
}

/** The ResourceScopeError reason assertInMount throws, or 'none'. */
async function reason(scope: MountScope, meta: ParentMeta, lookup: ParentLookup): Promise<string> {
  try {
    await assertInMount(scope, meta, lookup);
    return 'none';
  } catch (err) {
    expect(err).toBeInstanceOf(ResourceScopeError);
    return (err as ResourceScopeError).reason;
  }
}

beforeEach(() => {
  resetContainmentCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scope helpers', () => {
  it('derives the scope and kind from a mount record', () => {
    expect(mountScopeOf({ id: 'm-1', rootFolderId: 'r', driveId: null })).toEqual({ mountId: 'm-1', rootFolderId: 'r', driveId: null });
    expect(mountKindOf({ driveId: null })).toBe('my_drive_folder');
    expect(mountKindOf({ driveId: '0AAA' })).toBe('shared_drive');
  });

  it('requireSharedDriveId returns the drive or fails closed for My Drive', () => {
    expect(requireSharedDriveId(SHARED)).toBe('0AAAdrive');
    expect(() => requireSharedDriveId(MY)).toThrow(ResourceScopeError);
  });

  it('shortcuts.ts re-exports the same ResourceScopeError class', () => {
    expect(ReexportedScopeError).toBe(ResourceScopeError);
  });

  it('pins the spec constants', () => {
    expect([CONTAINMENT_MAX_DEPTH, CONTAINMENT_TTL_MS, CONTAINMENT_CACHE_MAX]).toEqual([32, 60_000, 5000]);
  });
});

describe('Shared Drive rule (unchanged)', () => {
  it('accepts meta.driveId === scope.driveId without any lookup', async () => {
    const { lookup, calls } = tree([]);
    expect(await reason(SHARED, { id: 'x', driveId: '0AAAdrive', parents: ['p'] }, lookup)).toBe('none');
    expect(calls).toEqual([]);
  });

  it('rejects another drive, a missing driveId and trashed items', async () => {
    const { lookup, calls } = tree([]);
    expect(await reason(SHARED, { id: 'x', driveId: '0BBB' }, lookup)).toBe('outside-mount');
    expect(await reason(SHARED, { id: 'x' }, lookup)).toBe('outside-mount');
    expect(await reason(SHARED, { id: 'x', driveId: '0AAAdrive', trashed: true }, lookup)).toBe('trashed');
    expect(calls).toEqual([]);
  });
});

describe('My Drive ancestor walk', () => {
  it('accepts the root folder itself without a lookup', async () => {
    const { lookup, calls } = tree([]);
    expect(await isInMount(MY, { id: ROOT, parents: ['my-drive-root'] }, lookup)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('accepts a direct child of the root without a lookup', async () => {
    const { lookup, calls } = tree([]);
    expect(await isInMount(MY, file(ROOT), lookup)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('accepts a deep descendant by walking parents[0]', async () => {
    const { lookup, calls } = tree(chain(5));
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(calls).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
  });

  it(`accepts exactly ${CONTAINMENT_MAX_DEPTH} hops and rejects one more`, async () => {
    const ok = tree(chain(CONTAINMENT_MAX_DEPTH));
    expect(await isInMount(MY, file('f1'), ok.lookup)).toBe(true);
    expect(ok.calls.length).toBe(CONTAINMENT_MAX_DEPTH);
    resetContainmentCacheForTests();
    const deep = tree(chain(CONTAINMENT_MAX_DEPTH + 1));
    expect(await reason(MY, file('f1'), deep.lookup)).toBe('outside-mount');
    expect(deep.calls.length).toBe(CONTAINMENT_MAX_DEPTH);
  });

  it('rejects a path through a trashed ancestor', async () => {
    const { lookup } = tree(chain(3).map((f) => (f.id === 'f2' ? { ...f, trashed: true } : f)));
    expect(await reason(MY, file('f1'), lookup)).toBe('outside-mount');
  });

  it('reports the target itself as trashed', async () => {
    expect(await reason(MY, file(ROOT, { trashed: true }), tree([]).lookup)).toBe('trashed');
  });

  it('rejects an out-of-tree file whose ancestors run out of parents', async () => {
    const { lookup } = tree([{ id: 'elsewhere', parents: ['my-drive-root'] }, { id: 'my-drive-root' }]);
    expect(await reason(MY, file('elsewhere'), lookup)).toBe('outside-mount');
    expect(await isInMount(MY, { id: 'orphan' }, lookup)).toBe(false);
  });

  it('treats a 404 ancestor as outside', async () => {
    expect(await isInMount(MY, file('gone'), tree([]).lookup)).toBe(false);
  });

  it('rejects a target or ancestor carrying a driveId in a My Drive mount', async () => {
    const { lookup, calls } = tree([{ id: 'sd-folder', parents: [ROOT], driveId: '0AAA' }]);
    expect(await isInMount(MY, file(ROOT, { driveId: '0AAA' }), lookup)).toBe(false);
    expect(calls).toEqual([]);
    expect(await isInMount(MY, file('sd-folder'), lookup)).toBe(false);
  });

  it('propagates non-404 upstream failures and caches nothing', async () => {
    let fail = true;
    const { lookup: ok, calls } = flat();
    const lookup: ParentLookup = async (id) => {
      if (fail) {
        calls.push(id);
        throw new DriveError('upstream-unavailable', 'boom', { status: 503 });
      }
      return ok(id);
    };
    await expect(isInMount(MY, file('f1'), lookup)).rejects.toBeInstanceOf(DriveError);
    fail = false;
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(calls).toEqual(['f1', 'f1']);
  });
});

describe('verdict cache', () => {
  it('serves a repeat check from the cache (no new lookups)', async () => {
    const { lookup, calls } = tree(chain(3));
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    // A sibling file under an already-proven folder costs nothing.
    expect(await isInMount(MY, { id: 'file-2', parents: ['f2'] }, lookup)).toBe(true);
    expect(calls.length).toBe(3);
  });

  it('caches negative verdicts for every folder on a failed path', async () => {
    const { lookup, calls } = tree([{ id: 'a', parents: ['b'] }, { id: 'b', parents: ['my-drive-root'] }, { id: 'my-drive-root' }]);
    expect(await isInMount(MY, file('a'), lookup)).toBe(false);
    expect(await isInMount(MY, { id: 'file-2', parents: ['b'] }, lookup)).toBe(false);
    expect(calls).toEqual(['a', 'b', 'my-drive-root']);
  });

  it('re-walks after the TTL so an external move out of the mount is denied (Review Focus #1)', async () => {
    const t0 = 1_760_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const { lookup, calls, byId } = tree(chain(2));
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(calls).toEqual(['f1', 'f2']);

    // Someone moves f2 out of the mount in the Drive UI.
    byId.set('f2', { id: 'f2', parents: ['outside'] });
    byId.set('outside', { id: 'outside' });

    // Within the TTL only the already-cached verdict is trusted.
    now.mockReturnValue(t0 + CONTAINMENT_TTL_MS - 1);
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(calls).toEqual(['f1', 'f2']);

    // Once the TTL expires the walk runs again and denies.
    now.mockReturnValue(t0 + CONTAINMENT_TTL_MS);
    expect(await reason(MY, file('f1'), lookup)).toBe('outside-mount');
    expect(calls).toEqual(['f1', 'f2', 'f1', 'f2', 'outside']);
  });

  it('invalidateFolder forces the next check to look the folder up again', async () => {
    const { lookup, calls } = tree(chain(1));
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(calls).toEqual(['f1']);
    invalidateFolder(MY, 'f1');
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(calls).toEqual(['f1', 'f1']);
  });

  it('keys verdicts per mount', async () => {
    const { lookup, calls } = tree(chain(1));
    expect(await isInMount(MY, file('f1'), lookup)).toBe(true);
    expect(await isInMount({ ...MY, mountId: 'm-other' }, file('f1'), lookup)).toBe(true);
    expect(calls).toEqual(['f1', 'f1']);
  });

  it(`is an LRU bounded at ${CONTAINMENT_CACHE_MAX} entries`, async () => {
    const { lookup, calls } = flat();
    const check = (id: string) => isInMount(MY, file(id), lookup);
    for (let i = 0; i < CONTAINMENT_CACHE_MAX; i++) await check(`d${i}`);
    expect(calls.length).toBe(CONTAINMENT_CACHE_MAX);
    // Touch d0 so it becomes most recently used; d1 is now the oldest.
    await check('d0');
    expect(calls.length).toBe(CONTAINMENT_CACHE_MAX);
    // One more entry evicts exactly the least recently used (d1).
    await check('d-new');
    await check('d0');
    await check(`d${CONTAINMENT_CACHE_MAX - 1}`);
    expect(calls.length).toBe(CONTAINMENT_CACHE_MAX + 1);
    await check('d1');
    expect(calls.length).toBe(CONTAINMENT_CACHE_MAX + 2);
    expect(calls.at(-1)).toBe('d1');
  });
});

describe('oauthParentLookup', () => {
  const writer: ResolvedWriter = {
    connectionId: 'conn-1', principalId: 'p-1', oauthClientId: 'oc-1',
    projectId: 'proj', connectionVersion: 1, oauthClientVersion: 1,
  };
  const providerOf = (getMetadata: (input: GetMetadataInput) => Promise<DriveFileMeta>) =>
    ({ getMetadata }) as unknown as OAuthCatalogWriteProvider;

  it('reads parents/trashed/driveId through the given OAuth writer', async () => {
    const seen: GetMetadataInput[] = [];
    const provider = providerOf(async (input) => {
      seen.push(input);
      const folder = 'application/vnd.google-apps.folder';
      return { id: input.ref.id, name: 'Folder', mimeType: folder, parents: ['up'], trashed: false, hasThumbnail: false };
    });
    expect(await oauthParentLookup({ provider, writer })('f-9')).toEqual({ id: 'f-9', parents: ['up'], trashed: false });
    expect(seen[0]?.writer).toBe(writer);
    expect(seen[0]?.ref).toEqual({ id: 'f-9' });
  });

  it('lets a 404 surface as "outside" through isInMount', async () => {
    const provider = providerOf(async () => {
      throw new DriveError('not-found', 'nope', { status: 404 });
    });
    expect(await isInMount(MY, file('f-9'), oauthParentLookup({ provider, writer }))).toBe(false);
  });
});
