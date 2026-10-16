import { describe, expect, it } from "vitest";
import {
  HASH_SLICE_BYTES,
  hashBlob,
  HashAbortedError,
  type IncrementalDigest,
} from "../../src/web/features/transfers/hash-core";

/**
 * hash-core slice-loop tests (T09). workerd cannot compile wasm, so the real
 * hash-wasm factories are exercised through the browser E2E instead; here a
 * recording digest proves exact 1 MiB slicing, progress reporting and abort.
 */

class RecordingDigest implements IncrementalDigest {
  readonly updates: Uint8Array[] = [];
  init(): void {
    this.updates.length = 0;
  }
  update(data: Uint8Array): void {
    this.updates.push(new Uint8Array(data));
  }
  digest(_encoding: "hex"): string {
    let acc = 0n;
    for (const u of this.updates) {
      for (const byte of u) acc = (acc + BigInt(byte)) % (1n << 64n);
    }
    void _encoding;
    return acc.toString(16).padStart(16, "0");
  }
}

function makeDigests() {
  const sha = new RecordingDigest();
  const md5 = new RecordingDigest();
  return {
    sha,
    md5,
    factories: {
      sha256: () => Promise.resolve(sha),
      md5: () => Promise.resolve(md5),
    },
  };
}

describe("hashBlob slicing", () => {
  it("updates digests with exact 1 MiB slices and reports progress", async () => {
    const size = 2 * HASH_SLICE_BYTES + 7;
    const source = new Uint8Array(size);
    for (let i = 0; i < size; i++) source[i] = i % 251;
    const { sha, md5, factories } = makeDigests();
    const progress: Array<{ done: string; total: string }> = [];
    const result = await hashBlob(new Blob([source]), {
      digests: factories,
      onProgress: (done, total) => progress.push({ done, total }),
    });
    // One buffered slice at a time; final partial slice is exact.
    expect(sha.updates.map((u) => u.length)).toEqual([
      HASH_SLICE_BYTES,
      HASH_SLICE_BYTES,
      7,
    ]);
    expect(sha.updates[2]?.[0]).toBe((2 * HASH_SLICE_BYTES) % 251);
    expect(md5.updates).toHaveLength(3);
    // Both digests saw the identical byte stream.
    expect(sha.updates.map((u) => [...u])).toEqual(
      md5.updates.map((u) => [...u]),
    );
    expect(progress).toHaveLength(3);
    expect(progress[2]?.done).toBe(String(size));
    expect(progress[2]?.total).toBe(String(size));
    expect(result.sha256).toMatch(/^[0-9a-f]+$/);
    expect(result.md5).toMatch(/^[0-9a-f]+$/);
  });

  it("aborts between slices without consuming the rest", async () => {
    const size = 3 * HASH_SLICE_BYTES;
    const { sha, factories } = makeDigests();
    let calls = 0;
    await expect(
      hashBlob(new Blob([new Uint8Array(size)]), {
        digests: factories,
        shouldAbort: () => {
          calls += 1;
          return calls > 1; // abort from the second slice onward
        },
      }),
    ).rejects.toBeInstanceOf(HashAbortedError);
    expect(sha.updates).toHaveLength(1);
  });

  it("handles an empty blob without reading slices", async () => {
    const { sha, factories } = makeDigests();
    const result = await hashBlob(new Blob([]), { digests: factories });
    expect(sha.updates).toHaveLength(0);
    expect(result.sha256).toMatch(/^[0-9a-f]+$/);
  });
});
