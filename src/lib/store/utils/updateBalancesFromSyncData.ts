import BigNumber from 'bignumber.js';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { AssetMetadata, DEFAULT_TOKEN_METADATA, MIDEN_METADATA } from 'lib/miden/metadata';
import { SerializedVaultAsset } from 'lib/shared/types';

import { setTokensBaseMetadata } from '../../miden/front/assets';
import { useWalletStore } from '../index';

/**
 * Convert SerializedVaultAsset[] from the service worker's SyncCompleted broadcast
 * into TokenBalanceData[] and update the Zustand store.
 *
 * Metadata is pre-fetched by the sync manager and included in each vault asset.
 * No RPC calls needed — this is synchronous aside from the faucet ID lookup.
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

  // Collect metadata from sync data to persist
  const newMetadatas: Record<string, AssetMetadata> = {};

  // Build balance list — metadata comes from the sync data (pre-fetched by SW)
  for (const asset of vaultAssets) {
    const isMiden = asset.faucetId === midenFaucetId;
    if (isMiden) hasMiden = true;

    let tokenMetadata: AssetMetadata;
    if (isMiden) {
      tokenMetadata = MIDEN_METADATA;
    } else if (localMetadatas[asset.faucetId]) {
      tokenMetadata = localMetadatas[asset.faucetId];
    } else if (asset.metadata) {
      // Use metadata from sync data (pre-fetched by SW)
      tokenMetadata = {
        decimals: asset.metadata.decimals,
        symbol: asset.metadata.symbol,
        name: asset.metadata.name,
        thumbnailUri: asset.metadata.thumbnailUri
      };
      newMetadatas[asset.faucetId] = tokenMetadata;
    } else {
      tokenMetadata = DEFAULT_TOKEN_METADATA;
      newMetadatas[asset.faucetId] = tokenMetadata;
    }

    const balance = new BigNumber(asset.amountBaseUnits).div(10 ** tokenMetadata.decimals);

    balances.push({
      tokenId: asset.faucetId,
      tokenSlug: tokenMetadata.symbol,
      metadata: tokenMetadata,
      fiatPrice: 1,
      balance: balance.toNumber()
    });
  }

  // Persist newly discovered metadata
  if (Object.keys(newMetadatas).length > 0) {
    await setTokensBaseMetadata(newMetadatas);
    store.setAssetsMetadata(newMetadatas);
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
