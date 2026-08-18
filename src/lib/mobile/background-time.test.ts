import {
  hiddenMsWithin,
  hiddenSecondsSince,
  initBackgroundTimeTracking,
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
