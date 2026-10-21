import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { isMidenAsset } from 'lib/miden/assets';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';

import { DEFAULT_TOKEN_METADATA } from './defaults';
import { readFaucetProofMetadata } from './faucet-proof';
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
    const accountId = accountRefToSdk(assetId);
    const proof = await rpcClient.getAccountProof(accountId);
    if (!proof.accountHeader()) {
      if (accountId.isPublic()) {
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
      metadata = readFaucetProofMetadata(proof);
    } catch (err) {
      // A present public header with incompatible standard storage is deterministic.
      console.warn('Invalid standard faucet metadata for', assetId, '- using default metadata', err);
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
