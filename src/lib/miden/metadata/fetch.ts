import { Address, BasicFungibleFaucetComponent, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { isMidenAsset } from 'lib/miden/assets';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';

import { DEFAULT_TOKEN_METADATA } from './defaults';
import { getNativeDisplayMetadataSync } from './native';
import { ensureTokensMetadataSchema, TOKENS_BASE_METADATA_STORAGE_KEY, updateTokensBaseMetadata } from './storage';
import { AssetMetadata } from './types';

async function persistTokenMetadata(assetId: string, metadata: AssetMetadata): Promise<void> {
  await updateTokensBaseMetadata(
    { [assetId]: metadata },
    () => fetchFromStorage<Record<string, AssetMetadata>>(TOKENS_BASE_METADATA_STORAGE_KEY),
    cached => putToStorage(TOKENS_BASE_METADATA_STORAGE_KEY, cached)
  );
}

async function cacheTokenMetadata(assetId: string, metadata: AssetMetadata): Promise<AssetMetadata> {
  try {
    await persistTokenMetadata(assetId, metadata);
  } /* c8 ignore next 2 -- metadata remains usable when persistence is unavailable */ catch {
    // A storage failure must not turn a successful RPC response into a metadata failure.
  }

  return metadata;
}

export async function fetchTokenMetadata(assetId: string): Promise<AssetMetadata> {
  if (isMidenAsset(assetId)) return getNativeDisplayMetadataSync();

  // Check cache before hitting RPC
  try {
    // Records of an older shape must not be served. This clears them one time per wallet.
    await ensureTokensMetadataSchema(fetchFromStorage, putToStorage);
    const cached = await fetchFromStorage<Record<string, AssetMetadata>>(TOKENS_BASE_METADATA_STORAGE_KEY);
    if (cached && cached[assetId]) {
      return cached[assetId];
    }
  } /* c8 ignore next 2 -- IndexedDB cache miss, defensive fallback */ catch {
    // Cache miss - proceed to RPC
  }

  return fetchChainTokenMetadata(assetId);
}

/** Reads RPC metadata directly, without display branding or the general token cache. */
export async function fetchChainTokenMetadata(assetId: string): Promise<AssetMetadata> {
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
        // but in case it does we return unknown metadata without caching it so a later fetch can retry
        console.warn('Failed to fetch metadata from chain for', assetId, 'Using default metadata');
        return DEFAULT_TOKEN_METADATA;
      }
      // if the account is private we are assigning it the unknown metadata, as there is no way to fetch the metadata from chain
      return cacheTokenMetadata(assetId, DEFAULT_TOKEN_METADATA);
    }
    let metadata: AssetMetadata;
    try {
      const faucet = BasicFungibleFaucetComponent.fromAccountStorage(underlyingAccount.storage());
      const symbol = faucet.symbol().toString();
      const description = faucet.description();
      metadata = {
        symbol,
        // A faucet can leave its name empty. Then the symbol is the name.
        name: faucet.tokenName() || symbol,
        decimals: faucet.decimals(),
        // Stated explicitly because the faucet reported these decimals. Without
        // it, a faucet named "Unknown" with the symbol "Unknown" and 6 decimals
        // is byte-for-byte the placeholder, and the shape test that recognises
        // pre-marker cached placeholders would refuse to quantify a token that
        // told us exactly what it was.
        scaleIsUnknown: false,
        ...(description ? { description } : {})
      };
    } catch (err) {
      // The account exists on-chain but its interface isn't a standard basic
      // fungible faucet (e.g. a custom or bridged-asset faucet whose interface
      // lacks the BasicFungibleFaucet procedures). There's nothing to read, and
      // this is a deterministic failure for this faucet — surface it as Unknown
      // (and cache that) rather than throwing into the inconsistent caller
      // fallbacks.
      console.warn('Account is not a basic fungible faucet for', assetId, '— using default metadata', err);
      return cacheTokenMetadata(assetId, DEFAULT_TOKEN_METADATA);
    }

    return cacheTokenMetadata(assetId, metadata);
  } catch (err) {
    console.error(err);

    throw new NotFoundTokenMetadata();
  }
}

export class NotFoundTokenMetadata extends Error {
  name = 'NotFoundTokenMetadata';
  message = 'Metadata for token not found';
}
