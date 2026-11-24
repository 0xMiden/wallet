import { reviewedEpochMinimum } from './epoch-send';

jest.mock('./sdk', () => ({}));
jest.mock('./miden-note', () => ({}));
jest.mock('lib/miden/activity', () => ({}));

it.each<[string, number, bigint]>([
  ['1.000000000000000001', 18, 1000000000000000001n],
  ['0.000001', 6, 1n],
  ['12', 0, 12n],
  ['1.230000', 6, 1230000n]
])('preserves exact reviewed decimal %s at scale %s', (value, decimals, expected) => {
  expect(reviewedEpochMinimum(value, decimals)).toBe(expected);
});

it.each(['', '0', '-1', '+1', '1e3', '.1', '1.', '01', ' 1', '1 ', '1.0000001', '0.0000001'])(
  'refuses malformed, nonpositive or rounded reviewed decimal %s',
  value => {
    expect(() => reviewedEpochMinimum(value, 6)).toThrow();
  }
);

it.each([-1, 0.5, NaN, Infinity, 256])('refuses invalid destination scale %s', decimals => {
  expect(() => reviewedEpochMinimum('1', decimals)).toThrow();
});

it('refuses an atomic amount outside uint256 without truncation', () => {
  expect(() => reviewedEpochMinimum((1n << 256n).toString(), 0)).toThrow();
});
