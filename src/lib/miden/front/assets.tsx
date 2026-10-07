import React, { useCallback, useEffect, useRef } from 'react';

import BigNumber from 'bignumber.js';
import Fuse from 'fuse.js';
import PQueue from 'p-queue';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import {
  DEFAULT_TOKEN_METADATA,
  AssetMetadata,
  fetchFromStorage,
  fetchTokenMetadata,
  onStorageChanged,
  putToStorage,
  isMidenAsset
} from 'lib/miden/front';
import { getNativeDisplayMetadataSync } from 'lib/miden/metadata/native';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { ensureTokensMetadataSchema, updateTokensBaseMetadata } from 'lib/miden/metadata/storage';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';
import { useWalletStore } from 'lib/store';
import { balancePrice } from 'lib/store/utils/balancePrice';

export const ALL_TOKENS_BASE_METADATA_STORAGE_KEY = 'tokens_base_metadata';

export type TokenBalance = {
  faucetId: string;
  balance: BigNumber;
};

const autoFetchMetadataQueue = new PQueue({ concurrency: 1 });
const autoFetchMetadataFails = new Set<string>();

/**
 * useAssetMetadata - Get metadata for a specific asset
 *
 * Uses Zustand store for state while maintaining storage persistence.
 */
export function useAssetMetadata(_slug: string, assetId: string) {
  const midenFaucetId = useMidenFaucetId();

  // Get from Zustand store
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);
  const setAssetsMetadata = useWalletStore(s => s.setAssetsMetadata);
  const fetchAssetMetadata = useWalletStore(s => s.fetchAssetMetadata);

  const isMidenFaucet = assetId === midenFaucetId;
  const isNativeFaucet = assetId === getNativeAssetIdSync();
  const tokenMetadata = assetsMetadata[assetId] ?? null;
  const exist = Boolean(tokenMetadata);

  // Auto-fetch missing metadata
  useEffect(() => {
    if (!isNativeFaucet && !exist && !autoFetchMetadataFails.has(assetId)) {
      autoFetchMetadataQueue
        .add(async () => {
          try {
            const metadata = await fetchTokenMetadata(assetId);
            // Update Zustand store
            setAssetsMetadata({ [assetId]: metadata });
            // Also persist to storage
            await setTokensBaseMetadata({ [assetId]: metadata });
            return metadata;
          } catch (error) {
            autoFetchMetadataFails.add(assetId);
            throw error;
          }
        })
        .catch(() => {});
    }
  }, [assetId, exist, fetchAssetMetadata, setAssetsMetadata, isNativeFaucet]);

  // Preserve authoritative native metadata, including its scale.
  if (isMidenFaucet || isNativeFaucet) {
    return getNativeDisplayMetadataSync(tokenMetadata ?? undefined, assetId);
  }

  // On a hard fetch failure (RPC throw, blacklisted asset) tokenMetadata stays
  // null — fall back to Unknown rather than handing back a null behind a
  // non-null assertion, which crashes consumers reading .symbol/.decimals.
  return tokenMetadata ?? DEFAULT_TOKEN_METADATA;
}

export async function useAllAssetMetadata(): Promise<Record<string, AssetMetadata>> {
  return (await fetchFromStorage(ALL_TOKENS_BASE_METADATA_STORAGE_KEY)) || defaultAllTokensBaseMetadata;
}

const defaultAllTokensBaseMetadata: Record<string, AssetMetadata> = {};

/**
 * TokensMetadataProvider - Syncs storage to Zustand on mount
 *
 * This is now a simple provider that syncs browser storage to Zustand.
 * No longer uses constate - just handles the initial sync and change listening.
 */
