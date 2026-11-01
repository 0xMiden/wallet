import { SharedEarnLocks } from 'lib/epoch/testing/earn-locks';
import { isOneClickTransaction } from 'lib/one-click/tracking';

import { decryptRecoveryDataFile, encryptRecoveryDataFile } from './external-file';
import { mergeExternalRecoveryData } from './external-import';
import { RecoveryJournal } from './journal';
import { restoreWalletRecoveryRows, restoreWalletRecoveryGeneration } from './restore';
import { receiptSnapshot, oneClickReceiptRow } from './testing/provider-receipts';
import type { RecoveryJournalSnapshot } from './types';
import { validateJournal } from './validation';
import { ITransactionStatus, type ITransaction } from '../db/types';
import * as Passworder from '../passworder';
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
  await Repo.db.open();
});

it('Task4C2 receipt restore preserves completed tracking phase and inert provenance', async () => {
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      restoreWalletRecoveryRows(validateJournal(receiptSnapshot()), capability)
    )
  ).resolves.toBeUndefined();
  const restored = await Repo.transactions.get('receipt-oneclick');
  expect(restored?.status).toBe(ITransactionStatus.Completed);
  expect(restored?.extraInputs.phase).toBe('delivering');
  expect(restored?.restoredFromBackup).toBe(true);
  expect(restored?.restoredFromJournal).toBe(true);
  expect(restored?.requestBytes).toBeUndefined();
  expect(getStorageHealth().status).toBe('unavailable');
});

it('Task4C2 restored OneClick receipt remains recognizable with its frozen quote and assets', async () => {
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      restoreWalletRecoveryRows(validateJournal(receiptSnapshot()), capability)
    )
  ).resolves.toBeUndefined();
  const restored = await Repo.transactions.get('receipt-oneclick');
  expect(restored && isOneClickTransaction(restored)).toBe(true);
  expect(restored?.extraInputs.oneClick).toEqual(oneClickReceiptRow().extraInputs.oneClick);
});

it('Task4C2 receipt restore refuses a surviving row owned by another account', async () => {
  await Repo.transactions.put({ ...oneClickReceiptRow(), accountId: 'other-account' });
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      restoreWalletRecoveryRows(validateJournal(receiptSnapshot()), capability)
    )
  ).rejects.toMatchObject({ name: 'StorageContinuityError' });
  expect((await Repo.transactions.get('receipt-oneclick'))?.accountId).toBe('other-account');
});

it('reconstructs the erased disposable wallet schema and original logical generation with scoped readback', async () => {
  const snapshot = source();
  await Repo.db.delete();
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  try {
    await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, async capability => {
      await expect(restoreWalletRecoveryGeneration(snapshot, capability)).resolves.toBeUndefined();
      await restoreWalletRecoveryRows(snapshot, capability);
      const reopened = await Repo.openWalletRecoveryStore(capability);
      try {
        expect(await reopened.table('metadata').get('generation')).toEqual({
          id: 'generation',
          generation: 'wallet',
          origin: 'authorized'
        });
        expect(await reopened.table('transactions').get('tx-a')).toMatchObject({
          status: ITransactionStatus.Unconfirmed,
          restoredFromJournal: true
        });
        expect(await reopened.table('spendingLimits').get('account-a')).toMatchObject({ limit: '10' });
      } finally {
        reopened.close();
      }
    });
    expect(getStorageHealth().status).toBe('unavailable');
    await expect(Promise.resolve().then(() => Repo.db.open())).rejects.toThrow('StorageUnavailableError');
  } finally {
    await resetStorageHealthForLifecycle(getStorageHealth().epoch);
    await Repo.db.open();
  }
});

it('refuses to replace a surviving different authorized wallet generation', async () => {
  await Repo.metadata.put({ id: 'generation', generation: 'other-wallet', origin: 'authorized' });
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      restoreWalletRecoveryGeneration(source(), capability)
    )
  ).rejects.toThrow();
  expect(await Repo.metadata.get('generation')).toMatchObject({ generation: 'other-wallet' });
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

