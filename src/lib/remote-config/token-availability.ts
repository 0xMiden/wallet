import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';

import type { BridgeConfigSnapshot } from './runtime';
import { epochCollateralFaucetId } from './schema';

/** New-transfer UI only. Keep the configured legacy identity for balances, history and recovery. */
export function isNewTransferTokenBlocked(snapshot: BridgeConfigSnapshot, faucetId: string | undefined): boolean {
  if (snapshot.network !== 'testnet' || !faucetId) return false;
  // Until the document identifies the retired faucet, hold new selections rather than allow a cached legacy one.
  if (!snapshot.config) return true;
  const legacy = epochCollateralFaucetId(snapshot.config);
  const native = getNativeAssetIdSync();
  const id = normalizedFaucetId(faucetId);
  return !!legacy && id === normalizedFaucetId(legacy) && (!native || id !== normalizedFaucetId(native));
}
