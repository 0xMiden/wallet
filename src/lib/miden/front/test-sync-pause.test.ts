import { isTestSyncPaused, setTestSyncPaused } from './test-sync-pause';

type FlagGlobal = { __TEST_SYNC_PAUSED__?: boolean };

describe('test-sync-pause', () => {
  const prevEnv = process.env.MIDEN_E2E_TEST;

  afterEach(() => {
    delete (globalThis as FlagGlobal).__TEST_SYNC_PAUSED__;
    process.env.MIDEN_E2E_TEST = prevEnv;
  });

  it('isTestSyncPaused returns true only when the E2E build flag and the pause flag are both set', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    (globalThis as FlagGlobal).__TEST_SYNC_PAUSED__ = true;
    expect(isTestSyncPaused()).toBe(true);
  });

  it('isTestSyncPaused returns false when the pause flag is unset', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    delete (globalThis as FlagGlobal).__TEST_SYNC_PAUSED__;
    expect(isTestSyncPaused()).toBe(false);
  });

  it('isTestSyncPaused returns false off the E2E build even if the pause flag is set', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    (globalThis as FlagGlobal).__TEST_SYNC_PAUSED__ = true;
    expect(isTestSyncPaused()).toBe(false);
  });

  it('setTestSyncPaused toggles the flag on the E2E build', () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setTestSyncPaused(true);
    expect((globalThis as FlagGlobal).__TEST_SYNC_PAUSED__).toBe(true);
    setTestSyncPaused(false);
    expect((globalThis as FlagGlobal).__TEST_SYNC_PAUSED__).toBe(false);
  });

  it('setTestSyncPaused is a no-op off the E2E build', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    setTestSyncPaused(true);
    expect((globalThis as FlagGlobal).__TEST_SYNC_PAUSED__).toBeUndefined();
  });
});
