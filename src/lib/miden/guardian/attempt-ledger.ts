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
 * widen the key exactly as far as the repair's writes reach - a
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
   * than per operator identity. Distinct from `guardianKey` on purpose: one
   * field per kind of identity, so a row uuid can never be read as a key.
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
 *  - `'charged'`  - the attempt really ran (landed or threw after reaching the
 *                   operator); one attempt is spent, the clock restarts from
 *                   NOW - settle time, not begin time.
 *  - `'refunded'` - the attempt bailed before any operator traffic; nothing is
 *                   spent, but the clock still restarts so a persistent local
 *                   failure retries on the cooldown, not on every tick.
 *  - `'closed'`   - the attempt proved no retry can work (this device is not
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
  // Both are ONE-SHOT and scoped to this attempt: once this handle has settled, or once a later
  // attempt has opened for the same subject, or once the subject has been cleared, they do nothing.
  // A late settle is a race, not a caller error.
}

export interface AttemptLedger {
  /**
   * May an attempt run now? False while the budget is spent or the gap since
   * the last stamp has not elapsed. A subject that has never been seen may.
   */
  mayAttempt(subject: AttemptSubject): boolean;
  /**
   * THE way in: opens an attempt when the cap and the cooldown allow one, and otherwise returns null
   * having stamped and charged nothing. The unguarded opener stays private on purpose, because a caller
   * that has to remember to pair a check with an open is the re-derived rule this module exists to end.
   *
   * Opening stamps the clock WITHOUT charging, so a guard that refuses after the attempt is open still
   * buys the cooldown (an abandoned handle keeps that stamp - the contract, not a leak). Charging
   * happens at settle.
   */
  tryBegin(subject: AttemptSubject): AttemptHandle | null;
  /** True once the subject's attempts have reached the policy cap. */
  budgetSpent(subject: AttemptSubject): boolean;
  /** Attempts charged so far - for log lines ("attempt 2/3"), never for gating. */
  attempts(subject: AttemptSubject): number;
  /**
   * Is ANY subject of this account out of budget? The account-level question
   * ("automatic repair for this account is exhausted") for callers that cannot
   * reconstruct the narrow subject key.
   *
   * Pass `endpoint` when the caller knows which operator it is asking about. An
   * account-wide answer INHERITS across a rotation: the budget spent against the
   * operator the account has just left keeps answering "spent" for the new one.
   */
  anySpentForAccount(accountPublicKey: string, endpoint?: string): boolean;
  /**
   * Forget ONE subject - the "this particular question is settled" reset. Use it
   * rather than `clearForAccount` when the budget is keyed narrower than the
   * account (the F-137 erasure shape, one level down).
   */
  clear(subject: AttemptSubject): void;
  /**
   * Forget every subject of this account - the endpoint-change / successful-
   * sync reset. Evidence spent against one operator regime must not outlive
   * it (F-137's rule, owned here).
   */
  clearForAccount(accountPublicKey: string): void;
  clearAll(): void;
}

/**
 * `closed` is its own flag rather than inferred from `attempts >= maxAttempts`,
 * because a close is a STRONGER and monotonic statement: no future attempt can
 * change this answer. Encoded only as a count it was reversible, since a refund
 * subtracts from whatever it finds, so a close that merely bumped the count to
 * the cap could be walked back to open again. A flag cannot be decremented.
 *
 * `accountPublicKey` and `endpoint` are carried so the account-level questions
 * can be answered without parsing the key back apart.
 */
type AttemptState = {
  accountPublicKey: string;
  endpoint?: string;
  attempts: number;
  lastAttemptAt: number;
  closed: boolean;
  generation: number;
};

/**
 * Subject identity, unambiguously encoded. A `|`-joined key COLLIDED across
 * components: `{endpoint: 'b|c', guardianKey: 'd'}` and `{endpoint: 'b',
 * guardianKey: 'c|d'}` produced the same string, as did `{pk}` and
 * `{pk, endpoint: ''}`. The components are a public key, a URL and two ids, and
 * nothing in the type constrains them; the old assertion that carried this
 * ("public keys carry no `|`") was about the one component that is safe.
 */
const subjectKey = (s: AttemptSubject): string =>
  JSON.stringify([s.accountPublicKey, s.endpoint ?? null, s.guardianKey ?? null, s.rowId ?? null]);

