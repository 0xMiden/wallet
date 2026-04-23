import { Address, BasicFungibleFaucetComponent, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { isMidenAsset } from 'lib/miden/assets';
import { fetchFromStorage } from 'lib/miden/front/storage';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';

import { DEFAULT_TOKEN_METADATA, getAssetUrl, MIDEN_METADATA } from './defaults';
import { AssetMetadata, DetailedAssetMetdata } from './types';

const METADATA_STORAGE_KEY = 'tokens_base_metadata';

export async function fetchTokenMetadata(
  assetId: string
): Promise<{ base: AssetMetadata; detailed: DetailedAssetMetdata }> {
  if (isMidenAsset(assetId)) {
    return { base: MIDEN_METADATA, detailed: MIDEN_METADATA };
  }

  // Check cache before hitting RPC
  try {
    const cached = await fetchFromStorage<Record<string, AssetMetadata>>(METADATA_STORAGE_KEY);
    if (cached && cached[assetId]) {
      return { base: cached[assetId], detailed: cached[assetId] };
    }
  } /* c8 ignore next 2 -- IndexedDB cache miss, defensive fallback */ catch {
    // Cache miss — proceed to RPC
  }

  try {
    // Page-side: gate on SDK WASM readiness so the wasm-bindgen `Endpoint`
    // constructor doesn't fire before the SDK chunk has hydrated. Without
    // this, the first faucet metadata fetch on a freshly-loaded page reliably
    // hits "Cannot read properties of undefined (reading '__wbindgen_malloc')",
    // gets blacklisted via `autoFetchMetadataFails`, and the token displays
    // with default metadata for the rest of the session.
    await ensureSdkWasmReady();
    const endpoint = getRpcEndpoint();
    const rpcClient = new RpcClient(endpoint);
    const account = await rpcClient.getAccountDetails(Address.fromBech32(assetId).accountId());
    const underlyingAccount = account.account();
    if (!underlyingAccount) {
      if (account.isPublic()) {
        // if the account was public and we couldn't fetch metadata it should not happen in first place
        // but in case it does we are storing it as unknown metadata and warning in console
        console.warn('Failed to fetch metadata from chain for', assetId, 'Using default metadata');
      }
      // if the account is private we are assigning it the unknown metadata, as there is no way to fetch the metadata from chain
      return { base: DEFAULT_TOKEN_METADATA, detailed: DEFAULT_TOKEN_METADATA };
    }
    const faucetDetails = BasicFungibleFaucetComponent.fromAccount(underlyingAccount);
    const decimals = faucetDetails.decimals();
    const symbol = faucetDetails.symbol().toString();
    const base: AssetMetadata = {
      decimals,
      symbol,
      name: symbol,
      shouldPreferSymbol: true,
      thumbnailUri: getAssetUrl('misc/token-logos/default.svg')
    };

    const detailed: DetailedAssetMetdata = {
      ...base
    };

    return { base, detailed };
  } catch (err: any) {
    console.error(err);

    throw new NotFoundTokenMetadata();
  }
}

export class NotFoundTokenMetadata extends Error {
  name = 'NotFoundTokenMetadata';
  message = 'Metadata for token not found';
}
