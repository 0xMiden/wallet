import type { AbandonStatus } from '@openzeppelin/guardian-client';

import * as Repo from 'lib/miden/repo';

import { __resetCadenceForTests, AccountState, NodeReads, observeTip } from './reconcile-reads';
import {
  nullifierIntervalMs,
  parseSchedule,
  reconcileUnconfirmedTransactions,
  SCHEDULE_KEY
} from './reconcile-unconfirmed';
import { GUARDIAN_PENDING_HOLD_SEC, keptCandidateHoldUntil } from './verdict-rules';
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
    clock = NOW_MS + 46_000;
    await reconcileUnconfirmedTransactions({ storage, createReads, now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ r: { nextCheckAt: NOW_MS + 46_000 + 60_000, step: 3 } });
  });

  // Uncapped, step 8 waits 3840 s, which isDue reads as a clock stepped back: the row would be judged every pass.
  it('caps the pending backoff at 300 s', async () => {
    await Repo.transactions.put(row('r'));
    const storage = memoryStorage({ [SCHEDULE_KEY]: { r: { nextCheckAt: NOW_MS - 1, step: 8 } } });
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => pendingNode(), now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ r: { nextCheckAt: NOW_MS + 300_000, step: 9 } });
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

  // Only reads can use the binding budget the fast lane exists for, and an entry on another network gets none.
  it('backs off an entry on another network instead of watching its nullifier', async () => {
    await Repo.transactions.put(
      row('c', {
        type: 'consume',
        submitEvidence: [
          entry({ outputNoteIds: [], nullifiers: [hex(30)], expirationBlock: 700, otherNetworkSince: NOW - 100 })
        ]
      })
    );
    const storage = memoryStorage();
    const otherNetwork: NodeReads = { ...pendingNode(), blockCommitment: async () => hex(99) };
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => otherNetwork, now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ c: { nextCheckAt: NOW_MS + 15_000, step: 1 } });
    clock = NOW_MS + 16_000;
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => otherNetwork, now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ c: { nextCheckAt: NOW_MS + 16_000 + 30_000, step: 2 } });
  });

  // A header the node cannot return (a reset chain still short of refBlock) never sets otherNetworkSince.
  it('watches a nullifier whose tip is unknown only for the hour after its crossing', async () => {
    const watched = { outputNoteIds: [], nullifiers: [hex(30)], expirationBlock: 700 };
    await Repo.transactions.bulkPut([
      row('fresh', { type: 'consume', submitEvidence: [entry(watched)] }),
      row('old', {
        type: 'consume',
        accountId: 'mtst1other',
        submitEvidence: [entry({ ...watched, capturedAt: NOW - 3601 })]
      })
    ]);
    const storage = memoryStorage();
    const noHeader: NodeReads = { ...pendingNode(), blockCommitment: async () => undefined };
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => noHeader, now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({
      fresh: { nextCheckAt: NOW_MS + 5_000, step: 0 },
      old: { nextCheckAt: NOW_MS + 15_000, step: 1 }
    });
  });

  it.each<[string, Partial<ISubmitEvidence>]>([
    ['a verdict', { verdict: 'unresolvable' }],
    ['a pre-submit end', { preSubmitEnd: true }]
  ])('never watches a nullifier entry that carries %s', async (_label, ended) => {
    await Repo.transactions.put(
      row('r', {
        submitEvidence: [
          entry({ outputNoteIds: [], nullifiers: [hex(30)], ...ended }),
          entry({ attemptId: 'a2', transactionId: hex(3) })
        ]
      })
    );
    const storage = memoryStorage();
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => pendingNode(), now });
    expect(storage.data[SCHEDULE_KEY]).toEqual({ r: { nextCheckAt: NOW_MS + 15_000, step: 1 } });
  });

  // Mobile fires a pass on every 3 s sync.
  it('writes nothing when no row was due', async () => {
    await Repo.transactions.put(row('r'));
    const storage = memoryStorage({ [SCHEDULE_KEY]: { r: { nextCheckAt: NOW_MS + 10_000, step: 1 } } });
    const set = jest.spyOn(storage, 'set');
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => pendingNode(), now });
    expect(set).not.toHaveBeenCalled();
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

  it('a row whose judgement throws backs off like an undecided one, and stops no other row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Repo.transactions.bulkPut([row('first'), row('second', { accountId: 'mtst1other' }), row('third')]);
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
    const firstCheck = { nextCheckAt: NOW_MS + 15_000, step: 1 };
    expect(storage.data[SCHEDULE_KEY]).toEqual({ first: firstCheck, second: firstCheck, third: firstCheck });
    expect(warn).toHaveBeenCalledTimes(1);
    clock = NOW_MS + 16_000;
    await reconcileUnconfirmedTransactions({ storage, createReads: async () => node, now });
    const secondCheck = { nextCheckAt: NOW_MS + 16_000 + 30_000, step: 2 };
    expect(storage.data[SCHEDULE_KEY]).toEqual({ first: secondCheck, second: secondCheck, third: secondCheck });
    expect(warn).toHaveBeenCalledTimes(2);
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

describe('releasing a kept Guardian candidate (#1081)', () => {
  const keptRow = () =>
    row('g', { submitEvidence: [entry({ expirationBlock: 700, candidateKept: true, guardianProposalNonce: 9 })] });
  const deadNode = () => pendingNode({ blockNum: 750, commitment: INITIAL });
  // The release's bound reads a monotonic clock, which a wall clock set back does not move.
  let mono = 0;
  const nowMono = () => mono;
  const sleep = async (ms: number) => {
    clock += ms;
    mono += ms;
  };
  const releaseAnswering = (answers: AbandonStatus[]) => {
    const status = jest.fn(async (_timeoutMs: number): Promise<AbandonStatus> => answers.shift() ?? 'waiting');
    const abandon = jest.fn(async (_accountId: string, _nonce: number, _attemptId: string) => ({ status }));
    return { release: { abandon }, abandon, status };
  };
  const stored = () => Repo.transactions.where({ id: 'g' }).first();

  beforeEach(() => {
    mono = 0;
    // Every unreleased candidate is logged.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('asks for the abandon after the never-committed write, and clears candidateKept once released', async () => {
    await Repo.transactions.put(keptRow());
    const { release, abandon, status } = releaseAnswering(['waiting', 'abandoned']);
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release
    });
    // With the entry's attempt id, which the release must find on this realm's record before it abandons that nonce.
    expect(abandon).toHaveBeenCalledWith('mtst1acct_s', 9, 'a1');
    expect(status).toHaveBeenCalledTimes(2);
    expect((await stored())?.neverCommittedAt).toBe(NOW);
    expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBeUndefined();
  });

  // #1317 run A: a submit failure the classifier does not read as unknown ends the row Failed, not Unconfirmed, and
  // a Failed row that can await a verdict is judged and released the same way.
  it('releases the kept candidate of a Failed row too', async () => {
    await Repo.transactions.put({ ...keptRow(), status: ITransactionStatus.Failed });
    const { release, abandon } = releaseAnswering(['abandoned']);
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release
    });
    expect(abandon).toHaveBeenCalledWith('mtst1acct_s', 9, 'a1');
    expect((await stored())?.status).toBe(ITransactionStatus.Failed);
    expect((await stored())?.neverCommittedAt).toBe(NOW);
    expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBeUndefined();
  });

  it('polls every 3 s for at most 60 s, then leaves candidateKept set', async () => {
    await Repo.transactions.put(keptRow());
    const { release, status } = releaseAnswering([]);
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release
    });
    // The last read is at 57 s: one more interval would leave no time to read in.
    expect(status).toHaveBeenCalledTimes(19);
    expect(mono).toBe(57_000);
    expect(clock - NOW_MS).toBe(57_000);
    expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBe(true);
  });

  it('caps each status read at the time left, so reads that each take 30 s still end the release within 60 s', async () => {
    await Repo.transactions.put(keptRow());
    // A Guardian that answers each read after 30 s, cut off at the timeout the release passes, as the real read is.
    const status = jest.fn(async (timeoutMs: number): Promise<AbandonStatus> => {
      const took = Math.min(30_000, timeoutMs);
      clock += took;
      mono += took;
      return 'waiting';
    });
    const release = {
      abandon: jest.fn(async (_accountId: string, _nonce: number, _attemptId: string) => ({ status }))
    };
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release
    });
    expect(mono).toBeLessThanOrEqual(60_000);
    expect(status.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([57_000, 24_000]);
    expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBe(true);
  });

  it('bounds the poll on the monotonic clock, so a wall clock set back an hour mid-poll still ends it by 60 s', async () => {
    await Repo.transactions.put(keptRow());
    const { release, status } = releaseAnswering([]);
    status
      .mockImplementationOnce(async () => 'waiting')
      .mockImplementationOnce(async () => {
        clock -= 3_600_000;
        return 'waiting';
      });
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release
    });
    expect(status).toHaveBeenCalledTimes(19);
    expect(mono).toBe(57_000);
  });

  it.each<AbandonStatus>(['landed', 'retained', 'unexpected'])(
    'stops at %s and leaves candidateKept set',
    async answer => {
      await Repo.transactions.put(keptRow());
      const { release, status } = releaseAnswering([answer]);
      await reconcileUnconfirmedTransactions({
        storage: memoryStorage(),
        createReads: async () => deadNode(),
        now,
        nowMono,
        sleep,
        release
      });
      expect(status).toHaveBeenCalledTimes(1);
      expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBe(true);
    }
  );

  it('leaves candidateKept set when nothing was asked of the Guardian', async () => {
    await Repo.transactions.put(keptRow());
    const abandon = jest.fn(async () => undefined);
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release: { abandon }
    });
    expect(abandon).toHaveBeenCalledTimes(1);
    expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBe(true);
  });

  it('an abandoned answer is what ends Retry`s hold: the clear removes the mark the hold reads', async () => {
    await Repo.transactions.put(keptRow());
    const before = await stored();
    expect(before && keptCandidateHoldUntil(before, NOW)).toBe(NOW - 60 + GUARDIAN_PENDING_HOLD_SEC);
    const { release } = releaseAnswering(['abandoned']);
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release
    });
    const after = await stored();
    expect(after && keptCandidateHoldUntil(after, NOW)).toBeUndefined();
  });

  it.each<[string, Partial<ISubmitEvidence>]>([
    ['its nonce', { guardianProposalNonce: 10 }],
    ['its attempt', { attemptId: 'a2' }]
  ])('clears nothing when the entry changed %s before the Guardian answered', async (_label, changed) => {
    await Repo.transactions.put(keptRow());
    const status = jest.fn(async (_timeoutMs: number): Promise<AbandonStatus> => 'abandoned');
    const abandon = jest.fn(async (_accountId: string, _nonce: number, _attemptId: string) => {
      // Another write moved the kept entry on between the pass's judgement and the clear.
      await Repo.transactions.where({ id: 'g' }).modify(row => {
        row.submitEvidence = (row.submitEvidence ?? []).map(entry => ({ ...entry, ...changed }));
      });
      return { status };
    });
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep,
      release: { abandon }
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBe(true);
  });

  it('a sleep that overshoots the bound ends the poll with no read past it', async () => {
    await Repo.transactions.put(keptRow());
    const { release, status } = releaseAnswering([]);
    let sleeps = 0;
    const lateTimer = async (ms: number) => {
      sleeps += 1;
      // The second timer fires 70 s late, past the 60 s bound.
      const took = sleeps === 2 ? 70_000 : ms;
      clock += took;
      mono += took;
    };
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => deadNode(),
      now,
      nowMono,
      sleep: lateTimer,
      release
    });
    expect(status.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([57_000]);
    expect((await stored())?.submitEvidence?.[0]?.candidateKept).toBe(true);
  });

  it('releases nothing for a row still pending', async () => {
    await Repo.transactions.put(keptRow());
    const { release, abandon } = releaseAnswering(['abandoned']);
    await reconcileUnconfirmedTransactions({
      storage: memoryStorage(),
      createReads: async () => pendingNode(),
      now,
      nowMono,
      sleep,
      release
    });
    expect(abandon).not.toHaveBeenCalled();
  });
});
