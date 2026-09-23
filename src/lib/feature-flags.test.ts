import {
  isBridgeDepositEnabled,
  isMidenNameResolveEnabled,
  isSwapEnabled,
  isUpdateNotificationsEnabled
} from './feature-flags';

describe('feature-flags - isMidenNameResolveEnabled', () => {
  const original = process.env.MIDEN_NAME_RESOLVE_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MIDEN_NAME_RESOLVE_ENABLED;
    } else {
      process.env.MIDEN_NAME_RESOLVE_ENABLED = original;
    }
  });

  it('is off when the build does not set the flag', () => {
    delete process.env.MIDEN_NAME_RESOLVE_ENABLED;
    expect(isMidenNameResolveEnabled()).toBe(false);
  });

  it('is on only for the literal value "true"', () => {
    process.env.MIDEN_NAME_RESOLVE_ENABLED = 'true';
    expect(isMidenNameResolveEnabled()).toBe(true);
    process.env.MIDEN_NAME_RESOLVE_ENABLED = 'false';
    expect(isMidenNameResolveEnabled()).toBe(false);
    process.env.MIDEN_NAME_RESOLVE_ENABLED = '1';
    expect(isMidenNameResolveEnabled()).toBe(false);
  });
});

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

describe('feature-flags - isUpdateNotificationsEnabled', () => {
  it('uses the build-time flag as the single source of truth', () => {
    const original = process.env.MIDEN_UPDATE_NOTIFICATIONS;
    const environment = process.env as Record<string, string | undefined>;
    environment.MIDEN_UPDATE_NOTIFICATIONS = 'true';
    expect(isUpdateNotificationsEnabled()).toBe(true);
    environment.MIDEN_UPDATE_NOTIFICATIONS = 'false';
    expect(isUpdateNotificationsEnabled()).toBe(false);
    environment.MIDEN_UPDATE_NOTIFICATIONS = original;
  });
});
