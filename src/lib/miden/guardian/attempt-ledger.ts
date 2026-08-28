/**
 * THE one implementation of a bounded, cooled-down repair budget.
 *
 * The #786 review re-taught the same four lessons eight separate times across
 * the guardian repair mechanisms (F-058 → F-172): charge an attempt when it
 * SETTLES, not when it starts (an attempt outlasting its own cooldown must not
 * make the next one due the instant it returns); refund an attempt that never
 * reached the operator (three unlucky local reads must not disable a repair
 * whose budget only a success can reset); key the budget by the full subject
 * it is spent against (an exhausted budget must not be inherited by a new
 * operator, nor a fresh one erased by a sibling's success); and close a budget
 * outright once an attempt proves no retry can ever work. Each mechanism
 * hand-rolled these rules into its own module-level Map and got a different
 * subset wrong. This module encodes them once; a new repair either calls
 * `createAttemptLedger` or fails the ledger fence.
 *
 * Deliberately pure and clock-injected, so the timing semantics are
 * table-testable without fake timers.
 */

/**
 * What a budget is spent AGAINST. The key is the whole subject: account plus
 * the operator identity the attempts are about. `endpoint` and `guardianKey`
 * widen the key exactly as far as the repair's writes reach — a
 * registration push names (account, endpoint, on-chain guardian key), so a
 * second rotation in the same session arrives with its own budget instead of
 * inheriting an exhausted one.
 */
export type AttemptSubject = {
  accountPublicKey: string;
  endpoint?: string;
  guardianKey?: string;
};

export type AttemptPolicy = {
  /** Attempts before the budget is spent (`budgetSpent` turns true). */
  maxAttempts: number;
  /** Gap before the next attempt, measured from the previous SETTLE stamp. */
  backoffMs: number;
  /**
   * 'flat': the same gap every time. 'doubling': `backoffMs * 2^(n-1)` after
   * the n-th charged attempt (the first gap is `backoffMs` either way).
   */
  curve: 'flat' | 'doubling';
};

/**
 * How an attempt settles against the budget:
 *  - `'charged'`  — the attempt really ran (landed or threw after reaching the
 *                   operator); one attempt is spent, the clock restarts from
 *                   NOW — settle time, not begin time.
 *  - `'refunded'` — the attempt bailed before any operator traffic; nothing is
 *                   spent, but the clock still restarts so a persistent local
 *                   failure retries on the cooldown, not on every tick.
 *  - `'closed'`   — the attempt proved no retry can work (this device is not
 *                   the account's signer any more); the budget jumps to spent.
 */
export type AttemptSettle = 'charged' | 'refunded' | 'closed';

export interface AttemptHandle {
  /**
   * Book the charge BEFORE an await whose write may land even if this realm is
   * torn down mid-flight (a `/configure` that was sent has been sent). The
   * later `settle('charged')` then only refreshes the stamp; a `'refunded'`
   * settle takes the charge back.
   */
  chargeEarly(): void;
  settle(outcome: AttemptSettle): void;
}

export interface AttemptLedger {
  /**
   * May an attempt run now? False while the budget is spent or the gap since
   * the last stamp has not elapsed. A subject that has never been seen may.
   */
  mayAttempt(subject: AttemptSubject, now?: number): boolean;
  /**
   * Open an attempt: stamps the clock immediately WITHOUT charging, so a guard
   * that refuses after `begin` still buys the cooldown (an abandoned handle
   * keeps the begin stamp — that is the contract, not a leak). Charging
   * happens at settle.
   */
  begin(subject: AttemptSubject, now?: number): AttemptHandle;
  /** True once the subject's attempts have reached the policy cap. */
  budgetSpent(subject: AttemptSubject): boolean;
  /** Attempts charged so far — for log lines ("attempt 2/3"), never for gating. */
  attempts(subject: AttemptSubject): number;
  /**
   * Forget every subject of this account — the endpoint-change / successful-
   * sync reset. Evidence spent against one operator regime must not outlive
   * it (F-137's rule, owned here).
   */
  clearForAccount(accountPublicKey: string): void;
  clearAll(): void;
}

