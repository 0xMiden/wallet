import colorsDefault, { getColorHex, getRandomColor, isColorCode } from './colors';
import { ColorCode } from '../types/colors';

/*
 * `colors.ts` is backed by `tailwind-colors.js`, whose keys are:
 *   primary, grey, blue, yellow, green, red
 * (there is NO `gray` key — so `delete _colors.gray` inside `getRandomColor`
 * is a no-op and `grey` remains in the random pool).
 *
 * The default export IS the internal `_colors` object that every function
 * closes over, which lets us exercise the empty-pool fallback branch by
 * temporarily emptying it (always restored via try/finally).
 */

describe('getColorHex', () => {
  it('returns the hex for a valid color code', () => {
    expect(getColorHex('primary-500')).toBe('#E77537');
    expect(getColorHex('grey-500')).toBe('#818181');
    expect(getColorHex('blue-500')).toBe('#56A1F9');
    expect(getColorHex('green-500')).toBe('#2BA84A');
    expect(getColorHex('red-500')).toBe('#EF4444');
    expect(getColorHex('yellow-500')).toBe('#FEA644');
  });

  it('resolves non-500 shades too', () => {
    expect(getColorHex('primary-50')).toBe('#FFF3EC');
    expect(getColorHex('primary-600')).toBe('#C95A21');
    expect(getColorHex('grey-900')).toBe('#1C1C1C');
  });

  it('throws when the code has no dash', () => {
    expect(() => getColorHex('primary' as ColorCode)).toThrow('Color primary does not exist');
  });

  it('throws when the name part is empty (leading dash)', () => {
    // includes('-500', '-') === true, but split -> ['', '500'] so name is falsy
    expect(() => getColorHex('-500')).toThrow('Color -500 does not exist');
  });

  it('throws when the shade part is empty (trailing dash)', () => {
    // name truthy ('primary'), shade falsy ('') -> hits the !shade branch
    expect(() => getColorHex('primary-')).toThrow('Color primary- does not exist');
  });

  it('throws when the color name is unknown', () => {
    expect(() => getColorHex('purple-500')).toThrow('Color purple does not exist');
  });

  it('throws when the shade is unknown for a known color', () => {
    expect(() => getColorHex('primary-999')).toThrow('Shade 999 does not exist for color primary');
  });
});

describe('isColorCode', () => {
  it('returns true for valid color codes', () => {
    expect(isColorCode('primary-500')).toBe(true);
    expect(isColorCode('grey-25')).toBe(true);
    expect(isColorCode('red-700')).toBe(true);
  });

  it('returns false when the code has no dash', () => {
    expect(isColorCode('primary')).toBe(false);
    expect(isColorCode('')).toBe(false);
  });

  it('returns false when the name part is empty (leading dash)', () => {
    expect(isColorCode('-500')).toBe(false);
  });

  it('returns false when the shade part is empty (trailing dash)', () => {
    expect(isColorCode('primary-')).toBe(false);
  });

  it('returns false for an unknown color name', () => {
    expect(isColorCode('purple-500')).toBe(false);
  });

  it('returns false for an unknown shade of a known color', () => {
    expect(isColorCode('primary-999')).toBe(false);
  });
});

describe('getRandomColor', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the first color for Math.random() === 0', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    // keys order: primary, grey, blue, yellow, green, red -> index 0
    expect(getRandomColor()).toBe('primary-500');
  });

  it('returns a middle color (grey is NOT excluded — delete gray is a no-op)', () => {
    // floor(0.2 * 6) === 1 -> 'grey'
    jest.spyOn(Math, 'random').mockReturnValue(0.2);
    expect(getRandomColor()).toBe('grey-500');
  });

  it('returns the last color for Math.random() close to 1', () => {
    // floor(0.999 * 6) === 5 -> 'red'
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(getRandomColor()).toBe('red-500');
  });

  it('always yields a valid, shade-500 color code', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const result = getRandomColor();
    expect(isColorCode(result)).toBe(true);
    expect(result.endsWith('-500')).toBe(true);
  });

  it('falls back to "primary" when no color names remain', () => {
    // Empty the shared pool so colorNames[...] is undefined -> `?? 'primary'`.
    const saved = { ...colorsDefault };
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      for (const key of Object.keys(colorsDefault)) {
        delete colorsDefault[key];
      }
      expect(getRandomColor()).toBe('primary-500');
    } finally {
      spy.mockRestore();
      Object.assign(colorsDefault, saved);
    }
  });
});

describe('default export', () => {
  it('exposes the full color palette', () => {
    expect(Object.keys(colorsDefault).sort()).toEqual(['blue', 'green', 'grey', 'primary', 'red', 'yellow'].sort());
    expect(colorsDefault.primary!['500']).toBe('#E77537');
  });
});
