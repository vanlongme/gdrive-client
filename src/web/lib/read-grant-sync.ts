/**
 * Resumable-sync driver for My Drive pool read access. Pure so it is unit-
 * tested without React. The server does at most 20 Drive mutations per call
 * and reports `remaining`; this loop calls again until 0, waits out
 * `retryAfterSeconds`, and stops on abort.
 */
export const MAX_SYNC_ROUNDS = 40;

export interface SyncProgress {
  readonly remaining: number;
  readonly retryAfterSeconds?: number | undefined;
}

export type SyncLoopOutcome = "done" | "stalled" | "aborted";

export async function runSyncLoop<T extends SyncProgress>(opts: {
  call: (signal: AbortSignal) => Promise<T>;
  wait: (seconds: number, signal: AbortSignal) => Promise<void>;
  onStep: (result: T) => void;
  signal: AbortSignal;
  maxRounds?: number;
}): Promise<SyncLoopOutcome> {
  const maxRounds = opts.maxRounds ?? MAX_SYNC_ROUNDS;
  let previousRemaining = Number.POSITIVE_INFINITY;
  for (let round = 0; round < maxRounds; round += 1) {
    if (opts.signal.aborted) return "aborted";
    const result = await opts.call(opts.signal);
    if (opts.signal.aborted) return "aborted";
    opts.onStep(result);
    if (result.remaining === 0) return "done";
    const wait = result.retryAfterSeconds ?? 0;
    if (wait <= 0 && result.remaining >= previousRemaining)
      return "stalled";
    previousRemaining = result.remaining;
    if (wait > 0) {
      try {
        await opts.wait(wait, opts.signal);
      } catch (error) {
        if (opts.signal.aborted) return "aborted";
        throw error;
      }
    }
  }
  return "stalled";
}

/**
 * Counts down once per second, reporting the seconds left (the full value
 * first, 0 last). Rejects with an AbortError when the signal aborts and
 * always clears its timer.
 */
export function waitSeconds(
  seconds: number,
  onTick: (remaining: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let remaining = seconds;
    const timer = setInterval(() => {
      remaining -= 1;
      onTick(Math.max(remaining, 0));
      if (remaining <= 0) {
        cleanup();
        resolve();
      }
    }, 1000);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    onTick(remaining);
  });
}
