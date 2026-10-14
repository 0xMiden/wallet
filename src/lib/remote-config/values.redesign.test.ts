import { TEST_BRIDGE_CONFIG_SNAPSHOT, TEST_EARN_MARKET } from 'lib/epoch/testing/bridge-config';

import { getBridgeConfigSnapshot } from './runtime';
import {
  BridgeConfigUnavailableError,
  getEarnMarket,
  getEpochAllocatorUrl,
  getEvmUsdc,
  selectEarnMarket,
  selectEvmUsdc,
  selectMidenUsdcFaucetId
} from './values';

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

it('selects the token and metadata for the requested chain', () => {
  expect(getEvmUsdc(11155111)).toMatchObject({ chainId: 11155111, decimals: 18 });
  expect(selectEvmUsdc(TEST_BRIDGE_CONFIG_SNAPSHOT, 84532)).toBeNull();
  expect(() => getEvmUsdc(84532)).toThrow(BridgeConfigUnavailableError);
});

it('retains configured values when a direction is disabled', () => {
  const snapshot = cloneSnapshot();
  const route = snapshot.config?.supportedEvmChains.sepolia?.bridges.epoch;
  if (!route) throw new Error('The test route is missing');
  route.depositEnabled = false;
  route.withdrawalEnabled = false;
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot);
  expect(getEvmUsdc().chainId).toBe(11155111);
  expect(getEarnMarket()).toEqual(TEST_EARN_MARKET);
});

function cloneSnapshot(): import('./runtime').BridgeConfigSnapshot {
  return JSON.parse(JSON.stringify(TEST_BRIDGE_CONFIG_SNAPSHOT));
}
