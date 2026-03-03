import { FungibleAsset } from '@miden-sdk/miden-sdk';
import BigNumber from 'bignumber.js';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { fetchFromStorage } from 'lib/miden/front';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { AssetMetadata, DEFAULT_TOKEN_METADATA, fetchTokenMetadata, MIDEN_METADATA } from 'lib/miden/metadata';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getTokenPrice, type TokenPrices } from 'lib/prices';

import { ALL_TOKENS_BASE_METADATA_STORAGE_KEY, setTokensBaseMetadata } from '../../miden/front/assets';

export interface FetchBalancesOptions {
  /** Callback to update asset metadata in the store */
  setAssetsMetadata?: (metadata: Record<string, AssetMetadata>) => void;
  /** Whether to fetch missing metadata inline (default: true) */
  fetchMissingMetadata?: boolean;
  /** Token prices from Binance API (symbol -> { price, change24h }) */
  tokenPrices?: TokenPrices;
}

/**
 * Fetch all token balances for an account
 *
 * This is the single source of truth for balance fetching logic.
 * Used by both the useAllBalances hook and the Zustand store action.
 *
 * The WASM lock is held only for getAccount (IndexedDB read).
 * Metadata fetching uses RpcClient directly and does not need the WASM lock.
 */
export async function fetchBalances(
  address: string,
  tokenMetadatas: Record<string, AssetMetadata>,
  options: FetchBalancesOptions = {}
): Promise<TokenBalanceData[]> {
  const cachedMetadatas =
    (await fetchFromStorage<Record<string, AssetMetadata>>(ALL_TOKENS_BASE_METADATA_STORAGE_KEY)) || {};
  console.log(
    'fetchBalances - address:',
    address,
    'tokenMetadatas:',
    tokenMetadatas,
    'cachedMetadatas:',
    cachedMetadatas
  );
  const { setAssetsMetadata, tokenPrices = {} } = options;
  const balances: TokenBalanceData[] = [];

  // Local copy of metadata that we can add to during this fetch
  const localMetadatas = { ...tokenMetadatas };

  // see if missing metadata should be fetched
  const fetchMissingMetadata = Object.keys(localMetadatas)
    .map(faucetId => !cachedMetadatas[faucetId])
    .some(isMissing => isMissing);
  // Get midenFaucetId early so we can use it inside the lock
  const midenFaucetId = await getFaucetIdSetting();

  // Only hold the WASM lock for the getAccount call (IndexedDB read)
  const { account, assets } = await withWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    const acc = await midenClient.getAccount(address);

    if (!acc) {
      return { account: null, assets: [] as FungibleAsset[] };
    }

    return { account: acc, assets: acc.vault().fungibleAssets() as FungibleAsset[] };
  });
  console.log('Fetched account and assets from WASM client:', { account, assets });
  // Fetch missing metadata OUTSIDE the lock — RpcClient doesn't use the WASM client
  const fetchedMetadatas: Record<string, AssetMetadata> = { ...cachedMetadatas };

  if (fetchMissingMetadata) {
    const metadataFetchPromises = assets
      .filter(asset => {
        const assetId = getBech32AddressFromAccountId(asset.faucetId());
        return assetId !== midenFaucetId && !localMetadatas[assetId];
      })
      .map(async asset => {
        const assetId = getBech32AddressFromAccountId(asset.faucetId());
        try {
          const tokenMetadata = await fetchTokenMetadata(assetId);
          fetchedMetadatas[assetId] = tokenMetadata.base;
        } catch (e) {
          console.warn('Failed to fetch metadata for', assetId, e);
          fetchedMetadatas[assetId] = DEFAULT_TOKEN_METADATA;
        }
      });
    await Promise.all(metadataFetchPromises);
  }

  // Handle case where account doesn't exist (outside the lock)
  if (!account) {
    console.warn(`Account not found: ${address}`);
    const midenPrice = getTokenPrice(tokenPrices, 'MIDEN');
    return [
      {
        tokenId: midenFaucetId,
        tokenSlug: 'MIDEN',
        metadata: MIDEN_METADATA,
        fiatPrice: midenPrice.price,
        change24h: midenPrice.change24h,
        balance: 0
      }
    ];
  }

  // Update metadata stores with newly fetched metadata (outside the lock)
  for (const [id, metadata] of Object.entries(fetchedMetadatas)) {
    localMetadatas[id] = metadata;
    await setTokensBaseMetadata({ [id]: metadata });
    setAssetsMetadata?.({ [id]: metadata });
  }

  // Build balance list
  let hasMiden = false;
  for (const asset of assets) {
    const tokenId = getBech32AddressFromAccountId(asset.faucetId());
    const isMiden = tokenId === midenFaucetId;

    if (isMiden) {
      hasMiden = true;
    }

    const tokenMetadata = isMiden ? MIDEN_METADATA : localMetadatas[tokenId];
    if (!tokenMetadata) {
      // Skip assets without metadata (metadata fetch failed)
      continue;
    }

    const balance = new BigNumber(asset.amount().toString()).div(10 ** tokenMetadata.decimals);
    const priceInfo = getTokenPrice(tokenPrices, tokenMetadata.symbol);

    balances.push({
      tokenId,
      tokenSlug: tokenMetadata.symbol,
      metadata: tokenMetadata,
      fiatPrice: priceInfo.price,
      change24h: priceInfo.change24h,
      balance: balance.toNumber()
    });
  }

  // Always include MIDEN token (even if balance is 0)
  if (!hasMiden) {
    const midenPrice = getTokenPrice(tokenPrices, 'MIDEN');
    balances.push({
      tokenId: midenFaucetId,
      tokenSlug: 'MIDEN',
      metadata: MIDEN_METADATA,
      fiatPrice: midenPrice.price,
      change24h: midenPrice.change24h,
      balance: 0
    });
  }

  return balances;
}