type AttemptState = { attempts: number; lastAttemptAt: number };

const subjectKey = (s: AttemptSubject): string => `${s.accountPublicKey}|${s.endpoint ?? ''}|${s.guardianKey ?? ''}`;

export function createAttemptLedger(policy: AttemptPolicy, clock?: () => number): AttemptLedger {
  const state = new Map<string, AttemptState>();
  // Lazy property read, NOT a captured `Date.now` reference: ledgers are
  // module-scoped, so a captured reference would be bound before any test's
  // `jest.spyOn(Date, 'now')` and every timing test would silently run on the
  // wall clock.
  const readClock = () => (clock ? clock() : Date.now());

  const gapMs = (attempts: number): number =>
    policy.curve === 'doubling' ? policy.backoffMs * 2 ** Math.max(attempts - 1, 0) : policy.backoffMs;

  const spent = (s: AttemptState | undefined): boolean => (s?.attempts ?? 0) >= policy.maxAttempts;

  return {
    mayAttempt(subject, now = readClock()) {
      const s = state.get(subjectKey(subject));
      if (spent(s)) return false;
      if (s && now - s.lastAttemptAt < gapMs(s.attempts)) return false;
      return true;
    },

    begin(subject, now = readClock()) {
      const key = subjectKey(subject);
      const attemptsAtBegin = state.get(key)?.attempts ?? 0;
      state.set(key, { attempts: attemptsAtBegin, lastAttemptAt: now });
      return {
        chargeEarly() {
          state.set(key, { attempts: attemptsAtBegin + 1, lastAttemptAt: now });
        },
        settle(outcome) {
          const attempts =
            outcome === 'charged'
              ? attemptsAtBegin + 1
              : outcome === 'closed'
                ? Math.max(policy.maxAttempts, attemptsAtBegin)
                : attemptsAtBegin;
          state.set(key, { attempts, lastAttemptAt: readClock() });
        }
      };
    },

    budgetSpent(subject) {
      return spent(state.get(subjectKey(subject)));
    },

    attempts(subject) {
      return state.get(subjectKey(subject))?.attempts ?? 0;
    },

    clearForAccount(accountPublicKey) {
      const prefix = `${accountPublicKey}|`;
      for (const key of state.keys()) {
        if (key.startsWith(prefix)) state.delete(key);
      }
    },

    clearAll() {
      state.clear();
    }
  };
}

/**
 * A pure server-driven cooldown — a deadline, no attempt count. Kept beside
 * the ledger because it shares the keying discipline but none of the budget
 * rules; a 429 is the operator asking for silence, not a failed repair.
 *
 * MONOTONIC by default at the call sites that use it for rate limits: a
 * wall-clock deadline survives a backward clock correction for the whole size
 * of the correction, so a stale 429 could park an account for hours.
 */
export interface RateCooldown {
  /** Arm the cooldown: `max(askedMs, floorMs)` clamped to `capMs`. */
  impose(key: string, askedMs: number | undefined): void;
  /** True while armed; expiry is lazy (checking an expired entry clears it). */
  isActive(key: string): boolean;
  clear(key: string): void;
  clearAll(): void;
}

export function createRateCooldown(bounds: { floorMs: number; capMs: number }, clock: () => number): RateCooldown {
  const until = new Map<string, number>();
  return {
    impose(key, askedMs) {
      const cooldown = Math.min(Math.max(askedMs ?? 0, bounds.floorMs), bounds.capMs);
      until.set(key, clock() + cooldown);
    },
    isActive(key) {
      const deadline = until.get(key);
      if (deadline === undefined) return false;
      if (clock() < deadline) return true;
      until.delete(key);
      return false;
    },
    clear(key) {
      until.delete(key);
    },
    clearAll() {
      until.clear();
    }
  };
}
