import type { ServiceAccountOverviewEntry } from "../../../shared/contracts/admin";

/**
 * Service-account management view state (wave 10): the filter/sort/page model
 * kept in the /admin URL query so a reload restores the exact view. Pure
 * functions only — the component owns React state; this module owns rules.
 */

export const SA_PAGE_SIZE = 50;

export type SaStatusFilter = "all" | "enabled" | "disabled" | "cooldown";
/** 'all' = every SA, 'none' = in no pool, otherwise a mount id. */
export type SaMountFilter = "all" | "none" | (string & {});
export type SaSortKey = "email" | "created" | "status";
export type SaSortDir = "asc" | "desc";

export interface SaFilterState {
  readonly q: string;
  readonly status: SaStatusFilter;
  /** '' = all projects. */
  readonly project: string;
  readonly mount: SaMountFilter;
  readonly sort: SaSortKey;
  readonly dir: SaSortDir;
  /** 1-based page. */
  readonly page: number;
}

export const DEFAULT_SA_FILTER: SaFilterState = {
  q: "",
  status: "all",
  project: "",
  mount: "all",
  sort: "email",
  dir: "asc",
  page: 1,
};

const STATUS_VALUES: ReadonlySet<string> = new Set([
  "all",
  "enabled",
  "disabled",
  "cooldown",
]);
const SORT_VALUES: ReadonlySet<string> = new Set(["email", "created", "status"]);

/** Read the filter model out of the URL query, defaulting invalid values. */
export function parseSaFilter(
  params: Pick<URLSearchParams, "get">,
): SaFilterState {
  const status = params.get("status");
  const sort = params.get("sort");
  const dir = params.get("dir");
  const mount = params.get("mount");
  const rawPage = Number(params.get("page") ?? "1");
  return {
    q: params.get("q") ?? "",
    status:
      status !== null && STATUS_VALUES.has(status)
        ? (status as SaStatusFilter)
        : "all",
    project: params.get("project") ?? "",
    mount:
      mount === null
        ? "all"
        : mount === "none" || mount === "all"
          ? mount
          : mount,
    sort:
      sort !== null && SORT_VALUES.has(sort) ? (sort as SaSortKey) : "email",
    dir: dir === "desc" ? "desc" : "asc",
    page: Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1,
  };
}

/**
 * Write the filter back to URL params — only non-default values are kept so
 * the query stays readable. Any filter change resets the page unless the
 * patch carries one explicitly.
 */
export function saFilterToParams(
  filter: SaFilterState,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (filter.q !== "") out.q = filter.q;
  if (filter.status !== "all") out.status = filter.status;
  if (filter.project !== "") out.project = filter.project;
  if (filter.mount !== "all") out.mount = filter.mount;
  if (filter.sort !== "email") out.sort = filter.sort;
  if (filter.dir !== "asc") out.dir = filter.dir;
  if (filter.page !== 1) out.page = String(filter.page);
  return out;
}

/**
 * The enabled-state badge an SA carries. Cooldown is a separate dimension
 * (review L4): a disabled SA that is also cooling down still matches the
 * "disabled" filter — cooling is shown as an additional badge, never one
 * that takes priority over enabled/disabled.
 */
export function saEnabledStateOf(
  sa: Pick<ServiceAccountOverviewEntry, "enabled">,
): "enabled" | "disabled" {
  return sa.enabled ? "enabled" : "disabled";
}

export function matchesSaFilter(
  sa: ServiceAccountOverviewEntry,
  filter: Pick<SaFilterState, "q" | "status" | "project" | "mount">,
): boolean {
  if (filter.status === "enabled" && !sa.enabled) return false;
  if (filter.status === "disabled" && sa.enabled) return false;
  // coolingDown null means the health check failed — unknown, not cooling.
  if (filter.status === "cooldown" && sa.coolingDown !== true) return false;
  if (filter.project !== "" && sa.projectId !== filter.project) return false;
  if (filter.mount === "none" && sa.mounts.length > 0) return false;
  if (
    filter.mount !== "all" &&
    filter.mount !== "none" &&
    !sa.mounts.some((mount) => mount.id === filter.mount)
  ) {
    return false;
  }
  const q = filter.q.trim().toLowerCase();
  if (q === "") return true;
  return (
    sa.email.toLowerCase().includes(q) ||
    sa.projectId.toLowerCase().includes(q) ||
    sa.keyId.toLowerCase().includes(q)
  );
}

