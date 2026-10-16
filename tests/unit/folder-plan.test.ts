import { describe, expect, it } from 'vitest';

import {
  planFolderTree,
  type FolderPlanFile,
} from '../../src/web/features/transfers/folder-plan';
import {
  canonicalPlanDigest,
  findPlanGraphIssue,
} from '../../src/shared/contracts/uploads';

function file(
  path: string,
  totalBytes: string | number | bigint = '1',
  mimeType = 'application/octet-stream',
): FolderPlanFile {
  return { path, totalBytes, mimeType };
}

describe('planFolderTree', () => {
  it('builds a deterministic tree with parents before children', async () => {
    const result = await planFolderTree([
      file('root/sub/b.txt', '2'),
      file('root/a.txt', '3'),
      file('other/c.txt', '5'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan } = result;
    expect(plan.fileCount).toBe(3);
    expect(plan.folderCount).toBe(3); // root, root/sub, other
    expect(plan.totalBytes).toBe('10');
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);

    const kinds = plan.nodes.map((n) => n.kind);
    // Every folder precedes its children.
    const ids = new Map(plan.nodes.map((n, i) => [n.nodeId, i]));
    for (const n of plan.nodes) {
      if (n.parentNodeId !== null) {
        expect(ids.get(n.parentNodeId)).toBeLessThan(ids.get(n.nodeId)!);
      }
    }
    // Folders first by depth, deterministic sibling order.
    expect(kinds[0]).toBe('folder');
    const names = plan.nodes
      .filter((n) => n.kind === 'folder' && n.parentNodeId === null)
      .map((n) => n.displayName);
    expect(names).toEqual(['other', 'root']);
  });

  it('is input-order independent (same tree, same ids, same digest)', async () => {
    const a = await planFolderTree([
      file('d/z.txt', '1'),
      file('d/e/f.txt', '4'),
      file('d/e/g.txt', '6'),
    ]);
    const b = await planFolderTree([
      file('d/e/g.txt', '6'),
      file('d/z.txt', '1'),
      file('d/e/f.txt', '4'),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.plan).toEqual(b.plan);
  });

  it('keeps same-named folders under different parents distinct', async () => {
    const result = await planFolderTree([
      file('a/dup/x.txt'),
      file('b/dup/y.txt'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dups = result.plan.nodes.filter(
      (n) => n.kind === 'folder' && n.displayName === 'dup',
    );
    expect(dups).toHaveLength(2);
    expect(dups[0]!.nodeId).not.toBe(dups[1]!.nodeId);
    // Each file binds to its own 'dup' folder, never the sibling's.
    const fileFor = (parentName: string) =>
      result.plan.nodes.find(
        (n) =>
          n.kind === 'file' &&
          n.parentNodeId ===
            dups.find((d) =>
              result.plan.nodes.some(
                (p) =>
                  p.nodeId === d.parentNodeId && p.displayName === parentName,
              ),
            )!.nodeId,
      );
    expect(fileFor('a')?.displayName).toBe('x.txt');
    expect(fileFor('b')?.displayName).toBe('y.txt');
  });

  it('NFC/NFD equivalent names dedupe to one folder node', async () => {
    const nfc = 'Café/x.txt';
    const nfd = 'Café/y.txt'.normalize('NFD');
    const result = await planFolderTree([file(nfc), file(nfd)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const folders = result.plan.nodes.filter((n) => n.kind === 'folder');
    expect(folders).toHaveLength(1);
    // The first-seen display name is preserved byte-for-byte.
    expect(folders[0]!.displayName).toBe('Café');
  });

  it('accepts backslash separators', async () => {
    const result = await planFolderTree([file('a\\b\\c.txt')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.plan.nodes.map((n) => n.displayName);
    expect(names).toEqual(['a', 'b', 'c.txt']);
  });

  it('accepts number and bigint sizes', async () => {
    const result = await planFolderTree([
      file('a.txt', 7),
      { path: 'b.txt', totalBytes: 9n },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.totalBytes).toBe('16');
    expect(
      result.plan.nodes.find((n) => n.displayName === 'b.txt')?.totalBytes,
    ).toBe('9');
  });

  it('rejects a duplicated file path deterministically', async () => {
    for (const entries of [
      [file('a/x.txt'), file('a/x.txt')],
      // NFC and NFD spellings of one path are the same path.
      [file('Café.txt'), file('Café.txt'.normalize('NFD'))],
    ]) {
      const result = await planFolderTree(entries);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('DUPLICATE_PATH');
    }
  });

  it('rejects file/folder kind collisions in both directions', async () => {
    const fileThenDir = await planFolderTree([
      file('a/b'),
      file('a/b/c.txt'),
    ]);
    expect(fileThenDir.ok).toBe(false);
    if (!fileThenDir.ok) expect(fileThenDir.error.code).toBe('KIND_COLLISION');
    const dirThenFile = await planFolderTree([
      file('a/b/c.txt'),
      file('a/b'),
    ]);
    expect(dirThenFile.ok).toBe(false);
    if (!dirThenFile.ok) expect(dirThenFile.error.code).toBe('KIND_COLLISION');
  });

  it('rejects escaping and malformed paths', async () => {
    const bad: Array<[string, string]> = [
      ['../x.txt', 'PATH_ESCAPE'],
      ['a/../x.txt', 'PATH_ESCAPE'],
      ['/x.txt', 'INVALID_PATH'],
      ['a//x.txt', 'INVALID_PATH'],
      ['a/./x.txt', 'INVALID_PATH'],
      ['x.txt/', 'INVALID_PATH'],
      ['', 'INVALID_PATH'],
      ['a/\0x.txt', 'INVALID_PATH'],
    ];
    for (const [path, code] of bad) {
      const result = await planFolderTree([file(path)]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
  });

  it('rejects invalid sizes', async () => {
    for (const size of ['-1', '1.5', 'abc', '', 1.5, -3, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await planFolderTree([
        { path: 'x.txt', totalBytes: size as string },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SIZE');
    }
  });

  it('rejects an empty plan and plans over the node cap', async () => {
    expect((await planFolderTree([])).ok).toBe(false);
    const big = await planFolderTree(
      [file('a/1.txt'), file('a/2.txt'), file('a/3.txt')],
      { maxNodes: 3 },
    );
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe('PLAN_TOO_LARGE');
  });

  it('node ids are opaque and bounded', async () => {
    const result = await planFolderTree([file('a/b/c.txt')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const n of result.plan.nodes) {
      expect(n.nodeId).toMatch(/^n[0-9a-f]{40}$/);
      expect(n.displayName).not.toBe(n.nodeId);
    }
  });
});

describe('findPlanGraphIssue', () => {
  const folder = (nodeId: string, parentNodeId: string | null = null) => ({
    nodeId,
    parentNodeId,
    kind: 'folder' as const,
  });
  const leaf = (nodeId: string, parentNodeId: string | null = null) => ({
    nodeId,
    parentNodeId,
    kind: 'file' as const,
  });

  it('accepts a valid tree', () => {
    expect(
      findPlanGraphIssue([folder('a'), folder('b', 'a'), leaf('f', 'b')]),
    ).toBeNull();
  });

  it('rejects cycles deterministically', () => {
    expect(
      findPlanGraphIssue([
        folder('a', 'b'),
        folder('b', 'a'),
      ])?.reason,
    ).toBe('cycle');
    expect(
      findPlanGraphIssue([folder('a', 'a')])?.reason,
    ).toBe('cycle');
  });

  it('rejects missing and foreign parents', () => {
    expect(findPlanGraphIssue([leaf('f', 'ghost')])?.reason).toBe(
      'missing-parent',
    );
    expect(
      findPlanGraphIssue([leaf('a'), leaf('f', 'a')])?.reason,
    ).toBe('parent-not-folder');
  });

  it('rejects duplicate node ids', () => {
    expect(findPlanGraphIssue([folder('a'), leaf('a')])?.reason).toBe(
      'duplicate-node',
    );
  });
});

describe('canonicalPlanDigest', () => {
  it('is stable for the same ordered node list', async () => {
    const nodes = [
      { nodeId: 'n1', parentNodeId: null, kind: 'folder' as const, displayName: 'Café' },
      {
        nodeId: 'n2',
        parentNodeId: 'n1',
        kind: 'file' as const,
        displayName: 'x.txt',
        mimeType: 'text/plain',
        totalBytes: '3' as const,
      },
    ];
    const a = await canonicalPlanDigest(nodes);
    const b = await canonicalPlanDigest(
      nodes.map((n) => ({ ...n, displayName: n.displayName.normalize('NFD') })),
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // NFC folding makes the digest encoding-independent.
    expect(a).toBe(b);
  });
});