export function createAttemptLedger(policy: AttemptPolicy, clock: () => number): AttemptLedger {
  const state = new Map<string, AttemptState>();
  // Which attempt an entry belongs to. Monotonic across the whole ledger, so no two live handles can
  // ever share one, whatever subject they opened against.
  let generations = 0;
  // REQUIRED, so no repair is handed a clock it never chose: the sibling `createRateCooldown` has always
  // demanded one, and the silent default here is what let a caller and this module disagree about which
  // clock an entry was stamped on. Pass `() => Date.now()` for the wall clock, never `Date.now` itself:
  // ledgers are module-scoped, so a captured reference binds before any test's `jest.spyOn(Date, 'now')`
  // and every timing test would silently run on the real clock.
  const readClock = clock;

  const gapMs = (attempts: number): number =>
    policy.curve === 'doubling' ? policy.backoffMs * 2 ** Math.max(attempts - 1, 0) : policy.backoffMs;

  const spent = (s: AttemptState | undefined): boolean =>
    s?.closed === true || (s?.attempts ?? 0) >= policy.maxAttempts;

  const mayAttempt = (subject: AttemptSubject, now: number = readClock()): boolean => {
    const s = state.get(subjectKey(subject));
    if (spent(s)) return false;
    if (s && now - s.lastAttemptAt < gapMs(s.attempts)) return false;
    return true;
  };

  const begin = (subject: AttemptSubject, now: number = readClock()): AttemptHandle => {
    const key = subjectKey(subject);
    const existing = state.get(key);
    const generation = ++generations;
    state.set(key, {
      accountPublicKey: subject.accountPublicKey,
      endpoint: subject.endpoint,
      attempts: existing?.attempts ?? 0,
      lastAttemptAt: now,
      closed: existing?.closed ?? false,
      generation
    });
    let settled = false;
    let charged = 0;
    // The entry still belongs to THIS attempt, and this attempt has not finished. Anything else means a
    // newer attempt opened, the subject was cleared, or this handle already settled, and a write now
    // would undo somebody else's bookkeeping with numbers captured before it existed.
    const isCurrent = (): boolean => !settled && state.get(key)?.generation === generation;
    // Rebuild from the LIVE entry, never from a count captured at begin. The generation guard above is
    // what stops a superseded handle writing at all, so this is defence in depth rather than the primary
    // rule - but a ledger that silently loses a charge when that discipline is broken is not the place to
    // assume it, and rebuilding also carries `endpoint` and `closed` forward instead of erasing them.
    const write = (attempts: number, at: number, close = false): void => {
      const current = state.get(key);
      if (!current || current.generation !== generation) return;
      state.set(key, {
        accountPublicKey: current.accountPublicKey,
        endpoint: current.endpoint,
        attempts: Math.max(attempts, 0),
        lastAttemptAt: at,
        // Never un-set: a close is permanent, so a later settle cannot walk it back.
        closed: current.closed || close,
        generation: current.generation
      });
    };
    const live = (): number => state.get(key)?.attempts ?? 0;
    return {
      chargeEarly() {
        if (!isCurrent() || charged > 0) return;
        charged = 1;
        write(live() + 1, now);
      },
      settle(outcome) {
        if (!isCurrent()) return;
        settled = true;
        // `charged` is what THIS handle already booked, so a charged settle after `chargeEarly`
        // re-stamps without double-charging, and a refund takes back exactly this handle's charge.
        const attempts =
          outcome === 'charged'
            ? live() + (1 - charged)
            : outcome === 'closed'
              ? Math.max(policy.maxAttempts, live())
              : live() - charged;
        write(attempts, readClock(), outcome === 'closed');
      }
    };
  };

  return {
    mayAttempt,

    tryBegin(subject) {
      // ONE reading, from the ledger's own clock, for both halves. The clock is deliberately not a
      // parameter: `settle` stamps from `readClock()`, so a caller passing its own reading could stamp
      // on one clock and be judged on another, and a gap measured across two clocks is not a gap. That
      // is not hypothetical - it is what a wall-clock caller did to a monotonic ledger here, and every
      // cooldown read as already elapsed.
      const now = readClock();
      return mayAttempt(subject, now) ? begin(subject, now) : null;
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
      // By stored field, not by key prefix: the key is a JSON tuple now, and a prefix scan over it would
      // also match an account whose public key is a prefix of another's.
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
 * A pure server-driven cooldown - a deadline, no attempt count. Kept beside
 * the ledger because it shares the keying discipline but none of the budget
 * rules; a 429 is the operator asking for silence, not a failed repair.
 *
 * MONOTONIC by default at the call sites that use it for rate limits: a
 * wall-clock deadline survives a backward clock correction for the whole size
 * of the correction, so a stale 429 could park an account for hours.
 */
export interface RateCooldown {
  /**
   * Arm the cooldown at `max(askedMs, floorMs)` clamped to `capMs`, and return the milliseconds armed. The
   * caller reports the pause it actually got rather than keeping a second copy of the clamp, which is the
   * copy that silently lies once either side moves.
   */
  impose(key: string, askedMs: number | undefined): number;
  /** True while armed; expiry is lazy (checking an expired entry clears it). */
  isActive(key: string): boolean;
  clear(key: string): void;
  clearAll(): void;
}

export type RateCooldownBounds = { floorMs: number; capMs: number };

/**
 * `max(askedMs, floor)` clamped to `cap`. Exported so a caller that also wants to LOG the cooldown it
 * imposed reports the number the cooldown actually used, instead of re-deriving the clamp beside it.
 *
 * A non-finite ask falls back to the floor: `Math.min(Math.max(NaN, floor), cap)` is `NaN`, and a `NaN`
 * deadline reads as already expired, so a malformed `Retry-After` would silently buy no cooldown at all,
 * which is the one input this clamp exists to survive.
 */
export const cooldownFor = (bounds: RateCooldownBounds, askedMs: number | undefined): number =>
  Math.min(Math.max(Number.isFinite(askedMs) ? Number(askedMs) : 0, bounds.floorMs), bounds.capMs);

export function createRateCooldown(bounds: RateCooldownBounds, clock: () => number): RateCooldown {
  const until = new Map<string, number>();
  return {
    impose(key, askedMs) {
      const cooldown = cooldownFor(bounds, askedMs);
      until.set(key, clock() + cooldown);
      return cooldown;
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
