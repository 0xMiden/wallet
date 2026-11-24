import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { BridgeConfig } from 'lib/remote-config/schema';

import { getWalletConnectChains, prepareWalletConnectChains } from './chains';
import { getChain } from './config';

let snapshot: BridgeConfigSnapshot;
const ensure = jest.fn(async () => snapshot);

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => snapshot,
  ensureBridgeConfig: () => ensure()
}));
jest.mock('lib/remote-config/values', () => ({
  BridgeConfigUnavailableError: class extends Error {}
}));

function config(chainIds: number[]): BridgeConfig {
  return {
    network: 'mainnet',
    version: 1,
    features: { earn: false, nearIntents: false },
    'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
    supportedEvmChains: Object.fromEntries(chainIds.map(id => [`chain-${id}`, { chainId: id, bridges: {} }]))
  };
}

beforeEach(() => {
  snapshot = { network: 'mainnet', status: 'ready', config: null, derived: null, lastFetch: null };
  ensure.mockClear();
});

it('uses the remote list and its order for production chains', async () => {
  snapshot.config = config([8453, 1, 42161]);
  expect(getWalletConnectChains().map(chain => chain.id)).toEqual([8453, 1, 42161]);
  expect((await prepareWalletConnectChains()).map(chain => chain.id)).toEqual([8453, 1, 42161]);
  expect(ensure).toHaveBeenCalledTimes(1);
});

it('does not enable a compiled chain when the config is missing or empty', async () => {
  expect(getWalletConnectChains()).toEqual([]);
  await expect(prepareWalletConnectChains()).rejects.toThrow();
  snapshot.config = config([]);
  await expect(prepareWalletConnectChains()).rejects.toThrow();
});

it('ignores unsupported IDs without falling back to a test chain', async () => {
  snapshot.config = config([999999999]);
  await expect(prepareWalletConnectChains()).rejects.toThrow();
});

it('keeps a removed chain available only for an explicit saved-transfer recovery', async () => {
  snapshot.config = config([8453]);
  expect((await prepareWalletConnectChains(1)).map(chain => chain.id)).toEqual([8453, 1]);
  expect(getWalletConnectChains().map(chain => chain.id)).toEqual([8453]);
  expect(getChain(1)?.name).toBe('Ethereum');
  await expect(prepareWalletConnectChains(999999999)).rejects.toThrow();
});

it('can reconnect a saved transfer without a current document', async () => {
  expect((await prepareWalletConnectChains(1)).map(chain => chain.id)).toEqual([1]);
});
