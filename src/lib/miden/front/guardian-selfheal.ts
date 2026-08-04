/**
 * Pure decision logic for the guardian request-auth self-heal (used by
 * `guardian-sync.ts`). Kept import-free so it is directly unit-testable without
 * mocking the store / SDK / guardian client that the sync module pulls in.
 *
 * Background: a guardian account authenticates every request against a stored
 * `cosigner_commitments` allowlist. That allowlist is written both by an
 * explicit `/configure` AND, for guardian v0.16.0, by the guardian's own
 * canonicalization (it re-derives the allowlist from the on-chain signer set
 * whenever a co-signed delta lands). Because every guardian-account state change
 * is guardian-co-signed, a rotation self-syncs the allowlist WITHOUT a
 * `/configure` re-register — so the common "post-rotation re-register failed ->
 * stuck" case does NOT occur on v0.16.0 (verified against the guardian server).
 *
 * This self-heal is therefore defensive, for the genuinely-stuck residual: a
 * never-`/configure`d account, or an on-chain signer set the guardian never
 * canonicalized. A raw 401 is NOT a sufficient trigger — the server collapses
 * stale-allowlist, clock-skew, and replay-protection failures into one
 * `authentication_failed`/401. So:
 *
 *  - PERSISTENCE: only after the 401 persists across `AUTH_FAILURE_THRESHOLD`
 *    consecutive sync ticks. Transient skew/replay/pre-canonicalization 401s
 *    clear within a tick or two, so requiring several in a row rules them out.
 *  - BOUNDED RETRY: `reRegisterCurrentStateOnGuardian` re-registers the CURRENT
 *    ON-CHAIN signer set, so it can only ever authorize a real on-chain signer.
 *    If it doesn't clear the 401 within `MAX_ATTEMPTS`, the local signer is
 *    genuinely not the on-chain signer (a corrupted local record) and
 *    re-registering can't help — stop, rather than loop forever.
 *  - COOLDOWN between attempts so a persistently-failing `/configure` can't
 *    storm the guardian.
 */

/** Consecutive auth-rejections (401s) required before the first self-heal attempt. */
export const SELF_HEAL_AUTH_FAILURE_THRESHOLD = 3;
/** Maximum cold re-register attempts before giving up on an account. */
export const SELF_HEAL_MAX_ATTEMPTS = 3;
/** Minimum gap between self-heal attempts for one account. */
export const SELF_HEAL_COOLDOWN_MS = 60_000;

export interface SelfHealAttemptState {
  /** Number of cold re-register attempts already made for this account. */
  attempts: number;
  /** `Date.now()` of the last attempt. */
  lastAttemptAt: number;
}

/**
 * Decide whether to attempt a cold re-register self-heal for an account right
 * now. Pure (all state passed in) so it is exhaustively unit-testable.
 *
 * @param now                     current `Date.now()`
 * @param consecutiveAuthFailures consecutive 401s observed for this account
 *                                (reset to 0 on any successful sync)
 * @param state                   prior attempt state, or `undefined` if none
 */
export function decideColdReRegisterSelfHeal(
  now: number,
  consecutiveAuthFailures: number,
  state: SelfHealAttemptState | undefined
): boolean {
  // Rule out transient 401s: require the failure to persist.
  if (consecutiveAuthFailures < SELF_HEAL_AUTH_FAILURE_THRESHOLD) return false;

  const attempts = state?.attempts ?? 0;
  // Give up once re-registering the on-chain signer set has demonstrably not
  // fixed it (the signer isn't the on-chain signer — nothing to re-authorize).
  if (attempts >= SELF_HEAL_MAX_ATTEMPTS) return false;

  // Rate-limit attempts.
  if (state && now - state.lastAttemptAt < SELF_HEAL_COOLDOWN_MS) return false;

  return true;
}
