import {
  __resetProveTelemetryForTest,
  beginProveAttempt,
  getProveTelemetry,
  recordProveTelemetry,
  recordSdkProveStep,
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

  describe('consuming the SDK prove-step observations', () => {
    it('attaches the SDK-measured prove time to the attempt it arrived during', () => {
      const attempt = beginProveAttempt();
      recordSdkProveStep({ durationMs: 18_500.4, failed: false });
      const entry = attempt.record({ path: 'delegate', durationMs: 24_000, fellBack: false });

      expect(entry?.proveStepMs).toBe(18_500);
      // The wall time the user waited is still the wallet's own measurement —
      // the SDK's number explains it, it does not replace it.
      expect(entry?.durationMs).toBe(24_000);
    });

    it('omits the field entirely when the SDK observed no prove step', () => {
      const attempt = beginProveAttempt();
      const entry = attempt.record({ path: 'local', durationMs: 300, fellBack: false });

      expect(entry).not.toHaveProperty('proveStepMs');
      expect(entry).not.toHaveProperty('proveStepFailed');
    });

    it('drops a step observed while no attempt is open', () => {
      recordSdkProveStep({ durationMs: 900, failed: false });
      const attempt = beginProveAttempt();
      const entry = attempt.record({ path: 'local', durationMs: 300, fellBack: false });

      expect(entry?.proveStepMs).toBeUndefined();
    });

    it('drops a step observed while two attempts are open, rather than guessing whose it is', () => {
      const first = beginProveAttempt();
      const second = beginProveAttempt();
      recordSdkProveStep({ durationMs: 900, failed: false });
      const firstEntry = first.record({ path: 'delegate', durationMs: 1_000, fellBack: false });
      // Only one attempt is open now, so this one is attributable again.
      recordSdkProveStep({ durationMs: 400, failed: false });
      const secondEntry = second.record({ path: 'delegate', durationMs: 1_200, fellBack: false });

      expect(firstEntry?.proveStepMs).toBeUndefined();
      expect(secondEntry?.proveStepMs).toBe(400);
    });

    it('stops collecting once the attempt has ended', () => {
      const attempt = beginProveAttempt();
      attempt.end();
      recordSdkProveStep({ durationMs: 700, failed: false });
      const entry = attempt.record({ path: 'local', durationMs: 800, fellBack: false });

      expect(entry?.proveStepMs).toBeUndefined();
    });

    it('closes the attempt on record, so a later step cannot be attributed to it', () => {
      const attempt = beginProveAttempt();
      attempt.record({ path: 'local', durationMs: 800, fellBack: false });
      recordSdkProveStep({ durationMs: 700, failed: false });
      const next = beginProveAttempt();
      const entry = next.record({ path: 'local', durationMs: 100, fellBack: false });

      expect(entry?.proveStepMs).toBeUndefined();
    });

    it('is safe to end twice, which is what the caller\u2019s finally block does', () => {
      const attempt = beginProveAttempt();
      attempt.end();
      expect(() => attempt.end()).not.toThrow();

      const next = beginProveAttempt();
      recordSdkProveStep({ durationMs: 250, failed: false });
      expect(next.record({ path: 'local', durationMs: 900, fellBack: false })?.proveStepMs).toBe(250);
      next.end();
    });

    it('flags the prove step as failed when any observed step errored', () => {
      const attempt = beginProveAttempt();
      recordSdkProveStep({ durationMs: 20_000, failed: true });
      recordSdkProveStep({ durationMs: 5_000, failed: false });
      const entry = attempt.record({ path: 'local', durationMs: 26_000, fellBack: true, remoteDurationMs: 20_000 });

      expect(entry?.proveStepMs).toBe(25_000);
      expect(entry?.proveStepFailed).toBe(true);
    });

    it('ignores a non-finite duration rather than poisoning the sum', () => {
      const attempt = beginProveAttempt();
      recordSdkProveStep({ durationMs: Number.NaN, failed: false });
      recordSdkProveStep({ durationMs: Number.POSITIVE_INFINITY, failed: false });
      recordSdkProveStep({ durationMs: 120, failed: false });
      const entry = attempt.record({ path: 'local', durationMs: 500, fellBack: false });

      expect(entry?.proveStepMs).toBe(120);
    });

    it('never throws out of the observation entry point', () => {
      expect(() => recordSdkProveStep({ durationMs: 5, failed: false })).not.toThrow();
    });

    it('closes an attempt a previous test left open, so one suite cannot blind the next', () => {
      beginProveAttempt(); // deliberately never ended, as a leaky test would
      __resetProveTelemetryForTest();

      const attempt = beginProveAttempt();
      recordSdkProveStep({ durationMs: 42, failed: false });
      // With the leaked attempt still open this is an ambiguous two-attempt
      // window and the step is dropped.
      expect(attempt.record({ path: 'local', durationMs: 100, fellBack: false })?.proveStepMs).toBe(42);
    });
  });
});
