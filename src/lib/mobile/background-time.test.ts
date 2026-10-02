import {
  foregroundNow,
  hiddenMsWithin,
  hiddenSecondsSince,
  initBackgroundTimeTracking,
  setForegroundTimeout,
  __resetBackgroundTimeForTest
} from './background-time';

describe('hiddenMsWithin (pure)', () => {
  const s = (start: number, end: number) => ({ start, end });

  it('is 0 with no hidden intervals and not currently hidden', () => {
    expect(hiddenMsWithin([], null, 0, 10_000)).toBe(0);
  });

  it('counts a closed interval fully inside the window', () => {
    expect(hiddenMsWithin([s(2_000, 5_000)], null, 0, 10_000)).toBe(3_000);
  });

  it('clamps an interval to the [since, now] window', () => {
    // interval 1_000..8_000, window 3_000..6_000 → overlap 3_000..6_000 = 3_000
    expect(hiddenMsWithin([s(1_000, 8_000)], null, 3_000, 6_000)).toBe(3_000);
  });

  it('ignores an interval entirely before the window start', () => {
    expect(hiddenMsWithin([s(0, 1_000)], null, 5_000, 10_000)).toBe(0);
  });

  it('sums multiple intervals', () => {
    expect(hiddenMsWithin([s(1_000, 2_000), s(4_000, 4_500)], null, 0, 10_000)).toBe(1_500);
  });

  it('counts the still-open hidden interval up to now', () => {
    // currently hidden since 7_000, now 10_000 → 3_000
    expect(hiddenMsWithin([], 7_000, 0, 10_000)).toBe(3_000);
  });

  it('clamps the open hidden interval to the window start', () => {
    // hidden since 2_000, window since 5_000, now 9_000 → 4_000
    expect(hiddenMsWithin([], 2_000, 5_000, 9_000)).toBe(4_000);
  });
});

describe('hiddenSecondsSince (module state via visibilitychange)', () => {
  let hidden = false;

  beforeEach(() => {
    __resetBackgroundTimeForTest();
    hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden
    });
  });

  const setHidden = (v: boolean) => {
    hidden = v;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('accumulates a completed hidden interval and reports seconds since a timestamp', () => {
    initBackgroundTimeTracking();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(10_000); // t = 10s: go hidden
    setHidden(true);
    nowSpy.mockReturnValue(13_000); // t = 13s: become visible → 3s hidden
    setHidden(false);

    // since t=5s (epoch seconds), now t=20s: the whole 3s hidden window counts
    expect(hiddenSecondsSince(5, 20_000)).toBe(3);
    nowSpy.mockRestore();
  });

  it('returns 0 when nothing was hidden since the given time', () => {
    initBackgroundTimeTracking();
    expect(hiddenSecondsSince(0, 10_000)).toBe(0);
  });

  it('is idempotent — a second init does not double-count a hidden interval', () => {
    const addSpy = jest.spyOn(document, 'addEventListener');
    initBackgroundTimeTracking();
    initBackgroundTimeTracking(); // second call is a no-op
    const visibilityListeners = addSpy.mock.calls.filter(([evt]) => evt === 'visibilitychange');
    expect(visibilityListeners).toHaveLength(1);

    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(10_000);
    setHidden(true);
    nowSpy.mockReturnValue(12_000);
    setHidden(false);
    // 2s hidden, recorded once (not twice)
    expect(hiddenSecondsSince(0, 20_000)).toBe(2);

    nowSpy.mockRestore();
    addSpy.mockRestore();
  });

  it('seeds the open interval when the app starts already hidden', () => {
    hidden = true; // relaunched in the background — no visibilitychange→hidden fires
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(5_000); // init at t = 5s while hidden
    initBackgroundTimeTracking();
    nowSpy.mockReturnValue(9_000); // becomes visible at t = 9s
    setHidden(false);
    // the [5s, 9s] startup-hidden stretch is counted (4s)
    expect(hiddenSecondsSince(0, 20_000)).toBe(4);
    nowSpy.mockRestore();
  });

  it('caps stored hidden intervals by count so memory stays bounded (#473 review)', () => {
    initBackgroundTimeTracking();
    const nowSpy = jest.spyOn(Date, 'now');
    let t = 0;
    const flapHidden = (durationMs: number) => {
      nowSpy.mockReturnValue(t);
      setHidden(true);
      t += durationMs;
      nowSpy.mockReturnValue(t);
      setHidden(false);
      t += 10; // brief visible gap between intervals
    };
    // MAX_HIDDEN_INTERVALS is 1000; push one more so the oldest is pruned.
    for (let i = 0; i < 1001; i++) flapHidden(1_000);
    // 1001 one-second intervals recorded, oldest dropped → 1000 s remain, not 1001.
    expect(hiddenSecondsSince(0, t)).toBe(1000);
    nowSpy.mockRestore();
  });
});

