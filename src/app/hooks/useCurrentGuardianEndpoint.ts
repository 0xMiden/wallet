import { GUARDIAN_OPTIONS } from 'lib/miden-chain/constants';
import { getEffectiveDefaultGuardianEndpoint, getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import type { GuardianOption } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

/**
 * The guardian endpoint the current account actually uses. Mirrors the
 * backend's `resolveGuardianEndpoint`: the per-account `guardianEndpoint` (set
 * at create/recovery and updated on switch-guardian), else the effective
 * default, which is also what `initiate` stamps as `previousGuardianEndpoint`,
 * so the UI never disagrees with the record it is about to write.
 */
export function useCurrentGuardianEndpoint(): { endpoint: string } {
  const accountEndpoint = useWalletStore(s => s.currentAccount?.guardianEndpoint);
  return { endpoint: accountEndpoint || getEffectiveDefaultGuardianEndpoint() };
}

// Match a provider by its endpoint ON THE EFFECTIVE NETWORK only. The former
// any-network match branded a custom URL with a built-in provider's name
// whenever it collided with that provider's endpoint on ANOTHER network — most
// visibly a custom `http://localhost:3000` guardian on a devnet/testnet build,
// which is OpenZeppelin's LOCALNET endpoint, so the rotation review, switch
// success, history and settings all named it "OpenZeppelin" instead of the URL
// the user typed. An endpoint that isn't this network's built-in is a custom
// guardian and displays as its host (guardianEndpointDisplayName's fallback).
export function guardianOptionForEndpoint(endpoint: string): GuardianOption | undefined {
  return GUARDIAN_OPTIONS.find(o => o.endpoint.get(getEffectiveNetworkName()) === endpoint);
}

// "https://guardian.miden.io/foo" -> "guardian.miden.io"; falls back to the raw
// string for custom endpoints that don't parse as URLs.
export function guardianEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Built-in provider name, custom hostname, or a localized unknown fallback. */
export function guardianEndpointDisplayName(endpoint: string | undefined, unknownLabel: string): string {
  if (!endpoint) return unknownLabel;
  return (guardianOptionForEndpoint(endpoint)?.name ?? guardianEndpointHost(endpoint)) || unknownLabel;
}
