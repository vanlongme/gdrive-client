import { describe, expect, it } from 'vitest';
import type { ServiceAccountOverviewEntry } from '../../src/shared/contracts/admin';
import {
  applySaFilter,
  clampSaPage,
  DEFAULT_SA_FILTER,
  matchesSaFilter,
  parseSaFilter,
  pruneSaSelection,
  SA_PAGE_SIZE,
  saDrainedMountIds,
  saEnabledStateOf,
  saFilterToParams,
  saPageCount,
  saPageSlice,
  saSelectAllState,
  summarizeAccounts,
  toggleSaSelectAll,
} from '../../src/web/features/admin/service-accounts-filter';

function sa(over: Partial<ServiceAccountOverviewEntry>): ServiceAccountOverviewEntry {
  return {
    id: 'sa-1',
    projectId: 'proj-1',
    email: 'one@proj-1.iam.gserviceaccount.com',
    keyId: 'key-1',
    enabled: true,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    coolingDown: false,
    cooldownUntil: null,
    mounts: [],
    grants: [],
    ...over,
  };
}

describe('parseSaFilter / saFilterToParams round-trip', () => {
  it('defaults missing and invalid params', () => {
    const params = new URLSearchParams('status=bogus&sort=nope&dir=sideways&page=-3');
    expect(parseSaFilter(params)).toEqual({ ...DEFAULT_SA_FILTER, page: 1 });
    expect(parseSaFilter(new URLSearchParams())).toEqual(DEFAULT_SA_FILTER);
  });

  it('parses every field and round-trips only non-defaults', () => {
    const params = new URLSearchParams(
      'q=Team&status=cooldown&project=proj-9&mount=m-2&sort=created&dir=desc&page=4',
    );
    const filter = parseSaFilter(params);
    expect(filter).toEqual({
      q: 'Team',
      status: 'cooldown',
      project: 'proj-9',
      mount: 'm-2',
      sort: 'created',
      dir: 'desc',
      page: 4,
    });
    const back = new URLSearchParams(saFilterToParams(filter));
    expect(parseSaFilter(back)).toEqual(filter);
    // The default view serializes to an empty query.
    expect(saFilterToParams(DEFAULT_SA_FILTER)).toEqual({});
  });
});

describe('matchesSaFilter', () => {
  const pool = sa({ mounts: [{ id: 'm-1', label: 'A' }] });
  it('matches case-insensitive email, project and key id', () => {
    expect(matchesSaFilter(pool, { q: 'ONE@PROJ', status: 'all', project: '', mount: 'all' })).toBe(true);
    expect(matchesSaFilter(pool, { q: 'key-1', status: 'all', project: '', mount: 'all' })).toBe(true);
    expect(matchesSaFilter(pool, { q: 'zzz', status: 'all', project: '', mount: 'all' })).toBe(false);
  });

  it('keeps enabled/disabled orthogonal to cooldown', () => {
    const cooling = sa({ enabled: true, coolingDown: true });
    const disabledCooling = sa({ enabled: false, coolingDown: true });
    const disabled = sa({ enabled: false });
    expect(saEnabledStateOf(cooling)).toBe('enabled');
    expect(saEnabledStateOf(disabledCooling)).toBe('disabled');
    // Enabled/disabled no longer exclude cooling-down accounts.
    expect(matchesSaFilter(cooling, { q: '', status: 'enabled', project: '', mount: 'all' })).toBe(true);
    expect(matchesSaFilter(disabledCooling, { q: '', status: 'disabled', project: '', mount: 'all' })).toBe(true);
    expect(matchesSaFilter(disabled, { q: '', status: 'disabled', project: '', mount: 'all' })).toBe(true);
    // The cooldown bucket is its own dimension over both states; an unknown
    // cooldown (null) is not "cooling down".
    expect(matchesSaFilter(cooling, { q: '', status: 'cooldown', project: '', mount: 'all' })).toBe(true);
    expect(matchesSaFilter(disabledCooling, { q: '', status: 'cooldown', project: '', mount: 'all' })).toBe(true);
    expect(matchesSaFilter(disabled, { q: '', status: 'cooldown', project: '', mount: 'all' })).toBe(false);
    expect(
      matchesSaFilter(sa({ coolingDown: null }), {
        q: '', status: 'cooldown', project: '', mount: 'all',
      }),
    ).toBe(false);
  });

  it('filters by mount membership and no-pool', () => {
    const pooled = sa({ mounts: [{ id: 'm-1', label: 'A' }] });
    const free = sa({ mounts: [] });
    expect(matchesSaFilter(pooled, { q: '', status: 'all', project: '', mount: 'm-1' })).toBe(true);
    expect(matchesSaFilter(pooled, { q: '', status: 'all', project: '', mount: 'm-2' })).toBe(false);
    expect(matchesSaFilter(pooled, { q: '', status: 'all', project: '', mount: 'none' })).toBe(false);
    expect(matchesSaFilter(free, { q: '', status: 'all', project: '', mount: 'none' })).toBe(true);
  });

  it('filters by project', () => {
    expect(matchesSaFilter(pool, { q: '', status: 'all', project: 'proj-1', mount: 'all' })).toBe(true);
    expect(matchesSaFilter(pool, { q: '', status: 'all', project: 'other', mount: 'all' })).toBe(false);
  });
});

