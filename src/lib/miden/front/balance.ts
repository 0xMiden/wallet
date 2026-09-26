import { useCallback, useEffect, useRef } from 'react';

import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { isExtension } from 'lib/platform';
import type { TokenPrices } from 'lib/prices';
import { useWalletStore } from 'lib/store';
import { balancePrice } from 'lib/store/utils/balancePrice';
import { fetchingAddresses } from 'lib/store/utils/fetchBalances';

import { AssetMetadata, MIDEN_METADATA } from '../metadata';
import { isTestSyncPaused } from './test-sync-pause';

export interface TokenBalanceData {
  tokenId: string;
  tokenSlug: string;
  metadata: AssetMetadata;
  balance: number;
  fiatPrice: number;
  change24h: number;
}

const REFRESH_INTERVAL = 5_000;
const DEDUPING_INTERVAL = 10_000;

/**
 * Default zero-balance row shown before the first fetch resolves.
 * Built lazily: we only render the placeholder row once the native asset ID
 * has been discovered (cached in memory), otherwise return `[]` and let the
 * loading state drive a skeleton. This avoids flashing a row with the wrong
 * tokenId while discovery is in flight on first install.
 */
function buildDefaultZeroBalance(tokenPrices: TokenPrices): TokenBalanceData[] {
  const midenFaucetId = getNativeAssetIdSync();
  if (!midenFaucetId) return [];
  return [
    {
      tokenId: midenFaucetId,
      tokenSlug: 'MIDEN',
      metadata: MIDEN_METADATA,
      ...balancePrice(tokenPrices, midenFaucetId, MIDEN_METADATA.symbol),
      balance: 0
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

  // Derive values with stable defaults
  // Show 0 MIDEN immediately before any async lookup completes — only once
  // the native asset ID has been learned, otherwise show `[]` (skeleton).
  const balances = balancesMap[address] ?? buildDefaultZeroBalance(tokenPrices);
  const balancesLastFetched = balancesLastFetchedMap[address] ?? 0;
  // Consider loading if: explicitly loading OR never fetched yet
  const balancesLoading = balancesLoadingMap[address] ?? balancesLastFetched === 0;

  // Track if component is mounted
  const mountedRef = useRef(true);

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
      // The action stores what lands whether or not this component is still mounted: every
      // other reader skipped the address in favour of this read (#1123).
      await useWalletStore.getState().fetchBalances(address, tokenMetadatasRef.current);
    } catch (error) {
      // Loading is left as it was: with nothing read yet, clearing it would show the zero
      // placeholder as a real "$0.00". The next tick retries.
      console.error('Failed to fetch balances:', error);
    }
  }, [address]);

  // Manual mutate function for compatibility
  const mutate = useCallback(() => {
    // Reset last fetched time to force a refresh
    useWalletStore.setState(state => ({
      balancesLastFetched: { ...state.balancesLastFetched, [address]: 0 }
    }));
    return fetchBalancesWithDeduping();
  }, [address, fetchBalancesWithDeduping]);

  // Initial fetch and polling
  useEffect(() => {
    mountedRef.current = true;

    // Initial fetch
    fetchBalancesWithDeduping();

    // Set up polling interval. `isTestSyncPaused()` lets an E2E hook quiesce
    // this poll (which contends for the WASM lock every tick) while it does its own
    // single-threaded-WASM read - otherwise the read is livelocked on mobile.
    // No-op in production (tree-shaken).
    const intervalId = setInterval(() => {
      if (mountedRef.current && !isTestSyncPaused()) {
        fetchBalancesWithDeduping();
      }
    }, REFRESH_INTERVAL);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchBalancesWithDeduping]);

  // Return SWR-compatible shape for backward compatibility
  return {
    data: balances,
    mutate,
    isLoading: balancesLoading,
    isValidating: balancesLoading
  };
}

// Keep for backward compatibility with any code that might use this
export function getAllBalanceSWRKey(address: string) {
  return ['allBalance', address].join('_');
}
