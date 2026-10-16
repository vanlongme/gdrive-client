/**
 * Timing and throughput metrics (architecture §13, plan T14; wave-5
 * worker D).
 *
 * Aggregation is IN-ISOLATE only: a fixed set of counters and duration
 * histograms lives in module scope, so recording is O(1), touches no
 * durable storage, and can never cause a per-request D1 write storm. The
 * trade-off is documented scope — counters cover only this isolate's
 * lifetime and are lost on eviction/restart; the diagnostics DTO marks
 * them `scope: 'isolate'` so operators never read them as fleet-wide or
 * durable.
 *
 * Boundedness and redaction are structural: series names are closed
 * literal types (request data can never create a new series), bucket
 * edges are fixed, and every emitted value is a count or a duration —
 * no ids beyond enum labels, no URLs, tokens or envelope material.
 */

// ---------------------------------------------------------------------------
// Duration histograms (fixed buckets keep aggregation bounded).
// ---------------------------------------------------------------------------

const LATENCY_BUCKETS_MS = [
  10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
] as const;

interface DurationSeries {
  count: number;
  totalMs: number;
  maxMs: number;
  /** LATENCY_BUCKETS_MS.length + 1 — the last slot is the >max overflow. */
  readonly buckets: number[];
}

function emptyDuration(): DurationSeries {
  return {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0),
  };
}

function recordDuration(series: DurationSeries, durationMs: number): void {
  const ms = Math.max(0, Math.round(durationMs));
  series.count += 1;
  series.totalMs += ms;
  if (ms > series.maxMs) series.maxMs = ms;
  let slot = series.buckets.length - 1;
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (ms <= LATENCY_BUCKETS_MS[i]!) {
      slot = i;
      break;
    }
  }
  series.buckets[slot]! += 1;
}

export interface DurationView {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly avgMs: number;
  readonly buckets: Record<string, number>;
}

function durationView(series: DurationSeries): DurationView {
  const buckets: Record<string, number> = {};
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    buckets[`<=${LATENCY_BUCKETS_MS[i]}`] = series.buckets[i]!;
  }
  buckets[`>${LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1]}`] =
    series.buckets[series.buckets.length - 1]!;
  return {
    count: series.count,
    totalMs: series.totalMs,
    maxMs: series.maxMs,
    avgMs: series.count === 0 ? 0 : Math.round(series.totalMs / series.count),
    buckets,
  };
}

// ---------------------------------------------------------------------------
// Registry — closed key sets only, never request-derived labels.
// ---------------------------------------------------------------------------

type DurationMetric =
  | 'content.firstByteMs'
  | 'catalog.listMs'
  | 'catalog.searchMs'
  | 'upload.chunkMs';

type CounterMetric =
  | 'content.requests'
  | 'content.readerBlocked'
  | 'upload.chunks'
  | 'upload.retries'
  | 'upload.blocked'
  | 'upload.reauthBlocked';

type BytesMetric = 'content.bytes' | 'upload.confirmedBytes';

interface Registry {
  startedMs: number;
  readonly durations: Record<DurationMetric, DurationSeries>;
  readonly counters: Record<CounterMetric, number>;
  readonly bytes: Record<BytesMetric, bigint>;
}

function freshRegistry(nowMs: number): Registry {
  return {
    startedMs: nowMs,
    durations: {
      'content.firstByteMs': emptyDuration(),
      'catalog.listMs': emptyDuration(),
      'catalog.searchMs': emptyDuration(),
      'upload.chunkMs': emptyDuration(),
    },
    counters: {
      'content.requests': 0,
      'content.readerBlocked': 0,
      'upload.chunks': 0,
      'upload.retries': 0,
      'upload.blocked': 0,
      'upload.reauthBlocked': 0,
    },
    bytes: {
      'content.bytes': 0n,
      'upload.confirmedBytes': 0n,
    },
  };
}

let registry = freshRegistry(Date.now());

/** Wipe every series (admin/testing utility — not a request seam). */
export function resetMetrics(): void {
  registry = freshRegistry(Date.now());
}

// ---------------------------------------------------------------------------
// Recording API used by route/transfer call sites.
// ---------------------------------------------------------------------------

/** A content response reached the streaming stage (upstream opened). */
export function recordContentRequest(): void {
  registry.counters['content.requests'] += 1;
}

/**
 * A reader-access verdict of 'blocked' — either the explicit readiness
 * probe or the post-upload finalize check.
 */
