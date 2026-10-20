import { describe, expect, it } from 'vitest';
import {
  runSaBulkAction,
  runSaPoolAction,
  saChunks,
  SA_BULK_CHUNK_SIZE,
  SA_POOL_CHUNK_SIZE,
} from '../../src/web/features/admin/service-accounts-actions';
import type {
  MountAdminView,
  ServiceAccountBulkResponse,
} from '../../src/shared/contracts/admin';

/**
 * Wave-10 review fix (M2): select-all spans every filtered page, so the SPA
 * must split bulk enable/disable into server-sized chunks (200) and pool
 * edits into chunks of 100, run them sequentially and merge per-id results.
 */

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `sa-${i}`);
}

describe('saChunks', () => {
  it('splits into size-bounded chunks preserving order', () => {
    expect(saChunks(ids(5), 2)).toEqual([
      ['sa-0', 'sa-1'],
      ['sa-2', 'sa-3'],
      ['sa-4'],
    ]);
    expect(saChunks([], 10)).toEqual([]);
    expect(saChunks(ids(4), 4)).toEqual([ids(4)]);
  });
});

describe('runSaBulkAction', () => {
  it('runs sequential chunks of 200 and merges per-id results in order', async () => {
    const sizes: number[] = [];
    const outcome = await runSaBulkAction('disable', ids(450), {
      bulk: async (_action, chunk) => {
        sizes.push(chunk.length);
        const res: ServiceAccountBulkResponse = {
          results: chunk.map((id) => ({ id, ok: true })),
        };
        return res;
      },
    });
    expect(sizes).toEqual([200, 200, 50]);
    expect(outcome.results.map((r) => r.id)).toEqual(ids(450));
    expect(outcome.ok).toBe(450);
    expect(outcome.failed).toBe(0);
    expect(SA_BULK_CHUNK_SIZE).toBe(200);
  });

  it('marks every id in a failed request as failed and continues', async () => {
    let call = 0;
    const outcome = await runSaBulkAction('enable', ids(210), {
      bulk: async (_action, chunk) => {
        call += 1;
        if (call === 2) throw new Error('server rejected the chunk');
        return { results: chunk.map((id) => ({ id, ok: true })) };
      },
    });
    expect(outcome.results).toHaveLength(210);
    expect(outcome.ok).toBe(200);
    expect(outcome.failed).toBe(10);
    // The failed chunk's ids are reported per id, in request order.
    for (const result of outcome.results.slice(200)) {
      expect(result.ok).toBe(false);
      expect(result.code).toBeTruthy();
    }
    // Per-id failures inside a successful response are honoured too.
    const partial = await runSaBulkAction('enable', ids(3), {
      bulk: async (_a, chunk) => ({
        results: chunk.map((id, i) =>
          i === 1 ? { id, ok: false, code: 'NOT_FOUND' } : { id, ok: true },
        ),
      }),
    });
    expect(partial.ok).toBe(2);
    expect(partial.failed).toBe(1);
  });
});

describe('runSaPoolAction', () => {
  const mount = (label: string): MountAdminView =>
    ({
      id: 'm-1',
      label,
      kind: 'shared_drive',
      rootFolderId: 'r',
      driveId: 'd',
      catalogConnectionId: 'c',
      writeConnectionId: 'c',
      readPoolVersion: 1,
      visibility: 'private',
      policyVersion: 1,
      readPool: [],
    }) as MountAdminView;

  it('runs sequential chunks of 100 and tallies ok/failed per id', async () => {
    const sizes: number[] = [];
    const outcome = await runSaPoolAction('add', 'm-1', ids(250), {
      pool: async (_mountId, chunk) => {
        sizes.push(chunk.length);
        return { mount: mount('Mount A') };
      },
    });
    expect(sizes).toEqual([100, 100, 50]);
    expect(outcome.ok).toBe(250);
    expect(outcome.failed).toBe(0);
    expect(outcome.mount?.label).toBe('Mount A');
    expect(SA_POOL_CHUNK_SIZE).toBe(100);
  });

  it('counts a failed chunk as failed ids and keeps the last good mount', async () => {
    let call = 0;
    const outcome = await runSaPoolAction('remove', 'm-1', ids(150), {
      pool: async () => {
        call += 1;
        if (call === 1) throw new Error('cap exceeded');
        return { mount: mount('Mount B') };
      },
    });
    expect(outcome.ok).toBe(50);
    expect(outcome.failed).toBe(100);
    expect(outcome.mount?.label).toBe('Mount B');
  });
});
