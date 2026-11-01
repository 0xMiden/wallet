import { ITransactionStatus, type ITransaction } from '../db/types';
import * as Repo from '../repo';
import { reconcileRecoveryTransactions, type RecoveryReconcileContext } from './reconcile';
import { projectRecoveryTransaction } from './transaction-record';
import type { RecoveryJournalSnapshot, RecoveryEntry } from './types';
import type { NodeReads } from '../transaction/reconcile-reads';

const row = (id = 'tx'): ITransaction => ({
  id,
  accountId: 'account-a',
  type: 'send',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: 1,
  displayIcon: 'SEND',
  restoredFromBackup: true,
  restoredFromJournal: true,
  mayHaveSubmitted: true,
  requestBytes: new Uint8Array([1]),
  submitEvidence: [
    {
      attemptId: id,
      capturedAt: 1,
      source: 'stage',
      transactionId: 'tx-hex',
      refBlock: 10,
      refBlockCommitment: 'header',
      initialCommitment: 'old',
      finalCommitment: 'new',
      initialNonce: '1',
      outputNoteIds: [],
      nullifiers: [],
      expirationBlock: 30
    }
  ]
});
const snapshot = (rows: ITransaction[]): RecoveryJournalSnapshot => ({
  version: 1,
  sequence: 1,
  scope: { network: 'network', walletGeneration: 'wallet', sdkGeneration: 'sdk' },
  accounts: [{ accountId: 'account-a', nonce: '1', commitment: 'old' }],
  entries: rows.map(value => ({
    kind: 'transaction',
    id: value.id,
    accountId: value.accountId,
    requestBytes: new Uint8Array([1]),
    mayHaveSubmitted: true,
    evidence: {},
    row: projectRecoveryTransaction(value)
  }))
});
const node = (): NodeReads => ({
  blockCommitment: async () => 'header',
  account: async () => ({ ok: true, state: { blockNum: 20, commitment: 'new', nonce: '2' } }),
  noteInclusions: async () => new Map(),
  nullifierHeight: async () => undefined
});
function context(
  rows: ITransaction[],
  retain: (entries: RecoveryEntry[]) => Promise<void> = async () => {}
): RecoveryReconcileContext {
  return {
    snapshot: snapshot(rows),
    database: Repo.db,
    node: node(),
    deadline: Date.now() + 1000,
    assertCurrent: () => {},
    retain
  };
}

it('Task4C1 classifies a trusted restored landing without signing submission relay adoption or delivery', async () => {
  await Repo.transactions.add(row());
  await expect(reconcileRecoveryTransactions(context([row()]))).resolves.toBe(1);
  expect(await Repo.transactions.get('tx')).toMatchObject({
    status: ITransactionStatus.Completed,
    restoredFromBackup: true,
    restoredFromJournal: true
  });
  expect((await Repo.transactions.get('tx'))?.noteDelivery).toBeUndefined();
});

it('Task4C1 retains a positive verdict before changing its restored primary row', async () => {
  await Repo.transactions.add(row());
  const observed: number[] = [];
  const retained: RecoveryEntry[][] = [];
  await reconcileRecoveryTransactions(
    context([row()], async entries => {
      observed.push((await Repo.transactions.get('tx'))!.status);
      retained.push(entries);
      throw new Error('retention refused');
    })
  ).catch(() => {});
  expect(observed).toEqual([ITransactionStatus.Unconfirmed]);
  expect(retained).toHaveLength(1);
  expect((await Repo.transactions.get('tx'))?.status).toBe(ITransactionStatus.Unconfirmed);
});

it('Task4C1 treats a missing SDK transaction and uncertain chain read as indeterminate', async () => {
  await Repo.transactions.add(row());
  const input = context([row()]);
  input.node.account = async () => ({ ok: false, pruned: false, timedOut: false });
  expect(await reconcileRecoveryTransactions(input)).toBe(0);
  expect((await Repo.transactions.get('tx'))?.status).toBe(ITransactionStatus.Unconfirmed);
});

it('Task4C1 includes all trusted restored siblings in landing attribution', async () => {
  const rows = [row(), row('sibling')];
  await Repo.transactions.bulkAdd(rows);
  expect(await reconcileRecoveryTransactions(context(rows))).toBe(0);
  expect((await Repo.transactions.toArray()).map(value => value.status)).toEqual([
    ITransactionStatus.Unconfirmed,
    ITransactionStatus.Unconfirmed
  ]);
});

it('Task4C1 refuses local trust for external backup rows', async () => {
  const imported = { ...row(), restoredFromJournal: undefined };
  await Repo.transactions.add(imported);
  expect(await reconcileRecoveryTransactions(context([row()]))).toBe(0);
  expect((await Repo.transactions.get('tx'))?.status).toBe(ITransactionStatus.Unconfirmed);
});

it('Task4C1 abandons an expired reconciliation before any journal or primary write', async () => {
  await Repo.transactions.add(row());
  const retained: RecoveryEntry[][] = [];
  const input = context([row()], async entries => {
    retained.push(entries);
  });
  input.deadline = Date.now() - 1;
  await reconcileRecoveryTransactions(input).catch(() => {});
  expect(retained).toEqual([]);
  expect((await Repo.transactions.get('tx'))?.status).toBe(ITransactionStatus.Unconfirmed);
});