export function recordReaderBlocked(): void {
  registry.counters['content.readerBlocked'] += 1;
}

/** Catalog list/search provider-call latency (uncached calls only). */
export function recordCatalogQuery(
  kind: 'list' | 'search',
  durationMs: number,
): void {
  recordDuration(
    registry.durations[kind === 'list' ? 'catalog.listMs' : 'catalog.searchMs'],
    durationMs,
  );
}

export type UploadChunkOutcome = 'confirmed' | 'retry' | 'blocked' | 'reauth';

/**
 * One upstream chunk PUT settled. `confirmed` adds the newly confirmed byte
 * delta to the total; `retry` covers outcome-unknown/session-expired
 * verdicts that drive reconcile/renew; `blocked` covers credential/policy
 * blocks; `reauth` is a blocked outcome whose reason requires the user to
 * re-authenticate.
 */
export function recordUploadChunk(args: {
  durationMs: number;
  outcome: UploadChunkOutcome;
  confirmedBytes?: bigint;
}): void {
  recordDuration(registry.durations['upload.chunkMs'], args.durationMs);
  registry.counters['upload.chunks'] += 1;
  switch (args.outcome) {
    case 'confirmed':
      if (args.confirmedBytes !== undefined && args.confirmedBytes > 0n) {
        registry.bytes['upload.confirmedBytes'] += args.confirmedBytes;
      }
      break;
    case 'retry':
      registry.counters['upload.retries'] += 1;
      break;
    case 'blocked':
      registry.counters['upload.blocked'] += 1;
      break;
    case 'reauth':
      registry.counters['upload.blocked'] += 1;
      registry.counters['upload.reauthBlocked'] += 1;
      break;
  }
}

/**
 * A directive was blocked before any remote call because the pinned OAuth
 * connection needs re-authentication (no chunk went upstream).
 */
export function recordUploadReauth(): void {
  registry.counters['upload.reauthBlocked'] += 1;
}

// ---------------------------------------------------------------------------
// Content stream wrapping — first-byte latency and actual streamed bytes.
// ---------------------------------------------------------------------------

/**
 * Wrap a downstream body so the first delivered chunk records the
 * request-to-first-byte duration and every delivered chunk adds to the
 * served-bytes counter. Bytes are counted as pulled by the client, so a
 * cancelled download reports what actually left the isolate — never the
 * promised Content-Length.
 */
export function countedDownloadBody(
  body: ReadableStream<Uint8Array>,
  startedMs: number,
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let firstMarked = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (!firstMarked) {
          firstMarked = true;
          recordDuration(
            registry.durations['content.firstByteMs'],
            now() - startedMs,
          );
        }
        registry.bytes['content.bytes'] += BigInt(value.byteLength);
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

// ---------------------------------------------------------------------------
// Diagnostics view — ids/enums/counts/durations only.
// ---------------------------------------------------------------------------

export interface MetricsView {
  /** 'isolate': per-isolate, in-memory aggregate since worker start. */
  readonly scope: 'isolate';
  readonly since: string;
  readonly content: {
    readonly requests: number;
    readonly bytes: string;
    readonly firstByte: DurationView;
    readonly readerBlocked: number;
  };
  readonly catalog: {
    readonly list: DurationView;
    readonly search: DurationView;
  };
  readonly uploads: {
    readonly chunks: number;
    readonly chunk: DurationView;
    readonly confirmedBytes: string;
    readonly retries: number;
    readonly blocked: number;
    readonly reauthBlocked: number;
  };
}

export function metricsSnapshot(): MetricsView {
  const r = registry;
  return {
    scope: 'isolate',
    since: new Date(r.startedMs).toISOString(),
    content: {
      requests: r.counters['content.requests'],
      bytes: r.bytes['content.bytes'].toString(10),
      firstByte: durationView(r.durations['content.firstByteMs']),
      readerBlocked: r.counters['content.readerBlocked'],
    },
    catalog: {
      list: durationView(r.durations['catalog.listMs']),
      search: durationView(r.durations['catalog.searchMs']),
    },
    uploads: {
      chunks: r.counters['upload.chunks'],
      chunk: durationView(r.durations['upload.chunkMs']),
      confirmedBytes: r.bytes['upload.confirmedBytes'].toString(10),
      retries: r.counters['upload.retries'],
      blocked: r.counters['upload.blocked'],
      reauthBlocked: r.counters['upload.reauthBlocked'],
    },
  };
}
