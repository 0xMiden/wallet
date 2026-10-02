/**
 * Per-account serialization + conflict-retry for guardian (multisig) transactions.
 *
 * Why: the guardian co-signs ONE delta per account at a time. While a delta is
 * being canonicalized it sets `has_pending_candidate`, so a second
 * `POST /delta/proposal` for the same account returns `409 ConflictPendingDelta`.
 * Worse, if two transactions mutate the same account concurrently, the
 * on-chain commitment advances past the guardian's single-delta expected
 * commitment, so its `verify_state` never matches and canonicalization stalls
 * for up to its full grace period (~10 min in prod) — observed as multi-minute
 * "stuck claim" hangs under concurrent load (see OpenZeppelin/guardian#303).
 *
 * Fix: (1) serialize guardian transactions per account so at most one is ever
 * in flight, (2) before a send, consume, swap, earn-deposit or execute proposal,
 * ask the guardian whether the candidate this realm's previous write left there
 * has settled, and requeue the row while it has not (#312), and (3) for a
 * structural proposal or a bridged send (Epoch or Agglayer) that still conflicts,
 * wait it out in process instead of failing the transaction.
 */

import { monotonicNowMs } from 'lib/miden/sync-backoff';

const noop = (): void => {};
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Tail of the per-account serialization chain. The stored promise NEVER rejects,
// so one transaction's failure can't poison the queue for the next.
const guardianTxChains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after any previously-queued guardian transaction for `accountId`
 * has settled, so same-account guardian transactions never overlap. The
 * returned promise carries `fn`'s real result/error; queued work runs whether
 * the prior transaction succeeded or failed.
 */
export function withGuardianAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = guardianTxChains.get(accountId) ?? Promise.resolve();
  // `prev.then(fn, fn)` runs fn once prev settles either way (a failed prior tx
  // must not skip the next one). fn takes no args, so the settle value is ignored.
  const run = prev.then(fn, fn);
  const tail = run.then(noop, noop);
  guardianTxChains.set(accountId, tail);
  // Evict the entry once it's the idle tail so the map can't retain settled
  // promises forever; don't clobber a newer queued chain.
  void tail.then(() => {
    if (guardianTxChains.get(accountId) === tail) guardianTxChains.delete(accountId);
  });
  return run;
}

/**
 * The candidate a Guardian write left on its Guardian once its submit resolved:
 * the Guardian (`endpoint`, spelled as the service that proposed it spells it)
 * and the delta's `nonce`. The next proposal on the account asks the Guardian
 * about it before proposing (#312).
 */
export interface GuardianCandidate {
  endpoint: string;
  nonce: number;
}

// Per realm, keyed like the lock chains above (the canonical account id), and dropped with them.
const guardianCandidates = new Map<string, GuardianCandidate>();

/** Record the candidate a write on `accountId` left on its Guardian, replacing any earlier one. */
export function recordGuardianCandidate(accountId: string, candidate: GuardianCandidate): void {
  guardianCandidates.set(accountId, candidate);
}

/** The candidate recorded for `accountId`, if any. */
export function getGuardianCandidate(accountId: string): GuardianCandidate | undefined {
  return guardianCandidates.get(accountId);
}

/** Forget `accountId`'s candidate, unless a later write has since recorded another nonce. */
export function clearGuardianCandidate(accountId: string, nonce: number): void {
  if (guardianCandidates.get(accountId)?.nonce === nonce) guardianCandidates.delete(accountId);
}

/** Drop all per-account guardian transaction locks and recorded candidates. */
export function clearGuardianAccountLocks(): void {
  guardianTxChains.clear();
  guardianCandidates.clear();
}

/**
 * A guardian `409` that is transient and worth waiting on — i.e. a pending
 * delta/proposal that clears once canonicalization completes.
 *
 * An ALLOWLIST when the guardian gave us a machine-readable code, because 409 is
 * not one condition. The vocabulary carries at least three non-transient members
 * (`account_paused`, `account_released`, `candidate_landed`), and this used to
 * treat every 409 as transient unless its body text happened to contain
 * "paused". `account_released` is the sharp one: it is documented terminal on
 * that server, it is the answer produced by a rotation that landed on chain
 * while the wallet's record of it did not, and it now routes to the direct
 * on-chain switch — so waiting out 12 attempts here would spend minutes retrying
 * a verdict that cannot change before the escape hatch it should have reached
 * immediately. Text matching on an attacker-influenced body is also the same
 * heuristic `isGuardianUnreachableError` documents as unsafe.
 *
 * With no recognized code — an older or mocked error carrying only `status` and
 * a body — the previous text heuristic still applies, widened to cover the
 * spelling of the released case.
 */
