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
 * in flight, and (2) when a proposal still conflicts (e.g. the prior delta is
 * mid-canonicalization), wait it out instead of failing the transaction.
 */

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

/** Drop all per-account guardian transaction locks (e.g. on lock/logout). */
export function clearGuardianAccountLocks(): void {
  guardianTxChains.clear();
}

/**
 * A guardian `409` that is transient and worth waiting on — i.e. a pending
 * delta/proposal that clears once canonicalization completes. Excludes
 * non-transient 409s such as `GUARDIAN_ACCOUNT_PAUSED`, which must fail fast.
 */
export function isGuardianPendingConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { status?: unknown }).status !== 409) return false;
  const detail = String((err as { body?: unknown }).body ?? (err as { message?: unknown }).message ?? '');
  // A paused account is not transient — retrying just delays the inevitable.
  return !/paused/i.test(detail);
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

/**
 * The guardian's requested cooldown for a rate-limited request, in seconds.
 * Reads `meta.retryAfterSecs` (and the snake_case wire spelling), returning
 * `undefined` when absent so callers can apply their own default.
 */
export function guardianRetryAfterSec(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const meta = (err as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const raw =
    (meta as { retryAfterSecs?: unknown }).retryAfterSecs ?? (meta as { retry_after_secs?: unknown }).retry_after_secs;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
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
