import { PerformanceTimings } from 'lib/miden/analytics-types';

import {
  PERFORMANCE_STORAGE_KEY,
  MIN_RECORDS_FOR_PERFORMANCE_ANALYTICS,
  setLastPerformanceSent,
  getLastPerformanceSent,
  sendScanPerformanceEvent
} from './performance-analytics';

const SEVEN_DAYS_MS = 1000 * 60 * 60 * 24 * 7;
const timings: PerformanceTimings = { scan: 42 };

describe('performance-analytics', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  describe('constants', () => {
    it('exposes the storage key and minimum-records threshold', () => {
      expect(PERFORMANCE_STORAGE_KEY).toBe('performance_analytics');
      expect(MIN_RECORDS_FOR_PERFORMANCE_ANALYTICS).toBe(1000);
    });
  });

  describe('setLastPerformanceSent', () => {
    it('persists the value as JSON to localStorage', () => {
      setLastPerformanceSent(12345);

      expect(localStorage.getItem(PERFORMANCE_STORAGE_KEY)).toBe('12345');
    });

    it('swallows errors thrown by localStorage.setItem', () => {
      const setItemSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });

      // Should not throw despite setItem blowing up.
      expect(() => setLastPerformanceSent(999)).not.toThrow();
      expect(setItemSpy).toHaveBeenCalledWith(PERFORMANCE_STORAGE_KEY, '999');
    });
  });

  describe('getLastPerformanceSent', () => {
    it('returns 0 when nothing is stored', () => {
      expect(getLastPerformanceSent()).toBe(0);
    });

    it('returns the parsed number when a value is stored', () => {
      localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(987654321));

      expect(getLastPerformanceSent()).toBe(987654321);
    });
  });

  describe('sendScanPerformanceEvent', () => {
    it('does nothing when there is no analytics state in localStorage', async () => {
      const nowSpy = jest.spyOn(Date, 'now');

      await sendScanPerformanceEvent('scan', timings);

      // No branch that reads/updates the timestamp is entered.
      expect(nowSpy).not.toHaveBeenCalled();
      expect(localStorage.getItem(PERFORMANCE_STORAGE_KEY)).toBeNull();
    });

    it('does nothing when analytics has no userId', async () => {
      localStorage.setItem('analytics', JSON.stringify({ enabled: true }));

      await sendScanPerformanceEvent('scan', timings);

      expect(localStorage.getItem(PERFORMANCE_STORAGE_KEY)).toBeNull();
    });

    it('does nothing when analytics is present but disabled', async () => {
      localStorage.setItem('analytics', JSON.stringify({ userId: 'u1', enabled: false }));

      await sendScanPerformanceEvent('scan', timings);

      expect(localStorage.getItem(PERFORMANCE_STORAGE_KEY)).toBeNull();
    });

    it('does not update the timestamp when the last send was recent', async () => {
      const now = 1_000_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      localStorage.setItem('analytics', JSON.stringify({ userId: 'u1', enabled: true }));
      // Sent one second ago -> well within the 7-day window.
      const recent = now - 1000;
      localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(recent));

      await sendScanPerformanceEvent('scan', timings);

      expect(getLastPerformanceSent()).toBe(recent);
    });

    it('updates the timestamp when more than 7 days have elapsed', async () => {
      const now = 2_000_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      localStorage.setItem('analytics', JSON.stringify({ userId: 'u1', enabled: true }));
      // Sent more than 7 days ago.
      const old = now - SEVEN_DAYS_MS - 1;
      localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(old));

      await sendScanPerformanceEvent('scan', timings, { extra: 'prop' });

      expect(getLastPerformanceSent()).toBe(now);
    });

    it('updates the timestamp when nothing was ever sent (defaults to 0)', async () => {
      const now = 3_000_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      localStorage.setItem('analytics', JSON.stringify({ userId: 'u1', enabled: true }));

      await sendScanPerformanceEvent('scan', timings);

      expect(getLastPerformanceSent()).toBe(now);
    });

    it('warns when persisting the new timestamp throws', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      // First Date.now() (in the elapsed-time check) returns a large value so
      // the 7-day branch is taken; the second Date.now() (the argument passed
      // to setLastPerformanceSent) throws, tripping the catch block.
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(SEVEN_DAYS_MS + 1)
        .mockImplementationOnce(() => {
          throw new Error('clock failure');
        });

      localStorage.setItem('analytics', JSON.stringify({ userId: 'u1', enabled: true }));

      await sendScanPerformanceEvent('scan', timings);

      expect(warnSpy).toHaveBeenCalledWith('Failed to send performance event');
    });
  });
});