export function isGuardianPendingConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { status?: unknown }).status !== 409) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) {
    return code === 'conflict_pending_delta' || code === 'conflict_pending_proposal';
  }
  const detail = String((err as { body?: unknown }).body ?? (err as { message?: unknown }).message ?? '');
  // A paused or released account is not transient — retrying just delays the
  // inevitable.
  return !/paused|released/i.test(detail);
}

/**
 * A Guardian request the fetch boundary cut off at its deadline
 * (`GuardianRequestTimeoutError` in ./native-http), anywhere in `err`'s cause
 * chain. Duck-typed by `name`, like the checks around it, which also keeps
 * ./native-http and its platform imports out of this module.
 */
export function isGuardianRequestTimeout(err: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = err;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('name' in current && current.name === 'GuardianRequestTimeoutError') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * The settlement gate's refusal (#312): the candidate this realm's previous write
 * on the account left on its Guardian is still settling, so a proposal now would
 * only meet the pending-delta 409. Thrown before any proposal work; the
 * transaction loop requeues a value-moving row on it.
 */
export class GuardianBackpressureError extends Error {
  constructor(
    readonly accountId: string,
    readonly nonce: number
  ) {
    super(`Guardian account ${accountId} still has candidate ${nonce} settling; the next proposal waits`);
    this.name = 'GuardianBackpressureError';
  }
}

/**
 * A guardian `429` rate-limit rejection. The guardian declares these retryable
 * (`meta.retryable`, `code: 'rate_limit_exceeded'`), so a value-moving
 * transaction that hits one must not be failed terminally — see #617.
 *
 * Duck-typed rather than `instanceof GuardianHttpError` for the same reason as
 * `isGuardianPendingConflict` above: it survives test mocks of the multisig
 * client and any duplicate-package instance of the error class.
 */
export function isGuardianRateLimited(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { status?: unknown }).status === 429) return true;
  return (err as { code?: unknown }).code === 'rate_limit_exceeded';
}

const isCooldownSecs = (raw: unknown): raw is number => typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;

/**
 * The guardian's requested cooldown for a rate-limited request, in seconds.
 * Prefers the error's own `retryAfterSecs()`: GuardianHttpError's reads the
 * Retry-After header before the envelope, and the header can state the longer
 * cooldown. Otherwise reads `meta.retryAfterSecs` (and the snake_case wire
 * spelling), returning `undefined` when neither states one so callers can apply
 * their own default.
 */
export function guardianRetryAfterSec(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  if ('retryAfterSecs' in err && typeof err.retryAfterSecs === 'function') {
    const stated: unknown = err.retryAfterSecs();
    if (isCooldownSecs(stated)) return stated;
  }
  const meta = (err as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const raw =
    (meta as { retryAfterSecs?: unknown }).retryAfterSecs ?? (meta as { retry_after_secs?: unknown }).retry_after_secs;
  return isCooldownSecs(raw) ? raw : undefined;
}

// Backoff between guardian register attempts: the rotation re-register
// (`registerOnGuardianWithRetry` in ./index), the direct switch, the 429 waits of
// `withGuardianRateLimitRetry` below, and Guardian creation's retry of a timed-out
// registration (./account). Right after the guardian accepts a rotation delta it
// can reject `/configure` for a few seconds while it canonicalizes the new state;
// the capped exponential sequence
// (1+2+4+8+8+8+8s ≈ 39s between GUARDIAN_RETRY_MAX_ATTEMPTS calls) clears that
// window while still bounding a genuinely-down guardian. Getting the budget wrong
// is costly: a re-register that silently exhausts leaves the new hot key
// unauthorized, so every later request then 401s ("session expired") until a
// re-register finally lands.
export const GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS = 1000;
export const GUARDIAN_REGISTER_RETRY_MAX_DELAY_MS = 8000;
// The call cap for the rotation re-register (./index), the direct switch's
// registration (./direct-switch) and `withGuardianRateLimitRetry` below. Guardian
// creation's timed-out registration retry (./account) has its own, smaller cap.
export const GUARDIAN_RETRY_MAX_ATTEMPTS = 8;

/**
 * Ceiling on the NEW guardian's unauthenticated `GET /pubkey`, the check both switch
 * paths (the coordinated proposal in ./index and the direct switch in ./direct-switch)
 * make BEFORE anything is signed or committed.
 *
 * Generous: it exists to stop a silent endpoint from parking a non-requeueable row,
 * not to hit a latency target. There is no retry loop behind it, so a failure here
 * fails the rotation before any state changed, which is the safe direction.
 */
export const NEW_GUARDIAN_PUBKEY_TIMEOUT_MS = 30_000;
// Ceiling for a server-provided Retry-After on a 429: high enough to honour the
// guardian's own cooldown (seconds → ~a minute) instead of retrying under it and
// earning another 429, bounded so a rate-limited re-register can't stall a
// rotation for too long. (#619)
export const GUARDIAN_REGISTER_RETRY_RATE_LIMITED_MAX_DELAY_MS = 60_000;

/**
 * Delay (ms) before the next `registerOnGuardian` retry. On a 429 that carries a
 * server Retry-After, honour that cooldown (clamped to
 * [base, rate-limited-max]) — the guardian just told us how long to wait, so a
 * blind exponential retry only earns another 429. Otherwise fall back to the
 * capped exponential backoff. (#619)
 */
export function guardianRegisterBackoffMs(error: unknown, attempt: number): number {
  const retryAfterSec = isGuardianRateLimited(error) ? guardianRetryAfterSec(error) : undefined;
  if (retryAfterSec !== undefined) {
    return Math.min(
      Math.max(retryAfterSec * 1000, GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS),
      GUARDIAN_REGISTER_RETRY_RATE_LIMITED_MAX_DELAY_MS
    );
  }
  return Math.min(GUARDIAN_REGISTER_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), GUARDIAN_REGISTER_RETRY_MAX_DELAY_MS);
}

