import { encodingVariantsOf } from './egress-guard';

/**
 * The variant generator gets its own test because the egress guard is only as
 * good as this list: a substring check that misses base64 is theatre, and it
 * would still pass while a recovery phrase left the device.
 */
describe('encodingVariantsOf', () => {
  it('includes the raw value', () => {
    expect(encodingVariantsOf('mtst1abc')).toContain('mtst1abc');
  });

  it('includes upper and lower case', () => {
    const variants = encodingVariantsOf('MtSt1Abc');
    expect(variants).toContain('mtst1abc');
    expect(variants).toContain('MTST1ABC');
  });

  it('includes base64', () => {
    expect(encodingVariantsOf('mtst1abc')).toContain(btoa('mtst1abc'));
  });

  it('includes base64url, which is base64 with a URL-safe alphabet and no padding', () => {
    // `?~` base64s to `P34=`, exercising neither substitution; `ÿþ` gives the
    // `+`/`/` pair that base64url replaces.
    const variants = encodingVariantsOf('\u00ff\u00fe\u00ff\u00fe');
    const base64 = btoa('\u00ff\u00fe\u00ff\u00fe');
    expect(base64).toMatch(/[+/]/);
    expect(variants).toContain(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  });

  it('includes hex in both cases', () => {
    const variants = encodingVariantsOf('ab');
    expect(variants).toContain('6162');
    expect(encodingVariantsOf('\u00ff')).toContain('FF');
  });

  it('includes URI encoding', () => {
    expect(encodingVariantsOf('a b')).toContain('a%20b');
  });

  it('includes a fully percent-encoded form in both hex cases', () => {
    expect(encodingVariantsOf('ab')).toContain('%61%62');
    expect(encodingVariantsOf('ab')).toContain('%61%62'.toUpperCase());
  });

  it('percent-encodes multi-byte characters as their UTF-8 bytes', () => {
    // A single `charCodeAt` per character would emit `%20ac`, which decodes to
    // something else entirely — the check would then miss the real payload.
    expect(encodingVariantsOf('\u20ac')).toContain('%e2%82%ac');
  });

  it('includes JSON escaping', () => {
    expect(encodingVariantsOf('a"b')).toContain('a\\"b');
    expect(encodingVariantsOf('a\nb')).toContain('a\\nb');
  });

  it('includes \\uXXXX escaping', () => {
    expect(encodingVariantsOf('ab')).toContain('\\u0061\\u0062');
  });

  it('survives input that cannot be base64-encoded, keeping the other variants', () => {
    const variants = encodingVariantsOf('\u{1f600}seed');
    expect(variants).toContain('\u{1f600}seed');
    expect(variants).toContain('%f0%9f%98%80seed'.replace('seed', '%73%65%65%64'));
  });

  it('returns no duplicates, so the guard does not repeat work', () => {
    const variants = encodingVariantsOf('1234');
    expect(new Set(variants).size).toBe(variants.length);
  });
});