describe('foregroundNow and setForegroundTimeout (#473)', () => {
  let hidden = false;

  beforeEach(() => {
    jest.useFakeTimers();
    __resetBackgroundTimeForTest();
    hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden
    });
  });

  afterEach(() => {
    __resetBackgroundTimeForTest();
    Reflect.deleteProperty(document, 'hidden');
    jest.useRealTimers();
  });

  const setHidden = (v: boolean) => {
    hidden = v;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('stands still while hidden, counting a stretch that is still open', () => {
    initBackgroundTimeTracking();
    jest.advanceTimersByTime(10_000);
    setHidden(true);
    jest.advanceTimersByTime(40_000);
    expect(foregroundNow()).toBe(10_000);
    setHidden(false);
    jest.advanceTimersByTime(5_000);
    expect(foregroundNow()).toBe(15_000);
    expect(performance.now()).toBe(55_000);
  });

  it('freezes from init when the app starts hidden', () => {
    hidden = true;
    jest.advanceTimersByTime(2_000);
    initBackgroundTimeTracking();
    jest.advanceTimersByTime(30_000);
    expect(foregroundNow()).toBe(2_000);
    setHidden(false);
    jest.advanceTimersByTime(1_000);
    expect(foregroundNow()).toBe(3_000);
  });

  it('equals performance.now() while tracking is not initialised', () => {
    jest.advanceTimersByTime(1_000);
    setHidden(true);
    jest.advanceTimersByTime(60_000);
    expect(foregroundNow()).toBe(performance.now());
    expect(foregroundNow()).toBe(61_000);
  });

  it('fires after 120 s of visible time', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    setForegroundTimeout(fired, 120_000);
    jest.advanceTimersByTime(119_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('re-arms an overdue timer for the foreground time it has left', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    setForegroundTimeout(fired, 120_000);
    jest.advanceTimersByTime(10_000);
    setHidden(true);
    // The wall-clock timer comes due at 120 s, inside the hidden stretch.
    jest.advanceTimersByTime(140_000);
    expect(fired).not.toHaveBeenCalled();
    setHidden(false);
    jest.advanceTimersByTime(109_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('adds up several background stretches against one deadline', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    setForegroundTimeout(fired, 120_000);
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(20_000);
      setHidden(true);
      jest.advanceTimersByTime(50_000);
      setHidden(false);
    }
    // 60 s visible and 150 s hidden so far.
    jest.advanceTimersByTime(59_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('cancel stops the timer, including after it has re-armed', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    const cancel = setForegroundTimeout(fired, 120_000);
    setHidden(true);
    jest.advanceTimersByTime(130_000);
    setHidden(false);
    cancel();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(300_000);
    expect(fired).not.toHaveBeenCalled();
  });

  it('falls back to Date.now() when performance is unavailable', () => {
    const fakePerformance = globalThis.performance;
    Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: undefined });
    try {
      jest.setSystemTime(1_234_567);
      expect(foregroundNow()).toBe(1_234_567);
    } finally {
      Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: fakePerformance });
    }
  });
});
