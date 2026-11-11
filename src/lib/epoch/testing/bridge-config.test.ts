import { act, renderHook } from '@testing-library/react';

import { type BridgeConfigSnapshot, initBridgeConfig, subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

import { publishMockBridgeSnapshot, TEST_BRIDGE_CONFIG_SNAPSHOT } from './bridge-config';

let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
});

// Guards on the overrides `remoteConfigRuntimeMock` makes; each fails when its override is removed.
describe('remoteConfigRuntimeMock', () => {
  it('starts no config fetch from initBridgeConfig and resolves to the snapshot read', async () => {
    const savedFetch = global.fetch;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    try {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      renderHook(() => useBridgeConfigSnapshot());
      const loaded = await initBridgeConfig();
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(loaded).toBe(TEST_BRIDGE_CONFIG_SNAPSHOT);
    } finally {
      global.fetch = savedFetch;
    }
  });

  it('tells a subscriber once per publish, and none after it unsubscribes', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeBridgeConfig(listener);

    publishMockBridgeSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishMockBridgeSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('remoteConfigValuesMock', () => {
  it('selects from its snapshot argument and does not expose the removed account finder', () => {
    const { remoteConfigValuesMock, TEST_ALLOCATOR_URL, TEST_ALLOCATOR_ACCOUNT } =
      jest.requireActual<typeof import('./bridge-config')>('./bridge-config');
    const values = remoteConfigValuesMock(() => ({ ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null }));

    expect(values.selectEpochAllocator(TEST_BRIDGE_CONFIG_SNAPSHOT)).toEqual({
      allocatorUrl: TEST_ALLOCATOR_URL,
      accountId: TEST_ALLOCATOR_ACCOUNT
    });
    expect(values).not.toHaveProperty('findEpochAllocatorAccount');
  });
});
