import * as Repo from 'lib/miden/repo';

import { __resetCadenceForTests, AccountState, NodeReads, observeTip } from './reconcile-reads';
import {
  nullifierIntervalMs,
  parseSchedule,
  reconcileUnconfirmedTransactions,
  SCHEDULE_KEY
} from './reconcile-unconfirmed';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const INITIAL = hex(10);
const OTHER = hex(12);

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 60,
  source: 'stage',
  transactionId: hex(2),
  initialCommitment: INITIAL,
  finalCommitment: hex(11),
  initialNonce: '5',
  outputNoteIds: [hex(20)],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  ...overrides
});

const row = (id: string, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id,
  type: 'send',
  accountId: 'mtst1acct_s',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 120,
  completedAt: NOW - 100,
  displayIcon: 'SEND',
  submitEvidence: [entry()],
  ...overrides
});

const memoryStorage = (initial: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: async (keys: string[]) => Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]])),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
    remove: async (keys: string[]) => {
      for (const key of keys) delete data[key];
    }
  };
};

/** Undecided by default: tip off E.initial, no marks, nothing proven. */
const pendingNode = (
  tip: AccountState = { blockNum: 150, commitment: OTHER },
  onRead?: () => Promise<void>
): NodeReads => ({
  blockCommitment: async () => HEADER,
  account: async () => {
    await onRead?.();
    return { ok: true, state: tip };
  },
  noteInclusions: async () => new Map(),
  nullifierHeight: async () => null
});

let clock = NOW_MS;
const now = () => clock;

beforeEach(async () => {
  clock = NOW_MS;
  __resetCadenceForTests();
  await Repo.transactions.clear();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});

