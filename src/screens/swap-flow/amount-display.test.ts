import { swapPayEstimate } from './amount-display';

it.each([
  ['0.040060070075077579', '0.04006007'],
  ['1.000000000000000001', '1'],
  ['0.000000000000000001', '0.000000000000000001'],
  ['0.000000000012345678', '0.000000000012'],
  ['100.25000000', '100.25'],
  ['9007199254740993.123456789', '9007199254740993.12345679']
])('formats %s for display as %s without losing small nonzero values', (exact, display) => {
  expect(swapPayEstimate(exact)).toBe(display);
});
