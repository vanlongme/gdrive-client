/**
 * Streaming ZIP writer (wave 8 Phase B2): STORE method, bit-3 data
 * descriptors, UTF-8 name flag, CRC32 accumulated while each file body is
 * relayed — a file is opened lazily when its turn comes and its bytes are
 * never buffered.
 *
 * CRC32 is a table-driven pure-TS implementation. The plan suggested
 * hash-wasm's crc32, but hash-wasm instantiates WASM via
 * WebAssembly.compile(), which workerd refuses ("Wasm code generation
 * disallowed by embedder") in tests AND production — a no-dependency
 * table implementation is the only working option (verified by spike).
 */

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3 polynomial, reflected)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  private value = 0xffffffff;
  update(bytes: Uint8Array): void {
    let c = this.value;
    for (let i = 0; i < bytes.byteLength; i++) {
      c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    this.value = c;
  }
  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

// ---------------------------------------------------------------------------
// Entries + wire emission
// ---------------------------------------------------------------------------

export interface ZipEntrySpec {
  /** '/'-separated path inside the archive; directories end with '/'. */
  readonly name: string;
  /** Expected byte size (from the listing). When present the stream aborts
   * if the relayed body exceeds or falls short of it — a changed file can
   * never silently produce a forged entry. */
  readonly size?: bigint;
  /** DOS-millisecond source (modifiedTime ISO) for the entry timestamp. */
  readonly modifiedTime?: string;
  /** Lazily opened file body; absent for directory entries. */
  readonly open?: () => Promise<ReadableStream<Uint8Array>>;
}

export interface ZipStreamOptions {
  /** Hard cap on total emitted bytes; defaults to the ZIP32 limit. */
  readonly maxTotalBytes?: bigint;
}

/** Highest offset a ZIP32 archive may reach (4 GiB, no ZIP64). */
export const ZIP32_MAX_TOTAL_BYTES = 0xfffffff0n; // leave headroom for EOCD records

/** Neutralize one path segment for the archive: ".", "..", "" and ':' all
 * become safe values so a Drive name can never traverse or confuse an
 * extractor. Applied per segment by callers building '/'-joined paths. */
export function sanitizeZipName(name: string): string {
  const safe = name.replace(/[/\\:\x00-\x1f]/g, '_');
  return safe === '' || safe === '.' || safe === '..' ? '_' : safe;
}

interface CentralRecord {
  readonly nameBytes: Uint8Array;
  readonly crc: number;
  readonly size: bigint;
  readonly localOffset: bigint;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly isDir: boolean;
}

const encoder = new TextEncoder();
const LOCAL_SIG = 0x04034b50;
const DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const FLAG_DESCRIPTOR_UTF8 = 0x0808; // bit 3 data descriptor + bit 11 UTF-8
const METHOD_STORE = 0;

function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function dosDateTime(iso: string | undefined): { time: number; date: number } {
  const ms = iso === undefined ? NaN : Date.parse(iso);
  const d = Number.isFinite(ms) ? new Date(ms as number) : new Date(1980, 0, 1);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function localHeader(nameBytes: Uint8Array, dos: { time: number; date: number }): Uint8Array {
  return concat([
    u32(LOCAL_SIG),
    u16(20), // version needed
    u16(FLAG_DESCRIPTOR_UTF8),
    u16(METHOD_STORE),
    u16(dos.time),
    u16(dos.date),
    u32(0), // crc in descriptor
    u32(0), // compressed size in descriptor
    u32(0), // uncompressed size in descriptor
    u16(nameBytes.byteLength),
    u16(0), // extra len
    nameBytes,
  ]);
}

function dataDescriptor(crc: number, size: bigint): Uint8Array {
  return concat([
    u32(DESCRIPTOR_SIG),
    u32(crc),
    u32(Number(size & 0xffffffffn)),
    u32(Number(size & 0xffffffffn)),
  ]);
}

function centralRecord(r: CentralRecord): Uint8Array {
  return concat([
    u32(CENTRAL_SIG),
    u16(20), // version made by
    u16(20), // version needed
    u16(FLAG_DESCRIPTOR_UTF8),
    u16(METHOD_STORE),
    u16(r.dosTime),
    u16(r.dosDate),
    u32(r.crc),
    u32(Number(r.size & 0xffffffffn)),
    u32(Number(r.size & 0xffffffffn)),
    u16(r.nameBytes.byteLength),
    u16(0), u16(0), u16(0), // extra/comment/disk
    u16(0), // internal attrs
    u32(r.isDir ? 0x10 : 0), // external attrs (MS-DOS dir bit)
    u32(Number(r.localOffset & 0xffffffffn)),
    r.nameBytes,
  ]);
}

function endOfCentralDirectory(count: number, cdSize: bigint, cdOffset: bigint): Uint8Array {
  return concat([
    u32(EOCD_SIG),
    u16(0), u16(0),
    u16(count), u16(count),
    u32(Number(cdSize & 0xffffffffn)),
    u32(Number(cdOffset & 0xffffffffn)),
    u16(0),
  ]);
}

interface ZipState {
  cancelled: boolean;
  activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
}

function* headerChunks(
  entry: ZipEntrySpec,
  state: { offset: bigint },
  maxTotal: bigint,
): Generator<Uint8Array, { nameBytes: Uint8Array; dos: { time: number; date: number }; localOffset: bigint }> {
  const nameBytes = encoder.encode(entry.name);
  if (nameBytes.byteLength > 0xffff) throw new Error('zip: entry name exceeds 64 KiB');
  const dos = dosDateTime(entry.modifiedTime);
  const localOffset = state.offset;
  const header = localHeader(nameBytes, dos);
  if (state.offset + BigInt(header.byteLength) > maxTotal) throw new Error('zip: archive exceeds the ZIP32 size limit');
  state.offset += BigInt(header.byteLength);
  yield header;
  return { nameBytes, dos, localOffset };
}

async function* zipChunks(
  entries: readonly ZipEntrySpec[],
  state: ZipState,
  maxTotal: bigint,
): AsyncGenerator<Uint8Array> {
  const central: CentralRecord[] = [];
  const offset = { offset: 0n };
  for (const entry of entries) {
    const gen = headerChunks(entry, offset, maxTotal);
    let step = gen.next();
    while (!step.done) {
      yield step.value;
      step = gen.next();
    }
    const { nameBytes, dos, localOffset } = step.value;
    const crc = new Crc32();
    let size = 0n;
    if (entry.open !== undefined) {
      const body = await entry.open();
      const reader = body.getReader();
      state.activeReader = reader;
      try {
        for (;;) {
          if (state.cancelled) return;
          const { done, value } = await reader.read();
          if (done) break;
          crc.update(value);
          size += BigInt(value.byteLength);
          if (entry.size !== undefined && size > entry.size) {
            throw new Error('zip: file grew beyond its listed size');
          }
          if (offset.offset + BigInt(value.byteLength) > maxTotal) {
            throw new Error('zip: archive exceeds the ZIP32 size limit');
          }
          offset.offset += BigInt(value.byteLength);
          yield value;
        }
        if (entry.size !== undefined && size !== entry.size) {
          throw new Error('zip: file shorter than its listed size');
        }
      } finally {
        state.activeReader = undefined;
        if (state.cancelled) await reader.cancel().catch(() => undefined);
      }
    }
    const descriptor = dataDescriptor(crc.digest(), size);
    offset.offset += BigInt(descriptor.byteLength);
    yield descriptor;
    central.push({
      nameBytes, crc: crc.digest(), size, localOffset,
      dosTime: dos.time, dosDate: dos.date, isDir: entry.open === undefined,
    });
    if (central.length > 0xffff) throw new Error('zip: entry count exceeds the ZIP32 limit');
  }
  const cdOffset = offset.offset;
  for (const record of central) {
    const bytes = centralRecord(record);
    offset.offset += BigInt(bytes.byteLength);
    yield bytes;
  }
  const eocd = endOfCentralDirectory(central.length, offset.offset - cdOffset, cdOffset);
  offset.offset += BigInt(eocd.byteLength);
  yield eocd;
}

/**
 * Pull-driven ZIP stream: upstream bytes are fetched ONLY when the consumer
 * pulls, so a slow reader can never make the isolate buffer the archive.
 * cancel() cancels the active upstream reader and stops further listing.
 * Upstream failures error the stream — the client sees a truncated archive,
 * never a forged one.
 */
export function createZipStream(
  entries: readonly ZipEntrySpec[],
  options: ZipStreamOptions = {},
): ReadableStream<Uint8Array> {
  const state: ZipState = { cancelled: false, activeReader: undefined };
  const gen = zipChunks(entries, state, options.maxTotalBytes ?? ZIP32_MAX_TOTAL_BYTES);
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) { controller.close(); return; }
      try {
        const next = await gen.next();
        if (next.done === true) {
          done = true;
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        done = true;
        controller.error(err);
      }
    },
    async cancel(reason) {
      state.cancelled = true;
      try {
        await state.activeReader?.cancel(reason);
      } catch {
        // Reader teardown raced; the stream is being torn down anyway.
      }
      await gen.return(undefined).catch(() => undefined);
    },
  });
}
