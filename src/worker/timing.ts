/**
 * Per-request latency instrumentation (wave 9, worker P). A RequestTiming
 * recorder counts upstream calls and their total milliseconds in named
 * buckets; the app-level middleware renders it as a `Server-Timing` header,
 * only for admin actors and never on the anonymous public surface.
 *
 * Per-request hints and the token-source memo live here too: both are keyed
 * by the Request object (WeakMap), so nothing crosses request boundaries and
 * tests that bypass the middleware simply find no hints and fall back to
 * the old reads.
 */

import type { AuthSession } from './auth/session';
import { tokenIdentityKey } from './drive/types';
import type {
  CoordinatorTokenSource,
  GetTokenOptions,
  TokenIdentity,
  TokenResult,
} from './drive/types';
import type { ParentLookup } from './drive/containment';
import type {
  OAuthCatalogWriteProvider,
  ServiceAccountContentReadProvider,
} from './drive/types';

// ---------------------------------------------------------------------------
// Buckets. d1 = D1 query; admit = coordinator /admit; drive-meta = files.get;
// contain = OAuth ancestor lookups; drive-media = content/thumbnail/export
// opens; drive-list = listChildren/search.
// ---------------------------------------------------------------------------

export class RequestTiming {
  private readonly buckets = new Map<string, { count: number; ms: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Time one async operation into `bucket`. */
  async measure<T>(bucket: string, run: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await run();
    } finally {
      this.record(bucket, this.now() - started);
    }
  }

  record(bucket: string, ms: number, count = 1): void {
    const entry = this.buckets.get(bucket) ?? { count: 0, ms: 0 };
    entry.count += count;
    entry.ms += ms;
    this.buckets.set(bucket, entry);
  }

  /** `d1;dur=12.4;cnt=9, admit;dur=0.1;cnt=0` — never ids or secrets. */
  render(): string {
    const parts: string[] = [];
    for (const [name, entry] of this.buckets) {
      parts.push(
        `${name};dur=${entry.ms.toFixed(1)};cnt=${String(entry.count)}`,
      );
    }
    return parts.join(', ');
  }
}

const timings = new WeakMap<Request, RequestTiming>();

export function setRequestTiming(request: Request, timing: RequestTiming): void {
  timings.set(request, timing);
}

export function timingFor(request: Request): RequestTiming | undefined {
  return timings.get(request);
}

// ---------------------------------------------------------------------------
// Timed wrappers. Each records only real outbound work: memoized hits and
// cache hits never enter a bucket.
// ---------------------------------------------------------------------------

const rawEnvs = new WeakMap<object, object>();

/**
 * The request-scoped env clone whose D1 calls are timed. Downstream caches
 * keyed on the env object (the Better Auth WeakMap) must key on the RAW env
 * via rawEnvOf — a fresh clone per request would look like a new env (L3).
 */
export function timedEnv(env: Env, timing: RequestTiming): Env {
  const clone = { ...env, DB: timedD1(env.DB, timing) };
  rawEnvs.set(clone, env);
  return clone;
}

/** The env a timed clone was derived from, or the env itself. */
export function rawEnvOf<T extends object>(env: T): T {
  return (rawEnvs.get(env) as T | undefined) ?? env;
}

export function timedD1(db: D1Database, timing: RequestTiming): D1Database {
  // batch() validates that its statements are real D1 objects, so the
  // wrapper remembers each proxy's inner statement and unwraps on batch.
  const inners = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const stmt = (inner: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => stmt(inner.bind(...values)),
      first: <T = unknown>(colName?: string) =>
        timing.measure('d1', () => inner.first<T>(colName as string)),
      run: () => timing.measure('d1', () => inner.run()),
      all: <T = unknown>() => timing.measure('d1', () => inner.all<T>()),
      raw: <T = unknown[]>(options?: unknown) =>
        timing.measure('d1', () => inner.raw<T>(options as never)),
    } as D1PreparedStatement;
    inners.set(wrapped, inner);
    return wrapped;
  };
  return {
    prepare: (query: string) => stmt(db.prepare(query)),
    batch: (statements: D1PreparedStatement[]) =>
      timing.measure('d1', () =>
        db.batch(statements.map((s) => inners.get(s) ?? s)),
      ),
    exec: (query: string) => timing.measure('d1', () => db.exec(query)),
    dump: () => db.dump(),
    withSession: (() => db.withSession()) as D1Database['withSession'],
  };
}

export function timedTokenSource(
  source: CoordinatorTokenSource,
  timing: RequestTiming,
): CoordinatorTokenSource {
  return {
    getToken: (identity: TokenIdentity, options?: GetTokenOptions) =>
      timing.measure('admit', () => source.getToken(identity, options)),
    reportFailure: (identity, report) =>
      timing.measure('admit', () => source.reportFailure(identity, report)),
  };
}

