/** Security-review tests (wave 8 H1/L7/M1/M3): pull-driven ZIP emission,
 * cancel propagation into the active upstream reader, listed-size mismatch
 * abort, ZIP32 offset guard, u16 entry guard, and entry-name sanitization.
 * Every test carries an explicit timeout and cancels its readers — a
 * never-resolving stream must fail the test, not hang the suite. */
import { describe, expect, it } from 'vitest';
import { createZipStream, sanitizeZipName } from '../../src/worker/public-links/zip';

const enc = new TextEncoder();
const TIMEOUT = 15_000;

function bytesOf(text: string): ReadableStream<Uint8Array> {
  const b = enc.encode(text);
  return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('backpressure (H1)', () => {
  it('pulls nothing from upstream while the consumer has not read', { timeout: TIMEOUT }, async () => {
    let opens = 0;
    // A ReadableStream fires pull() once at construction to fill its own
    // queue — the count past that initial call is what the ZIP consumed.
    let upstreamChunks = -1;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) {
        upstreamChunks++;
        if (upstreamChunks >= 3) { c.close(); return; }
        c.enqueue(enc.encode(`chunk${upstreamChunks}`));
      },
    });
    const stream = createZipStream([
      { name: 'a.bin', open: () => { opens++; return Promise.resolve(upstream); } },
      { name: 'b.bin', open: () => { opens++; return Promise.resolve(bytesOf('second')); } },
    ]);
    expect(opens).toBe(0);
    expect(upstreamChunks).toBe(0);
    const reader = stream.getReader();
    try {
      await tick(); // bounded: at most the first file's first chunk
      expect(opens).toBeLessThanOrEqual(1);
      expect(upstreamChunks).toBeLessThanOrEqual(1);
      const { value } = await reader.read();
      expect(value).not.toBeUndefined();
      expect(opens).toBeLessThanOrEqual(1); // at most the first file is open
      while (!(await reader.read()).done) { /* drain */ }
      expect(opens).toBe(2);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('cancel() propagates into the active upstream reader', { timeout: TIMEOUT }, async () => {
    const cancels: unknown[] = [];
    let upstreamReads = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(c) { upstreamReads++; c.enqueue(enc.encode('x'.repeat(64))); },
      cancel(r) { cancels.push(r); },
    });
    const stream = createZipStream([
      { name: 'big.bin', open: () => Promise.resolve(upstream) },
      { name: 'later.bin', open: () => Promise.resolve(bytesOf('never')) },
    ]);
    const reader = stream.getReader();
    for (let i = 0; i < 4; i++) await reader.read(); // header + a few body chunks
    await reader.cancel('client-gone');
    await tick();
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toBe('client-gone');
    const before = upstreamReads;
    await tick();
    expect(upstreamReads).toBe(before); // stopped pulling
  });
});

describe('integrity + bounds (L7/M1)', () => {
  it('aborts when streamed bytes exceed the listed size', { timeout: TIMEOUT }, async () => {
    const stream = createZipStream([
      { name: 'lied.bin', size: 5n, open: () => Promise.resolve(bytesOf('hello world')) },
    ]);
    const reader = stream.getReader();
    try {
      await expect(async () => {
        for (;;) { const { done } = await reader.read(); if (done) break; }
      }).rejects.toThrow();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
  it('aborts when streamed bytes come up short of the listed size', { timeout: TIMEOUT }, async () => {
    const stream = createZipStream([
      { name: 'short.bin', size: 10n, open: () => Promise.resolve(bytesOf('abc')) },
    ]);
    const reader = stream.getReader();
    try {
      await expect(async () => {
        for (;;) { const { done } = await reader.read(); if (done) break; }
      }).rejects.toThrow();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
  it('enforces the ZIP32 offset bound (injected for test)', { timeout: TIMEOUT }, async () => {
    const stream = createZipStream(
      [{ name: 'huge.bin', open: () => Promise.resolve(bytesOf('x'.repeat(128))) }],
      { maxTotalBytes: 64n },
    );
    const reader = stream.getReader();
    try {
      await expect(async () => {
        for (;;) { const { done } = await reader.read(); if (done) break; }
      }).rejects.toThrow();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
  it('rejects entry names that would overflow the u16 name field', { timeout: TIMEOUT }, async () => {
    const stream = createZipStream([
      { name: 'n'.repeat(0x10000), open: () => Promise.resolve(bytesOf('x')) },
    ]);
    const reader = stream.getReader();
    try {
      await expect(async () => {
        for (;;) { const { done } = await reader.read(); if (done) break; }
      }).rejects.toThrow();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
  it('still produces a well-formed archive for matching sizes', { timeout: TIMEOUT }, async () => {
    const stream = createZipStream([
      { name: 'ok.txt', size: 5n, open: () => Promise.resolve(bytesOf('hello')) },
    ]);
    try {
      const zip = await collect(stream);
      const view = new DataView(zip.buffer);
      expect(view.getUint32(0, true)).toBe(0x04034b50);
      expect(view.getUint32(zip.byteLength - 22, true)).toBe(0x06054b50);
    } finally {
      await stream.cancel().catch(() => undefined);
    }
  });
});

describe('sanitizeZipName (M3)', () => {
  it('neutralizes traversal, empty and colon segments', { timeout: TIMEOUT }, () => {
    expect(sanitizeZipName('..')).toBe('_');
    expect(sanitizeZipName('.')).toBe('_');
    expect(sanitizeZipName('')).toBe('_');
    expect(sanitizeZipName('a:b')).toBe('a_b');
    expect(sanitizeZipName(' C:/windows ')).toBe(' C__windows ');
    expect(sanitizeZipName('normal name.txt')).toBe('normal name.txt');
    expect(sanitizeZipName('...hidden')).toBe('...hidden'); // not '.', '..' or empty
    expect(sanitizeZipName('..evasive')).toBe('..evasive');
  });
});
