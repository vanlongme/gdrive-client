import type { ServiceAccountImportOutcome } from "../../../shared/contracts/admin";

/**
 * Multi-file import result rows (wave-10 review round 2): the source File
 * handle is retained ONLY on conflict rows — it exists so the explicit
 * "Rotate key" action can re-read the file on demand. Every other outcome
 * drops the handle immediately, and a settled rotate attempt drops it too
 * (success or failure), so key material never lingers in component state.
 */

export interface SaFileResult {
  name: string;
  outcome: ServiceAccountImportOutcome | "error" | "too_large";
  /** Present only while a rotate could still need to re-read the file. */
  file?: File;
}

/** Build a result row; keeps the handle only when a rotate may need it. */
export function saFileResult(
  name: string,
  outcome: SaFileResult["outcome"],
  file: File,
): SaFileResult {
  return outcome === "conflict" ? { name, outcome, file } : { name, outcome };
}

/** A rotate attempt always releases the retained handle, whatever it answered. */
export function saRotatedResult(
  result: SaFileResult,
  outcome: SaFileResult["outcome"],
): SaFileResult {
  return { name: result.name, outcome };
}
