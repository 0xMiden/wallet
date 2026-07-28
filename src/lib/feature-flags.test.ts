import { isBridgeDepositEnabled, isEarnEnabled, isSwapEnabled } from './feature-flags';

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

describe('feature-flags — isBridgeDepositEnabled', () => {
  const original = {
    e2e: process.env.MIDEN_E2E_TEST,
    dev: process.env.MIDEN_ENABLE_BRIDGE_UI
  };
  afterEach(() => {
    process.env.MIDEN_E2E_TEST = original.e2e;
    process.env.MIDEN_ENABLE_BRIDGE_UI = original.dev;
  });

  it('hides the receive-from-EVM deposit UI by default (production)', () => {
    delete process.env.MIDEN_E2E_TEST;
    delete process.env.MIDEN_ENABLE_BRIDGE_UI;
    expect(isBridgeDepositEnabled()).toBe(false);
  });

  it('stays enabled in the E2E build so the bridge-in e2e keeps exercising it', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    delete process.env.MIDEN_ENABLE_BRIDGE_UI;
    expect(isBridgeDepositEnabled()).toBe(true);
  });

  it('can be force-enabled via the MIDEN_ENABLE_BRIDGE_UI dev override', () => {
    delete process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_ENABLE_BRIDGE_UI = 'true';
    expect(isBridgeDepositEnabled()).toBe(true);
  });
});
