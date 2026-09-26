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

  // The bar reaches 73px over a navigation bar, 57px with no inset; the cushion keeps 15px at both.
  it('clears the docked Android bar by what it reaches, 57px plus the inset up to 16px', () => {
    mockPlatform.isMobile = true;
    mockPlatform.isAndroid = true;
    expect(stepFooterCushionClass()).toBe(
      'pb-[max(1rem,calc(4.5rem+min(1rem,env(safe-area-inset-bottom))-var(--keyboard-height,0px)))]'
    );
  });
});
