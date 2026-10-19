/**
 * My Drive whole-mount search (spec 4.2). Google's `corpora=user` search
 * spans the owner's entire Drive, so every hit is filtered through
 * containment before it reaches an actor. A request reads at most
 * MY_DRIVE_SEARCH_MAX_GOOGLE_PAGES Google pages and returns at most
 * MY_DRIVE_SEARCH_MAX_HITS hits; the continuation state says exactly where
 * to resume, including in the middle of a Google page, so a capped request
 * never drops a hit.
 *
 * The state string travels INSIDE the sealed catalog cursor (cursors.ts),
 * which already binds actor+session, mount, writer versions, policy and the
 * {q, scope} spec. It is never sent to a client bare.
 */

import { CursorError } from './cursors';
import { isInMount, oauthParentLookup, type MountScope } from './containment';
import type {
  CatalogEntry,
  CatalogPage,
  OAuthCatalogWriteProvider,
  ResolvedWriter,
} from './types';

export const MY_DRIVE_SEARCH_MAX_GOOGLE_PAGES = 3;
export const MY_DRIVE_SEARCH_PAGE_SIZE = 100;
export const MY_DRIVE_SEARCH_MAX_HITS = 50;

/** Hits verified concurrently; shared ancestors resolve via the containment cache. */
const CONTAINMENT_CHUNK = 10;
/** A Google page holds at most 100 entries; anything bigger is a forged state. */
const MAX_SKIP = 1000;

export interface MyDriveSearchState {
  /** Google token of the page being read; absent for the first page. */
  readonly t?: string;
  /** Entries of that page already returned to the caller. */
  readonly s: number;
}

export function encodeSearchState(state: MyDriveSearchState): string {
  return JSON.stringify(state);
}

export function decodeSearchState(raw: string | undefined): MyDriveSearchState {
  if (raw === undefined) return { s: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CursorError('malformed', 'search continuation is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CursorError('malformed', 'search continuation has the wrong shape');
  }
  const record = parsed as Record<string, unknown>;
  const s = record.s;
  const t = record.t;
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 0 || s > MAX_SKIP) {
    throw new CursorError('malformed', 'search continuation offset is invalid');
  }
  if (t !== undefined && (typeof t !== 'string' || t === '')) {
    throw new CursorError('malformed', 'search continuation page token is invalid');
  }
  return t === undefined ? { s } : { t, s };
}

export interface CollectHitsInput {
  readonly state: MyDriveSearchState;
  /** Fetch one Google page; `undefined` means the first page. */
  readonly fetchPage: (googleToken: string | undefined) => Promise<CatalogPage>;
  /** Containment verdict for one hit. Throws on upstream failure (fail closed). */
  readonly inMount: (entry: CatalogEntry) => Promise<boolean>;
}

function nextAfterPage(hits: readonly CatalogEntry[], page: CatalogPage): CatalogPage {
  return page.nextPageToken === undefined
    ? { entries: hits }
    : {
        entries: hits,
        nextPageToken: encodeSearchState({ t: page.nextPageToken, s: 0 }),
      };
}

export async function collectMyDriveHits(input: CollectHitsInput): Promise<CatalogPage> {
  const hits: CatalogEntry[] = [];
  let token = input.state.t;
  let skip = input.state.s;
  for (let pageNo = 0; pageNo < MY_DRIVE_SEARCH_MAX_GOOGLE_PAGES; pageNo++) {
    const page = await input.fetchPage(token);
    const entries = page.entries;
    for (let base = skip; base < entries.length; base += CONTAINMENT_CHUNK) {
      const chunk = entries.slice(base, base + CONTAINMENT_CHUNK);
      const verdicts = await Promise.all(chunk.map((e) => input.inMount(e)));
      for (let j = 0; j < chunk.length; j++) {
        const hit = chunk[j];
        if (hit === undefined || verdicts[j] !== true) continue;
        hits.push(hit);
        if (hits.length >= MY_DRIVE_SEARCH_MAX_HITS) {
          const consumed = base + j + 1;
          if (consumed < entries.length) {
            return {
              entries: hits,
              nextPageToken: encodeSearchState({
                ...(token === undefined ? {} : { t: token }),
                s: consumed,
              }),
            };
          }
          return nextAfterPage(hits, page);
        }
      }
    }
    skip = 0;
    if (page.nextPageToken === undefined) return { entries: hits };
    token = page.nextPageToken;
  }
  // Page cap reached with more pages upstream: resume at the next one.
  return token === undefined
    ? { entries: hits }
    : { entries: hits, nextPageToken: encodeSearchState({ t: token, s: 0 }) };
}

export interface SearchMyDriveInput {
  readonly provider: OAuthCatalogWriteProvider;
  readonly writer: ResolvedWriter;
  readonly scope: MountScope;
  readonly query: string;
  /** The state string recovered from a sealed cursor, if any. */
  readonly pageToken?: string;
  readonly signal?: AbortSignal;
}

export function searchMyDriveMount(input: SearchMyDriveInput): Promise<CatalogPage> {
  const state = decodeSearchState(input.pageToken);
  const lookup = oauthParentLookup({
    provider: input.provider,
    writer: input.writer,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return collectMyDriveHits({
    state,
    fetchPage: (token) =>
      input.provider.search({
        writer: input.writer,
        scope: input.scope,
        query: input.query,
        searchScope: 'drive',
        pageSize: MY_DRIVE_SEARCH_PAGE_SIZE,
        ...(token === undefined ? {} : { pageToken: token }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    inMount: (entry) =>
      isInMount(
        input.scope,
        {
          id: entry.id,
          ...(entry.parents === undefined ? {} : { parents: entry.parents }),
        },
        lookup,
      ),
  });
}
