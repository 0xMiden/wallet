import type { Page } from '@playwright/test';

import {
  DRAIN_DUMP_MARGIN_MS,
  DRAIN_STALL_WINDOW_MS,
  drainProgress,
  extendTestTimeoutForDrain,
  readDrainSnapshot,
  startDrainDeadline,
  type DrainSnapshot
} from './drain-progress';
import { readTransactionRows, readTransactionRowsOrNull } from './history';

const completed = (completedCount: number): DrainSnapshot => ({ completedCount });
const idle = completed(3);

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000;
  return {
    now: () => current,
    advance: ms => {
      current += ms;
    }
  };
}

describe('drainProgress', () => {
  it('is progress when the Completed count rose', () => {
    expect(drainProgress(completed(4), completed(5))).toBe(true);
  });

  it('is not progress on an identical snapshot', () => {
    expect(drainProgress(completed(4), completed(4))).toBe(false);
  });

  it('is not progress when the Completed count fell', () => {
    expect(drainProgress(completed(4), completed(3))).toBe(false);
  });

  it.each([
    { label: 'the new read', prev: completed(4), next: null },
    { label: 'the previous read', prev: null, next: completed(4) },
    { label: 'both reads', prev: null, next: null }
  ])('is never progress when $label is unreadable', ({ prev, next }) => {
    expect(drainProgress(prev, next)).toBe(false);
  });
});

describe('startDrainDeadline', () => {
  it('ends an idle queue exactly at its budget, as the flat deadline did', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(idle);
    clock.advance(59_999);
    deadline.observe(idle);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(1);
    expect(deadline.verdict()).toBe('stalled');
  });

  it('extends past the budget while the last progress is inside the stall window', () => {
    const clock = fakeClock();
    // A budget whose cap lies well past every assertion below, so this test never crosses into 'cap' territory
    // regardless of how wide DRAIN_STALL_WINDOW_MS is.
    const budgetMs = 400_000;
    const deadline = startDrainDeadline(budgetMs, clock.now);
    deadline.observe(completed(3));
    clock.advance(budgetMs - 20_000);
    deadline.observe(completed(4));
    clock.advance(20_000);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(DRAIN_STALL_WINDOW_MS - 20_001);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(1);
    expect(deadline.verdict()).toBe('stalled');
  });

  it('runs to the cap, twice the budget, while the Completed count keeps rising', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(completed(0));
    for (let lap = 1; lap <= 12; lap++) {
      clock.advance(9_999);
      deadline.observe(completed(lap));
    }
    expect(deadline.verdict()).toBe('continue');
    clock.advance(12);
    expect(deadline.verdict()).toBe('cap');
  });

  it('names a queue that stopped moving stalled, even past the cap', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(completed(3));
    clock.advance(20_000);
    deadline.observe(completed(4));
    // A full stall window past the last completion, whatever that window is, so the queue is never 'moving' here.
    clock.advance(DRAIN_STALL_WINDOW_MS);
    expect(deadline.verdict()).toBe('stalled');
  });

  it('reads continue through a normal Guardian turn-away and stalls the window past the last completion, not the budget', () => {
    const clock = fakeClock();
    // A budget whose cap sits well past every assertion below, so only the stall window is ever in play.
    const budgetMs = 400_000;
    const turnAwayMs = 165_000;
    const deadline = startDrainDeadline(budgetMs, clock.now);
    deadline.observe(completed(3));
    clock.advance(budgetMs);
    deadline.observe(completed(4));
    clock.advance(turnAwayMs - 1);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(1);
    deadline.observe(completed(5));
    clock.advance(DRAIN_STALL_WINDOW_MS - 1);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(1);
    expect(deadline.verdict()).toBe('stalled');
  });

  it('checks a read by observing it first, so a completion in it counts before a stall-window-old queue is judged', () => {
    const clock = fakeClock();
    // A budget whose cap sits well past every assertion below, so only the stall window is ever in play.
    const budgetMs = 400_000;
    const deadline = startDrainDeadline(budgetMs, clock.now);
    const twin = startDrainDeadline(budgetMs, clock.now);
    for (const each of [deadline, twin]) each.observe(completed(3));
    clock.advance(budgetMs + 10_000);
    for (const each of [deadline, twin]) each.observe(completed(4));
    clock.advance(DRAIN_STALL_WINDOW_MS + 5_000);
    expect(deadline.check(completed(5))).toBe('continue');
    expect(twin.verdict()).toBe('stalled');
    expect(twin.check(completed(4))).toBe('stalled');
  });

  it('compares across an unreadable lap with the last readable snapshot', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(completed(3));
    clock.advance(9_000);
    deadline.observe(null);
    clock.advance(9_000);
    deadline.observe(completed(4));
    clock.advance(42_000);
    expect(deadline.verdict()).toBe('continue');
  });

  it('lets unreadable laps count for nothing, so they cannot hold the deadline open', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(null);
    clock.advance(30_000);
    deadline.observe(completed(3));
    for (let lap = 0; lap < 3; lap++) {
      clock.advance(10_000);
      deadline.observe(null);
    }
    expect(deadline.verdict()).toBe('stalled');
  });

  it('reads the monotonic clock by default, so a wall-clock step neither ends nor stretches the drain', () => {
    let monotonicMs = 5_000;
    const monotonic = jest.spyOn(performance, 'now').mockImplementation(() => monotonicMs);
    const wall = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const deadline = startDrainDeadline(60_000);
      deadline.observe(idle);
      wall.mockReturnValue(1_700_000_000_000 + 10 * 60_000);
      expect(deadline.verdict()).toBe('continue');
      wall.mockReturnValue(1_700_000_000_000 - 10 * 60_000);
      monotonicMs += 60_000;
      expect(deadline.verdict()).toBe('stalled');
    } finally {
      monotonic.mockRestore();
      wall.mockRestore();
    }
  });

  it('does not call onOverrun before the budget', () => {
    const clock = fakeClock();
    const onOverrun = jest.fn();
    const deadline = startDrainDeadline(60_000, clock.now, onOverrun);
    deadline.observe(idle);
    clock.advance(59_999);
    expect(deadline.verdict()).toBe('continue');
    expect(onOverrun).not.toHaveBeenCalled();
  });

  it('calls onOverrun once on the first verdict that lands past the budget while moving', () => {
    const clock = fakeClock();
    const onOverrun = jest.fn();
    const deadline = startDrainDeadline(60_000, clock.now, onOverrun);
    deadline.observe(completed(3));
    clock.advance(59_999);
    deadline.observe(completed(4));
    clock.advance(1);
    expect(deadline.verdict()).toBe('continue');
    expect(onOverrun).toHaveBeenCalledTimes(1);
  });

  it('does not call onOverrun again on a later verdict, even once the drain reaches the cap', () => {
    const clock = fakeClock();
    const onOverrun = jest.fn();
    const deadline = startDrainDeadline(60_000, clock.now, onOverrun);
    deadline.observe(completed(0));
    for (let lap = 1; lap <= 12; lap++) {
      clock.advance(9_999);
      deadline.observe(completed(lap));
    }
    expect(deadline.verdict()).toBe('continue');
    expect(onOverrun).toHaveBeenCalledTimes(1);
    expect(deadline.verdict()).toBe('continue');
    expect(onOverrun).toHaveBeenCalledTimes(1);
    clock.advance(12);
    expect(deadline.verdict()).toBe('cap');
    expect(onOverrun).toHaveBeenCalledTimes(1);
  });

  it('does not call onOverrun when the verdict past the budget is stalled', () => {
    const clock = fakeClock();
    const onOverrun = jest.fn();
    const deadline = startDrainDeadline(60_000, clock.now, onOverrun);
    deadline.observe(idle);
    clock.advance(60_000);
    expect(deadline.verdict()).toBe('stalled');
    expect(onOverrun).not.toHaveBeenCalled();
  });
});

