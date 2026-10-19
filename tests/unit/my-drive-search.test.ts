import { describe, expect, it } from 'vitest';
import { CursorError } from '../../src/worker/drive/cursors';
import {
  MY_DRIVE_SEARCH_MAX_GOOGLE_PAGES,
  MY_DRIVE_SEARCH_MAX_HITS,
  collectMyDriveHits,
  decodeSearchState,
  encodeSearchState,
} from '../../src/worker/drive/my-drive-search';
import type { CatalogEntry, CatalogPage } from '../../src/worker/drive/types';

function ent(id: string): CatalogEntry {
  return {
    id,
    kind: 'file',
    name: id,
    mimeType: 'text/plain',
    size: '1',
    hasThumbnail: false,
  } as CatalogEntry;
}

/** Entries whose id starts with "out-" are outside the mount. */
const inMount = (e: CatalogEntry) => Promise.resolve(!e.id.startsWith('out-'));

function scripted(pages: Record<string, CatalogPage>) {
  const tokens: Array<string | undefined> = [];
  return {
    tokens,
    fetchPage: (token: string | undefined): Promise<CatalogPage> => {
      tokens.push(token);
      const page = pages[token ?? ''];
      if (page === undefined) return Promise.reject(new Error(`no page ${token ?? '<first>'}`));
      return Promise.resolve(page);
    },
  };
}

const many = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ent(`${prefix}${i}`));

describe('constants', () => {
  it('match the spec', () => {
    expect(MY_DRIVE_SEARCH_MAX_GOOGLE_PAGES).toBe(3);
    expect(MY_DRIVE_SEARCH_MAX_HITS).toBe(50);
  });
});

describe('search state codec', () => {
  it('round-trips and defaults to the first page', () => {
    expect(decodeSearchState(undefined)).toEqual({ s: 0 });
    expect(decodeSearchState(encodeSearchState({ t: 'g2', s: 7 }))).toEqual({ t: 'g2', s: 7 });
    expect(decodeSearchState(encodeSearchState({ s: 50 }))).toEqual({ s: 50 });
  });

  it('rejects malformed states as CursorError', () => {
    for (const bad of ['', 'not json', 'null', '[]', '{"s":-1}', '{"s":1.5}', '{"s":"1"}', '{"t":"","s":0}', '{"t":3,"s":0}', '{"s":100000}']) {
      expect(() => decodeSearchState(bad), bad).toThrow(CursorError);
    }
  });
});

describe('collectMyDriveHits', () => {
  it('filters out-of-tree entries and keeps order', async () => {
    const src = scripted({
      '': { entries: [ent('a'), ent('out-1'), ent('b'), ent('out-2'), ent('c')] },
    });
    const page = await collectMyDriveHits({ state: { s: 0 }, fetchPage: src.fetchPage, inMount });
    expect(page.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(page.nextPageToken).toBeUndefined();
  });

  it('reads at most 3 Google pages and resumes at the fourth', async () => {
    const src = scripted({
      '': { entries: [ent('out-1')], nextPageToken: 'g2' },
      g2: { entries: [ent('out-2')], nextPageToken: 'g3' },
      g3: { entries: [ent('hit-1')], nextPageToken: 'g4' },
      g4: { entries: [ent('hit-2')] },
    });
    const first = await collectMyDriveHits({ state: { s: 0 }, fetchPage: src.fetchPage, inMount });
    expect(src.tokens).toEqual([undefined, 'g2', 'g3']);
    expect(first.entries.map((e) => e.id)).toEqual(['hit-1']);
    expect(decodeSearchState(first.nextPageToken)).toEqual({ t: 'g4', s: 0 });

    const second = await collectMyDriveHits({
      state: decodeSearchState(first.nextPageToken),
      fetchPage: src.fetchPage,
      inMount,
    });
    expect(src.tokens.at(-1)).toBe('g4');
    expect(second.entries.map((e) => e.id)).toEqual(['hit-2']);
    expect(second.nextPageToken).toBeUndefined();
  });

  it('returns at most 50 hits and resumes inside the same Google page without loss', async () => {
    const all = many('h', 60);
    const src = scripted({
      '': { entries: all, nextPageToken: 'g2' },
      g2: { entries: [ent('tail')] },
    });
    const first = await collectMyDriveHits({ state: { s: 0 }, fetchPage: src.fetchPage, inMount });
    expect(first.entries).toHaveLength(50);
    expect(first.entries.at(-1)!.id).toBe('h49');
    expect(decodeSearchState(first.nextPageToken)).toEqual({ s: 50 });
    expect(src.tokens).toEqual([undefined]);

    const second = await collectMyDriveHits({
      state: decodeSearchState(first.nextPageToken),
      fetchPage: src.fetchPage,
      inMount,
    });
    expect(second.entries.map((e) => e.id)).toEqual([...all.slice(50).map((e) => e.id), 'tail']);
    expect(second.nextPageToken).toBeUndefined();
    expect(src.tokens).toEqual([undefined, undefined, 'g2']);
  });

  it('moves to the next Google page when the 50th hit ends a page exactly', async () => {
    const src = scripted({
      '': { entries: many('h', 50), nextPageToken: 'g2' },
    });
    const first = await collectMyDriveHits({ state: { s: 0 }, fetchPage: src.fetchPage, inMount });
    expect(first.entries).toHaveLength(50);
    expect(decodeSearchState(first.nextPageToken)).toEqual({ t: 'g2', s: 0 });
  });

  it('has no continuation when the 50th hit ends the last page', async () => {
    const src = scripted({ '': { entries: many('h', 50) } });
    const first = await collectMyDriveHits({ state: { s: 0 }, fetchPage: src.fetchPage, inMount });
    expect(first.entries).toHaveLength(50);
    expect(first.nextPageToken).toBeUndefined();
  });

  it('preserves order across containment chunks', async () => {
    const entries = many('h', 35);
    const delays = (e: CatalogEntry) =>
      new Promise<boolean>((resolve) => {
        const n = Number(e.id.slice(1));
        setTimeout(() => resolve(true), (35 - n) % 4);
      });
    const src = scripted({ '': { entries } });
    const page = await collectMyDriveHits({ state: { s: 0 }, fetchPage: src.fetchPage, inMount: delays });
    expect(page.entries.map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it('fails closed when a containment lookup throws', async () => {
    const src = scripted({ '': { entries: [ent('a'), ent('b')] } });
    await expect(
      collectMyDriveHits({
        state: { s: 0 },
        fetchPage: src.fetchPage,
        inMount: (e) => (e.id === 'b' ? Promise.reject(new Error('lookup failed')) : Promise.resolve(true)),
      }),
    ).rejects.toThrow('lookup failed');
  });
});
