import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import {
  guardianRequeueBackoffSec,
  MAX_QUEUED_AGE,
  nextQueuedWakeDelayMs,
  unauthorizedRequeueCooldownSec
} from 'lib/miden/transaction';

describe('unauthorizedRequeueCooldownSec', () => {
  // Both ends matter and neither is arbitrary. The floor has to stay clear of
  // the processing loop's ~5s poll, or a requeued row is re-picked every cycle
  // and hammers the guardian this arm exists to give room to recover. The
  // ceiling is what decorrelates a fleet that all hit this at the same moment,
  // since the trigger is guardian latency under load. It does NOT clear the
  // guardian's candidate quarantine — that window is budgeted at 12 x 5s, wider
  // than any draw can reach — see UNAUTHORIZED_EXECUTION_JITTER_SEC's own
  // comment.
  //
  // Pinned on the pure function rather than through `generateTransaction`,
  // because pinning it there needs a constant `Math.random`, and a constant draw
  // held across a failing assertion makes jest's source-map sort degenerate: the
  // run dies with `RangeError: Maximum call stack size exceeded` and never
  // prints which expectation failed. These are the assertions that must survive
  // their own failure, so they take the draw as an argument instead.
  it('is 15s at the floor of the draw', () => {
    expect(unauthorizedRequeueCooldownSec(0)).toBe(15);
  });

  it('is 54s at the ceiling of the draw, never 55', () => {
    // `Math.random` is exclusive of 1, so 54 is the real maximum — the value the
    // CHANGELOG and the arm's comments quote. A draw of exactly 1 would produce
    // 55, which is why the floor is taken rather than rounded.
    expect(unauthorizedRequeueCooldownSec(0.999999)).toBe(54);
    expect(unauthorizedRequeueCooldownSec(0.5)).toBe(35);
  });

  it('never returns below the loop poll interval, for any draw in range', () => {
    for (let draw = 0; draw < 1; draw += 0.01) {
      const cooldown = unauthorizedRequeueCooldownSec(draw);
      expect(cooldown).toBeGreaterThanOrEqual(15);
      expect(cooldown).toBeLessThanOrEqual(54);
    }
  });
});

describe('guardianRequeueBackoffSec', () => {
  // A guardian arm that requeues the same row again doubles its cooldown, so rows a guardian keeps failing stop being
  // eligible at every lap (#1223); the cap bounds how long a row waits once the guardian is back.
  it('doubles the base for each consecutive requeue', () => {
    expect(guardianRequeueBackoffSec(60, 1)).toBe(60);
    expect(guardianRequeueBackoffSec(60, 2)).toBe(120);
    expect(guardianRequeueBackoffSec(60, 3)).toBe(240);
    expect(guardianRequeueBackoffSec(15, 4)).toBe(120);
  });

  it('stops at 240 s however long the streak runs', () => {
    expect(guardianRequeueBackoffSec(60, 4)).toBe(240);
    expect(guardianRequeueBackoffSec(15, 12)).toBe(240);
  });

  it("never cuts a base above the cap short, since a 429's base is the guardian's own retry-after", () => {
    expect(guardianRequeueBackoffSec(300, 1)).toBe(300);
    expect(guardianRequeueBackoffSec(300, 3)).toBe(300);
  });
});

describe('nextQueuedWakeDelayMs', () => {
  // The extension's service worker arms a one-shot alarm from this when a run ends with rows still Queued, since the
  // run stops after a fixed number of passes and a backed-off row can come due after it has (#1223).
  const nowSec = 1_700_000_000;
  const queued = (
    extra: Partial<Pick<ITransaction, 'initiatedAt' | 'nextEligibleAt' | 'awaitingRecoverySeed'>> = {}
  ): Pick<ITransaction, 'status' | 'initiatedAt' | 'nextEligibleAt' | 'awaitingRecoverySeed'> => ({
    status: ITransactionStatus.Queued,
    initiatedAt: nowSec,
    ...extra
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(nowSec * 1000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the soonest wake across the Queued rows, a beat past eligibility', () => {
    expect(
      nextQueuedWakeDelayMs([
        queued({ nextEligibleAt: nowSec + 120 }),
        queued({ nextEligibleAt: nowSec + 40 }),
        queued({ nextEligibleAt: nowSec + 240 })
      ])
    ).toBe(41_000);
  });

  it("comes at a row's reap boundary when that is sooner than its eligibility", () => {
    expect(
      nextQueuedWakeDelayMs([queued({ initiatedAt: nowSec - MAX_QUEUED_AGE + 100, nextEligibleAt: nowSec + 240 })])
    ).toBe(103_000);
  });

  it('ignores rows that are not Queued', () => {
    expect(
      nextQueuedWakeDelayMs([
        { status: ITransactionStatus.GeneratingTransaction, initiatedAt: nowSec, nextEligibleAt: nowSec + 10 },
        queued({ nextEligibleAt: nowSec + 60 })
      ])
    ).toBe(61_000);
  });

  it('is undefined when no row is Queued', () => {
    expect(nextQueuedWakeDelayMs([])).toBeUndefined();
    expect(
      nextQueuedWakeDelayMs([{ status: ITransactionStatus.GeneratingTransaction, initiatedAt: nowSec }])
    ).toBeUndefined();
  });

  it('skips a row paused for its recovery seed, which the loop never picks and the reaper never expires', () => {
    expect(nextQueuedWakeDelayMs([queued({ awaitingRecoverySeed: true })])).toBeUndefined();
    expect(
      nextQueuedWakeDelayMs([queued({ awaitingRecoverySeed: true }), queued({ nextEligibleAt: nowSec + 60 })])
    ).toBe(61_000);
  });

  it('gives a row without a usable initiatedAt a finite delay', () => {
    expect(nextQueuedWakeDelayMs([queued({ initiatedAt: NaN, nextEligibleAt: nowSec + 60 * 60 })])).toBe(
      (MAX_QUEUED_AGE + 60) * 1000
    );
  });
});
