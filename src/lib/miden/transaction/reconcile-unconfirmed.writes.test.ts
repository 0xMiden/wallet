// Real Dexie: every write here is a guarded modify or a rw transaction, so stubbing the store would test nothing.
import * as Repo from 'lib/miden/repo';
import { NoteTypeEnum } from 'lib/miden/types';

import { TRANSACTION_NEVER_COMMITTED_ERROR } from './constants';
import { AccountState, NodeReads } from './reconcile-reads';
import { checkEvidenceForRetry, judgeAndWrite } from './reconcile-unconfirmed';
import { INoteDeliveryState, ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const INITIAL = hex(10);
const FINAL = hex(11);
const OTHER = hex(12);
const NOTE = hex(20);

/** Fake reads; `during` runs once, inside the note read, to model a writer outside the lock. */
const node = (
  tip: AccountState,
  options: { notes?: Record<string, number>; during?: () => Promise<void>; headerAfter?: string } = {}
): NodeReads => {
  let headerReads = 0;
  let ran = false;
  return {
    blockCommitment: async () => {
      headerReads += 1;
      return options.headerAfter !== undefined && headerReads > 2 ? options.headerAfter : HEADER;
    },
    account: async () => ({ ok: true, state: tip }),
    noteInclusions: async ids => {
      if (!ran && options.during) {
        ran = true;
        await options.during();
      }
      const found = new Map<string, number>();
      for (const id of ids) {
        const block = options.notes?.[id];
        if (block !== undefined) found.set(id, block);
      }
      return found;
    },
    nullifierHeight: async () => null
  };
};

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 60,
  source: 'stage',
  transactionId: hex(2),
  initialCommitment: INITIAL,
  finalCommitment: FINAL,
  initialNonce: '5',
  outputNoteIds: [NOTE],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  expirationBlock: 700,
  ...overrides
});

const unconfirmed = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'mtst1acct_s',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 120,
  completedAt: NOW - 100,
  error: 'sdk said no definite outcome',
  mayHaveSubmitted: true,
  noteType: NoteTypeEnum.Public,
  displayIcon: 'SEND',
  submitEvidence: [entry()],
  ...overrides
});

const context = (reads: NodeReads) => ({ node: reads, nowSec: NOW, cadenceMs: 3_000 });
const read = (id = 'tx-1') => Repo.transactions.where({ id }).first();
const UNDELIVERED_SEND = 'Sent - the private note could not be delivered';

beforeEach(async () => {
  jest.clearAllMocks();
  await Repo.transactions.clear();
});