describe('the pass (#1081)', () => {
  // Review Focus 5: the pass fires after every successful sync, every 3 s on mobile.
  it('with no row awaiting a verdict it builds no client and makes no read', async () => {
    await Repo.transactions.put(row('done', { status: ITransactionStatus.Completed }));
    const createReads = jest.fn(async () => pendingNode());
    await reconcileUnconfirmedTransactions({ storage: memoryStorage(), createReads, now });
    expect(createReads).not.toHaveBeenCalled();
  });

  it('checks a row on the first pass, then backs off 15 s doubling to a 300 s cap', async () => {
    await Repo.transactions.put(row('r'));
    const storage = memoryStorage();
    const createReads = jest.fn(async () => pendingNode());
    await reconcileUnconfirmedTransactions({ storage, createReads, now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ r: { nextCheckAt: NOW_MS + 15_000, step: 1 } });
    clock = NOW_MS + 10_000;
    await reconcileUnconfirmedTransactions({ storage, createReads, now });
    expect(createReads).toHaveBeenCalledTimes(1);
    clock = NOW_MS + 16_000;
    await reconcileUnconfirmedTransactions({ storage, createReads, now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ r: { nextCheckAt: NOW_MS + 16_000 + 30_000, step: 2 } });
  });

  it('waits an hour between checks of a row more than a day old', async () => {
    await Repo.transactions.put(row('old', { initiatedAt: NOW - 25 * 3600 }));
    const storage = memoryStorage();
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => pendingNode(), now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ old: { nextCheckAt: NOW_MS + 3_600_000, step: 1 } });
  });

  it('watches a nullifier-bearing entry every clamp(10 blocks, 2 s, 15 s), never backing off, until X + 1', async () => {
    await Repo.transactions.put(
      row('c', {
        type: 'consume',
        submitEvidence: [entry({ outputNoteIds: [], nullifiers: [hex(30)], expirationBlock: 700 })]
      })
    );
    const storage = memoryStorage();
    await reconcileUnconfirmedTransactions({
      storage,
      createReads: async () => pendingNode({ blockNum: 150, commitment: OTHER }),
      now
    });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ c: { nextCheckAt: NOW_MS + 5_000, step: 0 } });
    observeTip(1, 0);
    observeTip(2, 3_000);
    expect(nullifierIntervalMs(3_000)).toBe(15_000);
    expect(nullifierIntervalMs(100)).toBe(2_000);
    clock = NOW_MS + 6_000;
    await reconcileUnconfirmedTransactions({
      storage,
      createReads: async () => pendingNode({ blockNum: 701, commitment: OTHER }),
      now
    });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ c: { nextCheckAt: clock + 15_000, step: 1 } });
  });

  it('stops watching a nullifier without X an hour after the crossing', async () => {
    await Repo.transactions.put(
      row('c', {
        type: 'consume',
        submitEvidence: [entry({ outputNoteIds: [], nullifiers: [hex(30)], capturedAt: NOW - 3601 })]
      })
    );
    const storage = memoryStorage();
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => pendingNode(), now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ c: { nextCheckAt: NOW_MS + 15_000, step: 1 } });
  });

  it('drops a row that left the set, and a row a final verdict settled', async () => {
    await Repo.transactions.put(row('dead', { submitEvidence: [entry({ expirationBlock: 700 })] }));
    const storage = memoryStorage({
      [SCHEDULE_KEY]: { gone: { nextCheckAt: 0, step: 3 }, dead: { nextCheckAt: NOW_MS - 1, step: 2 } }
    });
    await reconcileUnconfirmedTransactions({
      storage,
      createReads: async () => pendingNode({ blockNum: 750, commitment: INITIAL }),
      now
    });
    expect(storage.data[SCHEDULE_KEY]).toEqual({});
    expect((await Repo.transactions.where({ id: 'dead' }).first())?.neverCommittedAt).toBe(NOW);
  });

  it('skips a row whose verdict lock is held and leaves its schedule alone', async () => {
    const { inVerdictTurn } = await import('lib/miden/front/storage');
    await Repo.transactions.put(row('r'));
    const storage = memoryStorage({ [SCHEDULE_KEY]: { r: { nextCheckAt: NOW_MS - 1, step: 2 } } });
    let release: () => void = () => {};
    const held = inVerdictTurn('r', () => new Promise<void>(resolve => (release = resolve)), { waitMs: 10_000 });
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => pendingNode(), now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ r: { nextCheckAt: NOW_MS - 1, step: 2 } });
    release();
    await held;
  });

  it('a concurrent call joins the running pass', async () => {
    await Repo.transactions.put(row('r'));
    const createReads = jest.fn(async () => pendingNode());
    const deps = { storage: memoryStorage(), createReads, now };
    await Promise.all([reconcileUnconfirmedTransactions(deps), reconcileUnconfirmedTransactions(deps)]);
    expect(createReads).toHaveBeenCalledTimes(1);
  });

  // Review Focus 2.
  it('a row deleted mid-pass neither throws nor stops the others', async () => {
    await Repo.transactions.bulkPut([row('first'), row('second', { accountId: 'mtst1other' })]);
    const storage = memoryStorage();
    let deleted = false;
    const node = pendingNode(undefined, async () => {
      if (!deleted) {
        deleted = true;
        await Repo.transactions.where({ id: 'second' }).delete();
      }
    });
    await expect(
      reconcileUnconfirmedTransactions({ storage, createReads: async () => node, now })
    ).resolves.toBeUndefined();
    expect(storage.data[SCHEDULE_KEY]).toEqual({ first: { nextCheckAt: NOW_MS + 15_000, step: 1 } });
  });

  it('a row whose judgement throws neither rejects nor stops the others', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Repo.transactions.bulkPut([row('first'), row('second', { accountId: 'mtst1other' })]);
    const storage = memoryStorage();
    const node: NodeReads = {
      ...pendingNode(),
      account: async accountId => {
        if (accountId === 'mtst1acct_s') throw new Error('a bug in a read');
        return { ok: true, state: { blockNum: 150, commitment: OTHER } };
      }
    };
    await expect(
      reconcileUnconfirmedTransactions({ storage, createReads: async () => node, now })
    ).resolves.toBeUndefined();
    expect(storage.data[SCHEDULE_KEY]).toEqual({ second: { nextCheckAt: NOW_MS + 15_000, step: 1 } });
    jest.restoreAllMocks();
  });

  // Review Focus 3.
  it.each<[string, unknown]>([
    ['a string', 'garbage'],
    ['an array', [1, 2]],
    ['entries with NaN and a negative step', { r: { nextCheckAt: Number.NaN, step: -1 } }]
  ])('reads %s of a stored schedule as empty and rewrites it clean', async (_label, stored) => {
    await Repo.transactions.put(row('r'));
    const storage = memoryStorage({ [SCHEDULE_KEY]: stored });
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => pendingNode(), now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ r: { nextCheckAt: NOW_MS + 15_000, step: 1 } });
  });

  // The pass drops every id that is not a row awaiting a verdict, which masks an array's index keys; a NaN time is
  // never due and so would starve its row.
  it('keeps only well-formed schedule entries', () => {
    expect(parseSchedule([{ nextCheckAt: 1, step: 0 }])).toEqual({});
    expect(
      parseSchedule({
        nan: { nextCheckAt: Number.NaN, step: 1 },
        negative: { nextCheckAt: 5, step: -1 },
        fractional: { nextCheckAt: 5, step: 1.5 },
        text: 'x',
        empty: null,
        ok: { nextCheckAt: 5, step: 2 }
      })
    ).toEqual({ ok: { nextCheckAt: 5, step: 2 } });
  });

  // Review Focus 4.
  it('a nextCheckAt far ahead of a clock stepped back never starves a row past the longest interval', async () => {
    await Repo.transactions.put(row('r'));
    const storage = memoryStorage({ [SCHEDULE_KEY]: { r: { nextCheckAt: NOW_MS + 10 * 24 * 3_600_000, step: 2 } } });
    const createReads = jest.fn(async () => pendingNode());
    await reconcileUnconfirmedTransactions({ storage, createReads, now });
    expect(createReads).toHaveBeenCalledTimes(1);
  });

  it('never rejects into the sync lap', async () => {
    await Repo.transactions.put(row('r'));
    await expect(
      reconcileUnconfirmedTransactions({
        storage: memoryStorage(),
        createReads: async () => {
          throw new Error('no wasm');
        },
        now
      })
    ).resolves.toBeUndefined();
  });
});
