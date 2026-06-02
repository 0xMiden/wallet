import '../../../../test/jest-mocks';

import React, { useEffect } from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { useWalletStore } from 'lib/store';

import { useAllBalances, getAllBalanceSWRKey } from './balance';

// webextension-polyfill auto-mock causes isExtension() to return true in tests.
// Override to return false so balance hooks use the WASM polling path.
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: jest.fn(() => false)
}));

// Tests assume the native asset ID is already known — simulates the post-
// discovery steady state. Without this, buildDefaultZeroBalance() returns [].
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => 'miden-faucet-id'),
  getNativeAssetId: jest.fn(async () => 'miden-faucet-id'),
  primeNativeAssetId: jest.fn(),
  onNativeAssetChanged: jest.fn(() => () => {}),
  resetNativeAssetCache: jest.fn(async () => {})
}));

// Track concurrent calls to detect WASM client abuse
let concurrentCalls = 0;
let maxConcurrentCalls = 0;

// Mock fetchBalances to track concurrent calls
jest.mock('lib/store/utils/fetchBalances', () => ({
  fetchBalances: jest.fn(async () => {
    concurrentCalls++;
    maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
    // Simulate async delay
    await new Promise(resolve => setTimeout(resolve, 50));
    concurrentCalls--;
    return [];
  })
}));

describe('useAllBalances infinite loop protection', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  beforeEach(() => {
    // Reset store state before each test
    useWalletStore.setState({
      balances: {},
      balancesLoading: {},
      balancesLastFetched: {},
      assetsMetadata: {}
    });
    // Reset concurrent call tracking
    concurrentCalls = 0;
    maxConcurrentCalls = 0;
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup React root to prevent cross-test pollution
    if (testRoot) {
      testRoot.unmount();
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('useAllBalances should not cause infinite re-renders', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    let renderCount = 0;
    const MAX_RENDERS = 10;

    const BalanceConsumer = () => {
      const { data } = useAllBalances('test-address-1', {});

      useEffect(() => {
        renderCount++;
        if (renderCount > MAX_RENDERS) {
          throw new Error(`Infinite loop detected: useAllBalances caused ${renderCount} renders`);
        }
      });

      return <div data-balance-count={data.length} />;
    };

    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });

    // Allow a few renders for initial mount and effects, but not too many
    expect(renderCount).toBeLessThan(MAX_RENDERS);
  });

  it('useAllBalances should return empty array when no balances exist without crashing', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    let finalData: any = null;

    const BalanceConsumer = () => {
      const { data } = useAllBalances('test-address-2', {});
      finalData = data;
      return <div data-length={data.length} />;
    };

    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });

    // Wait for effects to settle
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // Should return an empty array, not undefined or null
    expect(Array.isArray(finalData)).toBe(true);
    expect(finalData.length).toBe(0);
  });

  it('useAllBalances should not re-render infinitely when tokenMetadatas changes', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    let renderCount = 0;
    const MAX_RENDERS = 15;

    // Component that passes new tokenMetadatas object on each render
    const BalanceConsumerWithChangingMetadata = () => {
      // This creates a new object reference each render - the old bug would cause infinite loop
      const tokenMetadatas = { token1: { name: 'Test', symbol: 'TST', decimals: 18 } };
      const { data } = useAllBalances('test-address-3', tokenMetadatas);

      useEffect(() => {
        renderCount++;
        if (renderCount > MAX_RENDERS) {
          throw new Error(`Infinite loop detected: ${renderCount} renders with changing tokenMetadatas`);
        }
      });

      return <div data-balance-count={data.length} />;
    };

    await act(async () => {
      testRoot!.render(<BalanceConsumerWithChangingMetadata />);
    });

    // Wait for effects to settle
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    expect(renderCount).toBeLessThan(MAX_RENDERS);
  });

  it('useAllBalances should stabilize after store updates', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    let renderCount = 0;

    const BalanceConsumer = () => {
      const { data } = useAllBalances('test-address-4', {});
      renderCount++;
      return <div data-balance-count={data.length} />;
    };

    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });

    const initialCount = renderCount;

    // Simulate store update with balances
    await act(async () => {
      useWalletStore.setState({
        balances: {
          'test-address-4': [
            {
              tokenId: 't1',
              tokenSlug: 'test',
              metadata: { name: 'Test', symbol: 'T', decimals: 18 },
              balance: 100,
              fiatPrice: 1,
              change24h: 0
            }
          ]
        }
      });
    });

    // Should have rendered a few more times, but not infinitely
    expect(renderCount - initialCount).toBeLessThan(5);
  });

  it('multiple components should not trigger concurrent fetches for same address', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Multiple components using useAllBalances with the same address
    const BalanceConsumer1 = () => {
      const { data } = useAllBalances('same-address-5', {});
      return <div data-id="1" data-count={data.length} />;
    };

    const BalanceConsumer2 = () => {
      const { data } = useAllBalances('same-address-5', {});
      return <div data-id="2" data-count={data.length} />;
    };

    const BalanceConsumer3 = () => {
      const { data } = useAllBalances('same-address-5', {});
      return <div data-id="3" data-count={data.length} />;
    };

    await act(async () => {
      testRoot!.render(
        <>
          <BalanceConsumer1 />
          <BalanceConsumer2 />
          <BalanceConsumer3 />
        </>
      );
    });

    // Wait for fetches to complete
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    // Should never have more than 1 concurrent call for the same address
    // This prevents "recursive use of an object" errors in WASM client
    expect(maxConcurrentCalls).toBeLessThanOrEqual(1);
  });
});

