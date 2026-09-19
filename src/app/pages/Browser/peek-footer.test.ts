import { FOOTER_HEIGHT_FALLBACK, resolveFooterClearance } from './peek-footer';

describe('resolveFooterClearance', () => {
  it.each([
    ['the docked bar on an iPhone (1 + 56 + 34)', 91],
    ['the docked bar with no home indicator (1 + 56 + 8)', 65],
    ['the floating pill with its margin', 64]
  ])('uses the measured footer height as-is: %s', (_label, height) => {
    expect(resolveFooterClearance(height)).toBe(height);
  });

  it('no longer throws away a real bar shorter than the old 110px floor', () => {
    expect(resolveFooterClearance(91)).toBe(91);
    expect(resolveFooterClearance(91)).toBeLessThan(110);
  });

  it.each([0, null, undefined])('falls back to the iPhone bar height with no footer (%s)', measured => {
    expect(resolveFooterClearance(measured)).toBe(FOOTER_HEIGHT_FALLBACK);
    expect(FOOTER_HEIGHT_FALLBACK).toBe(1 + 56 + 34);
  });
});
