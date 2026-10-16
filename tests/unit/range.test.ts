import { describe, expect, it } from 'vitest';

import { parseSingleRange, type RangeResult } from '../../src/worker/transfers/range';

const SIZE = 1000n;

function satisfiable(start: bigint, end: bigint): RangeResult {
  return { type: 'satisfiable', start, end, length: end - start + 1n };
}

describe('absent headers', () => {
  it('treats null, empty and whitespace-only headers as absent', () => {
    for (const header of [null, '', '   ', '\t \n']) {
      expect(parseSingleRange(header, SIZE)).toEqual({ type: 'absent' });
    }
  });
});

describe('satisfiable single ranges', () => {
  it('resolves closed ranges with inclusive end', () => {
    expect(parseSingleRange('bytes=0-499', SIZE)).toEqual(satisfiable(0n, 499n));
    expect(parseSingleRange('bytes=500-999', SIZE)).toEqual(satisfiable(500n, 999n));
    expect(parseSingleRange('bytes=999-999', SIZE)).toEqual(satisfiable(999n, 999n));
    expect(parseSingleRange('bytes=0-0', 1n)).toEqual(satisfiable(0n, 0n));
  });

  it('keeps exact end semantics without off-by-one', () => {
    expect(parseSingleRange('bytes=0-999', SIZE)).toEqual(satisfiable(0n, 999n));
    expect(parseSingleRange('bytes=0-1000', SIZE)).toEqual(satisfiable(0n, 999n));
  });

  it('clamps a last-byte-pos beyond the representation', () => {
    expect(parseSingleRange('bytes=900-2000', SIZE)).toEqual(satisfiable(900n, 999n));
    expect(parseSingleRange('bytes=0-18446744073709551616', SIZE)).toEqual(satisfiable(0n, 999n));
  });

  it('resolves open-ended ranges through the final byte', () => {
    expect(parseSingleRange('bytes=0-', SIZE)).toEqual(satisfiable(0n, 999n));
    expect(parseSingleRange('bytes=999-', SIZE)).toEqual(satisfiable(999n, 999n));
    expect(parseSingleRange('bytes=1-', 1n)).toEqual({ type: 'unsatisfiable', size: 1n });
  });

  it('resolves suffix ranges from the end of the representation', () => {
    expect(parseSingleRange('bytes=-1', SIZE)).toEqual(satisfiable(999n, 999n));
    expect(parseSingleRange('bytes=-500', SIZE)).toEqual(satisfiable(500n, 999n));
    // Suffix larger than the representation serves the whole body.
    expect(parseSingleRange('bytes=-1000', SIZE)).toEqual(satisfiable(0n, 999n));
    expect(parseSingleRange('bytes=-1001', SIZE)).toEqual(satisfiable(0n, 999n));
  });

  it('accepts a case-insensitive bytes unit and benign whitespace', () => {
    expect(parseSingleRange('BYTES=0-9', SIZE)).toEqual(satisfiable(0n, 9n));
    expect(parseSingleRange('  bytes=0-10  ', SIZE)).toEqual(satisfiable(0n, 10n));
    expect(parseSingleRange('bytes =0-10', SIZE)).toEqual(satisfiable(0n, 10n));
    expect(parseSingleRange('bytes= 0-10', SIZE)).toEqual(satisfiable(0n, 10n));
  });

  it('accepts leading zeros and arbitrary precision decimal positions', () => {
    expect(parseSingleRange('bytes=007-009', SIZE)).toEqual(satisfiable(7n, 9n));
    const big = 9007199254740993n; // 2^53 + 1, beyond Number safe integer
    expect(parseSingleRange('bytes=9007199254740991-9007199254740992', big)).toEqual(
      satisfiable(9007199254740991n, 9007199254740992n),
    );
    const huge = 340282366920938463463374607431768211456n; // 2^128
    const result = parseSingleRange('bytes=340282366920938463463374607431768211455-', huge);
    expect(result).toEqual(satisfiable(340282366920938463463374607431768211455n, huge - 1n));
    if (result.type === 'satisfiable') {
      expect(typeof result.start).toBe('bigint');
      expect(typeof result.end).toBe('bigint');
      expect(typeof result.length).toBe('bigint');
      expect(result.length).toBe(1n);
    }
  });

  it('always satisfies the length invariant', () => {
    const cases = ['bytes=0-499', 'bytes=0-', 'bytes=-999', 'bytes=12-99999', 'bytes=000-000'];
    for (const header of cases) {
      const result = parseSingleRange(header, SIZE);
      expect(result.type).toBe('satisfiable');
      if (result.type === 'satisfiable') {
        expect(result.length).toBe(result.end - result.start + 1n);
        expect(result.start >= 0n && result.end < SIZE && result.end >= result.start).toBe(true);
      }
    }
  });
});

