import type { DecimalBytes } from "../../../shared/contracts/common";

/**
 * Incremental file hashing (spec section 6.1, plan T09): SHA-256 and MD5 over
 * bounded slices, default 1 MiB. One slice is buffered at a time — the loop
 * awaits each `arrayBuffer()` before reading the next, which is the strictest
 * possible backpressure: at most ~1 MiB of file data is in memory, never a
 * whole-file digest via crypto.subtle.
 *
 * The digest factories are injectable because this module also runs inside
 * the workerd vitest pool, where `WebAssembly.compile` is unavailable: unit
 * tests inject a deterministic digest, while the bundled hash worker uses
 * hash-wasm (createSHA256/createMD5, pin 4.12.0).
 */

export const HASH_SLICE_BYTES = 1024 * 1024;

export interface IncrementalDigest {
  init(): void;
  update(data: Uint8Array): void;
  digest(encoding: "hex"): string;
}

export interface DigestFactories {
  sha256(): Promise<IncrementalDigest>;
  md5(): Promise<IncrementalDigest>;
}

export interface FileHashResult {
  sha256: string;
  md5: string;
}

export class HashAbortedError extends Error {
  constructor() {
    super("Hashing was cancelled.");
    this.name = "AbortError";
  }
}

async function wasmFactories(): Promise<DigestFactories> {
  const { createMD5, createSHA256 } = await import("hash-wasm");
  return {
    sha256: () => createSHA256() as Promise<IncrementalDigest>,
    md5: () => createMD5() as Promise<IncrementalDigest>,
  };
}

export async function hashBlob(
  source: Blob,
  opts: {
    sliceBytes?: number;
    digests?: DigestFactories;
    onProgress?: (done: DecimalBytes, total: DecimalBytes) => void;
    shouldAbort?: () => boolean;
  } = {},
): Promise<FileHashResult> {
  const sliceBytes = opts.sliceBytes ?? HASH_SLICE_BYTES;
  const factories = opts.digests ?? (await wasmFactories());
  const [sha256, md5] = await Promise.all([
    factories.sha256(),
    factories.md5(),
  ]);
  sha256.init();
  md5.init();

  const total = BigInt(source.size);
  let offset = 0;
  while (offset < source.size) {
    if (opts.shouldAbort?.() === true) throw new HashAbortedError();
    const end = Math.min(offset + sliceBytes, source.size);
    const buffer = await source.slice(offset, end).arrayBuffer();
    const data = new Uint8Array(buffer);
    sha256.update(data);
    md5.update(data);
    offset = end;
    opts.onProgress?.(
      BigInt(offset).toString(10) as DecimalBytes,
      total.toString(10) as DecimalBytes,
    );
  }
  return { sha256: sha256.digest("hex"), md5: md5.digest("hex") };
}
