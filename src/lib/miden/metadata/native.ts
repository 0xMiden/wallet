import {
  getNativeAssetIdSync,
  getNativeAssetMetadata,
  getNativeAssetMetadataSync,
  type NativeAssetChainMetadata
} from 'lib/miden-chain/native-asset';

import { MIDEN_METADATA } from './defaults';
import { hasKnownScale } from './scale';
import type { AssetMetadata } from './types';

const PROVISIONAL_NATIVE_METADATA: AssetMetadata = { ...MIDEN_METADATA, scaleIsUnknown: true };

export function nativeDisplayMetadata(chain: NativeAssetChainMetadata | null, fallback?: AssetMetadata): AssetMetadata {
  if (chain && hasKnownScale({ ...chain, name: chain.symbol }))
    return {
      ...MIDEN_METADATA,
      ...chain,
      name: chain.symbol === 'MIDEN' ? MIDEN_METADATA.name : chain.symbol,
      scaleIsUnknown: false
    };
  return hasKnownScale(fallback) && fallback ? fallback : PROVISIONAL_NATIVE_METADATA;
}

export function getNativeDisplayMetadataSync(
  fallback?: AssetMetadata,
  faucetId = getNativeAssetIdSync()
): AssetMetadata {
  return nativeDisplayMetadata(
    faucetId !== null && faucetId === getNativeAssetIdSync() ? getNativeAssetMetadataSync() : null,
    fallback
  );
}

export async function getNativeDisplayMetadata(): Promise<AssetMetadata> {
  try {
    return nativeDisplayMetadata(await getNativeAssetMetadata());
  } catch {
    return PROVISIONAL_NATIVE_METADATA;
  }
}
