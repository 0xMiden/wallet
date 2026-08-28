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
 * that matches a different, reachable operator. It does, however, stop the
 * round from being able to say "no built-in holds this key" — see
 * `identifyGuardianOperator`, whose callers act on that difference.
 *
 * "Built-in" here means wallet code only. `getBuiltInGuardianOptionsForNetwork`
 * excludes the developer guardian-URL override that the onboarding picker's
 * `getGuardianOptionsForNetwork` appends, because this module is read as a
 * second source ABOUT a stored endpoint, and a persisted setting is the same
 * category of mutable state as the endpoint it would be checking.
 */
import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import { registerGuardianOrigin } from 'lib/miden/guardian/native-http';
import { getBuiltInGuardianOptionsForNetwork } from 'lib/miden-chain/constants';
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
 *
 * A non-string commitment is "did not answer", not a value. The guardian client
 * returns `data.commitment` off an unchecked `response.json()` cast, so the type
 * is whatever the endpoint chose to serve; `normalizeHex` calls `.startsWith` on
 * it, and the fold that does so in `probeBuiltInOperators` runs OUTSIDE the
 * per-operator catch. One endpoint answering `{"commitment": 1234}` therefore
 * threw a `TypeError` out of the whole fan-out and took drift reconciliation down
 * for every account on the device, including accounts pointed at other, healthy
 * operators — the opposite of the isolation this module is built to provide.
 * Rejecting it HERE rather than guarding the fold is what gives all four callers
 * the same guarantee and keeps the `answered < asked` bookkeeping honest: an
 * endpoint serving a nonsense type is exactly as informative as one that is down,
 * so it must not complete a round that `'none'` requires to be complete.
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
        const commitment: unknown = value?.commitment;
        if (commitment !== undefined && typeof commitment !== 'string') {
          console.warn(`[Guardian] ${endpoint} served a non-string key commitment; treating it as unanswered.`);
          resolve(undefined);
          return;
        }
        resolve(commitment);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** What one probe round of the built-in operators established. */
interface BuiltInOperatorProbe {
  /** Commitment → the single built-in that served it. Contested keys are absent. */
  byCommitment: Map<string, ResolvedGuardianOption>;
  /** Commitments served by MORE THAN ONE built-in, and therefore by none we can name. */
  contested: Set<string>;
  /** How many built-ins were asked, and how many answered with a commitment. */
  asked: number;
  answered: number;
}

/**
 * Ask every built-in operator for its public key commitment (GET /pubkey, no auth).
 *
 * `network` is passed straight through rather than defaulted here, so it lands on
 * `getBuiltInGuardianOptionsForNetwork`'s own default — the EFFECTIVE network.
 * Defaulting it to the build-time network instead meant that with a developer
 * endpoint override active, this probed the operator set of a different network
 * than the account actually lives on, and reported every one of them as not
 * holding the account's guardian key.
 *
 * The answers are collected first and folded into the map afterwards, in
 * GUARDIAN_OPTIONS order. Writing the map from inside the concurrent callbacks
 * instead made the winner of a commitment served by two options the one whose
 * HTTP response landed first — an outcome decided by latency, and the faster
 * endpoint is the one an attacker would be operating.
 *
 * A commitment two built-ins both claim is dropped rather than awarded to
 * either. They cannot both be the operator the chain names, so one of them is
 * misconfigured or answering for a host it does not own, and nothing here can
 * tell which — while `identifyGuardianOperator`'s answer decides which endpoint
 * an account gets repaired to. Declining reports the collision as
 * `'unavailable'` (below), which every caller treats as "no evidence" rather
 * than as "no built-in serves this".
 */
