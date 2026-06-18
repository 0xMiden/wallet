import { useCallback, useEffect, useRef } from 'react';

import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { isExtension } from 'lib/platform';
import { useWalletStore } from 'lib/store';
import { fetchBalances } from 'lib/store/utils/fetchBalances';

import { AssetMetadata, MIDEN_METADATA } from '../metadata';

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
function buildDefaultZeroBalance(): TokenBalanceData[] {
  const midenFaucetId = getNativeAssetIdSync();
  if (!midenFaucetId) return [];
  return [
    {
      tokenId: midenFaucetId,
      tokenSlug: 'MIDEN',
      metadata: MIDEN_METADATA,
      fiatPrice: 1,
      change24h: 0,
      balance: 0
    }
  ];
}

// Global lock to prevent concurrent fetches to WASM client (per address)
export const fetchingAddresses = new Set<string>();

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
  const balancesLoadingMap = useWalletStore(s => s.balancesLoading);
  const balancesLastFetchedMap = useWalletStore(s => s.balancesLastFetched);
  const setAssetsMetadata = useWalletStore(s => s.setAssetsMetadata);

  // Derive values with stable defaults
  // Show 0 MIDEN immediately before any async lookup completes — only once
  // the native asset ID has been learned, otherwise show `[]` (skeleton).
  const balances = balancesMap[address] ?? buildDefaultZeroBalance();
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

  // Fetch balances function that respects deduping
  // Uses global lock to prevent concurrent WASM client calls
  // On extension, balances arrive via SyncCompleted broadcast — skip WASM polling
  const fetchBalancesWithDeduping = useCallback(async () => {
    if (isExtension()) return;

    // Check global lock - prevents concurrent calls across all component instances
    if (fetchingAddresses.has(address)) return;

    // Read current value from store (not ref) to catch updates from prefetch
    const now = Date.now();
    const currentLastFetched = useWalletStore.getState().balancesLastFetched[address] ?? 0;
    if (now - currentLastFetched < DEDUPING_INTERVAL) {
      return;
    }

    // Acquire global lock
    fetchingAddresses.add(address);
    try {
      // Fetch balances using the consolidated utility
      // Metadata is fetched inline, so all tokens appear together
      const tokenPrices = useWalletStore.getState().tokenPrices;
      const fetchedBalances = await fetchBalances(address, tokenMetadatasRef.current, {
        setAssetsMetadata,
        tokenPrices
      });

      // Update store if still mounted
      if (mountedRef.current) {
        useWalletStore.setState(state => ({
          balances: { ...state.balances, [address]: fetchedBalances },
          balancesLoading: { ...state.balancesLoading, [address]: false },
          balancesLastFetched: { ...state.balancesLastFetched, [address]: Date.now() }
        }));
      }
    } catch (error) {
      console.error('Failed to fetch balances:', error);
      if (mountedRef.current) {
        useWalletStore.setState(state => ({
          balancesLoading: { ...state.balancesLoading, [address]: false }
        }));
      }
    } finally {
      // Release global lock
      fetchingAddresses.delete(address);
    }
  }, [address, setAssetsMetadata]);

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

    // Set up polling interval
    const intervalId = setInterval(() => {
      if (mountedRef.current) {
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
