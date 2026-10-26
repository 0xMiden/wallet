/**
 * Guardian endpoint liveness and latency probe for the guardian screens.
 *
 * Answers "is this operator responding right now, and how fast?" via the
 * same unauthenticated `GET /pubkey` the operator reverse-map uses (see
 * `operator-map.ts`): no account data, no signer, and a real proof the
 * guardian service itself (not just some host at that URL) is up, since only
 * a guardian answers with a key commitment.
 *
 * Deliberately tiny and dependency-light: plain HTTP only, no WASM, no
 * intercom — it runs from onboarding screens where none of that is loaded.
 * A ping that fails for ANY reason (network error, timeout, non-guardian
 * response) reports offline: the picker disables that operator's card until a
 * later round reports it online, and onboarding never picks it.
 */
import { isGuardianKeyCommitment } from 'lib/miden/guardian/key-commitment';
import { fetchOperatorCommitment } from 'lib/miden/guardian/operator-map';

/**
 * Per-ping deadline. Short on purpose: this verdict disables an operator's card
 * on the picker, and a guardian that can't answer an unauthenticated GET in this
 * window is effectively down for the co-signing flows that follow. The
 * guardian client exposes no abort, so a late response is simply dropped.
 */
export const GUARDIAN_PING_TIMEOUT_MS = 5_000;

/**
 * The round trip of one `GET /pubkey`, in milliseconds, when the guardian at
 * `endpoint` answers with a key commitment within `timeoutMs`; `null` when it
 * does not. The onboarding step that picks a guardian for the user ranks the
 * operators by this number. Never throws.
 */
export async function pingGuardianEndpointLatency(
  endpoint: string,
  timeoutMs: number = GUARDIAN_PING_TIMEOUT_MS
): Promise<number | null> {
  // One try around everything, so the ping cannot reject whatever the helper below does.
  try {
    const startedAt = performance.now();
    // Probes the origin on mobile, and settles it by the same rule as the verdict below.
    const commitment = await fetchOperatorCommitment(endpoint, timeoutMs);
    return isGuardianKeyCommitment(commitment) ? Math.max(0, Math.round(performance.now() - startedAt)) : null;
  } catch {
    // Offline, whatever the cause.
    return null;
  }
}
