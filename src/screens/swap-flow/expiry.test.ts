import {
  EXPIRY_PRESETS,
  isValidExpirySeconds,
  MAX_EXPIRY_SECONDS,
  MIN_EXPIRY_SECONDS,
  presetForSeconds
} from './expiry';

describe('expiry presets', () => {
  it.each([
    [2 * 60, '2m'],
    [60 * 60, '1h'],
    [24 * 60 * 60, '1d'],
    [MAX_EXPIRY_SECONDS, '7d']
  ] as const)('maps the preset seconds %p to the %s preset', (seconds, id) => {
    expect(presetForSeconds(seconds).id).toBe(id);
  });

  it.each([
    [90, '2m'],
    [Number.NaN, '2m'],
    [604800, '7d'],
    [10 ** 9, '7d']
  ] as const)('snaps %p seconds from elsewhere to the closest preset, %s', (seconds, id) => {
    expect(presetForSeconds(seconds).id).toBe(id);
  });

  it('offers only values the flow may submit', () => {
    for (const preset of EXPIRY_PRESETS) expect(isValidExpirySeconds(preset.seconds)).toBe(true);
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
});
