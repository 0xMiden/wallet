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
