import { CHECK_ALEO_PAGES_EXIST, WALLET_AUTOLOCK_TIME } from './fixed-times';

describe('fixed-times constants', () => {
  it('CHECK_ALEO_PAGES_EXIST is the 10-second short interval in ms', () => {
    expect(CHECK_ALEO_PAGES_EXIST).toBe(10 * 1_000);
    expect(CHECK_ALEO_PAGES_EXIST).toBe(10_000);
  });

  it('WALLET_AUTOLOCK_TIME is the 10-minute long interval in ms', () => {
    expect(WALLET_AUTOLOCK_TIME).toBe(10 * 60_000);
    expect(WALLET_AUTOLOCK_TIME).toBe(600_000);
  });

  it('exposes numeric, positive, integer millisecond values', () => {
    for (const value of [CHECK_ALEO_PAGES_EXIST, WALLET_AUTOLOCK_TIME]) {
      expect(typeof value).toBe('number');
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('autolock (long) interval is longer than the aleo-page check (short) interval', () => {
    expect(WALLET_AUTOLOCK_TIME).toBeGreaterThan(CHECK_ALEO_PAGES_EXIST);
    expect(WALLET_AUTOLOCK_TIME / CHECK_ALEO_PAGES_EXIST).toBe(60);
  });
});
