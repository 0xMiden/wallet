import { fetchFromStorage } from 'lib/miden/front/storage';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { FAUCET_ID_STORAGE_KEY } from './constants';

/**
 * Returns the legacy display faucet ID, honoring its optional settings override.
 * Otherwise uses the scoped native identity, discovered through the SDK client's
 * feeFaucetId() after a successful chain sync and cached per RPC endpoint and network.
 * Returns null while unknown. Fee decisions use getNativeAssetId() directly.
 */
export async function getFaucetIdSetting(): Promise<string | null> {
  const override = await fetchFromStorage<string>(FAUCET_ID_STORAGE_KEY);
  if (override) return override;
  try {
    return await getNativeAssetId();
  } catch (err) {
    console.warn('getFaucetIdSetting: native asset discovery failed', err);
    return null;
  }
}
