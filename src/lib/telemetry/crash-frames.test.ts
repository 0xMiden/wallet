import { sanitizeWalletFrame } from './crash-frames';

jest.mock('./crash-artifacts', () => ({
  crashAssetBase: 'capacitor://localhost/',
  crashArtifactLines: { 'mobile.js': [15000, 25], 'chunks/sdk.known123.js': [75000] }
}));

describe('build-proven wallet crash positions', () => {
  it('keeps compiled offsets without the original origin, query, or fragment', () => {
    expect(sanitizeWalletFrame('capacitor://localhost/mobile.js?secret=12345#private', 1, 12345)).toEqual({
      filename: 'app:///mobile.js',
      lineno: 1,
      colno: 12345
    });
  });

  it('matches an exact hashed artifact, never a suffix or prefix', () => {
    expect(sanitizeWalletFrame('capacitor://localhost/chunks/sdk.known123.js', 1, 45000)).toEqual({
      filename: 'app:///chunks/sdk.known123.js',
      lineno: 1,
      colno: 45000
    });
    expect(sanitizeWalletFrame('capacitor://localhost/chunks/sdk.unknown.js', 1, 45)).toBeUndefined();
    expect(sanitizeWalletFrame('capacitor://localhost/private/mobile.js', 1, 45)).toBeUndefined();
  });

  it.each([
    'https://external.example/mobile.js',
    'capacitor://other/mobile.js',
    'capacitor://localhost.evil/mobile.js',
    'capacitor://localhost/%6dobile.js',
    'capacitor://localhost/private/../mobile.js',
    'capacitor://localhost//mobile.js',
    'capacitor://localhost/mobile.js/private',
    'app:///mobile.js',
    '/mobile.js',
    'capacitor://localhost/mobile.js\\private',
    12345,
    null
  ])('rejects unknown or noncanonical frame source %p', filename => {
    expect(sanitizeWalletFrame(filename, 1, 20)).toBeUndefined();
  });

  it.each([0, -1, 3, 1.5, NaN, Infinity, '1', undefined, null])('rejects invalid line %p', line => {
    expect(sanitizeWalletFrame('capacitor://localhost/mobile.js', line, 12)).toBeUndefined();
  });

  it.each([0, -1, 15002, 1.5, NaN, Infinity, '12345', null])('drops invalid column %p', column => {
    expect(sanitizeWalletFrame('capacitor://localhost/mobile.js', 1, column)).toEqual({
      filename: 'app:///mobile.js',
      lineno: 1
    });
  });

  it('allows a missing column and the last emitted position', () => {
    expect(sanitizeWalletFrame('capacitor://localhost/mobile.js', 2, undefined)).toEqual({
      filename: 'app:///mobile.js',
      lineno: 2
    });
    expect(sanitizeWalletFrame('capacitor://localhost/mobile.js', 2, 26)?.colno).toBe(26);
    expect(sanitizeWalletFrame('capacitor://localhost/mobile.js', 2, 27)?.colno).toBeUndefined();
  });
});