async function probeBuiltInOperators(network?: MIDEN_NETWORK_NAME): Promise<BuiltInOperatorProbe> {
  const options = getBuiltInGuardianOptionsForNetwork(network);
  const answers = await Promise.all(
    options.map(async option => {
      try {
        return { option, commitment: await fetchOperatorCommitment(option.endpoint) };
      } catch {
        // Operator unreachable right now — a later call retries. Counted as
        // unanswered, which is what keeps a partial round from reading as proof.
        return { option, commitment: undefined };
      }
    })
  );

  const byCommitment = new Map<string, ResolvedGuardianOption>();
  const contested = new Set<string>();
  let answered = 0;
  for (const { option, commitment } of answers) {
    if (!commitment) continue;
    answered++;
    const key = normalizeHex(commitment);
    if (contested.has(key)) continue;
    const incumbent = byCommitment.get(key);
    if (incumbent) {
      byCommitment.delete(key);
      contested.add(key);
      console.warn(
        `[Guardian] two built-in operators serve the same guardian key: ${incumbent.endpoint} and ` +
          `${option.endpoint}. Neither can be named as the holder of ${key}.`
      );
      continue;
    }
    byCommitment.set(key, option);
  }

  return { byCommitment, contested, asked: options.length, answered };
}

/**
 * Commitment → built-in operator for one probe round, for callers resolving MANY
 * commitments against a single fan-out (`Vault.backfillGuardianEndpoints`). An
 * absent key conflates all three outcomes `identifyGuardianOperator` separates
 * below, which that caller can afford: its only action on a miss is to leave the
 * account untouched and retry on the next unlock.
 */
export async function buildOperatorKeyMap(network?: MIDEN_NETWORK_NAME): Promise<Map<string, ResolvedGuardianOption>> {
  return (await probeBuiltInOperators(network)).byCommitment;
}

/** Result of a built-in-operator lookup: a named holder, a negative, or neither. */
export type GuardianOperatorLookup =
  | { outcome: 'identified'; operator: ResolvedGuardianOption }
  | { outcome: 'none' }
  | { outcome: 'unavailable' };

/**
 * Which built-in operator holds this on-chain guardian commitment?
 *
 * Three outcomes, because a caller weighing this against an endpoint's own
 * self-report acts on the difference between the last two:
 *
 *  - `'identified'` — a built-in served exactly this commitment. Positive
 *    evidence, and complete on its own: nothing another operator answers can
 *    subtract from it, so an unreachable sibling does not weaken it.
 *  - `'none'` — every built-in answered and none of them serves this
 *    commitment. That is a real finding: the guardian is a custom operator.
 *  - `'unavailable'` — the round could not establish either. Some built-in did
 *    not answer, or two of them claimed this commitment and the collision was
 *    declined (see `probeBuiltInOperators`).
 *
 * Collapsing `'unavailable'` into `'none'` is what made a captive network, an
 * offline device or a targeted outage indistinguishable from "the guardian is
 * custom" — and `resolveGuardianDrift` PERMANENTLY latches an endpoint's
 * self-report on the strength of a `'none'`.
 *
 * `'none'` requires a COMPLETE round, not merely a non-empty one. A partial
 * round cannot rule out that the built-in which stayed silent is the very one
 * holding the key, so an attacker who could suppress a single operator would
 * otherwise buy himself a `'none'`. The cost is that a genuinely custom
 * operator's account keeps re-probing (once per drift-probe window) while ANY
 * built-in is unreachable, instead of settling; it settles as soon as one round
 * completes. A network with no built-in operators at all answers `'none'`
 * immediately, which is correct rather than a degenerate case: there is nothing
 * that could have served the key.
 */
export async function identifyGuardianOperator(
  onChainCommitment: string,
  network?: MIDEN_NETWORK_NAME
): Promise<GuardianOperatorLookup> {
  const { byCommitment, contested, asked, answered } = await probeBuiltInOperators(network);
  const key = normalizeHex(onChainCommitment);
  const operator = byCommitment.get(key);
  if (operator) return { outcome: 'identified', operator };
  if (contested.has(key) || answered < asked) return { outcome: 'unavailable' };
  return { outcome: 'none' };
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
 *
 * `timeoutMs` defaults to the tick budget, which is correct only for a caller
 * that repeats: 5s is affordable because a ~3s tick tries again. A ONE-SHOT
 * caller has no successor to defer to and must pass a generous value, or a
 * cold-starting but perfectly correct self-hosted operator reads as `unreachable`
 * on its only chance — the same mistake `USER_ENDPOINT_CHECK_TIMEOUT_MS` below
 * exists to record.
 */
export async function checkEndpointCommitment(
  endpoint: string,
  onChainCommitment: string,
  timeoutMs?: number
): Promise<EndpointCommitmentCheck> {
  try {
    const commitment = await fetchOperatorCommitment(endpoint, timeoutMs);
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
