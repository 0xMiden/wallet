import { WALLET_AUTOLOCK_TIME } from 'lib/fixed-times';

import { backgroundLockDelay, backgroundLockDelayMs, getIsLockUpEnabled } from './index';

describe('lock-up', () => {
  describe('getIsLockUpEnabled', () => {
    it('returns true', () => {
      expect(getIsLockUpEnabled()).toBe(true);
    });

    it('returns a boolean and is stable across calls', () => {
      const first = getIsLockUpEnabled();
      const second = getIsLockUpEnabled();
      expect(typeof first).toBe('boolean');
      expect(first).toBe(second);
    });
  });

  describe('backgroundLockDelay', () => {
    afterEach(() => localStorage.clear());

    it('defaults the background delay to the extension auto-lock time', () => {
      expect(backgroundLockDelayMs(backgroundLockDelay.get())).toBe(WALLET_AUTOLOCK_TIME);
    });

    it('reads an unknown stored value as the default', () => {
      localStorage.setItem('background_lock_delay_setting', '0');
      expect(backgroundLockDelay.get()).toBe('10');
    });
  });
});
