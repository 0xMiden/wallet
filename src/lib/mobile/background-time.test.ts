import {
  frozenMs,
  hiddenMsWithin,
  hiddenSecondsSince,
  initBackgroundTimeTracking,
  runningNow,
  setRunningTimeout,
  __resetBackgroundTimeForTest
} from './background-time';
import { installHiddenDocument, type HiddenDocument } from './testing/hidden-document';

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
  let doc: HiddenDocument;

  beforeEach(() => {
    __resetBackgroundTimeForTest();
    doc = installHiddenDocument();
  });

  afterEach(() => {
    doc.restore();
  });

  it('accumulates a completed hidden interval and reports seconds since a timestamp', () => {
    initBackgroundTimeTracking();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(10_000); // t = 10s: go hidden
    doc.setHidden(true);
    nowSpy.mockReturnValue(13_000); // t = 13s: become visible → 3s hidden
    doc.setHidden(false);

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
    doc.setHidden(true);
    nowSpy.mockReturnValue(12_000);
    doc.setHidden(false);
    // 2s hidden, recorded once (not twice)
    expect(hiddenSecondsSince(0, 20_000)).toBe(2);

    nowSpy.mockRestore();
    addSpy.mockRestore();
  });

  it('seeds the open interval when the app starts already hidden', () => {
    doc.setHidden(true, { dispatch: false }); // relaunched in the background - no visibilitychange→hidden fires
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(5_000); // init at t = 5s while hidden
    initBackgroundTimeTracking();
    nowSpy.mockReturnValue(9_000); // becomes visible at t = 9s
    doc.setHidden(false);
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
      doc.setHidden(true);
      t += durationMs;
      nowSpy.mockReturnValue(t);
      doc.setHidden(false);
      t += 10; // brief visible gap between intervals
    };
    // MAX_HIDDEN_INTERVALS is 1000; push one more so the oldest is pruned.
    for (let i = 0; i < 1001; i++) flapHidden(1_000);
    // 1001 one-second intervals recorded, oldest dropped → 1000 s remain, not 1001.
    expect(hiddenSecondsSince(0, t)).toBe(1000);
    nowSpy.mockRestore();
  });
});

