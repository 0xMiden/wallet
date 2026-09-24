/**
 * Guardian endpoint liveness probe for the guardian picker.
 *
 * Answers one question — "is this operator responding right now?" — via the
 * same unauthenticated `GET /pubkey` the operator reverse-map uses (see
 * `operator-map.ts`): no account data, no signer, and a real proof the
 * guardian service itself (not just some host at that URL) is up, since only
 * a guardian answers with a key commitment.
 *
 * Deliberately tiny and dependency-light: plain HTTP only, no WASM, no
 * intercom — it runs from onboarding screens where none of that is loaded.
 * A ping that fails for ANY reason (network error, timeout, non-guardian
 * response) reports offline, and the picker then disables that operator's
 * card until a later round reports it online.
 */
import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import { registerGuardianOrigin } from 'lib/miden/guardian/native-http';

/**
 * Per-ping deadline. Short on purpose: this verdict disables an operator's card
 * on the picker, and a guardian that can't answer an unauthenticated GET in this
 * window is effectively down for the co-signing flows that follow. The
 * guardian client exposes no abort, so a late response is simply dropped.
 */
export const GUARDIAN_PING_TIMEOUT_MS = 5_000;

/**
 * `true` iff the guardian at `endpoint` answers `GET /pubkey` with a key
 * commitment within `timeoutMs`. Never throws.
 */
export async function pingGuardianEndpoint(
  endpoint: string,
  timeoutMs: number = GUARDIAN_PING_TIMEOUT_MS
): Promise<boolean> {
  return (await pingGuardianEndpointLatency(endpoint, timeoutMs)) !== null;
}

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
  // Built-ins are pre-seeded for the mobile CORS bypass; register defensively
  // so a custom/overridden endpoint also routes through native HTTP.
  registerGuardianOrigin(endpoint);
  const startedAt = performance.now();
  try {
    const result = await new Promise<{ commitment?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`guardian ping to ${endpoint} timed out`)), timeoutMs);
      new GuardianHttpClient(endpoint).getPubkey('ecdsa').then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
    // A STRING commitment, not merely a truthy one. The body is an unchecked
    // `response.json()` cast, so `{"commitment": 1234}` reaches here as a number
    // and `Boolean(1234)` reported a host serving nonsense as a live guardian —
    // the same unvalidated value `fetchOperatorCommitment` refuses, on the same
    // endpoint, for the same reason. Fails toward "offline", which is what every
    // other non-guardian response already reports.
    const isGuardian = typeof result?.commitment === 'string' && result.commitment.length > 0;
    return isGuardian ? Math.max(0, Math.round(performance.now() - startedAt)) : null;
  } catch {
    return null;
  }
}
