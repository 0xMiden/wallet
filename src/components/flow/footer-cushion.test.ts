import { stepFooterCushionClass } from './footer-cushion';

const mockPlatform = { isMobile: false };

jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.isMobile
}));

describe('stepFooterCushionClass', () => {
  beforeEach(() => {
    mockPlatform.isMobile = false;
  });

  it('clears the floating pill off-mobile', () => {
    expect(stepFooterCushionClass()).toBe('pb-[max(1rem,calc(6rem-var(--keyboard-height,0px)))]');
  });

  // The room is main.css's `--navbar-cushion`, set when TabLayout marks the body for a bar that clears
  // the inset (Android, #1121), else 4rem.
  it('clears the docked bar by the room main.css gives it, 4rem when unset', () => {
    mockPlatform.isMobile = true;
    expect(stepFooterCushionClass()).toBe('pb-[max(1rem,calc(var(--navbar-cushion,4rem)-var(--keyboard-height,0px)))]');
  });
});
