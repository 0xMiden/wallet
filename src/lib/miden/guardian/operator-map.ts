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

/** Outcome of asking one endpoint whether it holds a given commitment. */
export type EndpointCommitmentCheck = 'match' | 'mismatch' | 'unreachable';

/**
 * Per-check deadline. The guardian client exposes no abort, so a late response
 * is dropped rather than cancelled — but the wait itself must be bounded,
 * because this runs from the ~3s guardian-sync tick and a hanging operator would
 * otherwise park a request per tick indefinitely. Same budget as the picker's
 * liveness ping.
 */
const ENDPOINT_CHECK_TIMEOUT_MS = 5_000;

/**
 * Ask one endpoint whether its operator key matches `onChainCommitment`,
 * distinguishing "it said no" from "it never answered".
 *
 * The distinction is the point: a caller that collapses them cannot tell a
 * genuine out-of-band guardian switch from a network blip, and treating a blip
 * as a mismatch accuses an endpoint that may be perfectly correct.
 */
export async function checkEndpointCommitment(
  endpoint: string,
  onChainCommitment: string
): Promise<EndpointCommitmentCheck> {
  try {
    const commitment = await new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`guardian pubkey check for ${endpoint} timed out`)),
        ENDPOINT_CHECK_TIMEOUT_MS
      );
      new GuardianHttpClient(endpoint).getPubkey('ecdsa').then(
        value => {
          clearTimeout(timer);
          resolve(value?.commitment);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
    // An answer with no commitment is not a guardian answering, so it is no
    // more evidence of a mismatch than a dropped connection is.
    if (!commitment) return 'unreachable';
    return normalizeHex(commitment) === normalizeHex(onChainCommitment) ? 'match' : 'mismatch';
  } catch {
    return 'unreachable';
  }
}

/**
 * Verify a specific endpoint's operator key matches the on-chain commitment.
 *
 * Boolean by design for callers that are about to WRITE the endpoint: there,
 * unreachable and mismatched are the same answer — do not persist something that
 * could not be confirmed. Callers that instead have to choose between "leave it
 * alone" and "flag the user" want `checkEndpointCommitment`.
 */
export async function verifyEndpointMatchesCommitment(endpoint: string, onChainCommitment: string): Promise<boolean> {
  return (await checkEndpointCommitment(endpoint, onChainCommitment)) === 'match';
}
