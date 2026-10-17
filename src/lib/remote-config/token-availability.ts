import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';

import type { BridgeConfigSnapshot } from './runtime';
import { epochCollateralFaucetId } from './schema';

// New-transfer UI only. Balances, history and recovery keep the configured legacy identity.

const sameFaucet = (faucetId: string, other: string | null | undefined): boolean =>
  !!other && normalizedFaucetId(faucetId) === normalizedFaucetId(other);

/** Whether the Testnet document names `faucetId` as the retired Epoch USDC faucet; the native asset never is. */
export function isRetiredTransferToken(
  snapshot: BridgeConfigSnapshot,
  faucetId: string | undefined,
  nativeFaucetId: string | null | undefined
): boolean {
  if (snapshot.network !== 'testnet' || !faucetId || !snapshot.config) return false;
  return sameFaucet(faucetId, epochCollateralFaucetId(snapshot.config)) && !sameFaucet(faucetId, nativeFaucetId);
}

/**
 * Whether new selection and submission hold `faucetId` back. Until a document identifies the retired faucet, every
 * Testnet token but the native asset is held rather than risk a cached legacy one; after that, only that faucet is.
 * A hold destroys nothing: what the user already chose goes only once `isRetiredTransferToken` says so.
 */
export function isNewTransferTokenHeld(
  snapshot: BridgeConfigSnapshot,
  faucetId: string | undefined,
  nativeFaucetId: string | null | undefined
): boolean {
  if (snapshot.network !== 'testnet' || !faucetId) return false;
  if (!snapshot.config) return !sameFaucet(faucetId, nativeFaucetId);
  return isRetiredTransferToken(snapshot, faucetId, nativeFaucetId);
}
