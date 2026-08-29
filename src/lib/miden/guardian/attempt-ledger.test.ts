/**
 * AttemptLedger — the one implementation of a bounded, cooled-down repair
 * budget. These tests port the boundary semantics the per-mechanism ledgers
 * each hand-rolled (and each got a different subset wrong, F-058 → F-172):
 * charge-on-settle, preflight refund, budget closing, full-subject keying,
 * and the flat vs doubling cooldown curves.
 */
import { createAttemptLedger, createRateCooldown, type AttemptSubject } from './attempt-ledger';

const SUBJECT: AttemptSubject = { accountPublicKey: 'pk', endpoint: 'https://op.example' };

describe('createAttemptLedger — flat curve (the cold re-register shape)', () => {
  const make = () => {
    let now = 1_000_000;
    const ledger = createAttemptLedger({ maxAttempts: 3, backoffMs: 60_000, curve: 'flat' }, () => now);
    return { ledger, tick: (ms: number) => (now += ms), at: () => now };
  };

  it('a never-seen subject may attempt; a begin stamp alone buys the cooldown', () => {
    const { ledger, tick } = make();
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);

    // A guard that refuses after begin abandons the handle — the begin stamp
    // stands, so the checks behind it cannot re-run on every tick.
    ledger.begin(SUBJECT);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(59_999);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(1);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
    // No charge was booked.
    expect(ledger.attempts(SUBJECT)).toBe(0);
  });

  it('charges at settle and measures the next gap from the settle stamp, not the begin stamp', () => {
    const { ledger, tick } = make();
    const attempt = ledger.begin(SUBJECT);
    // The attempt itself outlasts the cooldown it is supposed to buy.
    tick(4 * 60_000);
    attempt.settle('charged');

    expect(ledger.attempts(SUBJECT)).toBe(1);
    // Measured from begin it would be long overdue; from settle it is not.
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(59_999);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(1);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
  });

  it('a refunded settle spends nothing but still re-stamps the clock from its finish', () => {
    const { ledger, tick } = make();
    const attempt = ledger.begin(SUBJECT);
    tick(10_000);
    attempt.settle('refunded');

    expect(ledger.attempts(SUBJECT)).toBe(0);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(60_000);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
    // Refunds forever: transient refusals can never spend the budget.
    for (let i = 0; i < 10; i++) {
      ledger.begin(SUBJECT).settle('refunded');
      tick(60_000);
    }
    expect(ledger.attempts(SUBJECT)).toBe(0);
    expect(ledger.budgetSpent(SUBJECT)).toBe(false);
  });

  it('spends the budget after maxAttempts charges, and a closed settle jumps straight to spent', () => {
    const { ledger, tick } = make();
    for (let i = 0; i < 3; i++) {
      expect(ledger.mayAttempt(SUBJECT)).toBe(true);
      ledger.begin(SUBJECT).settle('charged');
      tick(60_000);
    }
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(60 * 60_000);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);

    const fresh = make();
    fresh.ledger.begin(SUBJECT).settle('closed');
    expect(fresh.ledger.budgetSpent(SUBJECT)).toBe(true);
    expect(fresh.ledger.mayAttempt(SUBJECT)).toBe(false);
  });

  it('chargeEarly books the attempt before the await; a later refunded settle takes it back', () => {
    const { ledger } = make();
    const attempt = ledger.begin(SUBJECT);
    attempt.chargeEarly();
    // A realm torn down mid-flight leaves the early charge standing.
    expect(ledger.attempts(SUBJECT)).toBe(1);
    attempt.settle('refunded');
    expect(ledger.attempts(SUBJECT)).toBe(0);
  });

  // 'closed' means the question has an answer and re-asking is pointless — it is
  // not "the counter happens to sit at max". Two handles can be open on one
  // subject (a slow first pass overlapping the next tick's), and while closure
  // was only the counter, the second handle's late refund decremented it back
  // under the cap and re-armed a budget that had already concluded.
  it('a late refund from a concurrent handle cannot reopen a closed budget', () => {
    const { ledger, tick } = make();
    const first = ledger.begin(SUBJECT);
    // The charge is what makes this test able to fail. A refund takes back
    // exactly the charge ITS OWN handle booked, so an uncharged `first` refunds
    // nothing and the assertions below hold under a counter-only closure too —
    // the very implementation the flag replaced. Booking the charge is what
    // gives the late refund something to decrement, and a count-based `closed`
    // then falls back under the cap exactly as it did in production.
    first.chargeEarly();
    tick(60_000);
    const second = ledger.begin(SUBJECT);

    second.settle('closed');
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);

    first.settle('refunded');
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(60 * 60_000);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
  });

  // Closure is sticky against the clock too, not just against refunds.
  it('a closed budget stays closed however long the cooldown outlives it', () => {
    const { ledger, tick } = make();
    ledger.begin(SUBJECT).settle('closed');
    tick(24 * 60 * 60_000);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);

    // Only an explicit clear re-arms it — that is the deliberate exit.
    ledger.clear(SUBJECT);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
    expect(ledger.budgetSpent(SUBJECT)).toBe(false);
  });

  // The existence check in `write` makes a cleared subject stay cleared, but
  // `begin` re-seeds the entry — so a clear followed by a fresh begin handed the
  // stale handle a live entry that is not its own.
  it('a stale handle cannot refund out of the incarnation that replaced it', () => {
    const { ledger } = make();
    const stale = ledger.begin(SUBJECT);
    stale.chargeEarly();
    expect(ledger.attempts(SUBJECT)).toBe(1);

    ledger.clear(SUBJECT);
    const fresh = ledger.begin(SUBJECT);
    fresh.chargeEarly();
    expect(ledger.attempts(SUBJECT)).toBe(1);

    // The late refund belongs to a subject that no longer exists; spending it
    // here would erase the new incarnation's real, in-flight attempt.
    stale.settle('refunded');
    expect(ledger.attempts(SUBJECT)).toBe(1);
  });

  it('a stale handle cannot close the incarnation that replaced it', () => {
    const { ledger } = make();
    const stale = ledger.begin(SUBJECT);
    ledger.clear(SUBJECT);
    ledger.begin(SUBJECT).chargeEarly();

    stale.settle('closed');
    expect(ledger.budgetSpent(SUBJECT)).toBe(false);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false); // still inside its own backoff
    expect(ledger.attempts(SUBJECT)).toBe(1);
  });

  it('keys budgets by the whole subject and clears by account prefix', () => {
    const { ledger, tick } = make();
    const otherEndpoint: AttemptSubject = { accountPublicKey: 'pk', endpoint: 'https://other.example' };
    const otherAccount: AttemptSubject = { accountPublicKey: 'pk2', endpoint: 'https://op.example' };

    for (let i = 0; i < 3; i++) {
      ledger.begin(SUBJECT).settle('charged');
      tick(60_000);
    }
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
    // A different operator regime arrives with its own budget…
    expect(ledger.mayAttempt(otherEndpoint)).toBe(true);
    expect(ledger.mayAttempt(otherAccount)).toBe(true);

    // …and the account-prefix clear re-arms this account only.
    ledger.begin(otherAccount).settle('charged');
    ledger.clearForAccount('pk');
    expect(ledger.budgetSpent(SUBJECT)).toBe(false);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
    expect(ledger.attempts(otherAccount)).toBe(1);
  });

  // The account-level question, and the reason it takes an endpoint. Its caller
  // is the shadow classifier, which knows the account and the operator but not
  // the on-chain guardian key the subject is also keyed by — so it cannot ask
  // `budgetSpent` and has to ask this instead.
  describe('anySpentForAccount', () => {
    const spendIt = (
      ledger: ReturnType<typeof createAttemptLedger>,
      subject: AttemptSubject,
      tick: (ms: number) => void
    ) => {
      for (let i = 0; i < 3; i++) {
        ledger.begin(subject).settle('charged');
        tick(60_000);
      }
    };

    it('answers for the account once any of its subjects is spent', () => {
      const { ledger, tick } = make();
      expect(ledger.anySpentForAccount('pk')).toBe(false);
      spendIt(ledger, SUBJECT, tick);
      expect(ledger.anySpentForAccount('pk')).toBe(true);
      expect(ledger.anySpentForAccount('pk2')).toBe(false);
    });

    // THE ENDPOINT HAS TO SURVIVE THE SETTLE. `begin` stamps it, but every
    // charge and settle rewrites the whole entry, and a rewrite that forgot the
    // field left the narrowed query unable to see the spent budgets it was
    // added to find — reporting "available" forever, which is exactly the
    // hardcoded-`'available'` blindness this fact exists to replace.
    it('still finds a spent budget by endpoint after the attempt settled', () => {
      const { ledger, tick } = make();
      spendIt(ledger, SUBJECT, tick);

      expect(ledger.anySpentForAccount('pk', SUBJECT.endpoint)).toBe(true);
    });

    // The narrowing's whole point: a budget spent against the operator the
    // account has just rotated AWAY from says nothing about the new one.
    it('does not inherit a spent budget across a rotation to another operator', () => {
      const { ledger, tick } = make();
      spendIt(ledger, SUBJECT, tick);

      expect(ledger.anySpentForAccount('pk', 'https://newly-rotated.example')).toBe(false);
    });
  });
});

