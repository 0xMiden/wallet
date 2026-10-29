import '../../../../test/jest-mocks';

import React, { useEffect } from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET } from 'lib/epoch/testing/bridge-config';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { fetchingAddresses } from 'lib/store/utils/fetchBalances';
import { _resetInteractionPriorityForTest, beginInteraction } from 'lib/ui/interaction-priority';

import { useAllBalances, getAllBalanceSWRKey, type TokenBalanceData } from './balance';

// webextension-polyfill auto-mock causes isExtension() to return true in tests.
// Override to return false so balance hooks use the WASM polling path.
// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: jest.fn(() => false)
}));

// Tests assume the native asset ID is already known — simulates the post-
// discovery steady state. Without this, buildDefaultZeroBalance() returns [].
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => 'miden-faucet-id'),
  // Read by the swap-token registry the placeholder row is priced through.
  getNativeAssetMetadataSync: jest.fn(() => null),
  getSdkSyncedNativeAssetIdSync: jest.fn(() => null),
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
  }),
  fetchingAddresses: new Set<string>()
}));

// The in-flight guard is module state shared by every suite here; a read a test leaves pending would
// otherwise hold its address into the next test.
beforeEach(() => {
  fetchingAddresses.clear();
  useWalletStore.setState({ storageAvailability: { status: 'healthy', epoch: 0 } });
  jest.mocked(getNativeAssetIdSync).mockImplementation(() => 'miden-faucet-id');
});

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

  it('useAllBalances returns an empty array before native asset discovery', async () => {
    jest.mocked(getNativeAssetIdSync).mockImplementation(() => null);
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

  it('keeps prior balances when fetchBalances returns null (WASM-busy skip)', async () => {
    const fetchBalancesMock = jest.requireMock('lib/store/utils/fetchBalances').fetchBalances as jest.Mock;
    fetchBalancesMock.mockClear();
    // The read was skipped mid-fetch (lock became busy) — fetchBalances resolves null.
    fetchBalancesMock.mockResolvedValueOnce(null);

    // Seed a prior balance; it must survive the skipped refresh.
    useWalletStore.setState({
      balances: {
        'null-skip-address': [
          {
            tokenId: 't',
            tokenSlug: 'T',
            metadata: { name: 'T', symbol: 'T', decimals: 8 },
            balance: 7,
            fiatPrice: 1,
            change24h: 0
          }
        ]
      }
    });

    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    const BalanceConsumer = () => {
      const { data } = useAllBalances('null-skip-address', {});
      return <div data-count={data.length} />;
    };

    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
    });

    expect(fetchBalancesMock).toHaveBeenCalled();
    // The null return short-circuits before setState, so the prior balance stays.
    expect(useWalletStore.getState().balances['null-skip-address']).toHaveLength(1);
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

  it('returns default 0 native balance instantly before any async IndexedDB lookup', async () => {
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

    // Verify: on first render, we get the default zero native row immediately
    // (the native-asset mock above pretends discovery is already complete).
    // This happens BEFORE fetchBalances is called.
    expect(firstRenderData).not.toBeNull();
    expect(firstRenderData.data).toHaveLength(1);
    expect(firstRenderData.data[0].tokenSlug).toBe('USDCX');
    expect(firstRenderData.data[0].metadata.scaleIsUnknown).toBe(true);
    expect(firstRenderData.data[0].balance).toBe(0);
    // isLoading should be true since we haven't fetched yet
    expect(firstRenderData.isLoading).toBe(true);
  });

  it('prices the placeholder row by its faucet, never by the USDCX symbol (#1131)', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    fetchBalancesMock.mockImplementation(() => new Promise(() => {}));
    let rows: TokenBalanceData[] = [];
    const BalanceConsumer = () => {
      rows = useAllBalances('placeholder-price-address', {}).data;
      return null;
    };

    useWalletStore.setState({ tokenPrices: {} });
    await act(async () => {
      testRoot!.render(<BalanceConsumer />);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenSlug: 'USDCX', fiatPrice: 0, change24h: 0 });

    await act(async () => {
      useWalletStore.setState({ tokenPrices: { USDCX: { price: 2, change24h: 0.5, percentageChange24h: 1 } } });
    });
    expect(rows[0]).toMatchObject({ tokenSlug: 'USDCX', fiatPrice: 0, change24h: 0 });
  });

  it("gives the placeholder row its faucet's quote when that faucet is priced", async () => {
    jest.mocked(getNativeAssetIdSync).mockImplementation(() => MIDEN_USDC_FAUCET);
    try {
      testContainer = document.createElement('div');
      testRoot = createRoot(testContainer);
      fetchBalancesMock.mockImplementation(() => new Promise(() => {}));
      let rows: TokenBalanceData[] = [];
      const BalanceConsumer = () => {
        rows = useAllBalances('placeholder-priced-faucet-address', {}).data;
        return null;
      };

      useWalletStore.setState({ tokenPrices: {} });
      await act(async () => {
        testRoot!.render(<BalanceConsumer />);
      });
      expect(rows[0]).toMatchObject({ tokenId: MIDEN_USDC_FAUCET, fiatPrice: 0, change24h: 0 });

      await act(async () => {
        useWalletStore.setState({ tokenPrices: { USDC: { price: 2, change24h: 0.5, percentageChange24h: 1 } } });
      });
      expect(rows[0]).toMatchObject({ tokenId: MIDEN_USDC_FAUCET, fiatPrice: 2, change24h: 0.5 });
    } finally {
      jest.mocked(getNativeAssetIdSync).mockImplementation(() => 'miden-faucet-id');
    }
  });

  // A reader with an effect on the rows, such as Send's amount check, re-renders forever on a new array per render.
  it('keeps one placeholder across renders until the prices or the native metadata change', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    fetchBalancesMock.mockImplementation(() => new Promise(() => {}));
    let rows: TokenBalanceData[] = [];
    const BalanceConsumer = ({ pass }: { pass: number }) => {
      rows = useAllBalances('placeholder-identity-address', {}).data;
      return <div data-pass={pass} />;
    };

    useWalletStore.setState({ tokenPrices: {} });
    await act(async () => {
      testRoot!.render(<BalanceConsumer pass={1} />);
    });
    const first = rows;
    await act(async () => {
      testRoot!.render(<BalanceConsumer pass={2} />);
    });
    expect(rows).toBe(first);

    await act(async () => {
      useWalletStore.setState({ tokenPrices: { ETH: { price: 2, change24h: 0.5, percentageChange24h: 1 } } });
    });
    const repriced = rows;
    expect(repriced).not.toBe(first);
    expect(repriced).toEqual(first);

    // The chain's own record of the native faucet: only the scale flag differs from the provisional metadata.
    jest.mocked(getNativeAssetMetadataSync).mockImplementation(() => ({ symbol: 'USDCX', decimals: 6 }));
    try {
      await act(async () => {
        testRoot!.render(<BalanceConsumer pass={3} />);
      });
      expect(rows).not.toBe(repriced);
      expect(rows[0]).toMatchObject({ tokenId: 'miden-faucet-id', balance: 0 });
      expect(rows[0]!.metadata).toEqual({ ...repriced[0]!.metadata, scaleIsUnknown: false });
    } finally {
      jest.mocked(getNativeAssetMetadataSync).mockImplementation(() => null);
    }
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

describe('the first read for an address (#1123)', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;
  const fetchBalancesMock = () => jest.requireMock('lib/store/utils/fetchBalances').fetchBalances as jest.Mock;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    consoleErrorSpy.mockRestore();
  });

  beforeEach(() => {
    useWalletStore.setState({ balances: {}, balancesLoading: {}, balancesLastFetched: {}, assetsMetadata: {} });
    fetchBalancesMock().mockReset();
    fetchBalancesMock().mockResolvedValue([]);
  });

  afterEach(() => {
    if (testRoot) {
      testRoot.unmount();
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  const mount = async (address: string, onRender?: (isLoading: boolean) => void) => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);
    const Consumer = () => {
      const { isLoading } = useAllBalances(address, {});
      onRender?.(isLoading);
      return <div />;
    };
    await act(async () => {
      testRoot!.render(<Consumer />);
    });
  };

  it('queues for the WASM lock while the address has no balances', async () => {
    await mount('fresh-address');

    expect(fetchBalancesMock()).toHaveBeenCalledWith(
      'fresh-address',
      expect.anything(),
      expect.objectContaining({ waitForLock: true })
    );
  });

  it('stores a first read that lands after its component unmounted', async () => {
    // Every other reader skipped the address in favour of this read, so dropping it would leave
    // Home with no read at all until the next poll tick.
    const row = {
      tokenId: 't',
      tokenSlug: 'T',
      metadata: { name: 'T', symbol: 'T', decimals: 8 },
      balance: 7,
      fiatPrice: 1,
      change24h: 0
    };
    let land!: (rows: (typeof row)[]) => void;
    fetchBalancesMock().mockImplementation(() => new Promise(resolve => (land = resolve)));

    await mount('unmounted-address');
    await act(async () => {
      testRoot!.unmount();
    });
    testRoot = null;
    await act(async () => {
      land([row]);
      await Promise.resolve();
    });

    expect(useWalletStore.getState().balances['unmounted-address']).toEqual([row]);
    expect(useWalletStore.getState().balancesLoading['unmounted-address']).toBe(false);
  });

  it('does not queue a second read behind a Ready-time read that is still in flight', async () => {
    // The import path: the store's Ready-time read is queued, then Home mounts before it lands.
    fetchBalancesMock().mockImplementation(() => new Promise(() => {}));
    const account = { publicKey: 'import-address', name: 'Account 1', isPublic: true, hdIndex: 0 };
    useWalletStore.setState({ status: WalletStatus.Locked });
    useWalletStore.getState().syncFromBackend({
      status: WalletStatus.Ready,
      storageAvailability: { status: 'healthy', epoch: 0 },
      accounts: [account],
      currentAccount: account,
      networks: [],
      settings: { contacts: [] },
      ownMnemonic: true
    } as any);

    await mount('import-address');

    expect(fetchBalancesMock()).toHaveBeenCalledTimes(1);
  });

  it('does not ask a refresh to wait once the address has balances', async () => {
    useWalletStore.setState({
      balances: {
        'known-address': [
          {
            tokenId: 't',
            tokenSlug: 'T',
            metadata: { name: 'T', symbol: 'T', decimals: 8 },
            balance: 7,
            fiatPrice: 1,
            change24h: 0
          }
        ]
      }
    });

    await mount('known-address');

    expect(fetchBalancesMock()).toHaveBeenCalledWith(
      'known-address',
      expect.anything(),
      expect.objectContaining({ waitForLock: false })
    );
  });

  it('stays loading after a first read fails, and a later tick reads again', async () => {
    jest.useFakeTimers();
    try {
      let lastIsLoading: boolean | undefined;
      fetchBalancesMock().mockRejectedValueOnce(new Error('evicted'));

      await mount('failing-address', isLoading => (lastIsLoading = isLoading));
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetchBalancesMock()).toHaveBeenCalledTimes(1);
      expect(lastIsLoading).toBe(true);
      expect(useWalletStore.getState().balancesLoading['failing-address']).toBeUndefined();

      // The poll interval is 5s; the failed read took no dedupe slot, so the next tick reads.
      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
      });
      expect(fetchBalancesMock()).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('poll ticks while the Home pager is moving', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      _resetInteractionPriorityForTest();
    });
    afterEach(() => {
      _resetInteractionPriorityForTest();
      jest.useRealTimers();
    });

    const mountSettled = async (address: string) => {
      await mount(address);
      await act(async () => {
        await Promise.resolve();
      });
      fetchBalancesMock().mockClear();
      // The mount read took a dedupe slot; let the next tick read.
      useWalletStore.setState({ balancesLastFetched: {} });
    };

    it('reads on the tick when idle', async () => {
      await mountSettled('idle-address');
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      expect(fetchBalancesMock()).toHaveBeenCalledTimes(1);
    });

    it('holds the tick read while an interaction is active, then reads once it ends', async () => {
      await mountSettled('busy-address');
      const end = beginInteraction();
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      expect(fetchBalancesMock()).not.toHaveBeenCalled();

      await act(async () => {
        end();
        jest.advanceTimersByTime(50);
      });
      expect(fetchBalancesMock()).toHaveBeenCalledTimes(1);
    });

    it('reads at the cap when the interaction never ends', async () => {
      await mountSettled('held-address');
      // The interaction begins just before the tick, so the 1500 ms cap lands after it.
      await act(async () => {
        jest.advanceTimersByTime(4_000);
      });
      beginInteraction();
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(fetchBalancesMock()).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(fetchBalancesMock()).toHaveBeenCalledTimes(1);
    });

    it('skips a deferred tick when sync was paused during the wait', async () => {
      await mountSettled('paused-address');
      const end = beginInteraction();
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__ = true;
      process.env.MIDEN_E2E_TEST = 'true';
      try {
        await act(async () => {
          end();
          jest.advanceTimersByTime(50);
        });
        expect(fetchBalancesMock()).not.toHaveBeenCalled();
      } finally {
        delete (globalThis as { __TEST_SYNC_PAUSED__?: boolean }).__TEST_SYNC_PAUSED__;
        delete process.env.MIDEN_E2E_TEST;
      }
    });

    it('does not read after unmount when the tick was deferred', async () => {
      await mountSettled('gone-address');
      const end = beginInteraction();
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      testRoot!.unmount();
      testRoot = null;
      await act(async () => {
        end();
        jest.advanceTimersByTime(50);
      });
      expect(fetchBalancesMock()).not.toHaveBeenCalled();
    });

    it('does not fetch the previous address when the address changes during a deferred tick', async () => {
      testContainer = document.createElement('div');
      testRoot = createRoot(testContainer);
      const Consumer = ({ address }: { address: string }) => {
        useAllBalances(address, {});
        return <div />;
      };
      await act(async () => {
        testRoot!.render(<Consumer address="first-address" />);
      });
      await act(async () => {
        await Promise.resolve();
      });
      fetchBalancesMock().mockClear();
      useWalletStore.setState({ balancesLastFetched: {} });

      await act(async () => {
        jest.advanceTimersByTime(4_000);
      });
      const end = beginInteraction();
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(fetchBalancesMock()).not.toHaveBeenCalled();

      await act(async () => {
        testRoot!.render(<Consumer address="second-address" />);
      });
      expect(fetchBalancesMock()).toHaveBeenCalledWith('second-address', expect.anything(), expect.anything());

      await act(async () => {
        end();
        jest.advanceTimersByTime(50);
      });
      expect(fetchBalancesMock()).not.toHaveBeenCalledWith('first-address', expect.anything(), expect.anything());
    });
  });

  it('stays loading when the read is skipped by the fuse', async () => {
    let lastIsLoading: boolean | undefined;
    fetchBalancesMock().mockResolvedValue(null);

    await mount('fused-address', isLoading => (lastIsLoading = isLoading));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(fetchBalancesMock()).toHaveBeenCalled();
    expect(lastIsLoading).toBe(true);
    expect(useWalletStore.getState().balances['fused-address']).toBeUndefined();
  });
});
