import { describe, expect, it } from "vitest";
import {
  saFileResult,
  saRotatedResult,
} from "../../src/web/features/admin/service-accounts-import";

/**
 * Wave-10 review round 2: a File handle is retained ONLY for conflict rows —
 * it exists so the explicit "Rotate key" action can re-read the file. Every
 * other outcome, and every settled rotate attempt, releases it so key
 * material never lingers in component state.
 */
describe("saFileResult", () => {
  it("keeps the File handle only on conflict rows", () => {
    const file = new File(["{}"], "sa.json");
    for (const outcome of [
      "imported",
      "rotated",
      "duplicate",
      "error",
      "too_large",
    ] as const) {
      const result = saFileResult("sa.json", outcome, file);
      expect(result.outcome).toBe(outcome);
      expect(result.file, `outcome ${outcome} retains no handle`).toBeUndefined();
    }
    const conflict = saFileResult("sa.json", "conflict", file);
    expect(conflict.file).toBe(file);
  });
});

describe("saRotatedResult", () => {
  it("drops the handle after a rotate attempt, success or failure", () => {
    const file = new File(["{}"], "sa.json");
    const conflict = saFileResult("sa.json", "conflict", file);
    for (const outcome of ["rotated", "error", "conflict"] as const) {
      const next = saRotatedResult(conflict, outcome);
      expect(next.outcome).toBe(outcome);
      expect(next.name).toBe("sa.json");
      expect(next.file).toBeUndefined();
    }
  });
});
