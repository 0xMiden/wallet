// Adapted from bridge-portal@cb52c470 src/bridge/providers/xreserve/deposit.test.ts (MIT).
import { getUsdcxExecutorSource } from 'lib/usdcx/constant';
import { buildDepositToRemoteArgs } from 'lib/usdcx/deposit';
import { buildExecutorBurnIntent } from 'lib/usdcx/executor';

jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () =>
  jest.requireActual('lib/bridge/testing/fixtures').referenceSnapshot('testnet') }));
jest.mock('lib/miden/activity', () => ({ updateBridgedReceivePhase: jest.fn() }));
const recipient = `0x${'0'.repeat(64)}` satisfies `0x${string}`;
const account = '0x1111111111111111111111111111111111111111';
function units(amount: string, executor: boolean) {
  return executor ? buildExecutorBurnIntent(amount, getUsdcxExecutorSource(11155111), recipient, account).value :
    buildDepositToRemoteArgs(amount, recipient, 5042002)[0];
}
it.each([false, true])('accepts the exact native asset amount ceiling without rounding (executor=%s)', executor => {
  expect(units('9223372034707.292160', executor)).toBe(9223372034707292160n);
  expect(units('0.000001', executor)).toBe(1n);
});
it.each(['0', '-1', '1.0000001', '9223372034707.292161'])('refuses unsupported direct amount %s instead of truncating or building it', amount => {
  expect(() => units(amount, false)).toThrow();
});
it.each(['0', '-1', '1.0000001', '9223372034707.292161'])('refuses unsupported executor amount %s instead of truncating or building it', amount => {
  expect(() => units(amount, true)).toThrow();
});
