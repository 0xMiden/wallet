import { act, renderHook, waitFor } from '@testing-library/react';

import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import type { ReownConfigureOptions, ReownState } from './native';
import { useNativeReown } from './useNativeReown';

let snapshot: BridgeConfigSnapshot;
const configureNative = jest.fn(async (_options: ReownConfigureOptions) => {});
interface ListenerHandle {
  remove: jest.Mock<Promise<void>, []>;
}
const addListener = jest.fn<Promise<ListenerHandle>, [string, unknown]>();
const getNativeState = jest.fn<Promise<ReownState>, []>(async () => ({
  configured: true,
  connected: false,
  accounts: []
}));
const newHandle = (): ListenerHandle => ({ remove: jest.fn(async () => {}) });

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
  NativeReown: {
    configure: (options: ReownConfigureOptions) => configureNative(options),
    addListener: (event: string, handler: unknown) => addListener(event, handler),
    getState: () => getNativeState()
  },
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
  configureNative.mockReset();
  configureNative.mockResolvedValue(undefined);
  addListener.mockReset();
  addListener.mockImplementation(async () => newHandle());
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

// Static imports: the hook needs the same React copy as the renderer, which the resets above would split.
describe('native listener setup', () => {
  it('removes a listener that registers after a chain-list change cleaned its setup up', async () => {
    const late = newHandle();
    let register: (handle: ListenerHandle) => void = () => {};
    addListener.mockImplementationOnce(() => new Promise(resolve => (register = resolve)));
    const { rerender, unmount } = renderHook(() => useNativeReown());
    await waitFor(() => expect(addListener).toHaveBeenCalledTimes(1));

    setChains([42161]);
    rerender();
    await waitFor(() => expect(addListener).toHaveBeenCalledTimes(3));
    register(late);
    await waitFor(() => expect(late.remove).toHaveBeenCalledTimes(1));

    unmount();
    const live = await Promise.all(addListener.mock.results.slice(1).map(result => result.value));
    live.forEach(handle => expect(handle.remove).toHaveBeenCalledTimes(1));
  });

  it('does not let a refresh that started before a deletion replace that deletion', async () => {
    let onState: (state: ReownState) => void = () => {};
    let releaseStale: (state: ReownState) => void = () => undefined;
    const stale = new Promise<ReownState>(resolve => {
      releaseStale = resolve;
    });
    addListener.mockImplementation(async (event, handler) => {
      if (event === 'stateChanged') onState = handler as typeof onState;
      return newHandle();
    });
    getNativeState.mockReset();
    getNativeState.mockResolvedValue({ configured: true, connected: false, accounts: [] });
    getNativeState.mockImplementationOnce(() => stale);
    const { result } = renderHook(() => useNativeReown());
    await waitFor(() => expect(getNativeState).toHaveBeenCalled());

    await act(() => {
      onState({ configured: true, connected: false, accounts: [] });
    });
    await act(async () => {
      releaseStale({ configured: true, connected: true, accounts: ['0xabc'], address: '0xabc' });
      await stale;
    });

    expect(result.current.state.connected).toBe(false);
  });

  it('clears the error of a failed setup once a later one completes', async () => {
    configureNative.mockRejectedValueOnce(new Error('relay unavailable'));
    setChains([10]);
    const { result, rerender } = renderHook(() => useNativeReown());
    await waitFor(() => expect(result.current.error).toBe('relay unavailable'));

    setChains([8453]);
    rerender();
    await waitFor(() => expect(getNativeState).toHaveBeenCalled());
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