export function TokensMetadataProvider({ children }: { children: React.ReactNode }) {
  const setAssetsMetadata = useWalletStore(s => s.setAssetsMetadata);

  // Sync the stored metadata to Zustand once on mount. The read comes after the shape check,
  // so records of an older shape never get into Zustand.
  useEffect(() => {
    let cancelled = false;
    const syncStoredMetadata = async () => {
      try {
        await ensureTokensMetadataSchema(fetchFromStorage, putToStorage);
      } catch (error) {
        console.warn('Token metadata cache check failed', error);
      }
      const stored = await fetchFromStorage<Record<string, AssetMetadata>>(ALL_TOKENS_BASE_METADATA_STORAGE_KEY);
      if (cancelled || !stored || Object.keys(stored).length === 0) return;
      setAssetsMetadata(stored);
      // This sync ends after the native effect below. The chain metadata of the native token
      // must stay ahead of a stored copy, so it is set again.
      const nativeId = getNativeAssetIdSync();
      const nativeMetadata = getNativeDisplayMetadataSync();
      if (nativeId && hasKnownScale(nativeMetadata)) setAssetsMetadata({ [nativeId]: nativeMetadata });
    };
    syncStoredMetadata().catch(error => console.warn('Token metadata sync from storage failed', error));
    return () => {
      cancelled = true;
    };
  }, [setAssetsMetadata]);

  // Listen for storage changes and sync to Zustand (separate effect)
  useEffect(() => {
    return onStorageChanged(ALL_TOKENS_BASE_METADATA_STORAGE_KEY, newValue => {
      setAssetsMetadata(newValue);
    });
  }, [setAssetsMetadata]);

  useEffect(() => {
    const updateNative = () => {
      const id = getNativeAssetIdSync();
      const metadata = getNativeDisplayMetadataSync();
      useWalletStore.setState(state => ({ tokenPrices: { ...state.tokenPrices } }));
      if (!id || !hasKnownScale(metadata)) return;
      setAssetsMetadata({ [id]: metadata });
      useWalletStore.setState(state => ({
        balances: Object.fromEntries(
          Object.entries(state.balances).map(([account, rows]) => [
            account,
            rows.map(row =>
              row.tokenId === id
                ? {
                    ...row,
                    metadata,
                    tokenSlug: metadata.symbol,
                    balance: new BigNumber(row.balance).shiftedBy(row.metadata.decimals - metadata.decimals).toNumber(),
                    ...balancePrice(state.tokenPrices, id, metadata.symbol)
                  }
                : row
            )
          ])
        )
      }));
    };
    const stop = onNativeAssetChanged(updateNative);
    updateNative();
    return stop;
  }, [setAssetsMetadata]);

  return <>{children}</>;
}

export async function setTokensBaseMetadata(toSet: Record<string, AssetMetadata>): Promise<void> {
  await updateTokensBaseMetadata(
    toSet,
    () => fetchFromStorage<Record<string, AssetMetadata>>(ALL_TOKENS_BASE_METADATA_STORAGE_KEY),
    metadata => putToStorage(ALL_TOKENS_BASE_METADATA_STORAGE_KEY, metadata)
  );
}

export const getTokensBaseMetadata = async (assetId: string) => {
  const allTokensBaseMetadata: Record<string, AssetMetadata> =
    (await fetchFromStorage(ALL_TOKENS_BASE_METADATA_STORAGE_KEY)) || defaultAllTokensBaseMetadata;

  return allTokensBaseMetadata[assetId];
};

/**
 * useGetTokenMetadata - Returns a function to get token metadata by slug/id
 *
 * Now uses Zustand store directly for better reactivity.
 */
export const useGetTokenMetadata = () => {
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);
  const nativeId = useMidenFaucetId();

  return useCallback(
    (slug: string, id: string) => {
      if (id === nativeId || id === getNativeAssetIdSync() || isMidenAsset(slug)) {
        return getNativeDisplayMetadataSync(assetsMetadata[id], id);
      }

      return assetsMetadata[id];
    },
    [assetsMetadata, nativeId]
  );
};

/**
 * useAllTokensBaseMetadata - Returns all cached token metadata
 *
 * Now uses Zustand store directly - no more forceUpdate needed.
 */
export function useAllTokensBaseMetadata() {
  return useWalletStore(s => s.assetsMetadata);
}

/**
 * useTokensMetadata - Provides a ref to all metadata, a fetch function, and a setter.
 * Used by claimable-notes to read metadata without triggering re-renders and to
 * background-fetch metadata for unknown tokens.
 */
export function useTokensMetadata() {
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);
  const setAssetsMetadata = useWalletStore(s => s.setAssetsMetadata);
  const allTokensBaseMetadataRef = useRef(assetsMetadata);
  allTokensBaseMetadataRef.current = assetsMetadata;

  const fetchMetadata = useCallback(async (faucetId: string) => {
    return fetchTokenMetadata(faucetId);
  }, []);

  // Persist to storage as well as Zustand — history rows resolve metadata via
  // getTokensBaseMetadata (storage), not the in-memory store.
  const setTokensBaseMetadataAndPersist = useCallback(
    async (batch: Record<string, AssetMetadata>) => {
      setAssetsMetadata(batch);
      await setTokensBaseMetadata(batch);
    },
    [setAssetsMetadata]
  );

  return { allTokensBaseMetadataRef, fetchMetadata, setTokensBaseMetadata: setTokensBaseMetadataAndPersist };
}

export function searchAssets(
  searchValue: string,
  assets: { slug: string; id: string }[],
  allTokensBaseMetadata: Record<string, AssetMetadata>
) {
  if (!searchValue) return assets;

  const fuse = new Fuse(
    assets.map(({ slug, id }) => ({
      slug,
      id,
      metadata:
        id === getNativeAssetIdSync() || isMidenAsset(slug)
          ? getNativeDisplayMetadataSync(allTokensBaseMetadata[id], id)
          : allTokensBaseMetadata[id]
    })),
    {
      keys: [
        { name: 'metadata.name', weight: 0.9 },
        { name: 'metadata.symbol', weight: 0.7 },
        { name: 'id', weight: 0.3 }
      ],
      threshold: 1
    }
  );

  return fuse.search(searchValue).map(({ item: { slug, id } }) => ({ slug, id }));
}
