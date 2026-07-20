import { bigIntToString, parseStringToBigIntArray, joinBigIntsToString } from './util';

// Helper: encode an ASCII string to the big-endian bigint that
// `bigIntToString` is expected to invert. Used to build round-trip cases
// without hard-coding every magic number.
const encodeToBigInt = (s: string): bigint => {
  let acc = BigInt(0);
  for (const byte of new TextEncoder().encode(s)) {
    acc = (acc << BigInt(8)) | BigInt(byte);
  }
  return acc;
};

describe('bigIntToString', () => {
  it('decodes a single-byte bigint to its ASCII character', () => {
    // 72 === 'H'
    expect(bigIntToString(BigInt(72))).toBe('H');
  });

  it('decodes a multi-byte bigint big-endian', () => {
    // 18537 === 0x4869 === 'Hi'
    expect(bigIntToString(BigInt(18537))).toBe('Hi');
  });

  it('reconstructs a longer ASCII string from its big-endian bigint', () => {
    expect(bigIntToString(BigInt('331941692750'))).toBe('MIDEN');
    expect(bigIntToString(encodeToBigInt('MIDEN'))).toBe('MIDEN');
  });

  it('returns an empty string for zero (loop body never runs)', () => {
    expect(bigIntToString(BigInt(0))).toBe('');
  });

  it('round-trips arbitrary ASCII strings', () => {
    for (const s of ['A', 'hello world', 'Miden Wallet 42!', 'x']) {
      expect(bigIntToString(encodeToBigInt(s))).toBe(s);
    }
  });
});

describe('parseStringToBigIntArray', () => {
  it('extracts a single u128-suffixed integer as a bigint', () => {
    expect(parseStringToBigIntArray('99u128')).toEqual([BigInt(99)]);
  });

  it('extracts multiple u128 values in order, ignoring surrounding text', () => {
    expect(parseStringToBigIntArray('foo 12u128 bar 34u128 baz 5')).toEqual([
      BigInt(12),
      BigInt(34)
    ]);
  });

  it('handles very large u128 values without precision loss', () => {
    const big = '340282366920938463463374607431768211455'; // 2^128 - 1
    expect(parseStringToBigIntArray(`${big}u128`)).toEqual([BigInt(big)]);
  });

  it('returns an empty array when there are no u128 matches', () => {
    expect(parseStringToBigIntArray('no numbers here')).toEqual([]);
    // Bare digits without the u128 suffix must not match.
    expect(parseStringToBigIntArray('123 456')).toEqual([]);
    expect(parseStringToBigIntArray('')).toEqual([]);
  });
});

describe('joinBigIntsToString', () => {
  it('returns an empty string for an empty array (loop never runs)', () => {
    expect(joinBigIntsToString([])).toBe('');
  });

  it('concatenates the decoded chunks in order', () => {
    // [72] -> 'H', [105] -> 'i'
    expect(joinBigIntsToString([BigInt(72), BigInt(105)])).toBe('Hi');
  });

  it('joins multi-byte chunks end to end', () => {
    const chunks = [encodeToBigInt('MID'), encodeToBigInt('EN')];
    expect(joinBigIntsToString(chunks)).toBe('MIDEN');
  });

  it('composes with parseStringToBigIntArray for a full parse round-trip', () => {
    const chunk = encodeToBigInt('Hi');
    const parsed = parseStringToBigIntArray(`${chunk.toString()}u128`);
    expect(joinBigIntsToString(parsed)).toBe('Hi');
  });
});