describe('applySaFilter sorting', () => {
  const items = [
    sa({ id: 'a', email: 'c@x.iam.gserviceaccount.com', createdAt: '2026-01-03T00:00:00Z' }),
    sa({ id: 'b', email: 'a@x.iam.gserviceaccount.com', enabled: false, createdAt: '2026-01-01T00:00:00Z' }),
    sa({ id: 'c', email: 'b@x.iam.gserviceaccount.com', coolingDown: true, createdAt: '2026-01-02T00:00:00Z' }),
  ];

  it('sorts by email asc and desc', () => {
    expect(applySaFilter(items, { q: '', status: 'all', project: '', mount: 'all', sort: 'email', dir: 'asc' }).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(applySaFilter(items, { q: '', status: 'all', project: '', mount: 'all', sort: 'email', dir: 'desc' }).map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts by created date', () => {
    expect(applySaFilter(items, { q: '', status: 'all', project: '', mount: 'all', sort: 'created', dir: 'asc' }).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by status: cooldown, enabled, disabled', () => {
    expect(applySaFilter(items, { q: '', status: 'all', project: '', mount: 'all', sort: 'status', dir: 'asc' }).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('paging and summary', () => {
  it('slices at 50 per page and clamps the requested page', () => {
    const items = Array.from({ length: SA_PAGE_SIZE + 7 }, (_, i) => i);
    expect(saPageSlice(items, 1)).toHaveLength(SA_PAGE_SIZE);
    expect(saPageSlice(items, 2)).toHaveLength(7);
    expect(saPageCount(items.length)).toBe(2);
    expect(saPageCount(0)).toBe(1);
    expect(clampSaPage(5, items.length)).toBe(2);
    expect(clampSaPage(0, items.length)).toBe(1);
  });

  it('summarizes the unfiltered set', () => {
    const summary = summarizeAccounts([
      sa({ id: 'a' }),
      sa({ id: 'b', enabled: false }),
      sa({ id: 'c', coolingDown: true }),
      sa({ id: 'd', enabled: false, coolingDown: true, mounts: [{ id: 'm', label: 'x' }] }),
    ]);
    // Enabled+disabled partition the total; cooling is an overlapping count.
    expect(summary).toEqual({ total: 4, enabled: 2, disabled: 2, coolingDown: 2, noPool: 3 });
  });
});

describe('saDrainedMountIds', () => {
  const poolMount = (
    id: string,
    members: readonly { id: string; enabled: boolean }[],
  ) => ({ id, readPool: members });

  it('names mounts whose pool would lose its last enabled member', () => {
    const mounts = [
      poolMount('m-a', [
        { id: 'sa-1', enabled: true },
        { id: 'sa-2', enabled: false },
      ]),
      poolMount('m-b', [
        { id: 'sa-1', enabled: true },
        { id: 'sa-3', enabled: true },
      ]),
      poolMount('m-c', [{ id: 'sa-2', enabled: false }]),
    ];
    // Disabling/removing sa-1 drains m-a (its other member is disabled) but
    // not m-b (sa-3 stays enabled); m-c already had no enabled member.
    expect(saDrainedMountIds(mounts, new Set(['sa-1']))).toEqual(['m-a']);
    expect(saDrainedMountIds(mounts, new Set(['sa-1', 'sa-3']))).toEqual([
      'm-a',
      'm-b',
    ]);
    expect(saDrainedMountIds(mounts, new Set(['sa-2']))).toEqual([]);
  });

  it('scopes to a single mount when asked (pool remove)', () => {
    const mounts = [
      poolMount('m-a', [{ id: 'sa-1', enabled: true }]),
      poolMount('m-b', [{ id: 'sa-1', enabled: true }]),
    ];
    expect(saDrainedMountIds(mounts, new Set(['sa-1']), 'm-b')).toEqual([
      'm-b',
    ]);
    expect(saDrainedMountIds(mounts, new Set(['sa-1']), 'm-x')).toEqual([]);
  });
});

describe('selection helpers', () => {
  it('select-all adds the whole filtered set and toggles it off again', () => {
    const filtered = ['a', 'b', 'c'];
    const selected = toggleSaSelectAll(new Set(['z']), filtered);
    expect([...selected].sort()).toEqual(['a', 'b', 'c', 'z']);
    const cleared = toggleSaSelectAll(selected, filtered);
    expect([...cleared]).toEqual(['z']);
  });

  it('reports all/some/none for the header checkbox', () => {
    const filtered = ['a', 'b'];
    expect(saSelectAllState(new Set(), filtered)).toBe('none');
    expect(saSelectAllState(new Set(['a']), filtered)).toBe('some');
    expect(saSelectAllState(new Set(['a', 'b', 'z']), filtered)).toBe('all');
    expect(saSelectAllState(new Set(['a']), [])).toBe('none');
  });

  it('prunes ids that no longer exist', () => {
    const pruned = pruneSaSelection(new Set(['a', 'b', 'gone']), new Set(['a', 'b']));
    expect([...pruned].sort()).toEqual(['a', 'b']);
  });
});
