/**
 * Single-Range request parser for content streaming (architecture §7.2).
 *
 * Parses an HTTP `Range` header against a known representation size and
 * resolves it to a discriminated union. All positions are bigint so file
 * offsets larger than Number.MAX_SAFE_INTEGER never lose precision; the
 * public API carries sizes as decimal strings per the global contracts.
 *
 * Scope: exactly one byte-range spec. Multi-range sets, non-bytes units
 * and malformed values are reported explicitly so the route layer can
 * choose 416-vs-ignore policy; nothing here fabricates a 206.
 */

/** Why a syntactically handled header is still not a usable single range. */
export type RangeInvalidReason =
  /** Does not match `unit = first-last` / `unit = -suffix` grammar. */
  | 'malformed'
  /** Range unit is not `bytes`. */
  | 'unsupported-unit'
  /** More than one range spec was supplied; multipart is unsupported. */
  | 'multiple-ranges'
  /** `last-byte-pos` is present and smaller than `first-byte-pos`. */
  | 'inverted';

export type RangeResult =
  /** No usable Range header: serve the full representation (200). */
  | { readonly type: 'absent' }
  /**
   * One satisfiable byte range, resolved against the representation:
   * `start` and `end` are inclusive byte positions (end clamped to
   * `size - 1`) and `length === end - start + 1`. Use for 206 + Content-Range.
   */
  | {
      readonly type: 'satisfiable';
      readonly start: bigint;
      readonly end: bigint;
      readonly length: bigint;
    }
  /**
   * Well-formed but cannot be satisfied against this size (start beyond
   * the end, zero-length resource, or a zero-length suffix request).
   * `size` is echoed for the `Content-Range: bytes *&#47;{size}` 416 header.
   */
  | { readonly type: 'unsatisfiable'; readonly size: bigint }
  /**
   * Recognizable as a Range attempt but not a supported single range.
   * `reason` distinguishes malformed syntax, foreign units, multi-range
   * sets and inverted specs.
   */
  | { readonly type: 'invalid'; readonly reason: RangeInvalidReason };

const ABSENT: RangeResult = { type: 'absent' };
const RANGE_SPEC = /^([0-9]*)-([0-9]*)$/;

/**
 * Resolve `header` (the raw `Range` header value, or null when absent)
 * against `size` bytes.
 *
 * Lenient where HTTP permits harmless whitespace — leading/trailing OWS on
 * the value, and OWS around `=` and list commas — strict inside the range
 * spec itself: `bytes=0 -10` is malformed. A null, empty or whitespace-only
 * header is 'absent' per the server's right to ignore unusable ranges.
 */
export function parseSingleRange(header: string | null, size: bigint): RangeResult {
  if (typeof size !== 'bigint') {
    throw new TypeError('size must be a bigint');
  }
  if (size < 0n) {
    throw new RangeError('size must be non-negative');
  }
  if (header === null) return ABSENT;
  const value = header.trim();
  if (value === '') return ABSENT;

  const eq = value.indexOf('=');
  if (eq < 0) return { type: 'invalid', reason: 'malformed' };

  const unit = value.slice(0, eq).trim().toLowerCase();
  if (unit === '') return { type: 'invalid', reason: 'malformed' };
  if (unit !== 'bytes') return { type: 'invalid', reason: 'unsupported-unit' };

  const set = value.slice(eq + 1).trim();
  if (set === '') return { type: 'invalid', reason: 'malformed' };

  // A comma means a range set; every element must be a spec for the header
  // to be a well-formed multi-range. We still refuse it either way.
  const parts = set.split(',');
  if (parts.length > 1) {
    const everyPartNonEmpty = parts.every((part) => part.trim() !== '');
    return { type: 'invalid', reason: everyPartNonEmpty ? 'multiple-ranges' : 'malformed' };
  }

  const match = RANGE_SPEC.exec(set);
  if (match === null) return { type: 'invalid', reason: 'malformed' };
  const firstRaw = match[1] ?? '';
  const lastRaw = match[2] ?? '';
  if (firstRaw === '' && lastRaw === '') return { type: 'invalid', reason: 'malformed' };

  if (size === 0n) return { type: 'unsatisfiable', size };

  if (firstRaw === '') {
    // Suffix range: last N bytes. -0 asks for zero bytes -> 416.
    const suffixLength = BigInt(lastRaw);
    if (suffixLength === 0n) return { type: 'unsatisfiable', size };
    const start = suffixLength >= size ? 0n : size - suffixLength;
    const end = size - 1n;
    return { type: 'satisfiable', start, end, length: end - start + 1n };
  }

  const first = BigInt(firstRaw);
  if (lastRaw !== '' && BigInt(lastRaw) < first) {
    return { type: 'invalid', reason: 'inverted' };
  }
  if (first >= size) return { type: 'unsatisfiable', size };
  const requestedEnd = lastRaw === '' ? size - 1n : BigInt(lastRaw);
  const end = requestedEnd >= size ? size - 1n : requestedEnd;
  return { type: 'satisfiable', start: first, end, length: end - first + 1n };
}
