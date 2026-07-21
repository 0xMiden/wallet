import { capitalizeFirstLetter, truncateAddress, truncateHash } from './string';

describe('truncateHash', () => {
  it('returns empty string for empty input', () => {
    expect(truncateHash('')).toBe('');
  });

  it('returns empty string for undefined-like falsy input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(truncateHash(undefined as any)).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(truncateHash(null as any)).toBe('');
  });

  it('truncates using default front (7) and back (4)', () => {
    const hash = '0123456789abcdef';
    // front 7 -> '0123456', back 4 -> 'cdef'
    expect(truncateHash(hash)).toBe('0123456…cdef');
  });

  it('uses the single-character ellipsis (U+2026) as the separator', () => {
    const result = truncateHash('0123456789abcdef');
    expect(result).toContain('…');
    // Not three ASCII dots.
    expect(result).not.toContain('...');
  });

  it('respects custom front and back lengths', () => {
    const hash = 'abcdefghijklmnop';
    // front 3 -> 'abc', back 2 -> 'op'
    expect(truncateHash(hash, 3, 2)).toBe('abc…op');
  });

  it('handles a string shorter than front + back (slices overlap)', () => {
    const hash = 'abcd';
    // slice(0,7) -> 'abcd', slice(-4) -> 'abcd'
    expect(truncateHash(hash, 7, 4)).toBe('abcd…abcd');
  });

  it('handles back of 0 (slice(-0) returns whole string)', () => {
    // slice(-0) === slice(0) === entire string
    expect(truncateHash('abcdef', 3, 0)).toBe('abc…abcdef');
  });
});

describe('truncateAddress', () => {
  it('returns empty string for empty input', () => {
    expect(truncateAddress('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(truncateAddress(undefined as any)).toBe('');
  });

  it('falls back to truncateHash when there is no underscore', () => {
    const address = '0123456789abcdef';
    // default front 6, back 4 -> '012345' + ellipsis + 'cdef'
    expect(truncateAddress(address)).toBe('012345…cdef');
  });

  it('passes custom front/back through to truncateHash on the no-underscore path', () => {
    const address = 'abcdefghijklmnop';
    // includeBack irrelevant here; front 3, back 2
    expect(truncateAddress(address, true, 3, 4, 2)).toBe('abc…op');
  });

  it('truncates an underscore address with back included (documented example)', () => {
    const address = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5_qruqqypuyph';
    expect(truncateAddress(address)).toBe('mtst1a...5qv5...uyph');
  });

  it('omits the back part when includeBack is false', () => {
    const address = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5_qruqqypuyph';
    expect(truncateAddress(address, false)).toBe('mtst1a...5qv5');
  });

  it('uses three ASCII dots as separators for underscore addresses', () => {
    const address = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5_qruqqypuyph';
    const result = truncateAddress(address);
    expect(result).toContain('...');
    expect(result).not.toContain('…');
  });

  it('respects custom front, middle, and back with back included', () => {
    const address = 'prefix12345_suffix67890';
    // underscoreIndex = 11; front 4 -> 'pref'; middle 3 -> slice(8,11) -> '345'; back 3 -> '890'
    expect(truncateAddress(address, true, 4, 3, 3)).toBe('pref...345...890');
  });

  it('respects custom front and middle when back is excluded', () => {
    const address = 'prefix12345_suffix67890';
    // front 4 -> 'pref'; middle 3 -> '345'
    expect(truncateAddress(address, false, 4, 3, 3)).toBe('pref...345');
  });

  it('handles an underscore at the start of the string', () => {
    const address = '_abcdef';
    // underscoreIndex = 0; front 6 -> '_abcde'; middle slice(-4,0) -> '' ; back 4 -> 'cdef'
    expect(truncateAddress(address)).toBe('_abcde......cdef');
  });
});

describe('capitalizeFirstLetter', () => {
  it('returns empty string for empty input', () => {
    expect(capitalizeFirstLetter('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(capitalizeFirstLetter(undefined as any)).toBe('');
  });

  it('capitalizes the first letter of a lowercase word', () => {
    expect(capitalizeFirstLetter('hello')).toBe('Hello');
  });

  it('leaves an already-capitalized word unchanged', () => {
    expect(capitalizeFirstLetter('World')).toBe('World');
  });

  it('capitalizes a single character', () => {
    expect(capitalizeFirstLetter('a')).toBe('A');
  });

  it('does not alter the rest of the string casing', () => {
    expect(capitalizeFirstLetter('hELLO wORLD')).toBe('HELLO wORLD');
  });

  it('leaves a leading non-letter character unchanged', () => {
    expect(capitalizeFirstLetter('1abc')).toBe('1abc');
    expect(capitalizeFirstLetter(' spaced')).toBe(' spaced');
  });
});
