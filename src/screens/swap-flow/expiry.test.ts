import {
  bestUnitForSeconds,
  clampExpirySeconds,
  EXPIRY_UNIT_SECONDS,
  expiryBounds,
  isValidExpirySeconds,
  MAX_EXPIRY_SECONDS,
  MIN_EXPIRY_SECONDS,
  secondsToUnitValue,
  unitValueToSeconds
} from './expiry';

describe('expiry bounds', () => {
  it('derives every unit range from the one pair of second bounds', () => {
    expect(expiryBounds('seconds')).toEqual({ min: 30, max: 604800 });
    expect(expiryBounds('minutes')).toEqual({ min: 1, max: 10080 });
    expect(expiryBounds('hours')).toEqual({ min: 1, max: 168 });
    expect(expiryBounds('days')).toEqual({ min: 1, max: 7 });
  });

  it('never offers a floor of zero, even where one whole unit overshoots the minimum', () => {
    // A day is far coarser than the 30s minimum; floor(30 / 86400) would be 0.
    expect(expiryBounds('days').min).toBe(1);
  });

  it('keeps every in-range value inside the real second bounds', () => {
    for (const unit of ['seconds', 'minutes', 'hours', 'days'] as const) {
      const { min, max } = expiryBounds(unit);
      expect(unitValueToSeconds(min, unit)).toBeGreaterThanOrEqual(MIN_EXPIRY_SECONDS);
      expect(unitValueToSeconds(max, unit)).toBeLessThanOrEqual(MAX_EXPIRY_SECONDS);
    }
  });
});

describe('conversion between seconds and a unit', () => {
  it('converts seconds down into whole units', () => {
    expect(secondsToUnitValue(120, 'minutes')).toBe(2);
    expect(secondsToUnitValue(7200, 'hours')).toBe(2);
    expect(secondsToUnitValue(172800, 'days')).toBe(2);
    expect(secondsToUnitValue(120, 'seconds')).toBe(120);
  });

  it('converts whole units back up into seconds', () => {
    expect(unitValueToSeconds(2, 'minutes')).toBe(120);
    expect(unitValueToSeconds(2, 'hours')).toBe(7200);
    expect(unitValueToSeconds(7, 'days')).toBe(MAX_EXPIRY_SECONDS);
  });

  it('round-trips every unit', () => {
    for (const unit of ['seconds', 'minutes', 'hours', 'days'] as const) {
      const seconds = 3 * EXPIRY_UNIT_SECONDS[unit] + (unit === 'seconds' ? 30 : 0);
      expect(unitValueToSeconds(secondsToUnitValue(seconds, unit), unit)).toBe(seconds);
    }
  });

  it('clamps rather than rounding to zero when the unit is coarser than the value', () => {
    // 120 seconds is a rounding-to-zero number of days; the floor catches it.
    expect(secondsToUnitValue(120, 'days')).toBe(1);
    expect(unitValueToSeconds(secondsToUnitValue(120, 'days'), 'days')).toBe(86400);
  });

  it('clamps down at the top of a unit', () => {
    expect(secondsToUnitValue(MAX_EXPIRY_SECONDS * 10, 'days')).toBe(7);
    expect(secondsToUnitValue(MAX_EXPIRY_SECONDS * 10, 'hours')).toBe(168);
  });

  it('falls back to the floor for a value that is not a number at all', () => {
    expect(secondsToUnitValue(Number.NaN, 'minutes')).toBe(1);
    expect(secondsToUnitValue(Number.NaN, 'seconds')).toBe(30);
  });
});

describe('best unit for a stored value', () => {
  it('reopens a stored value in the coarsest unit it divides into', () => {
    expect(bestUnitForSeconds(120)).toBe('minutes');
    expect(bestUnitForSeconds(7200)).toBe('hours');
    expect(bestUnitForSeconds(86400)).toBe('days');
    expect(bestUnitForSeconds(604800)).toBe('days');
  });

  it('keeps seconds for a value no coarser unit divides', () => {
    expect(bestUnitForSeconds(90)).toBe('seconds');
    expect(bestUnitForSeconds(45)).toBe('seconds');
  });

  it('never picks a unit the value is below the floor of', () => {
    // 60s IS a whole minute, and one minute is that unit's floor, so minutes is right.
    expect(bestUnitForSeconds(60)).toBe('minutes');
    expect(bestUnitForSeconds(0)).toBe('seconds');
    expect(bestUnitForSeconds(Number.NaN)).toBe('seconds');
  });
});

describe('validity of a submitted value', () => {
  it('accepts whole seconds inside the range', () => {
    expect(isValidExpirySeconds(MIN_EXPIRY_SECONDS)).toBe(true);
    expect(isValidExpirySeconds(120)).toBe(true);
    expect(isValidExpirySeconds(MAX_EXPIRY_SECONDS)).toBe(true);
  });

  it('refuses empty, zero, negative, fractional and out-of-range values', () => {
    expect(isValidExpirySeconds(Number.NaN)).toBe(false);
    expect(isValidExpirySeconds(0)).toBe(false);
    expect(isValidExpirySeconds(-120)).toBe(false);
    expect(isValidExpirySeconds(1.5)).toBe(false);
    expect(isValidExpirySeconds(MIN_EXPIRY_SECONDS - 1)).toBe(false);
    expect(isValidExpirySeconds(MAX_EXPIRY_SECONDS + 1)).toBe(false);
  });

  it('clamps out-of-range seconds back to the nearest bound', () => {
    expect(clampExpirySeconds(1)).toBe(MIN_EXPIRY_SECONDS);
    expect(clampExpirySeconds(MAX_EXPIRY_SECONDS * 3)).toBe(MAX_EXPIRY_SECONDS);
    expect(clampExpirySeconds(120)).toBe(120);
    expect(clampExpirySeconds(Number.NaN)).toBe(MIN_EXPIRY_SECONDS);
  });
});
