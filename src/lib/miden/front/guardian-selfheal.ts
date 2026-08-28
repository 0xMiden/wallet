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
 *  - `refused-transiently`  — could not tell (unreadable account/commitment); no
 *                             guardian traffic happened, so retry later for free.
 *  - `evicted`              — the WASM client was evicted under the attempt. A
 *                             SEPARATE outcome rather than one of the three above,
 *                             because it is the only one that is not a statement
 *                             about the OPERATOR at all, and the caller has to do
 *                             two things no other outcome asks for: stop the pass
 *                             (the abandoned call still holds a borrow of a client
 *                             the mutex has already handed on) and book the
 *                             eviction against the realm's sync fuse. Folded into
 *                             `attempted` it charged a LOCAL failure to the
 *                             operator's budget and, three deep, accused a healthy
 *                             guardian of "rejecting this device"; folded into
 *                             `refused-transiently` it refunded a `/configure`
 *                             that an abandoned-not-cancelled call may still land.
 */
export type SelfHealOutcome = 'attempted' | 'refused-permanently' | 'refused-transiently' | 'evicted';

// The BOUNDED RETRY and COOLDOWN halves of the decision live in the shared
// `guardian/attempt-ledger.ts` (the sync module's `selfHealLedger`); the
// PERSISTENCE gate stays at the caller, against `consecutiveAuthFailures`.
// This module keeps the constants and the outcome contract.
