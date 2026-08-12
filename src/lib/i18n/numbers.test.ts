import BigNumber from 'bignumber.js';
import i18n from 'i18next';

import {
  toLocalFormat,
  getPluralKey,
  formatBigInt,
  stringToBigInt,
  toLocalFixed,
  toShortened,
  toFixedRoundedDown,
  getAdaptiveDecimalPlaces,
  toAdaptiveFixed,
  formatUsd
} from './numbers';

// `toShortened` delegates the thousand/million/billion labelling to i18next's
// `t()`. In the unit environment i18next is never `init()`-ed, so we mock the
// singleton with a deterministic `t` that echoes its key + interpolation
// object. This lets us assert BOTH the exact format bucket chosen and the
// interpolated (already-localized) value, instead of the `undefined` an
// uninitialized i18next would return. `language` is left `undefined` so that
// `getCurrentLocale()` (used by `getPluralKey`) falls through to the real
// native-locale resolution, exactly as it does in production before init.
jest.mock('i18next', () => ({
  __esModule: true,
  default: {
    t: jest.fn((key: string, opts?: Record<string, unknown>) => `${key}|${opts ? JSON.stringify(opts) : ''}`),
    language: undefined
  }
}));

const mockT = i18n.t as jest.MockedFunction<typeof i18n.t>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('toLocalFormat', () => {
  describe('non-finite input', () => {
    it('returns the NaN symbol for NaN', () => {
      expect(toLocalFormat(NaN, {})).toBe('NaN');
    });

    it('returns the infinity symbol for +Infinity (no minus)', () => {
      expect(toLocalFormat(Infinity, {})).toBe('∞');
    });

    it('prefixes a minus for -Infinity', () => {
      expect(toLocalFormat(-Infinity, {})).toBe('-∞');
    });
  });

  describe('finite input', () => {
    it('uses toFormat(decimalPlaces, roundingMode, format) when both dp and rounding are set', () => {
      expect(toLocalFormat(1234567.891, { decimalPlaces: 2, roundingMode: BigNumber.ROUND_DOWN })).toBe('1,234,567.89');
    });

    it('rounds with the provided rounding mode', () => {
      // ROUND_UP on the 3rd decimal should bump .891 -> .90
      expect(toLocalFormat(1234567.891, { decimalPlaces: 2, roundingMode: BigNumber.ROUND_UP })).toBe('1,234,567.90');
    });

    it('returns the raw (un-localized) result when a custom format is supplied with dp + rounding', () => {
      const format: BigNumber.Format = { decimalSeparator: ',', groupSeparator: '.', groupSize: 3 };
      expect(toLocalFormat(1234567.891, { decimalPlaces: 2, roundingMode: BigNumber.ROUND_DOWN, format })).toBe(
        '1.234.567,89'
      );
    });

    it('uses toFormat(decimalPlaces, format) when dp + format are set (no rounding)', () => {
      const format: BigNumber.Format = { decimalSeparator: ',', groupSeparator: '.', groupSize: 3 };
      expect(toLocalFormat(1234567.891, { decimalPlaces: 2, format })).toBe('1.234.567,89');
    });

    it('uses toFormat(decimalPlaces) when only dp is set, then localizes', () => {
      expect(toLocalFormat(1234567.891, { decimalPlaces: 2 })).toBe('1,234,567.89');
    });

    it('uses toFormat(format) when only a format is set and returns it raw', () => {
      const format: BigNumber.Format = { decimalSeparator: ',', groupSeparator: '.', groupSize: 3 };
      expect(toLocalFormat(1234567.891, { format })).toBe('1.234.567,891');
    });

    it('uses the default toFormat() and localizes a value with a decimal point', () => {
      expect(toLocalFormat(1234567.891, {})).toBe('1,234,567.891');
    });

    it('localizes a whole number (no decimal-point branch)', () => {
      expect(toLocalFormat(1000, {})).toBe('1,000');
    });

    it('accepts string and BigNumber values', () => {
      expect(toLocalFormat('1000', {})).toBe('1,000');
      expect(toLocalFormat(new BigNumber(1000), {})).toBe('1,000');
    });
  });
});

describe('adaptive amount formatting', () => {
  it('keeps two decimal places for ordinary values and zero', () => {
    expect(getAdaptiveDecimalPlaces(12.345)).toBe(2);
    expect(toAdaptiveFixed(12.345)).toBe('12.35');
    expect(toAdaptiveFixed(0)).toBe('0.00');
  });

  it('shows the first two significant fractional places for small values', () => {
    expect(getAdaptiveDecimalPlaces('0.001234')).toBe(4);
    expect(toAdaptiveFixed('0.001234')).toBe('0.0012');
    expect(toAdaptiveFixed('-0.00005678')).toBe('-0.000057');
  });

  it('honours a larger normal precision before adapting', () => {
    // The first non-zero digit already fits inside the requested 4dp, so the
    // larger normal precision is kept as-is.
    expect(getAdaptiveDecimalPlaces('0.0001234', 4)).toBe(4);
    expect(toAdaptiveFixed('1.23456', 4)).toBe('1.2346');
    // Only once the value is small enough to vanish at 4dp does it adapt.
    expect(getAdaptiveDecimalPlaces('0.00001234', 4)).toBe(6);
    expect(toAdaptiveFixed('0.00001234', 4)).toBe('0.000012');
  });

  it('preserves non-finite BigNumber output', () => {
    expect(toAdaptiveFixed(NaN)).toBe('NaN');
    expect(toAdaptiveFixed(Infinity)).toBe('Infinity');
    expect(toAdaptiveFixed(-Infinity)).toBe('-Infinity');
  });

  it('uses adaptive precision for small USD values while preserving grouping', () => {
    expect(formatUsd(1024.5)).toBe('$1,024.50');
    expect(formatUsd(0.001234)).toBe('$0.0012');
  });
});

