import { accountRefToSdk, getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';

// Apart from the swap registry, which reaches the metadata modules: the metadata overrides read the token labels,
// and the labels read these, so a label module importing the registry would close an import cycle.

/** The swap registry's iETH faucet (`TOKEN_IETH`). */
export const IETH_FAUCET_ID = 'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h';

// Keyed by the network name getNetworkId derives from: the NetworkId object itself does not
// stringify. Only a parsed id is stored, so a failed parse is retried once the SDK can parse the id.
const normalizedFaucetIds = new Map<string, string>();

/** Test-only: forget every cached conversion. */
export const _resetNormalizedFaucetIdsForTest = (): void => normalizedFaucetIds.clear();

/**
 * The SDK's bech32 form of a faucet id in any encoding (hex, bech32 or the composite
 * `<address>_<suffix>`), so every spelling of one faucet reduces to one id. Throws when the SDK
 * cannot parse the id, as it does for every id until its WASM has loaded.
 */
export function canonicalFaucetId(faucetId: string): string {
  const key = `${getEffectiveNetworkName()}:${faucetId}`;
  const cached = normalizedFaucetIds.get(key);
  if (cached !== undefined) return cached;
  const canonical = getBech32AddressFromAccountId(accountRefToSdk(faucetId));
  normalizedFaucetIds.set(key, canonical);
  return canonical;
}

/** The balance store's key for a faucet id: its canonical id, or the raw id if the SDK cannot parse it yet. */
export function normalizedFaucetId(faucetId: string): string {
  try {
    return canonicalFaucetId(faucetId);
  } catch {
    return faucetId;
  }
}
