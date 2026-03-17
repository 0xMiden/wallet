import BigNumber from 'bignumber.js';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { AssetMetadata, DEFAULT_TOKEN_METADATA, MIDEN_METADATA, fetchTokenMetadata } from 'lib/miden/metadata';
import { SerializedVaultAsset } from 'lib/shared/types';

import { setTokensBaseMetadata } from '../../miden/front/assets';
import { useWalletStore } from '../index';

/**
 * Convert SerializedVaultAsset[] from the service worker's SyncCompleted broadcast
 * into TokenBalanceData[] and update the Zustand store.
 *
 * Reuses the same logic pattern as fetchBalances.ts but without touching the WASM client.
 */
export async function updateBalancesFromSyncData(
  accountPublicKey: string,
  vaultAssets: SerializedVaultAsset[]
): Promise<void> {
  const store = useWalletStore.getState();
  const localMetadatas = { ...store.assetsMetadata };
  const midenFaucetId = await getFaucetIdSetting();

  const balances: TokenBalanceData[] = [];
  let hasMiden = false;

  // Fetch missing metadata (RPC, no WASM needed)
  const fetchedMetadatas: Record<string, AssetMetadata> = {};
  const metadataFetchPromises = vaultAssets
    .filter(asset => asset.faucetId !== midenFaucetId && !localMetadatas[asset.faucetId])
    .map(async asset => {
      try {
        const tokenMetadata = await fetchTokenMetadata(asset.faucetId);
        fetchedMetadatas[asset.faucetId] = tokenMetadata.base;
      } catch (e) {
        console.warn('[updateBalancesFromSyncData] Failed to fetch metadata for', asset.faucetId, e);
        fetchedMetadatas[asset.faucetId] = DEFAULT_TOKEN_METADATA;
      }
    });
  await Promise.all(metadataFetchPromises);

  // Persist newly fetched metadata (batched)
  if (Object.keys(fetchedMetadatas).length > 0) {
    Object.assign(localMetadatas, fetchedMetadatas);
    await setTokensBaseMetadata(fetchedMetadatas);
    store.setAssetsMetadata(fetchedMetadatas);
  }

  // Build balance list
  for (const asset of vaultAssets) {
    const isMiden = asset.faucetId === midenFaucetId;
    if (isMiden) hasMiden = true;

    const tokenMetadata = isMiden ? MIDEN_METADATA : localMetadatas[asset.faucetId];
    if (!tokenMetadata) continue;

    const balance = new BigNumber(asset.amountBaseUnits).div(10 ** tokenMetadata.decimals);

    balances.push({
      tokenId: asset.faucetId,
      tokenSlug: tokenMetadata.symbol,
      metadata: tokenMetadata,
      fiatPrice: 1,
      balance: balance.toNumber()
    });
  }

  // Always include MIDEN token (even if 0 balance)
  if (!hasMiden) {
    balances.push({
      tokenId: midenFaucetId,
      tokenSlug: 'MIDEN',
      metadata: MIDEN_METADATA,
      fiatPrice: 1,
      balance: 0
    });
  }

  // Update Zustand store
  useWalletStore.setState(state => ({
    balances: { ...state.balances, [accountPublicKey]: balances },
    balancesLoading: { ...state.balancesLoading, [accountPublicKey]: false },
    balancesLastFetched: { ...state.balancesLastFetched, [accountPublicKey]: Date.now() }
  }));
}