/** Status sort keeps the old order: cooling first, then enabled, disabled. */
function saStatusRank(sa: ServiceAccountOverviewEntry): number {
  if (sa.coolingDown === true) return 0;
  return sa.enabled ? 1 : 2;
}

function compareSa(
  a: ServiceAccountOverviewEntry,
  b: ServiceAccountOverviewEntry,
  sort: SaSortKey,
): number {
  switch (sort) {
    case "created":
      return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    case "status":
      return (
        saStatusRank(a) - saStatusRank(b) ||
        a.email.localeCompare(b.email)
      );
    default:
      return a.email.localeCompare(b.email);
  }
}

/** Filter then sort; paging is applied separately so counts stay honest. */
export function applySaFilter(
  accounts: readonly ServiceAccountOverviewEntry[],
  filter: Pick<SaFilterState, "q" | "status" | "project" | "mount" | "sort" | "dir">,
): ServiceAccountOverviewEntry[] {
  const filtered = accounts.filter((sa) => matchesSaFilter(sa, filter));
  filtered.sort((a, b) => {
    const order = compareSa(a, b, filter.sort);
    return filter.dir === "desc" ? -order : order;
  });
  return filtered;
}

export function saPageSlice<T>(items: readonly T[], page: number): T[] {
  const start = (page - 1) * SA_PAGE_SIZE;
  return items.slice(start, start + SA_PAGE_SIZE);
}

export function saPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / SA_PAGE_SIZE));
}

/** Clamp a requested page into the real range after filtering shrinks. */
export function clampSaPage(page: number, total: number): number {
  return Math.min(Math.max(1, page), saPageCount(total));
}

export interface SaSummary {
  readonly total: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly coolingDown: number;
  readonly noPool: number;
}

export function summarizeAccounts(
  accounts: readonly ServiceAccountOverviewEntry[],
): SaSummary {
  let enabled = 0;
  let disabled = 0;
  let coolingDown = 0;
  let noPool = 0;
  for (const sa of accounts) {
    // enabled+disabled partition the set; cooling overlaps both (review L4).
    if (sa.enabled) enabled += 1;
    else disabled += 1;
    if (sa.coolingDown === true) coolingDown += 1;
    if (sa.mounts.length === 0) noPool += 1;
  }
  return { total: accounts.length, enabled, disabled, coolingDown, noPool };
}

/**
 * Mounts whose read pool would be left with ZERO enabled service accounts
 * after `leavingIds` stop counting — a bulk disable makes the selected ids
 * leave the enabled set, a pool remove makes them leave the pool. A pool
 * that already has no enabled member is not "left" with zero (review L5).
 */
export function saDrainedMountIds(
  mounts: readonly {
    id: string;
    readPool: readonly { id: string; enabled: boolean }[];
  }[],
  leavingIds: ReadonlySet<string>,
  mountId?: string,
): string[] {
  return mounts
    .filter((mount) => mountId === undefined || mount.id === mountId)
    .filter(
      (mount) =>
        mount.readPool.some((member) => member.enabled) &&
        !mount.readPool.some(
          (member) => member.enabled && !leavingIds.has(member.id),
        ),
    )
    .map((mount) => mount.id);
}

/**
 * Select-all over the CURRENT FILTERED set: when every filtered id is
 * already selected the toggle clears them from the selection, otherwise it
 * adds the whole filtered set (existing selections survive).
 */
export function toggleSaSelectAll(
  selected: ReadonlySet<string>,
  filteredIds: readonly string[],
): ReadonlySet<string> {
  const allSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const next = new Set(selected);
  if (allSelected) {
    for (const id of filteredIds) next.delete(id);
  } else {
    for (const id of filteredIds) next.add(id);
  }
  return next;
}

/** Selection state for the header checkbox. */
export function saSelectAllState(
  selected: ReadonlySet<string>,
  filteredIds: readonly string[],
): "all" | "some" | "none" {
  if (filteredIds.length === 0) return "none";
  const count = filteredIds.filter((id) => selected.has(id)).length;
  return count === 0 ? "none" : count === filteredIds.length ? "all" : "some";
}

/** Drop ids that no longer exist (after a reload or import). */
export function pruneSaSelection(
  selected: ReadonlySet<string>,
  existingIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const id of selected) {
    if (existingIds.has(id)) next.add(id);
  }
  return next;
}
