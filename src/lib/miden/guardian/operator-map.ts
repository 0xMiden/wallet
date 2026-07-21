/**
 * Reverse-maps an on-chain guardian public-key commitment back to the
 * built-in Guardian operator that holds it, so the wallet can tell the user
 * "your guardian is OpenZeppelin" instead of just showing a raw commitment.
 *
 * Each built-in operator's key is fetched unauthenticated via `GET /pubkey`
 * (no account data, no signer) — see `GuardianHttpClient.getPubkey` in
 * `@openzeppelin/guardian-client`. An operator that's unreachable at the
 * moment of the lookup is skipped rather than failing the whole map: a
 * transient outage on one operator shouldn't block identifying a guardian
 * that matches a different, reachable operator.
 */
import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import { DEFAULT_NETWORK, getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { MIDEN_NETWORK_NAME, ResolvedGuardianOption } from 'lib/miden-chain/constants';

/** Strip an optional `0x` prefix and lowercase, so commitments from different sources compare equal. */
export function normalizeHex(h: string): string {
  return (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
}

/** Fetch each built-in operator's public key commitment (HTTP GET /pubkey, no auth). */
export async function buildOperatorKeyMap(
  network: MIDEN_NETWORK_NAME = DEFAULT_NETWORK
): Promise<Map<string, ResolvedGuardianOption>> {
  const options = getGuardianOptionsForNetwork(network);
  const map = new Map<string, ResolvedGuardianOption>();
  await Promise.all(
    options.map(async option => {
      try {
        const { commitment } = await new GuardianHttpClient(option.endpoint).getPubkey('ecdsa');
        if (commitment) map.set(normalizeHex(commitment), option);
      } catch {
        // Operator unreachable right now — skip it; a later call retries.
      }
    })
  );
  return map;
}

/** Which built-in operator holds this on-chain guardian commitment? undefined => unknown/custom/rotated. */
export async function identifyGuardianOperator(
  onChainCommitment: string,
  network: MIDEN_NETWORK_NAME = DEFAULT_NETWORK
): Promise<ResolvedGuardianOption | undefined> {
  const map = await buildOperatorKeyMap(network);
  return map.get(normalizeHex(onChainCommitment));
}

/** Verify a specific endpoint's operator key matches the on-chain commitment. */
export async function verifyEndpointMatchesCommitment(endpoint: string, onChainCommitment: string): Promise<boolean> {
  try {
    const { commitment } = await new GuardianHttpClient(endpoint).getPubkey('ecdsa');
    return Boolean(commitment) && normalizeHex(commitment) === normalizeHex(onChainCommitment);
  } catch {
    return false;
  }
}
