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
  /**
   * A local transaction ROW id, for a budget spent per durable intent rather
   * than per operator identity. Distinct from `guardianKey` on purpose: the
   * pending-rotation recheck once put a Dexie row uuid in `guardianKey` and the
   * confusion cost it a whole seam (F-001) — one field per kind of identity.
   */
  rowId?: string;
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

/**
 * Subject identity, unambiguously encoded. A `|`-joined key collided across
 * components — `{endpoint: 'b|c', guardianKey: 'd'}` and `{endpoint: 'b',
 * guardianKey: 'c|d'}` produced the same string, as did `{pk}` and
 * `{pk, endpoint: ''}`. The components are a public key, a URL and two ids;
 * nothing in the type constrains them, and the assertion that used to carry
 * this ("public keys carry no `|`") was about the one component that is safe.
 */
const subjectKey = (s: AttemptSubject): string =>
  JSON.stringify([s.accountPublicKey, s.endpoint ?? null, s.guardianKey ?? null, s.rowId ?? null]);

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
   * Is ANY subject of this account out of budget? The account-level question
   * ("automatic repair for this account is exhausted") for callers that cannot
   * reconstruct the narrow subject key — the recovery dispatcher assembles
   * facts before the endpoint and on-chain guardian key are in hand, and
   * hardcoding `'available'` there made the shadow blind to the one fact it
   * exists to watch.
   *
   * Pass `endpoint` when the caller knows which operator it is asking about. An
   * account-wide answer INHERITS across a rotation — the budget spent against
   * the operator the account has just left keeps answering "spent" for the new
   * one — and for a fact that only feeds a divergence tally, inheriting is the
   * same defect as hardcoding, in the other direction.
   */
  anySpentForAccount(accountPublicKey: string, endpoint?: string): boolean;
  /**
   * Forget ONE subject — the "this particular question is settled" reset. Use
   * this rather than `clearForAccount` when the budget is keyed narrower than
   * the account, or a sibling's resolution re-arms an exhausted subject that
   * nothing has answered (the F-137 erasure shape, one level down).
   */
  clear(subject: AttemptSubject): void;
  /**
   * Forget every subject of this account — the endpoint-change / successful-
   * sync reset. Evidence spent against one operator regime must not outlive
   * it (F-137's rule, owned here).
   */
  clearForAccount(accountPublicKey: string): void;
  clearAll(): void;
}

/**
 * `closed` is tracked as its own flag rather than inferred from
 * `attempts >= maxAttempts`, because a close is a stronger and MONOTONIC
 * statement: "no future attempt can change this answer". Encoded only as a
 * count it was reversible — a sibling handle's late refund subtracts its own
 * charge from whatever it finds, so `closed` bumping the count to the cap and a
 * refund then taking one back reopened a budget that had been permanently shut.
 * A flag cannot be decremented.
 */
type AttemptState = {
  accountPublicKey: string;
  // Retained so `anySpentForAccount` can be narrowed to one operator. Without
  // it the account-level question inherits across a rotation: a budget spent
  // against the operator the account has just left still answers "spent" for
  // the new one, which is the same fact-that-is-not-a-fact — read high this
  // time rather than low — that hardcoding it read low.
  endpoint?: string;
  attempts: number;
  lastAttemptAt: number;
  closed: boolean;
};

