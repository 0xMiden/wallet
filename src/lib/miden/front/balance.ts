import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CONNECTIVITY_STATE_KEY,
  isConnectivitySnapshot,
  type ConnectivityStateSnapshot
} from 'lib/miden/activity/connectivity-state';
import { getNativeDisplayMetadataSync } from 'lib/miden/metadata/native';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { isExtension } from 'lib/platform';
import type { TokenPrices } from 'lib/prices';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { balancePrice } from 'lib/store/utils/balancePrice';
import { fetchingAddresses } from 'lib/store/utils/fetchBalances';
import { whenInteractionIdle } from 'lib/ui/interaction-priority';

import { AssetMetadata } from '../metadata';
import { fetchFromStorage, onStorageChanged } from './storage';
import { isTestSyncPaused } from './test-sync-pause';

export interface TokenBalanceData {
  tokenId: string;
  tokenSlug: string;
  metadata: AssetMetadata;
  balance: number;
  balanceBaseUnits?: string;
  fiatPrice: number;
  change24h: number;
}

const REFRESH_INTERVAL = 5_000;
const DEDUPING_INTERVAL = 10_000;
const EXTENSION_BALANCE_POLL_INTERVAL = 3_000;

interface BalanceReadStatus {
  readFailed: boolean;
  balanceReadInFlight: boolean;
  extensionRetryActive: boolean;
}

const EMPTY_BALANCE_READ_STATUS: BalanceReadStatus = {
  readFailed: false,
  balanceReadInFlight: false,
  extensionRetryActive: false
};

/**
 * Default zero-balance row shown before the first fetch resolves.
 * Built lazily: we only render the placeholder row once the native asset ID
 * has been discovered (cached in memory), otherwise return `[]` and let the
 * loading state drive a skeleton. This avoids flashing a row with the wrong
 * tokenId while discovery is in flight on first install.
 */
function buildDefaultZeroBalance(
  tokenPrices: TokenPrices,
  midenFaucetId: string | null,
  nativeMetadata: AssetMetadata
): TokenBalanceData[] {
  if (!midenFaucetId) return [];
  return [
    {
      tokenId: midenFaucetId,
      tokenSlug: nativeMetadata.symbol,
      metadata: nativeMetadata,
      ...balancePrice(tokenPrices, midenFaucetId, nativeMetadata.symbol),
      balance: 0,
      balanceBaseUnits: '0'
    }
  ];
}

/**
 * useAllBalances - Hook to get all token balances for an account
 *
 * Now uses Zustand store for state management while maintaining
 * the same return signature for backward compatibility.
 */
