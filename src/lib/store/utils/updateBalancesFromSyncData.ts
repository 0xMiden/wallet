import BigNumber from 'bignumber.js';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { AssetMetadata, DEFAULT_TOKEN_METADATA } from 'lib/miden/metadata';
import { getNativeDisplayMetadataSync } from 'lib/miden/metadata/native';
import { applyOverrideFor, getTokenMetadataOverrides, TokenMetadataOverrides } from 'lib/miden/metadata/overrides';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { SerializedVaultAsset } from 'lib/shared/types';

import { setTokensBaseMetadata } from '../../miden/front/assets';
import { useWalletStore } from '../index';
import { balancePrice } from './balancePrice';

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
  /* c8 ignore next -- tokenPrices always initialized in store */
  const tokenPrices = store.tokenPrices ?? {};
  const midenFaucetId = await getFaucetIdSetting();
  const actualNativeId = getNativeAssetIdSync();
  // Read from storage, not from the store: a sync can land before the provider loads them.
  const overrides = await getTokenMetadataOverrides().catch((error): TokenMetadataOverrides => {
    console.warn('Token metadata overrides read failed', error);
    return {};
  });

  const balances: TokenBalanceData[] = [];
  let hasMiden = false;

  // Collect metadata from sync data to persist
  const newMetadatas: Record<string, AssetMetadata> = {};

  // Build balance list — metadata comes from the sync data (pre-fetched by SW)
  for (const asset of vaultAssets) {
    const isMiden = asset.faucetId === midenFaucetId;
    if (isMiden) hasMiden = true;

    let tokenMetadata: AssetMetadata;
    const cached = localMetadatas[asset.faucetId];
    // A cached record whose scale is a guess is provisional: real metadata
    // arriving on a later sync must be allowed to replace it. Preferring the
    // cache unconditionally is what made a single failed lookup permanent.
    const localMeta = hasKnownScale(cached) ? cached : undefined;
    if (asset.faucetId === actualNativeId) {
      tokenMetadata = getNativeDisplayMetadataSync(asset.metadata ?? localMeta, asset.faucetId);
    } else if (localMeta) {
      tokenMetadata = localMeta;
    } else if (asset.metadata) {
      // Use metadata from sync data (pre-fetched by SW)
      tokenMetadata = {
        decimals: asset.metadata.decimals,
        symbol: asset.metadata.symbol,
        name: asset.metadata.name,
        description: asset.metadata.description,
        // Carried through: this record is PERSISTED by `setTokensBaseMetadata`
        // below, so dropping the marker here stores the placeholder's guessed
        // decimals as though the faucet had reported them.
        scaleIsUnknown: asset.metadata.scaleIsUnknown
      };
      // Only a resolved record is worth storing. Persisting the placeholder
      // would freeze the guess in place for a faucet whose lookup merely
      // failed this once — the sync retries, but the cache would already have
      // an answer for it.
      if (hasKnownScale(tokenMetadata)) newMetadatas[asset.faucetId] = tokenMetadata;
    } else {
      tokenMetadata = DEFAULT_TOKEN_METADATA;
    }
    // The user's display values apply after the faucet's record is kept to store above.
    // A cached store entry has them already, and a second application changes nothing.
    if (!isMiden) tokenMetadata = applyOverrideFor(asset.faucetId, tokenMetadata, overrides);

    const balance = new BigNumber(asset.amountBaseUnits).div(10 ** tokenMetadata.decimals);

    balances.push({
      tokenId: asset.faucetId,
      tokenSlug: tokenMetadata.symbol,
      metadata: tokenMetadata,
      ...balancePrice(tokenPrices, asset.faucetId, tokenMetadata.symbol),
      balance: balance.toNumber()
    });
  }

  // Persist newly discovered metadata
  if (Object.keys(newMetadatas).length > 0) {
    await setTokensBaseMetadata(newMetadatas);
    store.setAssetsMetadata(newMetadatas);
  }

  // Always include MIDEN token (even if 0 balance) — pre-discovery we omit
  // the placeholder row so the UI doesn't render MIDEN under a stale ID.
  if (!hasMiden && midenFaucetId) {
    balances.push({
      tokenId: midenFaucetId,
      tokenSlug: getNativeDisplayMetadataSync(localMetadatas[midenFaucetId], midenFaucetId).symbol,
      metadata: getNativeDisplayMetadataSync(localMetadatas[midenFaucetId], midenFaucetId),
      ...balancePrice(
        tokenPrices,
        midenFaucetId,
        getNativeDisplayMetadataSync(localMetadatas[midenFaucetId], midenFaucetId).symbol
      ),
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
