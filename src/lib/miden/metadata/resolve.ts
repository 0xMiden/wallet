import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';

import { DEFAULT_TOKEN_METADATA } from './defaults';
import { getNativeDisplayMetadataSync } from './native';
import { AssetMetadata } from './types';

/** Resolve authoritative native metadata before cached display records. */
export function resolveDisplayMetadata(
  faucetId: string | undefined,
  assetsMetadata: Record<string, AssetMetadata> | undefined,
  nativeFaucetId: string | null
): AssetMetadata {
  if (faucetId === undefined) return getNativeDisplayMetadataSync(assetsMetadata?.[getNativeAssetIdSync() ?? '']);
  const stored = assetsMetadata?.[faucetId];
  if (faucetId === getNativeAssetIdSync()) return getNativeDisplayMetadataSync(stored, faucetId);
  if (stored) return stored;
  return nativeFaucetId !== null && faucetId === nativeFaucetId
    ? getNativeDisplayMetadataSync(stored, faucetId)
    : DEFAULT_TOKEN_METADATA;
}
