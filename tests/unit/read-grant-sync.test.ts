import { describe, expect, it } from "vitest";

import {
  MAX_SYNC_ROUNDS,
  runSyncLoop,
  waitSeconds,
  type SyncProgress,
} from "../../src/web/lib/read-grant-sync";

interface Step extends SyncProgress {
  ready: number;
}

function scripted(steps: Step[]) {
  let index = 0;
  return {
    call: async (): Promise<Step> => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step === undefined) throw new Error("no scripted step");
      return step;
    },
    calls: () => index,
  };
}

const idle = new AbortController().signal;
const noWait = async () => undefined;

describe("runSyncLoop", () => {
  it("repeats until remaining is 0 (90 service accounts in five calls)", async () => {
    const script = scripted([
      { remaining: 70, ready: 20 },
      { remaining: 50, ready: 40 },
      { remaining: 30, ready: 60 },
      { remaining: 10, ready: 80 },
      { remaining: 0, ready: 90 },
    ]);
    const seen: number[] = [];
    const outcome = await runSyncLoop({
      call: script.call,
      wait: noWait,
      onStep: (s) => seen.push(s.ready),
      signal: idle,
    });
    expect(outcome).toBe("done");
    expect(seen).toEqual([20, 40, 60, 80, 90]);
  });

  it("honours retryAfterSeconds and does not call a rate-limited run stalled", async () => {
    const script = scripted([
      { remaining: 40, ready: 50, retryAfterSeconds: 30 },
      { remaining: 40, ready: 50, retryAfterSeconds: 30 },
      { remaining: 0, ready: 90 },
    ]);
    const waits: number[] = [];
    const outcome = await runSyncLoop({
      call: script.call,
      wait: async (seconds) => {
        waits.push(seconds);
      },
      onStep: () => undefined,
      signal: idle,
    });
    expect(outcome).toBe("done");
    expect(waits).toEqual([30, 30]);
  });

  it("stops as stalled when remaining does not drop and no retry hint is given", async () => {
    const script = scripted([{ remaining: 3, ready: 87 }]);
    const outcome = await runSyncLoop({
      call: script.call,
      wait: noWait,
      onStep: () => undefined,
      signal: idle,
    });
    expect(outcome).toBe("stalled");
    expect(script.calls()).toBe(2);
  });

  it("stops at maxRounds", async () => {
    const script = scripted([
      { remaining: 5, ready: 0, retryAfterSeconds: 1 },
    ]);
    const outcome = await runSyncLoop({
      call: script.call,
      wait: noWait,
      onStep: () => undefined,
      signal: idle,
      maxRounds: 3,
    });
    expect(outcome).toBe("stalled");
    expect(script.calls()).toBe(3);
    expect(MAX_SYNC_ROUNDS).toBe(40);
  });

  it("aborts during a wait and never calls again", async () => {
    const controller = new AbortController();
    const script = scripted([
      { remaining: 10, ready: 0, retryAfterSeconds: 30 },
      { remaining: 0, ready: 10 },
    ]);
    const outcome = await runSyncLoop({
      call: script.call,
      wait: async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      },
      onStep: () => undefined,
      signal: controller.signal,
    });
    expect(outcome).toBe("aborted");
    expect(script.calls()).toBe(1);
  });

  it("drops a response that arrives after abort", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const outcome = await runSyncLoop({
      call: async () => {
        controller.abort();
        return { remaining: 0, ready: 1 };
      },
      wait: noWait,
      onStep: (s: Step) => seen.push(s.ready),
      signal: controller.signal,
    });
    expect(outcome).toBe("aborted");
    expect(seen).toEqual([]);
  });
});

describe("waitSeconds", () => {
  it("ticks down once per second and resolves", async () => {
    const ticks: number[] = [];
    await waitSeconds(1, (n) => ticks.push(n), idle);
    expect(ticks).toEqual([1, 0]);
  });

  it("rejects with AbortError when aborted, also when already aborted", async () => {
    const controller = new AbortController();
    const pending = waitSeconds(30, () => undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      waitSeconds(30, () => undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
