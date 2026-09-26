import { stepFooterCushionClass } from './footer-cushion';

const mockPlatform = { isMobile: false };

jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.isMobile
}));

describe('stepFooterCushionClass', () => {
  // The room is main.css's `--navbar-cushion`, declared only on TabLayout's root, so a page outside that
  // layout (a slide page beside the covered tab layer) keeps the flat 1rem (#1109).
  it.each([
    ['on mobile', true],
    ['off-mobile', false]
  ])('reads the tab layout room, 1rem outside it, %s', (_platform, mobile) => {
    mockPlatform.isMobile = mobile;
    expect(stepFooterCushionClass()).toBe('pb-[max(1rem,calc(var(--navbar-cushion,1rem)-var(--keyboard-height,0px)))]');
  });
});