describe('the landed write (#1081)', () => {
  it('completes the row with the landed fields, binds the id, keeps completedAt and reports completed', async () => {
    await Repo.transactions.put(unconfirmed());
    const outcome = await judgeAndWrite(
      'tx-1',
      context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } }))
    );
    expect(outcome.kind).toBe('landed');
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Completed,
      transactionId: hex(2),
      completedAt: NOW - 100,
      displayMessage: 'Sent'
    });
    expect(row?.error).toBeUndefined();
    const { reportOperation } = jest.requireMock('lib/telemetry/report-operation');
    expect(reportOperation).toHaveBeenCalledWith({ operation: expect.any(String), result: 'completed' });
  });

  it.each<[ITransaction['type'], ITransaction['displayIcon']]>([
    ['send', 'SEND'],
    ['swap', 'SWAP'],
    ['execute', 'DEFAULT']
  ])('a Failed %s that landed stops drawing as failed: it takes its type`s icon', async (type, icon) => {
    await Repo.transactions.put(unconfirmed({ type, status: ITransactionStatus.Failed, displayIcon: 'FAILED' }));
    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));
    expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, displayIcon: icon });
  });

  it('marks a private send undelivered', async () => {
    await Repo.transactions.put(unconfirmed({ noteType: NoteTypeEnum.Private }));
    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));
    expect((await read())?.noteDelivery).toBe('undelivered');
  });

  // A cancelled private send's pipeline runs on and relays its note, and the terminal guard keeps the row Failed:
  // what the relay recorded is its own outcome and survives the landing, exactly as Retry's landed path keeps it.
  it.each<[INoteDeliveryState | undefined, INoteDeliveryState, string]>([
    [undefined, 'undelivered', UNDELIVERED_SEND],
    ['undelivered', 'undelivered', UNDELIVERED_SEND],
    ['relayed', 'relayed', 'Sent'],
    ['pending', 'pending', 'Sent'],
    ['confirmed', 'confirmed', 'Sent']
  ])('a landed private send recorded as %s ends %s', async (recorded, delivery, label) => {
    await Repo.transactions.put(
      unconfirmed({ status: ITransactionStatus.Failed, noteType: NoteTypeEnum.Private, noteDelivery: recorded })
    );
    await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } })));
    expect(await read()).toMatchObject({
      status: ITransactionStatus.Completed,
      noteDelivery: delivery,
      displayMessage: label
    });
  });

  it('a landing the network check voids just before its write still reads as a landing, and writes nothing', async () => {
    await Repo.transactions.put(unconfirmed());
    const outcome = await judgeAndWrite(
      'tx-1',
      context(node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 }, headerAfter: OTHER }))
    );
    expect(outcome.kind).toBe('landing-pending');
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
    expect(row?.transactionId).toBeUndefined();
  });

  it('writes nothing when another row of the account gains an entry naming the note meanwhile, and never binds the stale id', async () => {
    await Repo.transactions.put(unconfirmed());
    await Repo.transactions.put(unconfirmed({ id: 'tx-2', status: ITransactionStatus.Failed, submitEvidence: [] }));
    const outcome = await judgeAndWrite(
      'tx-1',
      context(
        node(
          { blockNum: 150, commitment: OTHER },
          {
            notes: { [NOTE]: 140 },
            during: async () => {
              await Repo.transactions.where({ id: 'tx-2' }).modify(row => {
                row.submitEvidence = [entry({ attemptId: 'b', transactionId: hex(9) })];
              });
            }
          }
        )
      )
    );
    expect(outcome.kind).not.toBe('landed');
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
    expect((await read())?.transactionId).toBeUndefined();
  });

  it('a sibling that turns live before the write voids it, and the landing record survives for the next pass', async () => {
    const consume = unconfirmed({
      type: 'consume',
      submitEvidence: [entry({ outputNoteIds: [], nullifiers: [hex(30)] })]
    });
    await Repo.transactions.put(consume);
    await Repo.transactions.put(unconfirmed({ id: 'tx-2', status: ITransactionStatus.Failed, submitEvidence: [] }));
    const reads: NodeReads = {
      ...node({ blockNum: 160, commitment: OTHER }),
      nullifierHeight: async () => 150,
      account: async (_id, atBlock) => {
        if (atBlock === 150) {
          await Repo.transactions.where({ id: 'tx-2' }).modify(row => {
            row.status = ITransactionStatus.Queued;
          });
          return { ok: true, state: { blockNum: 150, commitment: FINAL } };
        }
        return { ok: true, state: { blockNum: 160, commitment: OTHER } };
      }
    };
    const outcome = await judgeAndWrite('tx-1', context(reads));
    expect(outcome.kind).toBe('landing-pending');
    expect((await read())?.submitEvidence?.[0]).toMatchObject({ landingSeenAtBlock: 150, landingSeenBy: 3 });
  });

  describe('a note landing, re-checked against siblings that turn live before the write', () => {
    // Neither sibling changes its entries, so only the deferral's note branch can tell the two apart.
    const siblingTurnsLive = async (type: ITransaction['type']): Promise<NodeReads> => {
      await Repo.transactions.put(
        unconfirmed({ id: 'tx-2', type, status: ITransactionStatus.Failed, attemptId: 'sibling', submitEvidence: [] })
      );
      return node(
        { blockNum: 150, commitment: OTHER },
        {
          notes: { [NOTE]: 140 },
          during: async () => {
            await Repo.transactions.where({ id: 'tx-2' }).modify(row => {
              row.status = ITransactionStatus.GeneratingTransaction;
            });
          }
        }
      );
    };

    it('an execute whose output list is still unknown could have made the note: nothing is written, the record stays', async () => {
      await Repo.transactions.put(unconfirmed());
      const reads = await siblingTurnsLive('execute');
      const outcome = await judgeAndWrite('tx-1', context(reads));
      expect(outcome.kind).toBe('landing-pending');
      const row = await read();
      expect(row?.status).toBe(ITransactionStatus.Unconfirmed);
      expect(row?.transactionId).toBeUndefined();
      expect(row?.submitEvidence?.[0]).toMatchObject({ landingSeenAtBlock: 140, landingSeenBy: 2 });
    });

    it('a send cannot have made it, so the landing is written', async () => {
      await Repo.transactions.put(unconfirmed());
      const reads = await siblingTurnsLive('send');
      const outcome = await judgeAndWrite('tx-1', context(reads));
      expect(outcome.kind).toBe('landed');
      expect(await read()).toMatchObject({ status: ITransactionStatus.Completed, transactionId: hex(2) });
    });
  });
});