it('Task4C1 restores an unresolved retry as one inert reservation preserving its future debit and used grant', async () => {
  const snapshot = source();
  const future = Math.floor(Date.now() / 1000) + 100000;
  const debit = snapshot.entries.find(entry => entry.kind === 'debit');
  if (!debit || debit.kind !== 'debit') throw new Error('fixture');
  debit.retry = { previous: { initiatedAt: future, spentUsd: 7n, authorizationId: 'used' }, queuedSeq: 9 };
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await expect(
    withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
      restoreWalletRecoveryRows(snapshot, capability)
    )
  ).resolves.toBeUndefined();
  expect(await Repo.recoveryDebits.count()).toBe(1);
  const retained = await Repo.recoveryDebits.get('tx-a');
  expect(retained?.initiatedAt).toBe(future);
  expect(retained?.authorizationId).toBe('used');
  expect((await Repo.transactions.get('tx-a'))?.status).toBe(ITransactionStatus.Unconfirmed);
  expect((await Repo.transactions.get('tx-a'))?.restoredFromJournal).toBe(true);
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

it.each(['timestamp', 'amount', 'authorization'])(
  'preserves a surviving native debit with a different %s',
  async field => {
    const snapshot = source();
    const debit = snapshot.entries.find(entry => entry.kind === 'debit');
    if (debit?.kind !== 'debit') throw new Error('Missing debit fixture');
    const row: ITransaction = {
      id: 'tx-a',
      accountId: 'account-a',
      type: 'send',
      status: ITransactionStatus.Failed,
      initiatedAt: field === 'timestamp' ? debit.initiatedAt + 100 : debit.initiatedAt,
      spentUsd: field === 'amount' ? 11n : debit.spentUsd,
      spendingLimitAuthorizationId: field === 'authorization' ? 'new-grant' : debit.authorizationId,
      displayIcon: 'FAILED'
    };
    await Repo.transactions.put(row);
    markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
    await expect(
      withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, capability =>
        restoreWalletRecoveryRows(snapshot, capability)
      )
    ).rejects.toThrow('Storage continuity unavailable');
    expect(await Repo.transactions.get('tx-a')).toMatchObject(row);
    expect(await Repo.recoveryDebits.get('tx-a')).toBeUndefined();
  }
);

it('replays matching native debit evidence without changing its original future charge', async () => {
  const snapshot = source();
  const debit = snapshot.entries.find(entry => entry.kind === 'debit');
  if (debit?.kind !== 'debit') throw new Error('Missing debit fixture');
  await Repo.transactions.put({
    id: 'tx-a',
    accountId: 'account-a',
    type: 'send',
    status: ITransactionStatus.Failed,
    initiatedAt: debit.initiatedAt,
    spentUsd: debit.spentUsd,
    spendingLimitAuthorizationId: debit.authorizationId,
    displayIcon: 'FAILED'
  });
  markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
  await withStorageRecoveryAccess(getStorageHealth().epoch, Date.now() + 5000, async capability => {
    await restoreWalletRecoveryRows(snapshot, capability);
    await restoreWalletRecoveryRows(snapshot, capability);
  });
  expect(await Repo.recoveryDebits.get('tx-a')).toEqual(debit);
  expect(await Repo.transactions.get('tx-a')).toMatchObject({
    initiatedAt: debit.initiatedAt,
    spentUsd: debit.spentUsd,
    restoredFromJournal: true
  });
});

it.each(['transaction', 'receipt'])(
  'Task5 external %s provenance survives encryption restart and repeated row reconstruction',
  async kind => {
    const previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: new SharedEarnLocks() });
    try {
      const original = validateJournal(kind === 'transaction' ? source() : receiptSnapshot());
      const filePassword = crypto.randomUUID();
      const encrypted = await encryptRecoveryDataFile(original, filePassword);
      const decoded = await decryptRecoveryDataFile(encrypted, filePassword);
      const merged = mergeExternalRecoveryData(decoded, {
        scope: original.scope,
        accountIds: original.accounts.map(account => account.accountId)
      });
      const values = new Map<string, unknown>();
      const provider = {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter(key => values.has(key)).map(key => [key, values.get(key)])),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) values.set(key, value);
        },
        remove: async (keys: string[]) => {
          for (const key of keys) values.delete(key);
        }
      };
      const key = await Passworder.importVaultKey(crypto.getRandomValues(new Uint8Array(32)));
      await new RecoveryJournal(key, provider).update(() => merged);
      const restarted = await new RecoveryJournal(key, provider).read();
      if (!restarted) throw new Error('Missing encrypted restart fixture');
      const entry = restarted.entries.find(value => value.kind === kind);
      if (!entry || (entry.kind !== 'transaction' && entry.kind !== 'receipt') || !entry.row)
        throw new Error('Missing imported recovery row');
      expect(entry.row).toMatchObject({ restoredFromBackup: true, status: ITransactionStatus.Unconfirmed });
      expect(entry.row.restoredFromJournal).toBeUndefined();
      expect(entry.kind === 'transaction' ? entry.mayHaveSubmitted : undefined).toBe(
        kind === 'transaction' ? true : undefined
      );
      markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
      const incident = getStorageHealth();
      await withStorageRecoveryAccess(incident.epoch, Date.now() + 5000, async capability => {
        await restoreWalletRecoveryGeneration(restarted, capability);
        await restoreWalletRecoveryRows(restarted, capability);
        const first = await Repo.transactions.get(entry.id);
        expect(first).toMatchObject({ restoredFromBackup: true, status: ITransactionStatus.Unconfirmed });
        expect(first?.restoredFromJournal).toBeUndefined();
        await restoreWalletRecoveryRows(restarted, capability);
        const second = await Repo.transactions.get(entry.id);
        expect(second).toMatchObject({ restoredFromBackup: true, status: ITransactionStatus.Unconfirmed });
        expect(second?.restoredFromJournal).toBeUndefined();
      });
      expect(getStorageHealth()).toEqual(incident);
    } finally {
      if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  }
);