export function createAttemptLedger(policy: AttemptPolicy, clock?: () => number): AttemptLedger {
  const state = new Map<string, AttemptState>();
  // Lazy property read, NOT a captured `Date.now` reference: ledgers are
  // module-scoped, so a captured reference would be bound before any test's
  // `jest.spyOn(Date, 'now')` and every timing test would silently run on the
  // wall clock.
  const readClock = () => (clock ? clock() : Date.now());

  const gapMs = (attempts: number): number =>
    policy.curve === 'doubling' ? policy.backoffMs * 2 ** Math.max(attempts - 1, 0) : policy.backoffMs;

  const spent = (s: AttemptState | undefined): boolean =>
    s?.closed === true || (s?.attempts ?? 0) >= policy.maxAttempts;

  return {
    mayAttempt(subject, now = readClock()) {
      const s = state.get(subjectKey(subject));
      if (spent(s)) return false;
      if (s && now - s.lastAttemptAt < gapMs(s.attempts)) return false;
      return true;
    },

    begin(subject, now = readClock()) {
      const key = subjectKey(subject);
      const existing = state.get(key);
      state.set(key, {
        accountPublicKey: subject.accountPublicKey,
        endpoint: subject.endpoint,
        attempts: existing?.attempts ?? 0,
        lastAttemptAt: now,
        closed: existing?.closed ?? false
      });
      // Every mutation below reads the LIVE entry rather than the count captured
      // at `begin`. With the captured count, two handles open on one subject
      // each wrote `attemptsAtBegin ± 1`, so two real pushes charged one attempt
      // and a late refund zeroed a sibling's charge. Single-flight per subject
      // is the intended discipline, but a ledger that silently loses a charge
      // when it is broken is not the place to enforce it by assumption.
      let settled = false;
      let charged = 0;
      const write = (attempts: number, at: number, close = false): void => {
        // A subject cleared underneath an open handle stays cleared: the clear
        // is a statement that the question is settled, and re-creating the entry
        // would resurrect evidence its owner just withdrew.
        const current = state.get(key);
        if (!current) return;
        state.set(key, {
          accountPublicKey: subject.accountPublicKey,
          // CARRIED FORWARD, not re-derived and not dropped. This rebuilds the
          // whole entry, so a field it forgets is erased by the first charge or
          // settle — and an erased `endpoint` makes the narrowed
          // `anySpentForAccount` skip the very entries that ARE spent, which
          // reads as "budget available" forever: the same blindness as
          // hardcoding the fact, arrived at from the other side.
          endpoint: current.endpoint,
          attempts,
          lastAttemptAt: at,
          // Never un-set: a close is permanent, so a sibling handle settling
          // afterwards cannot walk it back.
          closed: current.closed || close
        });
      };
      const live = (): number => state.get(key)?.attempts ?? 0;
      return {
        chargeEarly() {
          if (settled || charged > 0) return;
          charged = 1;
          write(live() + 1, now);
        },
        settle(outcome) {
          if (settled) return;
          settled = true;
          // `charged` is what THIS handle already booked, so a charged settle
          // after `chargeEarly` re-stamps without double-charging, and a refund
          // takes back exactly this handle's charge and nothing else.
          const attempts =
            outcome === 'charged'
              ? live() + (1 - charged)
              : outcome === 'closed'
                ? Math.max(policy.maxAttempts, live())
                : live() - charged;
          write(Math.max(attempts, 0), readClock(), outcome === 'closed');
        }
      };
    },

    budgetSpent(subject) {
      return spent(state.get(subjectKey(subject)));
    },

    attempts(subject) {
      return state.get(subjectKey(subject))?.attempts ?? 0;
    },

    anySpentForAccount(accountPublicKey, endpoint) {
      for (const entry of state.values()) {
        if (entry.accountPublicKey !== accountPublicKey) continue;
        if (endpoint !== undefined && entry.endpoint !== endpoint) continue;
        if (spent(entry)) return true;
      }
      return false;
    },

    clear(subject) {
      state.delete(subjectKey(subject));
    },

    clearForAccount(accountPublicKey) {
      for (const [key, entry] of state) {
        if (entry.accountPublicKey === accountPublicKey) state.delete(key);
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

export type RateCooldownBounds = { floorMs: number; capMs: number };

/**
 * `max(askedMs, floor)` clamped to `cap`. Exported so a caller that also wants
 * to LOG the cooldown it just imposed reports the same number the cooldown
 * actually used, instead of re-deriving the clamp beside it.
 *
 * A non-finite ask falls back to the floor: `Math.min(Math.max(NaN, floor), cap)`
 * is `NaN`, and a `NaN` deadline reads as already expired — a malformed
 * `Retry-After` would silently buy no cooldown at all, which is the one input
 * this clamp exists to survive.
 */
export const cooldownFor = (bounds: RateCooldownBounds, askedMs: number | undefined): number =>
  Math.min(Math.max(Number.isFinite(askedMs) ? Number(askedMs) : 0, bounds.floorMs), bounds.capMs);

export function createRateCooldown(bounds: RateCooldownBounds, clock: () => number): RateCooldown {
  const until = new Map<string, number>();
  return {
    impose(key, askedMs) {
      until.set(key, clock() + cooldownFor(bounds, askedMs));
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
