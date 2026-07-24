import { isSwapEnabled } from './feature-flags';

describe('feature-flags — isSwapEnabled', () => {
  it('enables swap on every platform (including iOS)', () => {
    expect(isSwapEnabled()).toBe(true);
  });
});
