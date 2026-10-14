import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { ReownConfigureOptions } from './native';

let snapshot: BridgeConfigSnapshot;
const configureNative = jest.fn(async (_options: ReownConfigureOptions) => {});

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => snapshot,
  ensureBridgeConfig: async () => snapshot,
  initBridgeConfig: async () => snapshot,
  subscribeBridgeConfig: () => () => {}
}));
jest.mock('lib/remote-config/values', () => ({
  BridgeConfigUnavailableError: class extends Error {}
}));
jest.mock('./native', () => ({
  NativeReown: { configure: (options: ReownConfigureOptions) => configureNative(options) },
  isNativeReownAvailable: () => true
}));

function setChains(ids: number[]) {
  snapshot = {
    network: 'mainnet',
    status: 'ready',
    derived: null,
    lastFetch: null,
    config: {
      network: 'mainnet',
      version: 1,
      features: { earn: false },
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
      supportedEvmChains: Object.fromEntries(ids.map(chainId => [`chain-${chainId}`, { chainId, bridges: {} }]))
    }
  };
}

beforeEach(() => {
  jest.resetModules();
  configureNative.mockClear();
  setChains([8453, 1]);
});

it('updates native proposals when the document changes, with chain metadata', async () => {
  const { configureNativeReown } = await import('./useNativeReown');
  await Promise.all([configureNativeReown(), configureNativeReown()]);
  expect(configureNative).toHaveBeenCalledTimes(1);
  expect(configureNative).toHaveBeenLastCalledWith(
    expect.objectContaining({
      chainIds: [8453, 1],
      chains: expect.arrayContaining([expect.objectContaining({ id: 1, name: 'Ethereum' })])
    })
  );
  setChains([42161]);
  await configureNativeReown();
  expect(configureNative).toHaveBeenLastCalledWith(expect.objectContaining({ chainIds: [42161] }));
});

it('retries a failed native configuration and does not reuse its failed promise', async () => {
  const { configureNativeReown } = await import('./useNativeReown');
  configureNative.mockRejectedValueOnce(new Error('relay unavailable'));
  await expect(configureNativeReown()).rejects.toThrow('relay unavailable');
  await configureNativeReown();
  expect(configureNative).toHaveBeenCalledTimes(2);
});

it('does not configure a native proposal for an empty document', async () => {
  const { configureNativeReown } = await import('./useNativeReown');
  setChains([]);
  await expect(configureNativeReown()).rejects.toThrow();
  expect(configureNative).not.toHaveBeenCalled();
  await configureNativeReown(1);
  expect(configureNative).toHaveBeenLastCalledWith(expect.objectContaining({ chainIds: [1] }));
});

it('offers only remote chains in AppKit and applies later changes in document order', async () => {
  const { modal, prepareAppKitConnection, syncAppKitNetworks } = await import('./appkit');
  await prepareAppKitConnection();
  expect(modal.getCaipNetworks('eip155').map(chain => chain.id)).toEqual([8453, 1]);
  setChains([42161, 8453]);
  await syncAppKitNetworks();
  expect(modal.getCaipNetworks('eip155').map(chain => chain.id)).toEqual([42161, 8453]);
  setChains([]);
  await syncAppKitNetworks();
  expect(modal.getCaipNetworks('eip155')).toEqual([]);
  await expect(prepareAppKitConnection()).rejects.toThrow();
});

it('adds a saved recovery chain to AppKit only until the next ordinary connection', async () => {
  const { modal, prepareAppKitConnection, syncAppKitNetworks } = await import('./appkit');
  setChains([8453]);
  await prepareAppKitConnection(1);
  expect(modal.getCaipNetworks('eip155').map(chain => chain.id)).toEqual([8453, 1]);
  await syncAppKitNetworks();
  expect(modal.getCaipNetworks('eip155').map(chain => chain.id)).toEqual([8453, 1]);
  await prepareAppKitConnection();
  expect(modal.getCaipNetworks('eip155').map(chain => chain.id)).toEqual([8453]);
});
