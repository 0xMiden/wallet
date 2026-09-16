/**
 * The guardian request-auth self-heal's policy constants and its outcome
 * contract, read by `guardian-sync.ts`. The decision itself is no longer here:
 * the PERSISTENCE gate is the caller's `consecutiveAuthFailures` streak, and
 * the bounded retry and the cooldown are the shared `selfHealLedger`
 * (`guardian/attempt-ledger.ts`), which these constants configure.
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
 *  - PERSISTENCE (the caller's, against `SELF_HEAL_AUTH_FAILURE_THRESHOLD`):
 *    only after the 401 persists across that many consecutive sync ticks.
 *    Transient skew, replay and pre-canonicalization 401s clear within a tick
 *    or two, so requiring several in a row rules them out.
 *  - BOUNDED RETRY and COOLDOWN (the ledger's, from `SELF_HEAL_MAX_ATTEMPTS`
 *    and `SELF_HEAL_COOLDOWN_MS`): `reRegisterCurrentStateOnGuardian`
 *    re-registers the CURRENT ON-CHAIN signer set, so it can only ever
 *    authorize a real on-chain signer. If that does not clear the 401 within
 *    the cap, the local signer genuinely is not the on-chain signer (a
 *    corrupted local record) and re-registering cannot help, so the budget
 *    closes rather than looping forever; the gap between attempts keeps a
 *    persistently-failing `/configure` from storming the guardian.
 */

/** Consecutive auth-rejections (401s) required before the first self-heal attempt. */
export const SELF_HEAL_AUTH_FAILURE_THRESHOLD = 3;
/** Maximum cold re-register attempts before giving up on an account. */
export const SELF_HEAL_MAX_ATTEMPTS = 3;
/** Minimum gap between self-heal attempts for one account. */
export const SELF_HEAL_COOLDOWN_MS = 60_000;

/**
 * What one self-heal invocation actually did, so the caller can book the
 * bounded budget against work rather than against calls.
 *
 * The distinction matters because the budget is only reset by a SUCCESSFUL sync
 * — and a stale allowlist is exactly what prevents one. So an invocation that
 * bailed out before touching the guardian must not consume an attempt, or three
 * unlucky local read failures permanently disable the repair for the account.
 *
 *  - `attempted`            — `/configure` was issued (landed or threw); a real try.
 *  - `refused-permanently`  — this device is provably not the account's signer any
 *                             more; no later tick can change that, so stop asking.
 *  - `refused-transiently`  - could not tell (unreadable account/commitment); no
 *                             guardian traffic happened, so retry later for free.
 *  - `evicted`              - the WASM client was evicted AFTER `/configure` was
 *                             issued. A SEPARATE outcome rather than one of the
 *                             three above, because it is the only one that is not a
 *                             statement about the OPERATOR at all, and the caller
 *                             has to stop the pass: the abandoned call still holds
 *                             a borrow of a client the mutex has already handed on.
 *                             Folded into `attempted` it also reached the
 *                             "the operator keeps rejecting this device" marking
 *                             with a purely local failure.
 *  - `evicted-preflight`    - the WASM client was evicted BEFORE `/configure` was
 *                             issued. Split from `evicted` because the two settle
 *                             the budget in opposite directions and the difference
 *                             is the whole reason the budget exists. An eviction
 *                             past the issue point must CHARGE: abandoned is not
 *                             cancelled, so the POST may still land and a refund
 *                             would let the next tick prepare a second one. An
 *                             eviction before it prepared nothing, so charging it
 *                             is the "three local read failures disable the repair
 *                             for good" mistake `refused-transiently` exists to
 *                             avoid, and worse, since the caller stops the pass on
 *                             an eviction it never reaches the check that raises the
 *                             prompt, leaving a spent budget with nothing on screen.
 *                             Both stop the pass; only this one refunds.
 */
export type SelfHealOutcome =
  | 'attempted'
  | 'refused-permanently'
  | 'refused-transiently'
  | 'evicted'
  | 'evicted-preflight';
