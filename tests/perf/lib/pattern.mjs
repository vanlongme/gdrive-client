/**
 * Deterministic generated payload shared by the perf benches (T15 budgets).
 * The byte pattern is a fixed 1 MiB block repeated — bounded memory, never
 * written to disk, identical between the bytes the Node client sends and the
 * checksums it advertises to the worker (PERF_SHA256/PERF_MD5 bindings) so the
 * upload verification stage runs for real.
 */

import crypto from "node:crypto";

export const PATTERN_BLOCK_BYTES = 1024 * 1024;

export function patternBlock() {
  const block = new Uint8Array(PATTERN_BLOCK_BYTES);
  for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + 7) & 0xff;
  return block;
}

/** The bytes sent for a generated chunk of `length` bytes. */
export function patternSlice(block, length) {
  // Chunks are always ≤ the 1 MiB block or a multiple of it; emit the block
  // pattern start-aligned for each MiB and a prefix for the remainder. The
  // fixture worker generates the same pattern, so upload checksums match.
  const out = new Uint8Array(length);
  let written = 0;
  while (written < length) {
    const n = Math.min(block.length, length - written);
    out.set(block.subarray(0, n), written);
    written += n;
  }
  return out;
}

/** sha256+md5 hex over the logical generated stream of `totalBytes`. */
export function hashPattern(block, totalBytes) {
  const sha256 = crypto.createHash("sha256");
  const md5 = crypto.createHash("md5");
  let remaining = totalBytes;
  while (remaining > 0) {
    const n = Math.min(block.length, remaining);
    const slice = block.subarray(0, n);
    sha256.update(slice);
    md5.update(slice);
    remaining -= n;
  }
  return { sha256: sha256.digest("hex"), md5: md5.digest("hex") };
}

/** Minimal CLI flag parsing shared by the benches. */
export function parseFlags(argv, spec) {
  const out = {};
  for (const [key, def] of Object.entries(spec)) out[key] = def;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!(name in spec)) throw new Error(`unknown flag --${name}`);
    if (typeof spec[name] === "boolean") {
      // Boolean flags are presence-only; `--flag=false` is also accepted.
      out[name] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    out[name] = value;
  }
  return out;
}
