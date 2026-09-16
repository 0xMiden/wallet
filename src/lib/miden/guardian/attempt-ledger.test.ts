/**
 * AttemptLedger - the one implementation of a bounded, cooled-down repair
 * budget. These tests port the boundary semantics the per-mechanism ledgers
 * each hand-rolled (and each got a different subset wrong, F-058 → F-172):
 * charge-on-settle, preflight refund, budget closing, full-subject keying,
 * and the flat vs doubling cooldown curves.
 */
import {
  createAttemptLedger,
  createRateCooldown,
  type AttemptHandle,
  type AttemptLedger,
  type AttemptSubject
} from './attempt-ledger';

const SUBJECT: AttemptSubject = { accountPublicKey: 'pk', endpoint: 'https://op.example' };

/**
 * Open an attempt through the only door there is, failing loudly if the policy refuses one. Every case
 * below opens this way, so each also asserts admission at the point it opens.
 */
const open = (ledger: AttemptLedger, subject: AttemptSubject): AttemptHandle => {
  const attempt = ledger.tryBegin(subject);
  if (!attempt) throw new Error(`the ledger refused an attempt for ${subject.accountPublicKey}`);
  return attempt;
};

describe('createAttemptLedger - flat curve (the cold re-register shape)', () => {
  const make = () => {
    let now = 1_000_000;
    const ledger = createAttemptLedger({ maxAttempts: 3, backoffMs: 60_000, curve: 'flat' }, () => now);
    return { ledger, tick: (ms: number) => (now += ms), at: () => now };
  };

  it('a never-seen subject may attempt; a begin stamp alone buys the cooldown', () => {
    const { ledger, tick } = make();
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);

    // A guard that refuses after begin abandons the handle - the begin stamp
    // stands, so the checks behind it cannot re-run on every tick.
    open(ledger, SUBJECT);
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
    const attempt = open(ledger, SUBJECT);
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
    const attempt = open(ledger, SUBJECT);
    // The refusal outlasts the cooldown it is meant to buy, which is the ONLY shape that tells a settle
    // stamp from a begin stamp. It is the real one: this refund fires after a call the sync module
    // documents as spending eight 30s deadlines plus backoff, so under a begin stamp the next push would
    // already be due the moment this one returns, and the probe would re-run on every 3s tick.
    tick(4 * 60_000);
    attempt.settle('refunded');

    expect(ledger.attempts(SUBJECT)).toBe(0);
    // Measured from begin this gap would be long overdue; measured from settle it has not started.
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(59_999);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(1);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
    // Refunds forever: transient refusals can never spend the budget.
    for (let i = 0; i < 10; i++) {
      open(ledger, SUBJECT).settle('refunded');
      tick(60_000);
    }
    expect(ledger.attempts(SUBJECT)).toBe(0);
    expect(ledger.budgetSpent(SUBJECT)).toBe(false);
  });

  it('spends the budget after maxAttempts charges, and a closed settle jumps straight to spent', () => {
    const { ledger, tick } = make();
    for (let i = 0; i < 3; i++) {
      expect(ledger.mayAttempt(SUBJECT)).toBe(true);
      open(ledger, SUBJECT).settle('charged');
      tick(60_000);
    }
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    tick(60 * 60_000);
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);

    const fresh = make();
    // A closed settle stamps the clock like any other outcome, but nothing here can see WHICH stamp it
    // wrote: `mayAttempt` tests `spent` before it tests the gap, and closing jumps the budget straight to
    // spent. The refund cases are where settle-time stamping is pinned.
    open(fresh.ledger, SUBJECT).settle('closed');
    expect(fresh.ledger.budgetSpent(SUBJECT)).toBe(true);
    expect(fresh.ledger.mayAttempt(SUBJECT)).toBe(false);
  });

  it('chargeEarly books the attempt before the await; a later refunded settle takes it back', () => {
    const { ledger } = make();
    const attempt = open(ledger, SUBJECT);
    attempt.chargeEarly();
    // A realm torn down mid-flight leaves the early charge standing.
    expect(ledger.attempts(SUBJECT)).toBe(1);
    attempt.settle('refunded');
    expect(ledger.attempts(SUBJECT)).toBe(0);
  });

  it('a settled handle is spent: settling again, or charging after, changes nothing', () => {
    const { ledger } = make();
    const closing = open(ledger, SUBJECT);
    closing.settle('closed');
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);

    // Without one-shot handles this pair reopens a budget that was closed BECAUSE no retry can work.
    closing.settle('refunded');
    closing.chargeEarly();
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
  });

  it('a superseded handle is inert even though it never settled', () => {
    const { ledger, tick } = make();
    // Abandoned rather than settled, so the one-shot flag cannot be what rejects it later: only the generation
    // stamp can tell this handle from the one that replaces it. A handle really can reach here unsettled, since
    // a guard that refuses after the attempt opens returns without settling, which is the documented contract.
    const stale = open(ledger, SUBJECT);
    expect(ledger.attempts(SUBJECT)).toBe(0);

    tick(60_000);
    const live = open(ledger, SUBJECT);

    // Every path the stale handle still offers, against a live attempt it knows nothing about. chargeEarly comes
    // first on purpose: without generation matching it writes attemptsAtBegin + 1 and fails here, while a stale
    // 'refunded' would write 0 and look identical to the correct behaviour.
    stale.chargeEarly();
    expect(ledger.attempts(SUBJECT)).toBe(0);
    stale.settle('closed');
    expect(ledger.budgetSpent(SUBJECT)).toBe(false);
    stale.settle('charged');
    expect(ledger.attempts(SUBJECT)).toBe(0);
    stale.settle('refunded');
    expect(ledger.attempts(SUBJECT)).toBe(0);

    // The live attempt is the only one whose bookkeeping counts.
    live.settle('charged');
    expect(ledger.attempts(SUBJECT)).toBe(1);
  });

  it('a cleared subject cannot be resurrected by a handle that outlived the clear', () => {
    const { ledger } = make();
    const attempt = open(ledger, SUBJECT);
    ledger.clearForAccount(SUBJECT.accountPublicKey);
    attempt.settle('charged');

    // The endpoint-change reset means what it says: evidence spent against one operator regime does not
    // outlive it, not even by one in-flight attempt.
    expect(ledger.attempts(SUBJECT)).toBe(0);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
  });

  it('tryBegin opens an attempt only when one is allowed, and a refusal stamps and charges nothing', () => {
    const { ledger, tick } = make();
    ledger.tryBegin(SUBJECT)?.settle('charged');
    expect(ledger.attempts(SUBJECT)).toBe(1);

    // Cooling: refused, and the refusal neither charges nor pushes the deadline out.
    tick(10_000);
    expect(ledger.tryBegin(SUBJECT)).toBeNull();
    expect(ledger.attempts(SUBJECT)).toBe(1);
    tick(50_000);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);

    ledger.tryBegin(SUBJECT)?.settle('charged');
    tick(60_000);
    ledger.tryBegin(SUBJECT)?.settle('charged');
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
    // Spent: refused however long we wait.
    tick(60 * 60_000);
    expect(ledger.tryBegin(SUBJECT)).toBeNull();
  });

  it('keys budgets by the whole subject and clears by account prefix', () => {
    const { ledger, tick } = make();
    const otherEndpoint: AttemptSubject = { accountPublicKey: 'pk', endpoint: 'https://other.example' };
    const otherAccount: AttemptSubject = { accountPublicKey: 'pk2', endpoint: 'https://op.example' };
    const otherGuardianKey: AttemptSubject = {
      accountPublicKey: 'pk',
      endpoint: 'https://op.example',
      guardianKey: 'rotated-on-chain-key'
    };

    for (let i = 0; i < 3; i++) {
      open(ledger, SUBJECT).settle('charged');
      tick(60_000);
    }
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
    // A different operator regime arrives with its own budget…
    expect(ledger.mayAttempt(otherEndpoint)).toBe(true);
    expect(ledger.mayAttempt(otherAccount)).toBe(true);
    // The same account at the same endpoint under a different on-chain guardian key is its own subject too:
    // the registration push spends its budget against that triple, so a rotation must not inherit an
    // exhausted one. Drop guardianKey from subjectKey and this collides with the spent subject above.
    expect(ledger.mayAttempt(otherGuardianKey)).toBe(true);

    // …and the account-prefix clear re-arms this account only.
    open(ledger, otherAccount).settle('charged');
    ledger.clearForAccount('pk');
    expect(ledger.budgetSpent(SUBJECT)).toBe(false);
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);
    expect(ledger.attempts(otherAccount)).toBe(1);
  });
});

