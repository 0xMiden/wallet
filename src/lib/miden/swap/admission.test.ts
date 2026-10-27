import { SharedEarnLocks } from 'lib/epoch/testing/earn-locks';
import { ITransactionStatus, SendTransaction } from 'lib/miden/db/types';
import { readRetainedFinancialEntries, verifyFinancialRecoveryEntries } from 'lib/miden/recovery/financial';
import { getFinancialRecoveryBackend } from 'lib/miden/recovery/financial-backend';
import type { RecoveryPolicyEntry } from 'lib/miden/recovery/types';
import { transactions } from 'lib/miden/repo';
import { queueOutgoingTransaction, spendsOf } from 'lib/miden/spending-limits/queue';
import { assertStorageHealthy } from 'lib/miden/storage-health';
import { NoteTypeEnum } from 'lib/miden/types';

import { assertSwapQueueAvailable } from './admission';

jest.mock('lib/i18n/core', () => ({ getMessage: (key: string) => key }));
jest.mock('lib/miden/sdk/helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => a === b,
  canonicalWalletAccountId: (a: string) => a
}));
jest.mock('lib/miden-chain/native-asset', () => ({ cacheScope: () => 'testnet|rpc' }));
jest.mock('lib/miden/recovery/financial-backend', () => {
  const actual = jest.requireActual<typeof import('lib/miden/recovery/financial-backend')>(
    'lib/miden/recovery/financial-backend'
  );
  return { ...actual, getFinancialRecoveryBackend: jest.fn(actual.getFinancialRecoveryBackend) };
});
const baseline: RecoveryPolicyEntry[] = [{ kind: 'policy', id: 'account', accountId: 'account', configuration: null }];
const acknowledgements: number[] = [];
let previousLocks: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: new SharedEarnLocks() });
  acknowledgements.length = 0;
  const backend: NonNullable<ReturnType<typeof getFinancialRecoveryBackend>> = async (
    accountId,
    entry,
    expectedEpoch
  ) => {
    expect(accountId).toBe('account');
    expect(entry).toBeUndefined();
    assertStorageHealthy(expectedEpoch);
    verifyFinancialRecoveryEntries(baseline, await readRetainedFinancialEntries(baseline));
    assertStorageHealthy(expectedEpoch);
    acknowledgements.push(expectedEpoch);
  };
  jest.mocked(getFinancialRecoveryBackend).mockReturnValue(backend);
});

afterEach(() => {
  jest
    .mocked(getFinancialRecoveryBackend)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof import('lib/miden/recovery/financial-backend')>('lib/miden/recovery/financial-backend')
        .getFinancialRecoveryBackend
    );
  if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});

const row = (id: string) => {
  const tx = new SendTransaction('account', 10n, 'recipient', 'pay', NoteTypeEnum.Public);
  tx.id = id;
  return tx;
};
const queue = (id: string) => {
  const tx = row(id);
  return queueOutgoingTransaction(tx, spendsOf(tx), undefined, undefined, () => {
    expect(acknowledgements.length).toBeGreaterThan(0);
    return assertSwapQueueAvailable('account', 'testnet|rpc');
  });
};
it.each([ITransactionStatus.Queued, ITransactionStatus.GeneratingTransaction, ITransactionStatus.Unconfirmed])(
  'refuses an unresolved outgoing spend with status %s',
  async status => {
    await transactions.add({ ...row('existing'), status });
    await expect(queue('swap')).rejects.toThrow('swapPendingSpend');
    await expect(transactions.get('swap')).resolves.toBeUndefined();
  }
);
it('admits only one concurrent swap against the same vault', async () => {
  const results = await Promise.allSettled([queue('a'), queue('b')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find(result => result.status === 'rejected');
  expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toEqual(new Error('swapPendingSpend'));
  expect(await transactions.count()).toBe(1);
});
it('does not reserve funds for a completed outgoing transaction', async () => {
  await transactions.add({ ...row('existing'), status: ITransactionStatus.Completed });
  await expect(queue('swap')).resolves.toBeUndefined();
});
it('rejects a changed endpoint before inserting', async () => {
  await expect(assertSwapQueueAvailable('account', 'other')).rejects.toThrow('swapBalanceUnavailable');
  expect(acknowledgements).toEqual([]);
});

it('does not assume a pending claim leaves the fee balance available', async () => {
  await transactions.add({ ...row('claim'), type: 'consume' });
  await expect(queue('swap')).rejects.toThrow('swapPendingSpend');
});
