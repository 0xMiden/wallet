import { getIsLockUpEnabled } from './index';

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
});