describe('createAttemptLedger - doubling curve (the registration-push shape)', () => {
  it('widens the gap per charged attempt: 60s, then 120s, then the cap', () => {
    let now = 5_000_000;
    const ledger = createAttemptLedger({ maxAttempts: 3, backoffMs: 60_000, curve: 'doubling' }, () => now);

    open(ledger, SUBJECT).settle('charged'); // attempts = 1 → next gap 60s
    now += 59_999;
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    now += 1;
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);

    open(ledger, SUBJECT).settle('charged'); // attempts = 2 → next gap 120s
    now += 119_999;
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    now += 1;
    expect(ledger.mayAttempt(SUBJECT)).toBe(true);

    open(ledger, SUBJECT).settle('charged'); // attempts = 3 → spent
    now += 24 * 60 * 60_000;
    expect(ledger.mayAttempt(SUBJECT)).toBe(false);
    expect(ledger.budgetSpent(SUBJECT)).toBe(true);
  });

  it('a refund keeps the first gap: attempts 0 gets the same 60s as attempts 1', () => {
    let now = 5_000_000;
    const ledger = createAttemptLedger({ maxAttempts: 3, backoffMs: 60_000, curve: 'doubling' }, () => now);
    const attempt = open(ledger, SUBJECT);
    // Same shape as the flat curve's refund: the attempt outlives its own gap, so a begin stamp would
    // make the next one due the instant this one returns.
    now += 4 * 60_000;
    attempt.settle('refunded'); // attempts stays 0, so the next gap is still the first one
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

  it('returns the pause it armed, so the caller never keeps a second copy of the clamp', () => {
    const { cooldown, tick } = make();
    expect(cooldown.impose('pk', undefined)).toBe(30_000);
    tick(30_000);
    expect(cooldown.impose('pk', 5_000)).toBe(30_000);
    tick(30_000);
    // The returned value is the enforced one: armed for the cap, active until exactly then.
    expect(cooldown.impose('pk', 60 * 60_000)).toBe(120_000);
    tick(119_999);
    expect(cooldown.isActive('pk')).toBe(true);
    tick(1);
    expect(cooldown.isActive('pk')).toBe(false);
  });

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