export function useAllBalances(address: string, tokenMetadatas: Record<string, AssetMetadata>) {
  // Get state and actions from Zustand store
  // Use stable selectors to avoid infinite loops
  const balancesMap = useWalletStore(s => s.balances);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const balancesLoadingMap = useWalletStore(s => s.balancesLoading);
  const balancesLastFetchedMap = useWalletStore(s => s.balancesLastFetched);
  const balanceReadFailed = useWalletStore(s => s.balanceReadFailed[address] ?? false);
  const balanceReadInFlightFromStore = useWalletStore(s => s.balanceReadInFlight[address] ?? false);
  const hasCompletedInitialSync = useWalletStore(s => s.hasCompletedInitialSync);
  const extension = isExtension();
  const [readStatusByAddress, setReadStatusByAddress] = useState<Record<string, BalanceReadStatus>>({});
  const readStatus = readStatusByAddress[address] ?? EMPTY_BALANCE_READ_STATUS;
  const [connectivitySnapshot, setConnectivitySnapshot] = useState<ConnectivityStateSnapshot | null>(null);
  const mounted = useRef(false);
  const extensionRetry = useRef<{ address: string; generation: number; timer?: ReturnType<typeof setTimeout> } | null>(
    null
  );
  const retryGeneration = useRef(0);

  const updateReadStatus = useCallback((targetAddress: string, patch: Partial<BalanceReadStatus>) => {
    setReadStatusByAddress(current => {
      const previous = current[targetAddress] ?? EMPTY_BALANCE_READ_STATUS;
      const next = { ...previous, ...patch };
      if (
        previous.readFailed === next.readFailed &&
        previous.balanceReadInFlight === next.balanceReadInFlight &&
        previous.extensionRetryActive === next.extensionRetryActive
      ) {
        return current;
      }
      return { ...current, [targetAddress]: next };
    });
  }, []);

  // Derive values with stable defaults
  // Show 0 MIDEN immediately before any async lookup completes — only once
  // the native asset ID has been learned, otherwise show `[]` (skeleton).
  const midenFaucetId = getNativeAssetIdSync();
  const { symbol, name, decimals, scaleIsUnknown } = getNativeDisplayMetadataSync();
  // The same array while its inputs hold: Send's amount check sets state in an effect on the rows,
  // so a new array per render loops it until a read lands.
  const defaultZeroBalance = useMemo(
    () => buildDefaultZeroBalance(tokenPrices, midenFaucetId, { symbol, name, decimals, scaleIsUnknown }),
    [tokenPrices, midenFaucetId, symbol, name, decimals, scaleIsUnknown]
  );
  const balances = balancesMap[address] ?? defaultZeroBalance;
  const hasLandedBalances = balancesMap[address] !== undefined;
  const balancesLastFetched = balancesLastFetchedMap[address] ?? 0;
  // Consider loading if: explicitly loading OR never fetched yet
  const balancesLoading = balancesLoadingMap[address] ?? balancesLastFetched === 0;
  const connectivityFailed =
    extension &&
    !readStatus.extensionRetryActive &&
    !hasLandedBalances &&
    Boolean(connectivitySnapshot?.network.active || connectivitySnapshot?.node.active);
  const readFailed = balanceReadFailed || readStatus.readFailed || connectivityFailed;
  const balanceReadInFlight = balanceReadInFlightFromStore || readStatus.balanceReadInFlight;

  useEffect(() => {
    mounted.current = true;
    const mountedAddress = address;
    return () => {
      mounted.current = false;
      const retry = extensionRetry.current;
      if (retry?.address === mountedAddress) {
        clearTimeout(retry.timer);
        extensionRetry.current = null;
      }
    };
  }, [address]);

  useEffect(() => {
    if (!extension) return;
    let active = true;
    let observedChange = false;
    const updateSnapshot = (value: unknown) => {
      if (!active) return;
      setConnectivitySnapshot(isConnectivitySnapshot(value) ? value : null);
    };
    const unsubscribe = onStorageChanged<unknown>(CONNECTIVITY_STATE_KEY, value => {
      observedChange = true;
      updateSnapshot(value);
    });
    void (async () => {
      try {
        await unsubscribe.attached;
        const initialSnapshot = await fetchFromStorage<unknown>(CONNECTIVITY_STATE_KEY);
        if (!observedChange) updateSnapshot(initialSnapshot);
      } catch {
        if (!observedChange) updateSnapshot(null);
      }
    })();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [extension]);

  useEffect(() => {
    if (!hasLandedBalances) return;
    const retry = extensionRetry.current;
    if (retry?.address === address) {
      clearTimeout(retry.timer);
      extensionRetry.current = null;
    }
    updateReadStatus(address, { readFailed: false, balanceReadInFlight: false, extensionRetryActive: false });
  }, [address, hasLandedBalances, updateReadStatus]);

  useEffect(() => {
    if (
      !extension ||
      hasLandedBalances ||
      !hasCompletedInitialSync ||
      readStatus.extensionRetryActive ||
      readStatus.readFailed ||
      connectivityFailed
    ) {
      return;
    }
    // The popup reads miden_sync_data on its own 3-second poll after the forced sync settles.
    const timer = setTimeout(() => {
      if (!mounted.current || useWalletStore.getState().balances[address] !== undefined) return;
      if (extensionRetry.current?.address === address) return;
      updateReadStatus(address, { readFailed: true });
    }, EXTENSION_BALANCE_POLL_INTERVAL);
    return () => clearTimeout(timer);
  }, [
    address,
    connectivityFailed,
    extension,
    hasCompletedInitialSync,
    hasLandedBalances,
    readStatus.extensionRetryActive,
    readStatus.readFailed,
    updateReadStatus
  ]);

  // Use refs for values that shouldn't trigger callback recreation
  const tokenMetadatasRef = useRef(tokenMetadatas);
  // Keep refs in sync
  useEffect(() => {
    tokenMetadatasRef.current = tokenMetadatas;
  }, [tokenMetadatas]);

  // Fetch balances function that respects deduping. The read itself is the store's
  // fetchBalances action, which every reader goes through and which holds the in-flight entry
  // On extension, balances arrive via SyncCompleted broadcast — skip WASM polling
  const fetchBalancesWithDeduping = useCallback(async () => {
    if (isExtension()) return;

    // Another reader already has this address in flight; the action would skip it anyway
    if (fetchingAddresses.has(address)) return;

    // Read current value from store (not ref) to catch updates from prefetch
    const now = Date.now();
    const currentLastFetched = useWalletStore.getState().balancesLastFetched[address] ?? 0;
    if (now - currentLastFetched < DEDUPING_INTERVAL) {
      return;
    }

    try {
      // The action stores what lands, and the shared read outcome, whether or not this component is
      // still mounted: every other reader skipped the address in favour of this read (#1123).
      await useWalletStore.getState().fetchBalances(address, tokenMetadatasRef.current);
    } catch (error) {
      // Loading is left as it was: with nothing read yet, clearing it would show the zero
      // placeholder as a real "$0.00". The next tick retries.
      console.error('Failed to fetch balances:', error);
    }
  }, [address]);

  // Manual mutate function for compatibility
  const mutate = useCallback(() => {
    if (extension) {
      if (extensionRetry.current?.address === address) return Promise.resolve();
      const generation = ++retryGeneration.current;
      extensionRetry.current = { address, generation };
      updateReadStatus(address, { readFailed, balanceReadInFlight: true, extensionRetryActive: true });

      let request: Promise<unknown>;
      try {
        request = getIntercom().request({ type: WalletMessageType.SyncRequest, force: true });
      } catch {
        request = Promise.resolve();
      }

      return request
        .catch(() => undefined)
        .then(() => {
          if (!mounted.current || extensionRetry.current?.generation !== generation) return;
          if (useWalletStore.getState().balances[address] !== undefined) {
            extensionRetry.current = null;
            updateReadStatus(address, {
              readFailed: false,
              balanceReadInFlight: false,
              extensionRetryActive: false
            });
            return;
          }

          const timer = setTimeout(() => {
            if (!mounted.current || extensionRetry.current?.generation !== generation) return;
            const landed = useWalletStore.getState().balances[address] !== undefined;
            extensionRetry.current = null;
            updateReadStatus(address, {
              readFailed: !landed,
              balanceReadInFlight: false,
              extensionRetryActive: false
            });
          }, EXTENSION_BALANCE_POLL_INTERVAL);
          extensionRetry.current = { address, generation, timer };
        });
    }

    // Reset last fetched time to force a refresh
    useWalletStore.setState(state => ({
      balancesLastFetched: { ...state.balancesLastFetched, [address]: 0 }
    }));
    return fetchBalancesWithDeduping();
  }, [address, extension, fetchBalancesWithDeduping, readFailed, updateReadStatus]);

  // Initial fetch and polling
  useEffect(() => {
    // Per run, not per component: an address change re-runs this effect, and a tick the old run
    // deferred must not wake up into the new run's liveness and fetch the old address.
    let live = true;

    // Initial fetch
    fetchBalancesWithDeduping();

    // Set up polling interval. `isTestSyncPaused()` lets an E2E hook quiesce
    // this poll (which contends for the WASM lock every tick) while it does its own
    // single-threaded-WASM read - otherwise the read is livelocked on mobile.
    // No-op in production (tree-shaken).
    const intervalId = setInterval(() => {
      if (live && !isTestSyncPaused()) {
        // The poll's store write re-renders Home; wait out a moving pager (capped).
        void whenInteractionIdle().then(() => {
          if (live && !isTestSyncPaused()) void fetchBalancesWithDeduping();
        });
      }
    }, REFRESH_INTERVAL);

    return () => {
      live = false;
      clearInterval(intervalId);
    };
  }, [fetchBalancesWithDeduping]);

  // Return SWR-compatible shape for backward compatibility
  return {
    data: balances,
    mutate,
    isLoading: balancesLoading,
    isValidating: balancesLoading,
    readFailed,
    balanceReadInFlight
  };
}

// Keep for backward compatibility with any code that might use this
export function getAllBalanceSWRKey(address: string) {
  return ['allBalance', address].join('_');
}
