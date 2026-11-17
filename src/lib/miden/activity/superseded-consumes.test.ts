import { Collection } from 'dexie';

import { ISubmitEvidence, ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';

import { createClaimEvidenceLookup, supersededFailedConsumeIds } from './superseded-consumes';

const A = 'account-a';
const B = 'account-b';
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
/** Every field a verdict reads, unjudged: the reconciler still judges a row carrying it. */
const CHECKABLE: ISubmitEvidence = {
  attemptId: 'a1',
  capturedAt: Math.floor(Date.now() / 1000),
  source: 'stage',
  transactionId: hex(1),
  initialCommitment: hex(2),
  finalCommitment: hex(3),
  initialNonce: '1',
  outputNoteIds: [],
  nullifiers: [hex(4)],
  refBlock: 10,
  refBlockCommitment: hex(5)
};

function row(id: string, overrides: Partial<ITransaction> = {}): ITransaction {
  return {
    id,
    accountId: A,
    initiatedAt: 100,
    completedAt: 100,
    status: ITransactionStatus.Failed,
    type: 'consume',
    displayIcon: 'RECEIVE',
    ...overrides
  };
}

const completedClaim = (id: string, notes: string[], overrides: Partial<ITransaction> = {}) =>
  row(id, { status: ITransactionStatus.Completed, noteId: notes[0], noteIds: notes, ...overrides });

beforeEach(async () => {
  await transactions.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await transactions.clear();
});

describe('supersededFailedConsumeIds (#771)', () => {
  it('does not materialize failed claim history in indexed results', async () => {
    const failed = Array.from({ length: 150 }, (_, i) => row(`failed-${i}`, { noteId: 'n1' }));
    await transactions.bulkAdd([...failed, completedClaim('done', ['n1'])]);
    const toArray = transactions.toCollection().toArray;
    const lengths: number[] = [];
    jest.spyOn(transactions.db.Collection.prototype, 'toArray').mockImplementation(function <T>(
      this: Collection<ITransaction, string>,
      callback?: (rows: ITransaction[]) => T
    ) {
      return toArray.call(this, (rows: ITransaction[]) => {
        lengths.push(rows.length);
        return callback ? callback(rows) : rows;
      });
    });
    expect(await supersededFailedConsumeIds(failed.slice(0, 1))).toEqual(new Set(['failed-0']));
    expect(lengths.length).toBeGreaterThan(0);
    expect(lengths.every(length => length <= 1)).toBe(true);
  });

  it('shares claim evidence across batches and concurrent requests with account suffixes', async () => {
    await transactions.add(completedClaim('done', ['n0', 'n1']));
    const lookup = createClaimEvidenceLookup();
    const where = jest.spyOn(transactions, 'where');
    const pending = lookup(A, 'n1');
    expect(lookup(`${A}_x`, 'n1')).toBe(pending);
    expect(
      await Promise.all([
        supersededFailedConsumeIds([row('first', { noteId: 'n1' })], lookup),
        supersededFailedConsumeIds([row('second', { accountId: `${A}_y`, noteId: 'n1' })], lookup)
      ])
    ).toEqual([new Set(['first']), new Set(['second'])]);
    expect(await supersededFailedConsumeIds([row('third', { noteId: 'n1' })], lookup)).toEqual(new Set(['third']));
    expect(where.mock.calls.filter(([index]) => typeof index === 'string' && index === 'noteId')).toHaveLength(1);
    expect(where.mock.calls.filter(([index]) => typeof index === 'string' && index === 'noteIds')).toHaveLength(1);
  });

  it('caches negative evidence across batches and keeps accounts and notes separate', async () => {
    await transactions.add(completedClaim('done', ['n1'], { accountId: B }));
    const lookup = createClaimEvidenceLookup();
    const where = jest.spyOn(transactions, 'where');
    expect(await supersededFailedConsumeIds([row('first', { noteId: 'n1' })], lookup)).toEqual(new Set());
    expect(await supersededFailedConsumeIds([row('second', { accountId: `${A}_x`, noteId: 'n1' })], lookup)).toEqual(
      new Set()
    );
    expect(where.mock.calls.filter(([index]) => typeof index === 'string' && index === 'noteId')).toHaveLength(1);
    expect(where.mock.calls.filter(([index]) => typeof index === 'string' && index === 'noteIds')).toHaveLength(1);
    expect(await lookup(B, 'n1')).toBe(true);
    expect(await lookup(B, 'n2')).toBe(false);
  });

  it('uses fresh default evidence after a completed claim is inserted', async () => {
    const failed = row('attempt', { noteId: 'n1' });
    expect(await supersededFailedConsumeIds([failed])).toEqual(new Set());
    await transactions.add(completedClaim('done', ['n1']));
    expect(await supersededFailedConsumeIds([failed])).toEqual(new Set(['attempt']));
  });

  it('does not match empty accounts or share their negative evidence with suffixed accounts', async () => {
    await transactions.bulkAdd([
      completedClaim('empty', ['n1'], { accountId: '' }),
      completedClaim('suffixed', ['n2'], { accountId: '_x' })
    ]);
    const lookup = createClaimEvidenceLookup();
    const empty = lookup('', 'n1');
    expect(lookup('', 'n1')).toBe(empty);
    expect(await empty).toBe(false);
    expect(await lookup('', 'n2')).toBe(false);
    expect(await lookup('_y', 'n2')).toBe(true);
    expect(await lookup('', 'n2')).toBe(false);
  });

  it('uses noteIds before noteId when checking claim membership', async () => {
    await transactions.bulkAdd([
      completedClaim('different-batch', ['n2'], { noteId: 'n1' }),
      completedClaim('empty-batch', [], { noteId: 'n1' })
    ]);
    expect(await supersededFailedConsumeIds([row('attempt', { noteId: 'n1' })])).toEqual(new Set());
    expect(await supersededFailedConsumeIds([row('covered', { noteId: 'n2' })])).toEqual(new Set(['covered']));
  });

  it('hides a failed claim of a note this account later claimed, found in the database, not the batch', async () => {
    await transactions.add(completedClaim('done', ['n1']));
    const failed = row('attempt', { noteId: 'n1' });
    expect(await supersededFailedConsumeIds([failed])).toEqual(new Set(['attempt']));
  });

  it('matches a later batch claim that carries the note in noteIds', async () => {
    await transactions.add(completedClaim('batch-done', ['n0', 'n1', 'n2']));
    expect(await supersededFailedConsumeIds([row('attempt', { noteId: 'n1' })])).toEqual(new Set(['attempt']));
  });

  it('matches a single-note claim stored with noteId alone, which only the scalar index finds', async () => {
    await transactions.add(row('done', { status: ITransactionStatus.Completed, noteId: 'n1' }));
    expect(await supersededFailedConsumeIds([row('attempt', { noteId: 'n1' })])).toEqual(new Set(['attempt']));
  });

  it('hides a failed batch row only when every one of its notes was claimed', async () => {
    await transactions.add(completedClaim('done-n1', ['n1']));
    const partly = row('partly', { noteId: 'n1', noteIds: ['n1', 'n2'] });
    expect(await supersededFailedConsumeIds([partly])).toEqual(new Set());
    await transactions.add(completedClaim('done-n2', ['n2']));
    expect(await supersededFailedConsumeIds([partly])).toEqual(new Set(['partly']));
  });

  it('keeps the failure when the only claim is on another account', async () => {
    await transactions.add(completedClaim('elsewhere', ['n1'], { accountId: B }));
    expect(await supersededFailedConsumeIds([row('attempt', { noteId: 'n1' })])).toEqual(new Set());
  });

  it('matches the claim by account whatever suffix its stored account id carries', async () => {
    await transactions.add(completedClaim('suffixed', ['n1'], { accountId: `${A}_x` }));
    expect(await supersededFailedConsumeIds([row('attempt', { noteId: 'n1' })])).toEqual(new Set(['attempt']));
  });

  it('keeps the failure when the only claim was restored from a backup', async () => {
    await transactions.add(completedClaim('restored', ['n1'], { restoredFromBackup: true }));
    expect(await supersededFailedConsumeIds([row('attempt', { noteId: 'n1' })])).toEqual(new Set());
  });

  it('keeps the failure while the later claim is still in flight or failed too', async () => {
    await transactions.bulkAdd([
      completedClaim('queued', ['n1'], { status: ITransactionStatus.Queued }),
      completedClaim('failed-again', ['n1'], { status: ITransactionStatus.Failed })
    ]);
    expect(await supersededFailedConsumeIds([row('attempt', { noteId: 'n1' })])).toEqual(new Set());
  });

  it('leaves a failed claim with no note ids, other failed types and non-failed consumes alone', async () => {
    await transactions.add(completedClaim('done', ['n1']));
    const input = [
      row('legacy'),
      row('send', { type: 'send', noteId: 'n1' }),
      completedClaim('done-row', ['n1']),
      row('queued', { status: ITransactionStatus.Queued, noteId: 'n1' })
    ];
    expect(await supersededFailedConsumeIds(input)).toEqual(new Set());
  });

  it('hides an Unconfirmed claim that holds nothing once a later claim covers its note (#1081)', async () => {
    await transactions.add(completedClaim('done', ['n1']));
    const unheld = row('unheld', {
      status: ITransactionStatus.Unconfirmed,
      noteId: 'n1',
      submitEvidence: [{ attemptId: 'x', capturedAt: 1, source: 'end' }]
    });
    expect(await supersededFailedConsumeIds([unheld])).toEqual(new Set(['unheld']));
  });

  it('never hides an Unconfirmed claim that still holds its notes (#1081)', async () => {
    await transactions.add(completedClaim('done', ['n1']));
    const held = row('held', {
      status: ITransactionStatus.Unconfirmed,
      noteId: 'n1',
      submitEvidence: [CHECKABLE]
    });
    expect(await supersededFailedConsumeIds([held])).toEqual(new Set());
  });

  it('reads nothing when the batch has no failed consume row', async () => {
    const whereSpy = jest.spyOn(transactions, 'where');
    expect(await supersededFailedConsumeIds([completedClaim('done', ['n1'])])).toEqual(new Set());
    expect(whereSpy).not.toHaveBeenCalled();
  });
});
