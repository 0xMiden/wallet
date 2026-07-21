import { isSwapEnabled } from './feature-flags';

const mockPlatform = { isIOS: false };
const originalIncludeSwapForIOS = process.env.MIDEN_INCLUDE_SWAP_FOR_IOS;

jest.mock('lib/platform', () => ({
  isIOS: () => mockPlatform.isIOS
}));

describe('feature-flags — isSwapEnabled', () => {
  afterEach(() => {
    mockPlatform.isIOS = false;
    if (originalIncludeSwapForIOS === undefined) {
      delete process.env.MIDEN_INCLUDE_SWAP_FOR_IOS;
    } else {
      process.env.MIDEN_INCLUDE_SWAP_FOR_IOS = originalIncludeSwapForIOS;
    }
  });

  it('enables swap off-iOS (Android / extension / desktop)', () => {
    mockPlatform.isIOS = false;
    expect(isSwapEnabled()).toBe(true);
  });

  it('disables swap on iOS (App Store Guideline 3.1.5(iii))', () => {
    mockPlatform.isIOS = true;
    process.env.MIDEN_INCLUDE_SWAP_FOR_IOS = 'false';
    expect(isSwapEnabled()).toBe(false);
  });

  it('enables swap on iOS when the internal testing override is included', () => {
    mockPlatform.isIOS = true;
    process.env.MIDEN_INCLUDE_SWAP_FOR_IOS = 'true';
    expect(isSwapEnabled()).toBe(true);
  });
});
