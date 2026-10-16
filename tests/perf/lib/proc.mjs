/**
 * Process-tree RSS sampling for the perf harness (T15 budgets).
 *
 * Method: every `intervalMs` we scan /proc, find every `workerd` process that
 * is a descendant of this Node harness (Miniflare spawns workerd as a child),
 * and sum VmRSS. That sum is the "worker process RSS" in the report — it is
 * the only honest memory signal available outside workerd, and it captures
 * the runtime + all isolates of this bench's Miniflare instance.
 *
 * The workerd heap itself is not observable from outside the runtime; the
 * report therefore records workerd RSS (baseline/peak/delta) and, separately,
 * the Node harness's own process.memoryUsage() for completeness.
 */

import fs from "node:fs";

function listPids() {
  return fs
    .readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
}

function readPpid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces/parens — fields after the final ')'.
    const close = stat.lastIndexOf(")");
    const rest = stat.slice(close + 2).split(" ");
    return Number(rest[1]); // ppid is the 4th field: state ppid ...
  } catch {
    return -1;
  }
}

function readComm(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

function readVmRssKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s*kB/m);
    return m === null ? 0 : Number(m[1]);
  } catch {
    return 0;
  }
}

/** All workerd PIDs descended from `rootPid` (default: this process). */
export function workerdPids(rootPid = process.pid) {
  const childrenOf = new Map();
  for (const pid of listPids()) {
    const ppid = readPpid(pid);
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  const pids = [];
  const queue = [...(childrenOf.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (readComm(pid) === "workerd") pids.push(pid);
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return pids;
}

/** Summed VmRSS in kB across descendant workerd processes. */
export function workerdRssKb(rootPid = process.pid) {
  return workerdPids(rootPid).reduce((sum, pid) => sum + readVmRssKb(pid), 0);
}

/**
 * Start a background sampler. `stop()` returns { samples, peakKb } where
 * samples is every observed summed workerd RSS (kB). Callers diff against a
 * baseline taken after warmup, so the delta is streaming-attributable.
 */
export function startWorkerdSampler(intervalMs = 50, rootPid = process.pid) {
  const samples = [];
  const timer = setInterval(() => {
    samples.push(workerdRssKb(rootPid));
  }, intervalMs);
  timer.unref?.();
  return {
    sampleNow() {
      const kb = workerdRssKb(rootPid);
      samples.push(kb);
      return kb;
    },
    stop() {
      clearInterval(timer);
      return {
        samples,
        peakKb: samples.length === 0 ? 0 : Math.max(...samples),
      };
    },
  };
}
