/** @jest-environment node */

jest.mock('lib/remote-config/runtime', () => {
  throw new Error('E2E helpers must not load the wallet configuration runtime');
});

jest.mock('lib/miden/activity', () => {
  throw new Error('E2E helpers must not load the wallet activity module, which pulls in the SDK');
});

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  throw new Error('E2E helpers must not load the SDK');
});

it('loads bridge helper constants without the browser wallet runtime', () => {
  const harness = jest.requireActual<typeof import('./usdcx-constants')>('./usdcx-constants');
  expect(harness.USDCX_DECIMALS).toBe(6);
  expect(harness.USDCX_DESTINATIONS.size).toBe(4);
  expect(harness.minimumUsdcxPayout(5042002, 1_000_000n)).toBe(900_000n);
});

// The live L2 bridge-in suite signs the wallet's own executor deposit in Node (usdcx-l2-deposit.ts).
it("loads the wallet's executor-route deposit without the wallet runtime, its activity module or the SDK", () => {
  const executor = jest.requireActual<typeof import('../../../src/lib/usdcx/executor')>(
    '../../../src/lib/usdcx/executor'
  );
  expect(typeof executor.runUsdcxExecutorDeposit).toBe('function');
  expect(typeof executor.encodeExecutorHookData).toBe('function');
});

it('loads the L2 bridge-in deposit helper without the wallet runtime or the SDK', () => {
  const helper = jest.requireActual<typeof import('./usdcx-l2-deposit')>('./usdcx-l2-deposit');
  expect(typeof helper.submitL2Deposit).toBe('function');
});