describe('unsatisfiable ranges', () => {
  it('rejects first-byte-pos at or beyond the end', () => {
    for (const header of ['bytes=1000-1001', 'bytes=1000-', 'bytes=5000-9999']) {
      expect(parseSingleRange(header, SIZE)).toEqual({ type: 'unsatisfiable', size: SIZE });
    }
  });

  it('rejects a zero-length suffix request', () => {
    expect(parseSingleRange('bytes=-0', SIZE)).toEqual({ type: 'unsatisfiable', size: SIZE });
    expect(parseSingleRange('bytes=-0', 0n)).toEqual({ type: 'unsatisfiable', size: 0n });
  });

  it('rejects every range against a zero-byte resource', () => {
    for (const header of ['bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=-0', 'bytes=5-2']) {
      expect(parseSingleRange(header, 0n)).toEqual({ type: 'unsatisfiable', size: 0n });
    }
  });
});

describe('invalid or unsupported headers', () => {
  it('reports malformed syntax', () => {
    const malformed = [
      'bytes',
      'bytes=',
      'bytes=-',
      'range',
      '=0-1',
      'bytes==0-1',
      'bytes=1-2-3',
      'bytes=-1-2',
      'bytes=a-b',
      'bytes=1.5-2',
      'bytes=+1-2',
      'bytes=1 -2',
      'bytes=1- 2',
      'bytes=0x10-0x20',
      'bytes=1e3-2e3',
      'bytes=0-1,', // trailing comma is not a second spec
      'bytes=,0-1',
      'bytes=0-١', // non-ASCII digits
    ];
    for (const header of malformed) {
      expect(parseSingleRange(header, SIZE)).toEqual({ type: 'invalid', reason: 'malformed' });
    }
  });

  it('rejects non-bytes units', () => {
    for (const header of ['items=0-1', 'none=0-1', 'bytesx=0-1', 'rows=-5']) {
      expect(parseSingleRange(header, SIZE)).toEqual({ type: 'invalid', reason: 'unsupported-unit' });
    }
  });

  it('rejects multi-range sets explicitly', () => {
    const multiple = [
      'bytes=0-1,2-3',
      'bytes=0-1, 2-3',
      'bytes=-5,0-1',
      'bytes=0-1,2-3,4-5',
      'bytes=0-1 , 2-3',
    ];
    for (const header of multiple) {
      expect(parseSingleRange(header, SIZE)).toEqual({ type: 'invalid', reason: 'multiple-ranges' });
    }
  });

  it('rejects inverted specs before bounds checks', () => {
    for (const header of ['bytes=5-2', 'bytes=999-0', 'bytes=2000-1999']) {
      expect(parseSingleRange(header, SIZE)).toEqual({ type: 'invalid', reason: 'inverted' });
    }
    // Inversion wins over unsatisfiable: the spec itself is invalid.
    expect(parseSingleRange('bytes=2000-10', SIZE)).toEqual({ type: 'invalid', reason: 'inverted' });
  });
});

describe('argument validation', () => {
  it('requires a non-negative bigint size', () => {
    expect(() => parseSingleRange('bytes=0-1', 10 as unknown as bigint)).toThrow(TypeError);
    expect(() => parseSingleRange('bytes=0-1', -1n)).toThrow(RangeError);
  });
});
