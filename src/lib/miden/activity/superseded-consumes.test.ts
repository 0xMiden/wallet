import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { transactions } from 'lib/miden/repo';

import { supersededFailedConsumeIds } from './superseded-consumes';

const A = 'account-a';
const B = 'account-b';

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
  it('hides a failed claim of a note this account later claimed, found in the database, not the batch', async () => {
    await transactions.add(completedClaim('done', ['n1']));
    const failed = row('attempt', { noteId: 'n1' });
    expect(await supersededFailedConsumeIds([failed])).toEqual(new Set(['attempt']));
  });

  it('matches a later batch claim that carries the note in noteIds', async () => {
    await transactions.add(completedClaim('batch-done', ['n0', 'n1', 'n2']));
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

  it('reads nothing when the batch has no failed consume row', async () => {
    const whereSpy = jest.spyOn(transactions, 'where');
    expect(await supersededFailedConsumeIds([completedClaim('done', ['n1'])])).toEqual(new Set());
    expect(whereSpy).not.toHaveBeenCalled();
  });
});
