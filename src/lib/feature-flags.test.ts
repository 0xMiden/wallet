import { isEarnEnabled, isSwapEnabled } from './feature-flags';

describe('feature-flags — isSwapEnabled', () => {
  it('enables swap on every platform (including iOS)', () => {
    expect(isSwapEnabled()).toBe(true);
  });
});

describe('feature-flags — isEarnEnabled', () => {
  it('keeps Earn disabled (built but not yet exposed to users)', () => {
    expect(isEarnEnabled()).toBe(false);
  });
});
