/** isWithinFolder unit tests (wave 8 B2): descendant-of-link-root proof
 * for Shared Drive and My Drive scopes, walk bounds and caching. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isWithinFolder,
  resetDescendantCacheForTests,
  type MountScope,
  type ParentMeta,
} from '../../src/worker/drive/containment';
import { DriveError } from '../../src/worker/drive/errors';

const SD: MountScope = { mountId: 'm1', rootFolderId: 'drive-1', driveId: 'drive-1' };
const MD: MountScope = { mountId: 'm2', rootFolderId: 'mount-root', driveId: null };

function lookup(tree: Record<string, Partial<ParentMeta>>) {
  const calls: string[] = [];
  const fn = async (id: string): Promise<ParentMeta> => {
    calls.push(id);
    const node = tree[id];
    if (node === undefined) throw new DriveError('not-found', 'gone', { status: 404 });
    return { id, ...node } as ParentMeta;
  };
  return { fn, calls };
}

beforeEach(() => resetDescendantCacheForTests());

describe('shared drive scope', () => {
  const tree: Record<string, Partial<ParentMeta>> = {
    'link-root': { name: 'Public', parents: ['drive-1'], driveId: 'drive-1' },
    'sub': { name: 'Sub', parents: ['link-root'], driveId: 'drive-1' },
    'drive-1': { name: 'Drive', parents: [], driveId: 'drive-1' },
    'outside': { name: 'Out', parents: ['drive-1'], driveId: 'drive-1' },
    'other-drive': { name: 'X', parents: ['x'], driveId: 'drive-9' },
  };
  it('admits root, direct child and deep descendant', async () => {
    const l = lookup(tree);
    expect((await isWithinFolder(SD, 'link-root', { id: 'link-root', driveId: 'drive-1' }, l.fn)).inside).toBe(true);
    expect((await isWithinFolder(SD, 'link-root', { id: 'f1', parents: ['link-root'], driveId: 'drive-1' }, l.fn)).inside).toBe(true);
    const deep = await isWithinFolder(SD, 'link-root', { id: 'f2', parents: ['sub'], driveId: 'drive-1' }, l.fn);
    expect(deep.inside).toBe(true);
    expect(deep.path.map((p) => p.id)).toEqual(['sub']);
  });
  it('rejects siblings, other drives and trashed metas', async () => {
    const l = lookup(tree);
    expect((await isWithinFolder(SD, 'link-root', { id: 'f3', parents: ['outside'], driveId: 'drive-1' }, l.fn)).inside).toBe(false);
    expect((await isWithinFolder(SD, 'link-root', { id: 'f4', driveId: 'drive-9' }, l.fn)).inside).toBe(false);
    expect((await isWithinFolder(SD, 'link-root', { id: 'f5', parents: ['link-root'], driveId: 'drive-1', trashed: true }, l.fn)).inside).toBe(false);
  });
  it('treats link root == mount root correctly', async () => {
    const l = lookup(tree);
    expect((await isWithinFolder(SD, 'drive-1', { id: 'f6', parents: ['outside'], driveId: 'drive-1' }, l.fn)).inside).toBe(true);
  });
});

describe('my drive scope', () => {
  const tree: Record<string, Partial<ParentMeta>> = {
    'mount-root': { name: 'Mount', parents: ['mydrv'] },
    'link-root': { name: 'Pub', parents: ['mount-root'] },
    'sub': { name: 'Sub', parents: ['link-root'] },
    'outside': { name: 'Out', parents: ['mydrv'] },
    'mydrv': { name: 'My Drive', parents: [] },
    'shared-folder': { name: 'Elsewhere', parents: [], driveId: 'drive-9' },
  };
  it('walks to the link root inside a My Drive mount', async () => {
    const l = lookup(tree);
    const deep = await isWithinFolder(MD, 'link-root', { id: 'f1', parents: ['sub'] }, l.fn);
    expect(deep.inside).toBe(true);
    expect(deep.path.map((p) => p.name)).toEqual(['Sub']);
    const sib = await isWithinFolder(MD, 'link-root', { id: 'f2', parents: ['outside'] }, l.fn);
    expect(sib.inside).toBe(false);
    expect((await isWithinFolder(MD, 'link-root', { id: 'f3', driveId: 'drive-9' }, l.fn)).inside).toBe(false);
  });
});

describe('bounds and caching', () => {
  it('stops at the depth cap and caches verdicts', async () => {
    const tree: Record<string, Partial<ParentMeta>> = { 'link-root': { parents: ['drive-1'], driveId: 'drive-1' } };
    let prev = 'link-root';
    for (let i = 0; i < 40; i++) { tree[`d${i}`] = { parents: [prev], driveId: 'drive-1' }; prev = `d${i}`; }
    const l = lookup(tree);
    const res = await isWithinFolder(SD, 'link-root', { id: 'deep', parents: [prev], driveId: 'drive-1' }, l.fn);
    expect(res.inside).toBe(false);
    expect(l.calls.length).toBeLessThanOrEqual(33);
    // Cached: a second run of an inside verdict does no lookups.
    const l2 = lookup({ 'link-root': { parents: ['drive-1'], driveId: 'drive-1' }, 'sub': { parents: ['link-root'], driveId: 'drive-1' } });
    await isWithinFolder(SD, 'link-root', { id: 'f', parents: ['sub'], driveId: 'drive-1' }, l2.fn);
    const n = l2.calls.length;
    await isWithinFolder(SD, 'link-root', { id: 'f', parents: ['sub'], driveId: 'drive-1' }, l2.fn);
    expect(l2.calls.length).toBe(n); // hit cache, no new lookups
  });
});