describe('extendTestTimeoutForDrain', () => {
  const fakeInfo = (timeout: number): { timeout: number; setTimeout: jest.Mock } => ({
    timeout,
    setTimeout: jest.fn()
  });

  it('extends a 600s timeout by (cap - budget) + DRAIN_DUMP_MARGIN_MS for a given budget', () => {
    const info = fakeInfo(600_000);
    extendTestTimeoutForDrain(240_000, info);
    expect(info.setTimeout).toHaveBeenCalledWith(600_000 + 240_000 + DRAIN_DUMP_MARGIN_MS);
  });

  it('leaves timeout 0 untouched (setTimeout not called)', () => {
    const info = fakeInfo(0);
    extendTestTimeoutForDrain(240_000, info);
    expect(info.setTimeout).not.toHaveBeenCalled();
  });

  it('is a no-op with no info', () => {
    expect(() => extendTestTimeoutForDrain(240_000, undefined)).not.toThrow();
  });
});

describe('readDrainSnapshot', () => {
  const pageRunningHere = (): Page =>
    ({
      evaluate: jest.fn(async <T>(callback: (arg: T) => unknown, arg: T) => callback(arg))
    }) as unknown as Page;

  const seed = async (rows: Array<Record<string, unknown>>, removedIds: string[] = []): Promise<void> => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('TridentMain', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('transactions', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('transactions', 'readwrite');
      for (const each of rows) tx.objectStore('transactions').put(each);
      for (const id of removedIds) tx.objectStore('transactions').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  // jest.setup.js's global afterEach clears the production `TridentMain` Dexie connection on
  // every test in the file, which auto-opens it at the real schema version. Wipe before AND
  // after each test here, or a preceding, unrelated test leaves the real schema (with its own
  // `transactions` store) open under this suite's own seeded rows.
  const wipeTridentMain = (): Promise<void> =>
    new Promise<void>(resolve => {
      const request = indexedDB.deleteDatabase('TridentMain');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });

  beforeEach(wipeTridentMain);
  afterEach(wipeTridentMain);

  it('counts the Completed rows and reads nothing else', async () => {
    await seed([
      { id: 'c1', status: 2, stage: 'complete' },
      { id: 'c2', status: 2 },
      { id: 'f1', status: 3, stage: 'sending' },
      { id: 'g1', status: 1, stage: 'signing-proposal', stageTimestamps: { syncing: 1, sending: 2 } },
      { id: 'q1', status: 0 }
    ]);
    await expect(readDrainSnapshot(pageRunningHere())).resolves.toEqual({ completedCount: 2 });
  });

  it('is unreadable, not empty, when the page cannot run the read', async () => {
    const page = {
      evaluate: jest.fn(async () => {
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      })
    } as unknown as Page;
    await expect(readDrainSnapshot(page)).resolves.toBeNull();
  });

  it('is unreadable when the database has no transactions store', async () => {
    await expect(readDrainSnapshot(pageRunningHere())).resolves.toBeNull();
  });

  it('reads a readable empty store as no Completed rows, not as unreadable', async () => {
    await seed([]);
    await expect(readDrainSnapshot(pageRunningHere())).resolves.toEqual({ completedCount: 0 });
  });

  it('shares a reader that tells a missing store apart, while readTransactionRows keeps [] for it', async () => {
    await expect(readTransactionRowsOrNull(pageRunningHere())).resolves.toBeNull();
    await expect(readTransactionRows(pageRunningHere())).resolves.toEqual([]);
  });

  it('streams the rows, so readTransactionRows reads them projected and in key order without getAll', async () => {
    await seed([
      { id: 'q1', status: 0, type: 'send', amount: 5n, stageTimestamps: { syncing: 1 } },
      { id: 'c1', status: 2, stage: 'complete', feeAmount: 7n, completedAt: 9, rotationFunding: true }
    ]);
    const getAll = jest.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => {
      throw new Error('getAll: rows carry request and result bytes');
    });
    try {
      await expect(readTransactionRows(pageRunningHere())).resolves.toEqual([
        { id: 'c1', status: 2, stage: 'complete', feeAmount: '7', completedAt: 9, rotationFunding: true },
        { id: 'q1', status: 0, type: 'send', amount: '5' }
      ]);
    } finally {
      getAll.mockRestore();
    }
  });

  const signing = { id: 'g1', status: 1, stage: 'signing-proposal' };

  it.each([
    { label: 'the Generating row went back to Queued (a requeue)', rows: [{ ...signing, status: 0 }], removedIds: [] },
    { label: 'the Generating row changed stage', rows: [{ ...signing, stage: 'sending' }], removedIds: [] },
    { label: 'the Generating row was deleted', rows: [], removedIds: ['g1'] },
    {
      label: 'the Generating row went to Failed with the Completed count unchanged',
      rows: [{ ...signing, status: 3 }],
      removedIds: []
    },
    { label: 'a new Queued row joined', rows: [{ id: 'q1', status: 0 }], removedIds: [] }
  ])('reads no progress between two reads when $label', async ({ rows, removedIds }) => {
    await seed([signing, { id: 'c1', status: 2, stage: 'complete' }]);
    const before = await readDrainSnapshot(pageRunningHere());
    await seed(rows, removedIds);
    expect(drainProgress(before, await readDrainSnapshot(pageRunningHere()))).toBe(false);
  });

  it('reads progress between two reads when the Generating row went to Completed', async () => {
    await seed([signing, { id: 'c1', status: 2, stage: 'complete' }]);
    const before = await readDrainSnapshot(pageRunningHere());
    await seed([{ ...signing, status: 2, stage: 'complete' }]);
    expect(drainProgress(before, await readDrainSnapshot(pageRunningHere()))).toBe(true);
  });

  it('stalls a queue whose rows only join and fail one window after its last completion, not at the cap', async () => {
    const budgetMs = 240_000;
    const lapMs = 10_000;
    const clock = fakeClock();
    const page = pageRunningHere();
    await seed([{ id: 'r0', status: 0 }]);
    const deadline = startDrainDeadline(budgetMs, clock.now);
    deadline.observe(await readDrainSnapshot(page));
    let lap = 0;
    // Each lap a new Queued row joins and the previous lap's row fails, except at the budget, where it completes.
    const runLap = async (): Promise<void> => {
      lap += 1;
      const settled = lap * lapMs === budgetMs ? 2 : 3;
      await seed([
        { id: `r${lap - 1}`, status: settled },
        { id: `r${lap}`, status: 0 }
      ]);
      deadline.observe(await readDrainSnapshot(page));
    };
    while ((lap + 1) * lapMs < budgetMs + DRAIN_STALL_WINDOW_MS) {
      clock.advance(lapMs);
      await runLap();
    }
    clock.advance(lapMs - 1);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(1);
    await runLap();
    expect(deadline.verdict()).toBe('stalled');
  });
});
