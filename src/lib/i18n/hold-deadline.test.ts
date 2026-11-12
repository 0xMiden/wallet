import { formatHoldCountdown, formatHoldDeadline, holdSecondsLeft } from './hold-deadline';

// 2026-03-10 12:00:00 UTC.
const NOON = Date.UTC(2026, 2, 10, 12);
const inSec = (ms: number): number => Math.floor(ms / 1000);

describe('formatHoldDeadline (#2060)', () => {
  it.each([
    ['a whole-hour zone', 'Europe/Warsaw', /^13:18:00 GMT\+1$/],
    ['a half-hour zone', 'Asia/Kolkata', /^17:48:00 GMT\+5:30$/],
    ['a zone behind UTC', 'America/New_York', /^08:18:00 GMT-4$/]
  ])('names the offset in %s', (_label, timeZone, expected) => {
    expect(formatHoldDeadline(inSec(NOON + 1_080_000), { locale: 'en-GB', timeZone, nowMs: NOON })).toMatch(expected);
  });

  // Each hold starts before the change and clears after it, so the deadline's offset is not the one in force at `now`.
  it.each([
    ['clocks going forward', 'Europe/Warsaw', Date.UTC(2026, 2, 29, 0, 50), /^03:08:00 GMT\+2$/],
    ['clocks going back', 'America/New_York', Date.UTC(2026, 10, 1, 5, 50), /^01:08:00 GMT-5$/],
    [
      'clocks going back in a half-hour zone',
      'Australia/Adelaide',
      Date.UTC(2026, 3, 4, 16, 20),
      /^02:08:00 GMT\+9:30$/
    ]
  ])('names the offset at the deadline across %s', (_label, timeZone, nowMs, expected) => {
    expect(formatHoldDeadline(inSec(nowMs + 1_080_000), { locale: 'en-GB', timeZone, nowMs })).toMatch(expected);
  });

  it('follows the wallet locale, in the form the wallet stores it', () => {
    const formatted = formatHoldDeadline(inSec(NOON), { locale: 'zh_CN', timeZone: 'Asia/Shanghai', nowMs: NOON });

    expect(formatted).toContain('20:00:00');
    expect(formatted).toContain('GMT+8');
  });

  it('adds the date only when the deadline falls on another day in that zone', () => {
    const lateEvening = Date.UTC(2026, 2, 10, 23, 55);
    const pastMidnight = inSec(lateEvening + 1_080_000);

    expect(formatHoldDeadline(pastMidnight, { locale: 'en-GB', timeZone: 'UTC', nowMs: lateEvening })).toContain('Mar');
    expect(
      formatHoldDeadline(pastMidnight, { locale: 'en-GB', timeZone: 'Asia/Tokyo', nowMs: lateEvening })
    ).not.toMatch(/Mar/);
  });

  describe('where the runtime predates shortOffset', () => {
    const Native = Intl.DateTimeFormat;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const refuse = (name: string) =>
      jest.spyOn(Intl, 'DateTimeFormat').mockImplementation((locale, options) => {
        if (options?.timeZoneName === 'shortOffset') throw new RangeError(name);
        return new Native(locale, options);
      });

    it('falls back to the short zone name', () => {
      refuse('Value shortOffset out of range');

      expect(formatHoldDeadline(inSec(NOON), { locale: 'en-US', timeZone: 'America/New_York', nowMs: NOON })).toContain(
        'EDT'
      );
    });

    it('rethrows anything that is not that refusal', () => {
      jest.spyOn(Intl, 'DateTimeFormat').mockImplementation((locale, options) => {
        if (options?.timeZoneName === 'shortOffset') throw new TypeError('broken');
        return new Native(locale, options);
      });

      expect(() => formatHoldDeadline(inSec(NOON), { locale: 'en-US', nowMs: NOON })).toThrow(TypeError);
    });
  });
});

describe('the hold countdown (#2060)', () => {
  it('counts whole seconds up, so a hold that has not cleared never reads as zero', () => {
    const clearsAtSec = 1_700_000_000;
    const at = clearsAtSec * 1000;

    expect(holdSecondsLeft(clearsAtSec, at - 1_080_000)).toBe(1080);
    expect(holdSecondsLeft(clearsAtSec, at - 1_001)).toBe(2);
    expect(holdSecondsLeft(clearsAtSec, at - 1_000)).toBe(1);
    expect(holdSecondsLeft(clearsAtSec, at - 1)).toBe(1);
    expect(holdSecondsLeft(clearsAtSec, at)).toBe(0);
    expect(holdSecondsLeft(clearsAtSec, at + 1)).toBeLessThanOrEqual(0);
  });

  it.each([
    [1080, '18:00'],
    [61, '01:01'],
    [60, '01:00'],
    [59, '00:59'],
    [1, '00:01'],
    [3_600, '60:00']
  ])('reads %i seconds as %s', (seconds, expected) => {
    expect(formatHoldCountdown(seconds)).toBe(expected);
  });
});
