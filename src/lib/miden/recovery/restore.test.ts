import { restoreWalletRecoveryRows } from './restore';
import type { RecoveryJournalSnapshot } from './types';
import { ITransactionStatus } from '../db/types';
import * as Repo from '../repo';
import {
  getStorageHealth,
  markStorageUnavailable,
  resetStorageHealthForLifecycle,
  withStorageRecoveryAccess
} from '../storage-health';

const source = (): RecoveryJournalSnapshot => ({
  version: 1,
  sequence: 1,
  scope: { network: 'test', walletGeneration: 'wallet', sdkGeneration: 'sdk' },
  accounts: [{ accountId: 'account-a', nonce: '1', commitment: 'state' }],
  entries: [
    {
      kind: 'policy',
      id: 'account-a',
      accountId: 'account-a',
      configuration: { accountId: 'account-a', limit: '10', revision: 'r1', createdAt: 1, updatedAt: 1 }
    },
    {
      kind: 'debit',
      id: 'tx-a',
      accountId: 'account-a',
      initiatedAt: Math.floor(Date.now() / 1000) + 10,
      spentUsd: 7n,
      authorizationId: 'used'
    },
    {
      kind: 'transaction',
      id: 'tx-a',
      accountId: 'account-a',
      requestBytes: new Uint8Array([1, 2]),
      mayHaveSubmitted: true,
      evidence: {},
      row: {
        id: 'tx-a',
        accountId: 'account-a',
        type: 'send',
        initiatedAt: 1,
        status: ITransactionStatus.GeneratingTransaction,
        displayIcon: 'SEND',
        spentUsd: 7n
      }
    }
  ]
});

beforeEach(async () => {
  await Repo.db.open();
});

afterEach(async () => {
  await resetStorageHealthForLifecycle(getStorageHealth().epoch);
});

it('restores policy and the original debit while every submitted row stays inert and unconfirmed', async () => {
  const snapshot = source();
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
    restoreWalletRecoveryRows(snapshot, capability)
  );
  expect(getStorageHealth().status).toBe('unavailable');
  expect(await Repo.spendingLimits.get('account-a')).toMatchObject({ limit: '10', revision: 'r1' });
  expect(await Repo.recoveryDebits.get('tx-a')).toEqual(snapshot.entries[1]);
  expect(await Repo.transactions.get('tx-a')).toMatchObject({
    status: ITransactionStatus.Unconfirmed,
    restoredFromBackup: true,
    restoredFromJournal: true,
    mayHaveSubmitted: true,
    requestBytes: new Uint8Array([1, 2])
  });
});

it('refuses to overwrite a surviving cap with a different journal policy', async () => {
  await Repo.spendingLimits.put({ accountId: 'account-a', limit: '2', revision: 'newer', createdAt: 1, updatedAt: 2 });
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      restoreWalletRecoveryRows(source(), capability)
    )
  ).rejects.toThrow('Storage continuity unavailable');
  expect(await Repo.spendingLimits.get('account-a')).toMatchObject({ limit: '2' });
  expect(await Repo.recoveryDebits.count()).toBe(0);
  expect(await Repo.transactions.count()).toBe(0);
});

it('refuses writes after the recovery capability expires', async () => {
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  const capability = await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, async value => value);
  await expect(restoreWalletRecoveryRows(source(), capability)).rejects.toThrow('StorageUnavailableError');
  expect(await Repo.transactions.count()).toBe(0);
});
