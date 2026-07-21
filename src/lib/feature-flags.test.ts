import { isSwapEnabled } from './feature-flags';

const mockPlatform = { isIOS: false };

jest.mock('lib/platform', () => ({
  isIOS: () => mockPlatform.isIOS
}));

describe('feature-flags — isSwapEnabled', () => {
  afterEach(() => {
    mockPlatform.isIOS = false;
  });

  it('enables swap off-iOS (Android / extension / desktop)', () => {
    mockPlatform.isIOS = false;
    expect(isSwapEnabled()).toBe(true);
  });

  it('disables swap on iOS (App Store Guideline 3.1.5(iii))', () => {
    mockPlatform.isIOS = true;
    expect(isSwapEnabled()).toBe(false);
  });
});