describe('createAttemptLedger — doubling curve (the registration-push shape)', () => {
  it('widens the gap per charged attempt: 60s, then 120s, then the cap', () => {
    let now = 5_000_000;
    const ledger = createAttemptLedger({ maxAttempts: 3, backoffMs: 60_000, curve: 'doubling' }, () => now);

    ledger.begin(SUBJECT).settle('charged'); // attempts = 1 → next gap 60s
    now += 59_999;
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    now += 1;
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);

    ledger.begin(SUBJECT).settle('charged'); // attempts = 2 → next gap 120s
    now += 119_999;
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    now += 1;
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);

    ledger.begin(SUBJECT).settle('charged'); // attempts = 3 → spent
    now += 24 * 60 * 60_000;
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
  });

  it('a refund keeps the first gap: attempts 0 gets the same 60s as attempts 1', () => {
    let now = 5_000_000;
    const ledger = createAttemptLedger({ maxAttempts: 3, backoffMs: 60_000, curve: 'doubling' }, () => now);
    ledger.begin(SUBJECT).settle('refunded'); // attempts stays 0
    now += 59_999;
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    now += 1;
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
  });
});

describe('createRateCooldown', () => {
  const make = () => {
    let now = 100_000;
    const cooldown = createRateCooldown({ floorMs: 30_000, capMs: 120_000 }, () => now);
    return { cooldown, tick: (ms: number) => (now += ms) };
  };

  it('applies the floor when the server names no cooldown, or a shorter one', () => {
    const { cooldown, tick } = make();
    cooldown.impose('pk', undefined);
    tick(29_999);
    expect(cooldown.isActive('pk')).toBe(true);
    tick(1);
    expect(cooldown.isActive('pk')).toBe(false);

    cooldown.impose('pk', 5_000);
    tick(29_999);
    expect(cooldown.isActive('pk')).toBe(true);
    tick(1);
    expect(cooldown.isActive('pk')).toBe(false);
  });

  it('caps a server-provided cooldown so one bad header cannot park syncing', () => {
    const { cooldown, tick } = make();
    cooldown.impose('pk', 60 * 60_000);
    tick(119_999);
    expect(cooldown.isActive('pk')).toBe(true);
    tick(1);
    expect(cooldown.isActive('pk')).toBe(false);
  });

  it('clears per key and lazily expires without an explicit clear', () => {
    const { cooldown, tick } = make();
    cooldown.impose('a', undefined);
    cooldown.impose('b', undefined);
    cooldown.clear('a');
    expect(cooldown.isActive('a')).toBe(false);
    expect(cooldown.isActive('b')).toBe(true);
    tick(30_000);
    expect(cooldown.isActive('b')).toBe(false);
  });
});