describe('instant balance loading', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let fetchBalancesMock: jest.Mock;
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  beforeEach(() => {
    // Reset store state - no cached balances
    useWalletStore.setState({
      balances: {},
      balancesLoading: {},
      balancesLastFetched: {},
      assetsMetadata: {}
    });
    fetchBalancesMock = jest.requireMock('lib/store/utils/fetchBalances').fetchBalances;
    fetchBalancesMock.mockClear();
  });

  afterEach(() => {
    // Cleanup React root to prevent cross-test pollution
    if (testRoot) {
      testRoot.unmount();
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  it('returns default 0 MIDEN balance instantly before any async IndexedDB lookup', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Track data captured on first synchronous render
    let firstRenderData: any = null;
    let fetchStarted = false;

    // Override mock to track when fetch starts
    fetchBalancesMock.mockImplementation(async () => {
      fetchStarted = true;
      // Simulate slow IndexedDB read
      await new Promise(resolve => setTimeout(resolve, 500));
      return [
        {
          tokenId: 'miden-faucet-id',
          tokenSlug: 'MIDEN',
          metadata: { name: 'Miden', symbol: 'MIDEN', decimals: 8 },
          fiatPrice: 1,
          balance: 100
        }
      ];
    });

    const BalanceConsumer = () => {
      const { data, isLoading } = useAllBalances('new-address-instant', {});

      // Capture first render data before any async effects
      if (firstRenderData === null) {
        firstRenderData = { data: [...data], isLoading, fetchStarted };
      }

      return <div data-balance={data[0]?.balance ?? 'none'} />;
    };

    // Render synchronously - first render should have data immediately
    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });

    // Verify: on first render, we get the default zero MIDEN row immediately
    // (the native-asset mock above pretends discovery is already complete).
    // This happens BEFORE fetchBalances is called.
    expect(firstRenderData).not.toBeNull();
    expect(firstRenderData.data).toHaveLength(1);
    expect(firstRenderData.data[0].tokenSlug).toBe('MIDEN');
    expect(firstRenderData.data[0].balance).toBe(0);
    // isLoading should be true since we haven't fetched yet
    expect(firstRenderData.isLoading).toBe(true);
  });

  it('transitions from default 0 to actual balance after fetch completes', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Pre-populate with actual balances to test the transition
    const uniqueAddress = 'test-address-transition-' + Date.now();

    // First verify no cached balances exist
    expect(useWalletStore.getState().balances[uniqueAddress]).toBeUndefined();

    // Track balances at each render
    const capturedBalances: number[] = [];

    const BalanceConsumer = () => {
      const { data } = useAllBalances(uniqueAddress, {});
      capturedBalances.push(data[0]?.balance ?? -1);
      return <div>{data[0]?.balance}</div>;
    };

    // Render the component
    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });

    // First render should show 0 MIDEN (default before any fetch)
    expect(capturedBalances[0]).toBe(0);

    // Simulate the store being updated (as would happen after IndexedDB read)
    await act(async () => {
      useWalletStore.setState(state => ({
        balances: {
          ...state.balances,
          [uniqueAddress]: [
            {
              tokenId: 'miden-faucet-id',
              tokenSlug: 'MIDEN',
              metadata: { name: 'Miden', symbol: 'MIDEN', decimals: 8 },
              fiatPrice: 1,
              balance: 42,
              change24h: 0
            }
          ]
        },
        balancesLastFetched: {
          ...state.balancesLastFetched,
          [uniqueAddress]: Date.now()
        }
      }));
    });

    // After store update, balance should reflect new value
    expect(capturedBalances[capturedBalances.length - 1]).toBe(42);
  });

  it('uses cached balance from store if available instead of default', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    // Pre-populate store with cached balance (simulating data loaded from IndexedDB on previous session)
    useWalletStore.setState({
      balances: {
        'cached-address-instant': [
          {
            tokenId: 'miden-faucet-id',
            tokenSlug: 'MIDEN',
            metadata: { name: 'Miden', symbol: 'MIDEN', decimals: 8 },
            fiatPrice: 1,
            balance: 999,
            change24h: 0
          }
        ]
      },
      balancesLastFetched: {
        'cached-address-instant': Date.now() // Recently fetched, so no new fetch needed
      }
    });

    let firstRenderBalance: number | undefined;

    const BalanceConsumer = () => {
      const { data, isLoading } = useAllBalances('cached-address-instant', {});

      if (firstRenderBalance === undefined) {
        firstRenderBalance = data[0]?.balance;
      }

      return <div data-loading={isLoading}>{data[0]?.balance}</div>;
    };

    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });

    // Should immediately show cached balance, not default 0
    expect(firstRenderBalance).toBe(999);
    // fetchBalances should not be called since we have recent data
    expect(fetchBalancesMock).not.toHaveBeenCalled();
  });
});

describe('getAllBalanceSWRKey', () => {
  it('returns correctly formatted SWR key', () => {
    const key = getAllBalanceSWRKey('test-address-123');
    expect(key).toBe('allBalance_test-address-123');
  });

  it('handles different address formats', () => {
    expect(getAllBalanceSWRKey('0xabc123')).toBe('allBalance_0xabc123');
    expect(getAllBalanceSWRKey('')).toBe('allBalance_');
    expect(getAllBalanceSWRKey('very-long-address-string-here')).toBe('allBalance_very-long-address-string-here');
  });
});
