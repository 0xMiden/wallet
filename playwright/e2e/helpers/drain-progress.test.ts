import type { Page } from '@playwright/test';

import {
  DRAIN_DUMP_MARGIN_MS,
  DRAIN_STALL_WINDOW_MS,
  drainProgress,
  extendTestTimeoutForDrain,
  readDrainSnapshot,
  startDrainDeadline,
  type DrainRow,
  type DrainSnapshot
} from './drain-progress';

const row = (id: string, status: number, stage: string | null): DrainRow => ({ id, status, stage });
const snap = (rows: DrainRow[], completedCount: number): DrainSnapshot => ({ rows, completedCount });
const at = (stage: string): DrainSnapshot => snap([row('a', 1, stage)], 3);
const idle = snap([], 3);

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
  const signing = snap([row('a', 1, 'signing-proposal')], 4);

  it.each([
    { label: 'a row changed status', next: snap([row('a', 0, 'signing-proposal')], 4) },
    { label: 'a row changed stage', next: snap([row('a', 1, 'sending')], 4) },
    { label: 'a row left the uncompleted set', next: snap([], 4) },
    { label: 'the Completed count rose', next: snap([row('a', 1, 'signing-proposal')], 5) }
  ])('is progress when $label', ({ next }) => {
    expect(drainProgress(signing, next)).toBe(true);
  });

  it('is not progress on an identical snapshot', () => {
    expect(drainProgress(signing, snap([row('a', 1, 'signing-proposal')], 4))).toBe(false);
  });

  it('is not progress when a row only joins the queue', () => {
    expect(drainProgress(signing, snap([row('a', 1, 'signing-proposal'), row('b', 0, null)], 4))).toBe(false);
  });

  it.each([
    { label: 'the new read', prev: signing, next: null },
    { label: 'the previous read', prev: null, next: signing },
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
    const deadline = startDrainDeadline(120_000, clock.now);
    deadline.observe(at('sending'));
    clock.advance(100_000);
    deadline.observe(at('signing-proposal'));
    clock.advance(20_000);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(DRAIN_STALL_WINDOW_MS - 20_001);
    expect(deadline.verdict()).toBe('continue');
    clock.advance(1);
    expect(deadline.verdict()).toBe('stalled');
  });

  it('ends at the cap, twice the budget, while the queue is still moving', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(at('complete'));
    for (let lap = 0; lap < 12; lap++) {
      clock.advance(9_999);
      deadline.observe(at(lap % 2 === 0 ? 'sending' : 'signing-proposal'));
    }
    expect(deadline.verdict()).toBe('continue');
    clock.advance(12);
    expect(deadline.verdict()).toBe('cap');
  });

  it('names a queue that stopped moving stalled, even past the cap', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(at('sending'));
    clock.advance(20_000);
    deadline.observe(at('signing-proposal'));
    clock.advance(110_000);
    expect(deadline.verdict()).toBe('stalled');
  });

  it('compares across an unreadable lap with the last readable snapshot', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(at('signing-proposal'));
    clock.advance(9_000);
    deadline.observe(null);
    clock.advance(9_000);
    deadline.observe(idle);
    clock.advance(42_000);
    expect(deadline.verdict()).toBe('continue');
  });

  it('lets unreadable laps count for nothing, so they cannot hold the deadline open', () => {
    const clock = fakeClock();
    const deadline = startDrainDeadline(60_000, clock.now);
    deadline.observe(null);
    clock.advance(30_000);
    deadline.observe(at('sending'));
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

  const seed = async (rows: Array<Record<string, unknown>>): Promise<void> => {
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

  it('reads the Queued and Generating rows and counts the Completed ones, skipping Failed', async () => {
    await seed([
      { id: 'c1', status: 2, stage: 'complete' },
      { id: 'c2', status: 2 },
      { id: 'f1', status: 3, stage: 'sending' },
      { id: 'g1', status: 1, stage: 'signing-proposal', stageTimestamps: { syncing: 1, sending: 2 } },
      { id: 'q1', status: 0 }
    ]);
    await expect(readDrainSnapshot(pageRunningHere())).resolves.toEqual({
      rows: [
        { id: 'g1', status: 1, stage: 'signing-proposal' },
        { id: 'q1', status: 0, stage: null }
      ],
      completedCount: 2
    });
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
});