export function timedSaProvider(
  provider: ServiceAccountContentReadProvider,
  timing: RequestTiming,
): ServiceAccountContentReadProvider {
  return {
    getReadMetadata: (input) =>
      timing.measure('drive-meta', () => provider.getReadMetadata(input)),
    getRevision: (input) =>
      timing.measure('drive-meta', () => provider.getRevision(input)),
    openContent: (input) =>
      timing.measure('drive-media', () => provider.openContent(input)),
    openThumbnail: (input) =>
      timing.measure('drive-media', () => provider.openThumbnail(input)),
    exportDocument: (input) =>
      timing.measure('drive-media', () => provider.exportDocument(input)),
  };
}

export function timedOauthProvider(
  provider: OAuthCatalogWriteProvider,
  timing: RequestTiming,
): OAuthCatalogWriteProvider {
  return {
    ...provider,
    getMetadata: (input) =>
      timing.measure('drive-meta', () => provider.getMetadata(input)),
    listChildren: (input) =>
      timing.measure('drive-list', () => provider.listChildren(input)),
    search: (input) =>
      timing.measure('drive-list', () => provider.search(input)),
  };
}

/** Containment ancestor hops get their own bucket. */
export function timedParentLookup(
  lookup: ParentLookup,
  timing: RequestTiming,
): ParentLookup {
  return (folderId) => timing.measure('contain', () => lookup(folderId));
}

// ---------------------------------------------------------------------------
// Per-request token-source memo (wave 9 step 1b). Within one request the SA
// metadata call and the media call for the same identity+file share a single
// admission; containment ancestor hops share one OAuth admission. Keys carry
// the file id so file-scoped cooldown checks still run per file. Only `ok`
// results and in-flight promises are shared; a reported failure invalidates
// the identity's entries so callDriveApi's single re-auth retry re-admits.
// Tokens never cross requests — the memo lives only in this WeakMap.
// ---------------------------------------------------------------------------

class TokenSourceMemo {
  private readonly entries = new Map<string, Promise<TokenResult>>();

  wrap(source: CoordinatorTokenSource): CoordinatorTokenSource {
    return {
      getToken: (identity, options) => {
        const key = `${tokenIdentityKey(identity)}|${options?.fileId ?? ''}`;
        const existing = this.entries.get(key);
        if (existing !== undefined) return existing;
        const promise = source.getToken(identity, options).then((result) => {
          // Failed admissions are never shared: callers may retry, and each
          // retry must reach the coordinator fresh.
          if (!result.ok) this.entries.delete(key);
          return result;
        });
        this.entries.set(key, promise);
        return promise;
      },
      reportFailure: async (identity, report) => {
        const prefix = `${tokenIdentityKey(identity)}|`;
        for (const key of this.entries.keys()) {
          if (key.startsWith(prefix)) this.entries.delete(key);
        }
        await source.reportFailure(identity, report);
      },
    };
  }
}

const tokenSourceMemos = new WeakMap<Request, TokenSourceMemo>();

/**
 * The per-request token-source memo. Wrap a CoordinatorTokenSource with
 * `memo.wrap(source)` — same-identity+file admissions share one DO /admit
 * for the life of the Request and never beyond it.
 */
export function requestTokenMemo(request: Request): {
  wrap(source: CoordinatorTokenSource): CoordinatorTokenSource;
} {
  let memo = tokenSourceMemos.get(request);
  if (memo === undefined) {
    memo = new TokenSourceMemo();
    tokenSourceMemos.set(request, memo);
  }
  return memo;
}

// ---------------------------------------------------------------------------
// Per-request resolution hints (wave 9 step 1a). The app middleware reads the
// app_settings row once and resolves the session once; every downstream
// consumer (resolveActor, requireUser, getAuthSession) reuses them through
// this WeakMap. A missing entry always means "read it yourself" — routes in
// unit-test harnesses (no middleware) behave exactly as before.
// ---------------------------------------------------------------------------

export interface RequestHints {
  readonly canonicalOrigin: string | null;
  /**
   * 'error' = session resolution itself failed; consumers must surface the
   * same AUTH_UNAVAILABLE they would produce on a getAuthSession throw.
   */
  readonly session: AuthSession | null | 'error';
}

const requestHints = new WeakMap<Request, RequestHints>();

export function setRequestHints(request: Request, hints: RequestHints): void {
  requestHints.set(request, hints);
}

export function getRequestHints(request: Request): RequestHints | undefined {
  return requestHints.get(request);
}

// ---------------------------------------------------------------------------
// waitUntil with a test-safe fallback: Hono's c.executionCtx throws when the
// fetch ran without a third argument (unit-test harnesses), so the work
// still runs fire-and-forget there.
// ---------------------------------------------------------------------------

export function defer(
  c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } | undefined },
  work: Promise<unknown>,
): void {
  // Attach-only catch: the deferred write is fire-and-forget, so its
  // rejection must never surface as an unhandled rejection — whether or not
  // an execution context exists to waitUntil it (review L5).
  work.catch(() => undefined);
  try {
    c.executionCtx?.waitUntil(work);
  } catch {
    // No execution context (test harness): the work is still handled above.
  }
}
