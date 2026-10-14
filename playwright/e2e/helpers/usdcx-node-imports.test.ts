/** @jest-environment node */

jest.mock('lib/remote-config/runtime', () => {
  throw new Error('E2E helpers must not load the wallet configuration runtime');
});

it('loads bridge helper constants without the browser wallet runtime', () => {
  const harness = jest.requireActual<typeof import('./usdcx-constants')>('./usdcx-constants');
  expect(harness.USDCX_DECIMALS).toBe(6);
  expect(harness.USDCX_DESTINATIONS.size).toBe(4);
  expect(harness.minimumUsdcxPayout(5042002, 1_000_000n)).toBe(900_000n);
});
