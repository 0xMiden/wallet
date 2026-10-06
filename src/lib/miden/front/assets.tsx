import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import BigNumber from 'bignumber.js';
import Fuse from 'fuse.js';
import PQueue from 'p-queue';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import {
  DEFAULT_TOKEN_METADATA,
  AssetMetadata,
  DetailedAssetMetdata,
  fetchFromStorage,
  fetchTokenMetadata,
  onStorageChanged,
  putToStorage,
  usePassiveStorage,
  isMidenAsset
} from 'lib/miden/front';
import { getNativeDisplayMetadataSync } from 'lib/miden/metadata/native';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { updateTokensBaseMetadata } from 'lib/miden/metadata/storage';
import { getNativeAssetIdSync, onNativeAssetChanged } from 'lib/miden-chain/native-asset';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { useWalletStore } from 'lib/store';
import { balancePrice } from 'lib/store/utils/balancePrice';
import { useRetryableSWR } from 'lib/swr';

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
            setAssetsMetadata({ [assetId]: metadata.base });
            // Also persist to storage
            await setTokensBaseMetadata({ [assetId]: metadata.base });
            await setTokensDetailedMetadataStorage({ [assetId]: metadata.detailed });
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
  const initialSyncDone = useRef(false);

  // Load initial metadata from storage
  const [initialAllTokensBaseMetadata] = usePassiveStorage<Record<string, AssetMetadata>>(
    ALL_TOKENS_BASE_METADATA_STORAGE_KEY,
    defaultAllTokensBaseMetadata
  );

  // Sync initial storage to Zustand once on mount
  useEffect(() => {
    if (!initialSyncDone.current && Object.keys(initialAllTokensBaseMetadata).length > 0) {
      initialSyncDone.current = true;
      setAssetsMetadata(initialAllTokensBaseMetadata);
    }
  }, [initialAllTokensBaseMetadata, setAssetsMetadata]);

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

// Helper to set detailed metadata to storage
async function setTokensDetailedMetadataStorage(toSet: Record<string, DetailedAssetMetdata>): Promise<void> {
  await getStorageProvider().set(mapObjectKeys(toSet, getDetailedMetadataStorageKey));
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

export function useDetailedAssetMetadata(assetSlug: string, assetId: string) {
  const baseMetadata = useAssetMetadata(assetSlug, assetId);

  const storageKey = useMemo(() => getDetailedMetadataStorageKey(assetId), [assetId]);

  const { data: detailedMetadata, mutate } = useRetryableSWR<DetailedAssetMetdata>(
    ['detailed-metadata', storageKey],
    fetchFromStorage as (key: string) => Promise<DetailedAssetMetdata>,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false
    }
  );

  useEffect(() => onStorageChanged(storageKey, mutate), [storageKey, mutate]);

  if (assetId === getNativeAssetIdSync() && baseMetadata) return { ...detailedMetadata, ...baseMetadata };

  return detailedMetadata ?? baseMetadata;
}

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

function getDetailedMetadataStorageKey(assetId: string) {
  return `detailed_asset_metadata_${assetId}`;
}

function mapObjectKeys<T extends Record<string, any>>(obj: T, predicate: (key: string) => string): T {
  const newObj: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    newObj[predicate(key)] = obj[key];
  }

  return newObj as T;
}
