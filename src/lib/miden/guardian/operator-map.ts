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

import { registerGuardianOrigin } from 'lib/miden/guardian/native-http';
import { getGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
import type { MIDEN_NETWORK_NAME, ResolvedGuardianOption } from 'lib/miden-chain/constants';

/** Strip an optional `0x` prefix and lowercase, so commitments from different sources compare equal. */
export function normalizeHex(h: string): string {
  return (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();
}

/**
 * Per-request deadline for the unauthenticated `GET /pubkey` probes below. The
 * guardian client exposes no abort, so a late response is dropped rather than
 * cancelled — but the wait itself must be bounded, because these run from the
 * ~3s guardian-sync tick and a hanging operator would otherwise park a request
 * per tick indefinitely. Same budget as the picker's liveness ping.
 */
const ENDPOINT_CHECK_TIMEOUT_MS = 5_000;

/**
 * One operator's key commitment, or `undefined` if it did not answer in time.
 *
 * `registerGuardianOrigin` first: on mobile, guardian traffic reaches the
 * network only through the `CapacitorHttp` CORS bypass, and that interceptor
 * routes registered origins only. The built-ins are pre-seeded, so this matters
 * for the custom / self-hosted endpoint — which is exactly the endpoint the
 * drift reconciler and the manual-URL apply below hand to this function, so
 * without it those two paths report every custom operator unreachable on mobile.
 */
async function fetchOperatorCommitment(
  endpoint: string,
  timeoutMs: number = ENDPOINT_CHECK_TIMEOUT_MS
): Promise<string | undefined> {
  registerGuardianOrigin(endpoint);
  return new Promise<string | undefined>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`guardian pubkey check for ${endpoint} timed out`)), timeoutMs);
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
}

/**
 * Fetch each built-in operator's public key commitment (HTTP GET /pubkey, no auth).
 *
 * `network` is passed straight through rather than defaulted here, so it lands on
 * `getGuardianOptionsForNetwork`'s own default — the EFFECTIVE network. Defaulting
 * it to the build-time network instead meant that with a developer endpoint
 * override active, this probed the operator set of a different network than the
 * account actually lives on, and reported every one of them as not holding the
 * account's guardian key.
 */
export async function buildOperatorKeyMap(network?: MIDEN_NETWORK_NAME): Promise<Map<string, ResolvedGuardianOption>> {
  const options = getGuardianOptionsForNetwork(network);
  const map = new Map<string, ResolvedGuardianOption>();
  await Promise.all(
    options.map(async option => {
      try {
        const commitment = await fetchOperatorCommitment(option.endpoint);
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
  network?: MIDEN_NETWORK_NAME
): Promise<ResolvedGuardianOption | undefined> {
  const map = await buildOperatorKeyMap(network);
  return map.get(normalizeHex(onChainCommitment));
}

/** Outcome of asking one endpoint whether it holds a given commitment. */
export type EndpointCommitmentCheck = 'match' | 'mismatch' | 'unreachable';

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
    const commitment = await fetchOperatorCommitment(endpoint);
    // An answer with no commitment is not a guardian answering, so it is no
    // more evidence of a mismatch than a dropped connection is.
    if (!commitment) return 'unreachable';
    return normalizeHex(commitment) === normalizeHex(onChainCommitment) ? 'match' : 'mismatch';
  } catch {
    return 'unreachable';
  }
}

/**
 * Deadline for the one-shot, user-initiated verification below.
 *
 * Much longer than the tick budget, and for the opposite reason: the tick's 5s
 * exists because it repeats every ~3s, while this fires once when the user
 * submits a URL and has no successor to defer to. Reusing 5s here made a
 * cold-starting but perfectly correct self-hosted operator report as the WRONG
 * operator — the harshest possible reading of "slow".
 */
const USER_ENDPOINT_CHECK_TIMEOUT_MS = 20_000;

/**
 * Verify a specific endpoint's operator key matches the on-chain commitment.
 *
 * Boolean by design for callers that are about to WRITE the endpoint: there,
 * unreachable and mismatched are the same answer — do not persist something that
 * could not be confirmed. Callers that instead have to choose between "leave it
 * alone" and "flag the user" want `checkEndpointCommitment`.
 */
export async function verifyEndpointMatchesCommitment(endpoint: string, onChainCommitment: string): Promise<boolean> {
  try {
    const commitment = await fetchOperatorCommitment(endpoint, USER_ENDPOINT_CHECK_TIMEOUT_MS);
    if (!commitment) return false;
    return normalizeHex(commitment) === normalizeHex(onChainCommitment);
  } catch {
    return false;
  }
}