interface ConflictRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  // Injectable for tests so they don't wait on real timers.
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Run a guardian proposal-creating `fn`, waiting out transient
 * `409 ConflictPendingDelta` responses. The guardian's canonicalization worker
 * ticks ~every 10s, so a prior delta typically finalizes within a handful of
 * ticks; retrying with backoff lets the next proposal land instead of failing
 * the transaction. Non-409 errors (and paused-account 409s) propagate immediately.
 * Only structural proposals and a bridged send, on either bridge provider, still
 * use it: a send, consume, swap, earn-deposit or execute proposal requeues on a
 * 409 instead (#312).
 */
export async function withGuardianConflictRetry<T>(fn: () => Promise<T>, opts: ConflictRetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 12;
  const delayMs = opts.delayMs ?? 5_000;
  const wait = opts.sleepFn ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isGuardianPendingConflict(err)) throw err;
      console.warn(
        `[guardian] proposal conflicted (409, attempt ${attempt}/${maxAttempts}); ` +
          'waiting for the prior delta to canonicalize before retrying'
      );
      await wait(delayMs);
    }
  }
}

/**
 * Run a guardian call, waiting out `429` rate-limit rejections (#906). The
 * guardian marks them retryable and rejects them before any handler runs, so a
 * retry can never apply a request twice. Before each retry it waits the
 * guardian's own `retry_after_secs`, or the capped exponential backoff when the
 * 429 carries none: retrying under the cooldown only earns another 429. Without
 * a deadline the wait is clamped to a minute; with one, the deadline bounds it.
 * Any other error propagates at once; after GUARDIAN_RETRY_MAX_ATTEMPTS calls the
 * last 429 is rethrown unchanged, so callers still see the guardian's own error.
 * A caller bounds the waits with `deadlineMs`, an absolute time on
 * `monotonicNowMs()`, whether or not it holds a lock: a wait that would end past
 * it is not started, and the 429 is rethrown as at the attempt limit. `afterWait`,
 * run after each wait and before the next call, is the caller's own liveness
 * check (Guardian creation's key fetch passes the vault's locked refusal):
 * whatever it throws ends the retry, unwrapped.
 */
export async function withGuardianRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: { deadlineMs?: number; sleepFn?: (ms: number) => Promise<void>; afterWait?: () => void } = {}
): Promise<T> {
  const wait = opts.sleepFn ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= GUARDIAN_RETRY_MAX_ATTEMPTS || !isGuardianRateLimited(err)) throw err;
      const delayMs = guardianRegisterBackoffMs(err, attempt);
      // Judged against the guardian's stated cooldown, not the wait clamped to a
      // minute, and not shortened to fit: a retry inside the cooldown only earns
      // another 429. `!== undefined` because 0 is a valid monotonic stamp.
      const cooldownMs = Math.max(delayMs, (guardianRetryAfterSec(err) ?? 0) * 1000);
      if (opts.deadlineMs !== undefined && monotonicNowMs() + cooldownMs > opts.deadlineMs) {
        console.warn(
          `[guardian] rate limited (429, attempt ${attempt}/${GUARDIAN_RETRY_MAX_ATTEMPTS}); ` +
            `the ${cooldownMs} ms cooldown would pass the deadline, giving up`
        );
        throw err;
      }
      const waitMs = opts.deadlineMs !== undefined ? cooldownMs : delayMs;
      console.warn(
        `[guardian] rate limited (429, attempt ${attempt}/${GUARDIAN_RETRY_MAX_ATTEMPTS}); retrying in ${waitMs} ms`
      );
      await wait(waitMs);
      opts.afterWait?.();
    }
  }
}