describe('the never-committed write (#1081)', () => {
  it('marks a Failed row safe: the reason, the old reason kept raw, the marker and the verdicts', async () => {
    await Repo.transactions.put(
      unconfirmed({ status: ITransactionStatus.Failed, error: 'old reason', rawError: undefined })
    );
    const outcome = await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));
    expect(outcome.kind).toBe('never-committed');
    const row = await read();
    expect(row).toMatchObject({
      status: ITransactionStatus.Failed,
      error: TRANSACTION_NEVER_COMMITTED_ERROR,
      rawError: 'old reason',
      displayMessage: 'Failed',
      displayIcon: 'FAILED',
      neverCommittedAt: NOW
    });
    expect(row?.submitEvidence?.[0]).toMatchObject({ verdict: 'never-committed', initialSeenAtBlock: 750 });
  });

  it('moves an Unconfirmed row to Failed the same way, with no report', async () => {
    await Repo.transactions.put(unconfirmed());
    await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })));
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
    expect(jest.requireMock('lib/telemetry/report-operation').reportOperation).not.toHaveBeenCalled();
  });

  it('a late stamp adding an attempt voids it', async () => {
    await Repo.transactions.put(unconfirmed());
    const reads: NodeReads = {
      ...node({ blockNum: 750, commitment: INITIAL }),
      account: async () => {
        await Repo.transactions.where({ id: 'tx-1' }).modify(row => {
          row.submitEvidence = [...(row.submitEvidence ?? []), { attemptId: 'late', capturedAt: NOW, source: 'stage' }];
        });
        return { ok: true, state: { blockNum: 750, commitment: INITIAL } };
      }
    };
    await judgeAndWrite('tx-1', context(reads));
    expect((await read())?.neverCommittedAt).toBeUndefined();
  });

  it('a header that changes before the write voids it', async () => {
    await Repo.transactions.put(unconfirmed());
    await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL }, { headerAfter: OTHER })));
    expect((await read())?.neverCommittedAt).toBeUndefined();
    expect((await read())?.submitEvidence?.[0]?.verdict).toBeUndefined();
  });
});

describe('the catch-all write (#1081)', () => {
  it('persists an unresolvable verdict and leaves the stored message alone', async () => {
    await Repo.transactions.put(
      unconfirmed({ submitEvidence: [entry({ expirationBlock: undefined, initialSeenAtBlock: 101 })] })
    );
    const outcome = await judgeAndWrite('tx-1', context(node({ blockNum: 150, commitment: OTHER })));
    expect(outcome.kind).toBe('pending');
    const row = await read();
    expect(row?.submitEvidence?.[0]?.verdict).toBe('unresolvable');
    expect(row?.error).toBe('sdk said no definite outcome');
  });

  it('skips a row that is no longer in the set', async () => {
    await Repo.transactions.put(unconfirmed({ neverCommittedAt: 5 }));
    expect((await judgeAndWrite('tx-1', context(node({ blockNum: 750, commitment: INITIAL })))).kind).toBe('skipped');
  });
});

describe('checkEvidenceForRetry (#1081)', () => {
  it.each<[string, string, AccountState, Record<string, number>]>([
    ['a landed row', 'landed', { blockNum: 150, commitment: OTHER }, { [NOTE]: 140 }],
    ['a dead row', 'proven', { blockNum: 750, commitment: INITIAL }, {}],
    ['an undecided row', 'undecided', { blockNum: 150, commitment: OTHER }, {}]
  ])('%s -> %s', async (_label, kind, tip, notes) => {
    await Repo.transactions.put(unconfirmed());
    const check = await checkEvidenceForRetry(unconfirmed(), { createReads: async () => node(tip, { notes }) });
    expect(check.kind).toBe(kind);
  });

  it('a landing whose write the network check voids -> landing-pending, never undecided', async () => {
    await Repo.transactions.put(unconfirmed());
    const check = await checkEvidenceForRetry(unconfirmed(), {
      createReads: async () =>
        node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 }, headerAfter: OTHER })
    });
    expect(check.kind).toBe('landing-pending');
  });
});
