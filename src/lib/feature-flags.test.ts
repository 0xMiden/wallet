import { isBridgeDepositEnabled, isSwapEnabled } from './feature-flags';

describe('feature-flags — isSwapEnabled', () => {
  it('enables swap on every platform (including iOS)', () => {
    expect(isSwapEnabled()).toBe(true);
  });
});

describe('feature-flags — isBridgeDepositEnabled', () => {
  it('enables the receive-from-EVM deposit UI on every platform, regardless of env', () => {
    const original = {
      e2e: process.env.MIDEN_E2E_TEST,
      dev: process.env.MIDEN_ENABLE_BRIDGE_UI
    };
    delete process.env.MIDEN_E2E_TEST;
    delete process.env.MIDEN_ENABLE_BRIDGE_UI;
    expect(isBridgeDepositEnabled()).toBe(true);
    process.env.MIDEN_E2E_TEST = original.e2e;
    process.env.MIDEN_ENABLE_BRIDGE_UI = original.dev;
  });
});