describe('runningNow, frozenMs and setRunningTimeout (#473)', () => {
  let doc: HiddenDocument;

  beforeEach(() => {
    jest.useFakeTimers();
    __resetBackgroundTimeForTest();
    doc = installHiddenDocument();
  });

  afterEach(() => {
    __resetBackgroundTimeForTest();
    doc.restore();
    jest.useRealTimers();
  });

  it('stands still across a freeze, less one pulse of slack', () => {
    initBackgroundTimeTracking();
    jest.advanceTimersByTime(10_000);
    doc.setHidden(true);
    doc.freezeFor(100_000);
    expect(frozenMs()).toBe(85_000);
    expect(runningNow()).toBe(25_000);
    doc.setHidden(false);
    jest.advanceTimersByTime(5_000);
    expect(runningNow()).toBe(30_000);
    expect(performance.now()).toBe(115_000);
  });

  it('starts the pulse at init when the app starts hidden, and measures a freeze from there', () => {
    doc.setHidden(true, { dispatch: false });
    jest.advanceTimersByTime(2_000);
    initBackgroundTimeTracking();
    expect(jest.getTimerCount()).toBe(1);
    // A hidden event arriving after all starts no second pulse.
    doc.setHidden(true);
    expect(jest.getTimerCount()).toBe(1);
    doc.freezeFor(100_000);
    expect(runningNow()).toBe(17_000);
    doc.setHidden(false);
    jest.advanceTimersByTime(1_000);
    expect(runningNow()).toBe(18_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts a freeze that comes before any read when the app starts hidden', () => {
    doc.setHidden(true, { dispatch: false });
    initBackgroundTimeTracking();
    doc.freezeFor(140_000);
    expect(frozenMs()).toBe(125_000);
    expect(runningNow()).toBe(15_000);
  });

  it('equals performance.now() while tracking is not initialised, with no pulse and nothing frozen', () => {
    jest.advanceTimersByTime(1_000);
    doc.setHidden(true);
    jest.advanceTimersByTime(60_000);
    expect(runningNow()).toBe(performance.now());
    expect(runningNow()).toBe(61_000);
    doc.freezeFor(100_000);
    expect(runningNow()).toBe(161_000);
    expect(frozenMs()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps running while hidden as long as JS runs: a timeout armed while hidden fires at 120 s', () => {
    initBackgroundTimeTracking();
    doc.setHidden(true);
    const fired = jest.fn();
    setRunningTimeout(fired, 120_000);
    jest.advanceTimersByTime(119_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(frozenMs()).toBe(0);
    // Only the pulse is left: the timeout did not re-arm.
    expect(jest.getTimerCount()).toBe(1);
  });

  it('a missed visible event cannot stop the clock', () => {
    initBackgroundTimeTracking();
    doc.setHidden(true);
    let firedAt: number | null = null;
    const startedAt = runningNow();
    setRunningTimeout(() => {
      firedAt = performance.now();
    }, 120_000);
    doc.setHidden(false, { dispatch: false });
    jest.advanceTimersByTime(200_000);
    expect(runningNow() - startedAt).toBe(200_000);
    expect(firedAt).toBe(120_000);
    // The pulse's first tick saw the document visible and stopped itself.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts a 60 s hidden gap as running and a 76 s one as 61 s frozen', () => {
    initBackgroundTimeTracking();
    doc.setHidden(true);
    doc.freezeFor(60_000);
    expect(frozenMs()).toBe(0);
    expect(runningNow()).toBe(60_000);
    doc.freezeFor(76_000);
    expect(frozenMs()).toBe(61_000);
    expect(runningNow()).toBe(75_000);
  });

  it('frozenMs measures a freeze no timer has woken from yet', () => {
    initBackgroundTimeTracking();
    doc.setHidden(true);
    // On resume both clocks have jumped and a catch can read the clock before any overdue
    // timer runs, so move them 140 s without running one.
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 140_000);
    jest.setSystemTime(Date.now() + 140_000);
    try {
      expect(frozenMs()).toBe(125_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('never counts a gap that began while visible as frozen', () => {
    initBackgroundTimeTracking();
    expect(runningNow()).toBe(0);
    jest.advanceTimersByTime(200_000);
    expect(frozenMs()).toBe(0);
    expect(runningNow()).toBe(200_000);
  });

  it('fires after 120 s of visible time', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    setRunningTimeout(fired, 120_000);
    jest.advanceTimersByTime(119_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('re-arms an overdue timer for the running time it has left', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    setRunningTimeout(fired, 120_000);
    jest.advanceTimersByTime(10_000);
    doc.setHidden(true);
    // The timer comes due at 120 s, inside the freeze.
    doc.freezeFor(140_000);
    expect(fired).not.toHaveBeenCalled();
    expect(frozenMs()).toBe(125_000);
    doc.setHidden(false);
    // 10 s visible and 15 s of pulse slack are spent, so 95 s are left.
    jest.advanceTimersByTime(94_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('counts a freeze that comes before the first pulse tick, as on iOS', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    setRunningTimeout(fired, 120_000);
    // iOS freezes JS about 5 s after the hidden event, before the pulse first reads the clock.
    doc.setHidden(true);
    doc.freezeFor(140_000);
    expect(frozenMs()).toBe(125_000);
    expect(fired).not.toHaveBeenCalled();
    doc.setHidden(false);
    jest.advanceTimersByTime(104_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('adds up several freezes against one deadline', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    setRunningTimeout(fired, 120_000);
    for (let i = 0; i < 3; i++) {
      jest.advanceTimersByTime(20_000);
      doc.setHidden(true);
      doc.freezeFor(100_000);
      doc.setHidden(false);
    }
    // 60 s visible and 45 s of pulse slack so far.
    jest.advanceTimersByTime(14_999);
    expect(fired).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('cancel stops the timer, including after it has re-armed', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    const cancel = setRunningTimeout(fired, 120_000);
    doc.setHidden(true);
    doc.freezeFor(130_000);
    doc.setHidden(false);
    cancel();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(300_000);
    expect(fired).not.toHaveBeenCalled();
  });

  it('hands onRearm the running time left on a re-arm, and never on the fire that calls back', () => {
    initBackgroundTimeTracking();
    const fired = jest.fn();
    const onRearm = jest.fn();
    setRunningTimeout(fired, 120_000, onRearm);
    jest.advanceTimersByTime(10_000);
    doc.setHidden(true);
    doc.freezeFor(140_000);
    expect(onRearm).toHaveBeenCalledTimes(1);
    expect(onRearm).toHaveBeenCalledWith(95_000);
    doc.setHidden(false);
    jest.advanceTimersByTime(95_000);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(onRearm).toHaveBeenCalledTimes(1);
  });

  it('calls back instead of re-arming with less than 1 ms left', () => {
    const fired = jest.fn();
    const onRearm = jest.fn();
    setRunningTimeout(fired, 120_000, onRearm);
    const fakeNow = performance.now.bind(performance);
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => fakeNow() - 0.5);
    try {
      jest.advanceTimersByTime(120_000);
      expect(onRearm).not.toHaveBeenCalled();
      expect(fired).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('falls back to Date.now() when performance is unavailable', () => {
    const fakePerformance = globalThis.performance;
    Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: undefined });
    try {
      jest.setSystemTime(1_234_567);
      expect(runningNow()).toBe(1_234_567);
    } finally {
      Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: fakePerformance });
    }
  });
});

describe('installHiddenDocument (test fixture)', () => {
  let doc: HiddenDocument;

  beforeEach(() => {
    jest.useFakeTimers();
    doc = installHiddenDocument();
  });

  afterEach(() => {
    doc.restore();
    jest.useRealTimers();
  });

  it('freezeFor moves both clocks and runs a timer that came due once, at the end', () => {
    expect(() => doc.freezeFor(90_000)).toThrow('freezeFor needs a hidden document');
    doc.setHidden(true);
    const ranAt: number[] = [];
    const pulse = jest.fn(() => ranAt.push(performance.now()));
    setInterval(pulse, 15_000);
    const monoBefore = performance.now();
    const epochBefore = Date.now();

    doc.freezeFor(90_000);

    expect(performance.now() - monoBefore).toBe(90_000);
    expect(Date.now() - epochBefore).toBe(90_000);
    expect(pulse).toHaveBeenCalledTimes(1);
    expect(ranAt).toEqual([monoBefore + 90_000]);
  });
});