describe('getPluralKey', () => {
  it('appends the CLDR plural category for a singular amount', () => {
    expect(getPluralKey('item', 1)).toBe('item_one');
  });

  it('appends the CLDR plural category for a plural amount', () => {
    expect(getPluralKey('item', 2)).toBe('item_other');
  });

  it('reuses the memoized PluralRules instance across calls (cache hit)', () => {
    // First call populates the memo cache; subsequent calls hit the cached path.
    const first = getPluralKey('day', 0);
    const second = getPluralKey('day', 5);
    expect(first).toBe('day_other');
    expect(second).toBe('day_other');
  });
});

describe('formatBigInt', () => {
  it('short-circuits to "0" for a zero amount', () => {
    expect(formatBigInt(BigInt(0))).toBe('0');
  });

  it('formats a whole unit using the default (MIDEN) decimals and trims the trailing dot', () => {
    expect(formatBigInt(BigInt(1_000_000))).toBe('1');
  });

  it('trims trailing zeros in the fractional part', () => {
    expect(formatBigInt(BigInt(1_500_000))).toBe('1.5');
    expect(formatBigInt(BigInt(1_230_000))).toBe('1.23');
  });

  it('prepends a leading zero for a value below one unit', () => {
    expect(formatBigInt(BigInt(123))).toBe('0.000123');
  });

  it('respects an explicit decimals argument', () => {
    expect(formatBigInt(BigInt(250), 2)).toBe('2.5');
  });

  it('falls back to a single zero-pad when decimals is not positive', () => {
    // decimals === 0 => numZeros forced to 1; documents the real (quirky) output.
    expect(formatBigInt(BigInt(5), 0)).toBe('0.05');
  });
});

describe('stringToBigInt', () => {
  it('scales a decimal string by 10^decimals', () => {
    expect(stringToBigInt('1.5', 6)).toBe(BigInt(1_500_000));
  });

  it('rounds to avoid float precision drift', () => {
    expect(stringToBigInt('2.7', 2)).toBe(BigInt(270));
    expect(stringToBigInt('1.005', 2)).toBe(BigInt(100));
  });
});

describe('toLocalFixed', () => {
  it('returns the NaN symbol for NaN', () => {
    expect(toLocalFixed(NaN)).toBe('NaN');
  });

  it('returns the infinity symbol for +Infinity (no minus)', () => {
    expect(toLocalFixed(Infinity)).toBe('∞');
  });

  it('prefixes a minus for -Infinity', () => {
    expect(toLocalFixed(-Infinity)).toBe('-∞');
  });

  it('uses toFixed(decimalPlaces, roundingMode) when decimalPlaces is provided', () => {
    expect(toLocalFixed(1234.5678, 2, BigNumber.ROUND_DOWN)).toBe('1234.56');
  });

  it('uses bare toFixed() when decimalPlaces is omitted', () => {
    expect(toLocalFixed(1234.5)).toBe('1234.5');
  });

  it('localizes an integer value (no decimal point)', () => {
    expect(toLocalFixed(1000)).toBe('1000');
  });
});

describe('toShortened', () => {
  it('formats sub-unit magnitudes to one significant figure', () => {
    expect(toShortened(0.5)).toBe('0.5');
    expect(toShortened(0.0004)).toBe('0.0004');
    expect(toShortened(0)).toBe('0');
    expect(toShortened(-0.5)).toBe('-0.5');
  });

  it('returns a plain fixed value for magnitudes between 1 and 999 (no unit bucket)', () => {
    expect(toShortened(999)).toBe('999');
    // integerValue() rounds half-up before formatting, so 500.7 -> 501.
    expect(toShortened(500.7)).toBe('501');
    expect(mockT).not.toHaveBeenCalled();
  });

  it('uses the thousand bucket and floors to one decimal', () => {
    expect(toShortened(1999)).toBe('thousandFormat|{"thousand":"1.9"}');
    expect(mockT).toHaveBeenCalledWith('thousandFormat', { thousand: '1.9' });
  });

  it('uses the thousand bucket for a multi-thousand value', () => {
    expect(toShortened(12345)).toBe('thousandFormat|{"thousand":"12.3"}');
  });

  it('uses the million bucket', () => {
    expect(toShortened(1_500_000)).toBe('millionFormat|{"million":"1.5"}');
    expect(mockT).toHaveBeenCalledWith('millionFormat', { million: '1.5' });
  });

  it('uses the billion bucket and does not overflow past it', () => {
    expect(toShortened(2_500_000_000)).toBe('billionFormat|{"billion":"2.5"}');
    // Trillions still clamp to the billion bucket (format list is capped).
    expect(toShortened(2_500_000_000_000)).toBe('billionFormat|{"billion":"2500"}');
  });

  it('preserves the sign in a bucketed value', () => {
    expect(toShortened(-1500)).toBe('thousandFormat|{"thousand":"-1.5"}');
  });
});

describe('toFixedRoundedDown', () => {
  it('floors to the requested precision', () => {
    expect(toFixedRoundedDown(1.2399, 2)).toBe('1.23');
  });

  it('pads with trailing zeros to the fixed precision', () => {
    expect(toFixedRoundedDown(1.2, 3)).toBe('1.200');
  });

  it('handles zero precision', () => {
    expect(toFixedRoundedDown(9.99, 0)).toBe('9');
  });
});
