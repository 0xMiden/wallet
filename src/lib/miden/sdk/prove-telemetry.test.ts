import {
  __resetProveTelemetryForTest,
  getProveTelemetry,
  recordProveTelemetry,
  SLOW_PROVE_THRESHOLD_MS
} from './prove-telemetry';

const mockIsMobile = jest.fn(() => false);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

describe('prove-telemetry (#466)', () => {
  beforeEach(() => {
    __resetProveTelemetryForTest();
    mockIsMobile.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  it('records a prove sample into the ring with platform + rounded duration', () => {
    const entry = recordProveTelemetry({ path: 'delegate', durationMs: 1234.7, fellBack: false });
    expect(entry?.path).toBe('delegate');
    expect(entry?.durationMs).toBe(1235);
    expect(entry?.platform).toBe('desktop');
    expect(entry?.fellBack).toBe(false);
    expect(entry?.slow).toBe(false);
    expect(getProveTelemetry()).toHaveLength(1);
  });

  it('flags slow proves (> threshold) and warns', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = recordProveTelemetry({ path: 'local', durationMs: SLOW_PROVE_THRESHOLD_MS + 1, fellBack: false });
    expect(entry?.slow).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('slow prove'));
  });

  it('does not flag a prove at exactly the threshold as slow', () => {
    const entry = recordProveTelemetry({ path: 'local', durationMs: SLOW_PROVE_THRESHOLD_MS, fellBack: false });
    expect(entry?.slow).toBe(false);
  });

  it('captures the remote portion + combined wall time on a delegate->local fallback', () => {
    const entry = recordProveTelemetry({
      path: 'local',
      durationMs: 9000,
      fellBack: true,
      remoteDurationMs: 6000
    });
    expect(entry?.fellBack).toBe(true);
    expect(entry?.remoteDurationMs).toBe(6000);
    expect(entry?.durationMs).toBe(9000);
  });

  it('marks the platform mobile when isMobile()', () => {
    mockIsMobile.mockReturnValue(true);
    expect(recordProveTelemetry({ path: 'native-mobile', durationMs: 10, fellBack: false })?.platform).toBe('mobile');
  });

  it('records a failed double-failure prove (remote + local both failed)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const entry = recordProveTelemetry({
      path: 'local',
      durationMs: SLOW_PROVE_THRESHOLD_MS + 5000,
      fellBack: true,
      remoteDurationMs: 20000,
      failed: true
    });
    expect(entry?.failed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FAILED'));
  });

  it('never throws or slows a prove — a throw inside is swallowed (returns undefined)', () => {
    // Force the console.warn on the slow path to throw; recordProveTelemetry
    // must swallow it (it runs on the hot proving path).
    jest.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger blew up');
    });
    let result: unknown;
    expect(() => {
      result = recordProveTelemetry({ path: 'local', durationMs: SLOW_PROVE_THRESHOLD_MS + 1, fellBack: false });
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it('bounds the ring (drops the oldest beyond capacity)', () => {
    for (let i = 0; i < 60; i++) recordProveTelemetry({ path: 'local', durationMs: i, fellBack: false });
    const ring = getProveTelemetry();
    expect(ring).toHaveLength(50);
    // oldest 10 dropped → first retained sample is durationMs 10, newest is 59
    expect(ring[0]?.durationMs).toBe(10);
    expect(ring[ring.length - 1]?.durationMs).toBe(59);
  });
});
