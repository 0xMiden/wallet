import * as Repo from 'lib/miden/repo';

import { getCompletedTransactions, getNoteHoldingTransactions, getUnconfirmedTransactions } from './get';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const checkable: ISubmitEvidence = {
  attemptId: 'a1',
  capturedAt: Math.floor(Date.now() / 1000),
  source: 'stage',
  transactionId: hex(1),
  initialCommitment: hex(2),
  finalCommitment: hex(2),
  initialNonce: '1',
  outputNoteIds: [],
  nullifiers: [hex(3)],
  refBlock: 10,
  refBlockCommitment: hex(4)
};

const row = (id: string, overrides: Partial<ITransaction> = {}): ITransaction => ({
  id,
  type: 'consume',
  accountId: 'mtst1acct_suffix',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: 1000,
  completedAt: 1100,
  displayIcon: 'RECEIVE',
  noteId: `note-${id}`,
  noteIds: [`note-${id}`],
  submitEvidence: [checkable],
  ...overrides
});

beforeEach(async () => {
  await Repo.transactions.clear();
});

describe('Unconfirmed rows in the lists (#1081)', () => {
  it('History and the unread badge include them; the pending lists do not', async () => {
    await Repo.transactions.bulkPut([
      row('u'),
      row('f', { status: ITransactionStatus.Failed }),
      row('c', { status: ITransactionStatus.Completed })
    ]);
    expect((await getUnconfirmedTransactions()).map(r => r.id)).toEqual(['u']);
    expect((await getCompletedTransactions('mtst1acct', undefined, undefined, true)).map(r => r.id).sort()).toEqual([
      'c',
      'f',
      'u'
    ]);
    expect((await getCompletedTransactions('mtst1acct')).map(r => r.id)).toEqual(['c']);
  });
});

describe('getNoteHoldingTransactions (#1081)', () => {
  it('holds the notes of live claims and of claims awaiting a verdict, across id forms', async () => {
    await Repo.transactions.bulkPut([
      row('queued', { status: ITransactionStatus.Queued, submitEvidence: undefined }),
      row('awaiting', { accountId: 'mtst1acct' }),
      row('failed-awaiting', { status: ITransactionStatus.Failed }),
      row('evidence-less', { submitEvidence: [{ attemptId: 'x', capturedAt: 1, source: 'end' }] }),
      row('proven', { status: ITransactionStatus.Failed, neverCommittedAt: 5 }),
      row('restored', { status: ITransactionStatus.Failed, restoredFromBackup: true }),
      row('funding', { rotationFunding: true }),
      row('other-account', { accountId: 'mtst1other' }),
      row('send', { type: 'send' })
    ]);
    const held = (await getNoteHoldingTransactions('mtst1acct_suffix')).map(r => r.id).sort();
    expect(held).toEqual(['awaiting', 'failed-awaiting', 'queued']);
  });

  it('holds the notes of a dApp transaction while it is live or awaiting its verdict, and not once it ended', async () => {
    const execute = (id: string, overrides: Partial<ITransaction> = {}) =>
      row(id, { type: 'execute', noteId: undefined, noteIds: undefined, heldNoteIds: [`note-${id}`], ...overrides });
    await Repo.transactions.bulkPut([
      execute('x-queued', { status: ITransactionStatus.Queued, submitEvidence: undefined }),
      execute('x-generating', { status: ITransactionStatus.GeneratingTransaction, submitEvidence: undefined }),
      execute('x-awaiting'),
      execute('x-completed', { status: ITransactionStatus.Completed }),
      execute('x-failed', { status: ITransactionStatus.Failed, submitEvidence: undefined }),
      execute('x-proven', { status: ITransactionStatus.Failed, neverCommittedAt: 5 })
    ]);
    const held = (await getNoteHoldingTransactions('mtst1acct')).map(r => r.id).sort();
    expect(held).toEqual(['x-awaiting', 'x-generating', 'x-queued']);
  });

  it('keeps a completed dApp transaction holding its notes for a grace window, and a failed one not at all', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const completedAgo = (seconds: number) => ({ status: ITransactionStatus.Completed, completedAt: nowSec - seconds });
    const held = (id: string, overrides: Partial<ITransaction>) =>
      row(id, { noteId: undefined, noteIds: undefined, heldNoteIds: [`note-${id}`], ...overrides });
    await Repo.transactions.bulkPut([
      held('x-just-completed', { type: 'execute', ...completedAgo(10) }),
      held('x-long-completed', { type: 'execute', ...completedAgo(3600) }),
      held('x-just-failed', {
        type: 'execute',
        status: ITransactionStatus.Failed,
        completedAt: nowSec - 10,
        submitEvidence: undefined
      }),
      // Completion re-types an input-only dApp transaction as a claim, without a claim's own note ids.
      held('x-retyped', { type: 'consume', ...completedAgo(10) }),
      // The wallet's own completed claim stays out: the claim dedup's Completed arm covers it.
      row('own-claim', completedAgo(10))
    ]);
    const holding = (await getNoteHoldingTransactions('mtst1acct')).map(r => r.id).sort();
    expect(holding).toEqual(['x-just-completed', 'x-retyped']);
  });
});
