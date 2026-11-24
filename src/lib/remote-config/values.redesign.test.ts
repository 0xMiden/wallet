import { TEST_BRIDGE_CONFIG_SNAPSHOT, TEST_EARN_MARKET } from 'lib/epoch/testing/bridge-config';

import { getBridgeConfigSnapshot } from './runtime';
import { getEarnMarket, getEpochAllocatorUrl, selectEarnMarket, selectMidenUsdcFaucetId } from './values';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));

beforeEach(() => jest.mocked(getBridgeConfigSnapshot).mockReturnValue(cloneSnapshot()));

it('uses the market returned by Epoch rather than a document protocol name', () => {
  expect(getEarnMarket()).toEqual(TEST_EARN_MARKET);
  expect(selectEarnMarket({ ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null })).toBeNull();
});

it('reads the named testnet output and provider service', () => {
  expect(selectMidenUsdcFaucetId(TEST_BRIDGE_CONFIG_SNAPSHOT)).toBe('0x537c15a622074e91188aa894456c52');
  expect(getEpochAllocatorUrl()).toBe('https://allocator.test');
});

it('retains configured values when a direction is disabled', () => {
  const snapshot = cloneSnapshot();
  const route = snapshot.config?.supportedEvmChains.sepolia?.bridges.epoch;
  if (!route) throw new Error('The test route is missing');
  route.depositEnabled = false;
  route.withdrawalEnabled = false;
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot);
  expect(getEarnMarket()).toEqual(TEST_EARN_MARKET);
});

function cloneSnapshot(): import('./runtime').BridgeConfigSnapshot {
  return JSON.parse(JSON.stringify(TEST_BRIDGE_CONFIG_SNAPSHOT));
}
