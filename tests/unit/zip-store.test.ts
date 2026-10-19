/** Streaming ZIP writer unit tests (wave 8 B2): parses local headers,
 * data descriptors, central directory and EOCD out of createZipStream. */
import { describe, expect, it } from 'vitest';
import { Crc32, createZipStream } from '../../src/worker/public-links/zip';

const enc = new TextEncoder();
const dec = new TextDecoder();
const TIMEOUT = 15_000;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  try {
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
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function bytesOf(text: string): ReadableStream<Uint8Array> {
  const b = enc.encode(text);
  return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
}

describe('Crc32', () => {
  it('matches the known IEEE vector', () => {
    const crc = new Crc32();
    crc.update(enc.encode('123456789'));
    expect(crc.digest()).toBe(0xcbf43926);
  });
});

describe('createZipStream', () => {
  it('emits a well-formed STORE archive with data descriptors', { timeout: TIMEOUT }, async () => {
    const stream = createZipStream([
      { name: 'dir/', modifiedTime: '2026-01-02T03:04:06Z' },
      { name: 'dir/hello.txt', modifiedTime: '2026-01-02T03:04:06Z', open: () => Promise.resolve(bytesOf('hello world')) },
      { name: 'empty.bin', open: () => Promise.resolve(bytesOf('')) },
    ]);
    const zip = await collect(stream);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // Local header 1: directory entry.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(4, true)).toBe(20); // version needed
    expect(view.getUint16(6, true)).toBe(0x0808); // descriptor + UTF-8
    expect(view.getUint16(8, true)).toBe(0); // STORE
    expect(view.getUint32(14, true)).toBe(0); // crc deferred to descriptor
    const nameLen = view.getUint16(26, true);
    expect(dec.decode(zip.subarray(30, 30 + nameLen))).toBe('dir/');
    let at = 30 + nameLen;
    // Empty dir: descriptor immediately.
    expect(view.getUint32(at, true)).toBe(0x08074b50);
    expect(view.getUint32(at + 4, true)).toBe(new Crc32().digest() === 0 ? 0 : 0);
    at += 16;

    // Local header 2: file.
    expect(view.getUint32(at, true)).toBe(0x04034b50);
    const name2 = view.getUint16(at + 26, true);
    expect(dec.decode(zip.subarray(at + 30, at + 30 + name2))).toBe('dir/hello.txt');
    at += 30 + name2;
    const body = dec.decode(zip.subarray(at, at + 11));
    expect(body).toBe('hello world');
    at += 11;
    expect(view.getUint32(at, true)).toBe(0x08074b50);
    const crc = new Crc32();
    crc.update(enc.encode('hello world'));
    expect(view.getUint32(at + 4, true)).toBe(crc.digest());
    expect(Number(view.getUint32(at + 8, true))).toBe(11);
    expect(Number(view.getUint32(at + 12, true))).toBe(11);
    at += 16;

    // Third entry (empty file) then central directory.
    expect(view.getUint32(at, true)).toBe(0x04034b50);
    const name3 = view.getUint16(at + 26, true);
    at += 30 + name3 + 16; // header + (no body) + descriptor

    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const cdStart = at;
    let entries = 0;
    while (view.getUint32(at, true) === 0x02014b50) {
      const cLen = view.getUint16(at + 28, true);
      const name = dec.decode(zip.subarray(at + 46, at + 46 + cLen));
      entries++;
      if (name === 'dir/hello.txt') {
        expect(view.getUint32(at + 16, true)).toBe(crc.digest());
        expect(Number(view.getUint32(at + 24, true))).toBe(11);
      }
      at += 46 + cLen;
    }
    expect(entries).toBe(3);
    expect(view.getUint32(at, true)).toBe(0x06054b50);
    expect(view.getUint16(at + 10, true)).toBe(3);
    expect(Number(view.getUint32(at + 12, true))).toBe(at - cdStart);
    expect(at + 22).toBe(zip.byteLength);
  });

  it('marks UTF-8 names correctly', { timeout: TIMEOUT }, async () => {
    const zip = await collect(createZipStream([
      { name: 'tài liệu.txt', open: () => Promise.resolve(bytesOf('x')) },
    ]));
    const view = new DataView(zip.buffer);
    expect(view.getUint16(6, true)).toBe(0x0808);
    const nameLen = view.getUint16(26, true);
    expect(dec.decode(zip.subarray(30, 30 + nameLen))).toBe('tài liệu.txt');
  });

  it('streams file bodies without buffering the whole archive', { timeout: TIMEOUT }, async () => {
    let opens = 0;
    const stream = createZipStream([
      { name: 'a', open: () => { opens++; return Promise.resolve(bytesOf('A')); } },
      { name: 'b', open: () => { opens++; return Promise.resolve(bytesOf('B')); } },
    ]);
    expect(opens).toBeLessThanOrEqual(1); // only the first body is open
    await collect(stream);
    expect(opens).toBe(2);
  });
});
