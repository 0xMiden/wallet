import { stepFooterCushionClass } from './footer-cushion';

const mockPlatform = { isMobile: false, isAndroid: false };

jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.isMobile,
  isAndroid: () => mockPlatform.isAndroid
}));

describe('stepFooterCushionClass', () => {
  beforeEach(() => {
    mockPlatform.isMobile = false;
    mockPlatform.isAndroid = false;
  });

  it('clears the floating pill off-mobile', () => {
    expect(stepFooterCushionClass()).toBe('pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]');
  });

  it('clears the docked iOS bar, which reaches 49px into the page', () => {
    mockPlatform.isMobile = true;
    expect(stepFooterCushionClass()).toBe('pb-[max(1rem,calc(4rem-var(--keyboard-height,0px)))]');
  });

  // With its tabs above the system navigation bar the Android bar reaches 73px into the page, so a
  // 4rem cushion left the CTA 9px under it (#1121).
  it('clears the taller docked Android bar', () => {
    mockPlatform.isMobile = true;
    mockPlatform.isAndroid = true;
    expect(stepFooterCushionClass()).toBe('pb-[max(1rem,calc(5.5rem-var(--keyboard-height,0px)))]');
  });
});
