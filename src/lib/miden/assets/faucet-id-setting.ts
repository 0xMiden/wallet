import { fetchFromStorage } from 'lib/miden/front/storage';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { FAUCET_ID_STORAGE_KEY } from './constants';

/**
 * Returns the faucet ID the wallet should treat as the native asset, or `null`
 * if discovery hasn't completed yet (first install + offline, or a transient
 * RPC failure).
 *
 * Resolution order:
 *   1. user override (dev-mode escape hatch, written from EditMidenFaucetId)
 *   2. discovered native asset ID (BlockHeader.feeFaucetId(), keyed per RPC node)
 *   3. `null`: callers must tolerate unknown-native-asset by falling through
 *      comparisons to "not MIDEN" so the rest of the UI still works
 *
 * No hardcoded fallback by design: if we guessed wrong, MIDEN-tagged UI
 * would render under the wrong token ID until discovery corrected it. Better
 * to show no MIDEN branding than to show it under a stale ID.
 *
 * A leaf module so the transaction layer can read it (#805): `./utils` imports the
 * `lib/miden/front` barrel, which loads the whole provider tree.
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
