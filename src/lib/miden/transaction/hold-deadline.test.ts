import { formatHoldDeadline } from './hold-deadline';

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
