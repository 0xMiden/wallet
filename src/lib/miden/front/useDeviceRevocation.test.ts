import { act, renderHook, waitFor } from '@testing-library/react';
import Dexie from 'dexie';

import { ITransactionStatus } from 'lib/miden/db/types';

import { useDeviceRevocation } from './useDeviceRevocation';

interface ReceiptRow {
  id: number;
  accountId: string;
  type: string;
  status: ITransactionStatus;
  transactionId?: string;
  extraInputs?: { revokedSignerCommitment: string };
}

const mockDb = new Dexie('device-revocation-test');
mockDb.version(1).stores({ transactions: 'id' });
const mockTransactions = mockDb.table<ReceiptRow, number>('transactions');
const mockCommitment = jest.fn<Promise<string>, [string]>();
const mockWithWasmClientLock = jest.fn(() => new Promise<never>(() => {}));

jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return mockTransactions;
  }
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: () => mockWithWasmClientLock()
}));
jest.mock('lib/secure-hot-key/commitment', () => ({
  ...jest.requireActual('lib/secure-hot-key/commitment'),
  commitmentFromPublicKeyHex: (key: string) => mockCommitment(key)
}));

beforeEach(async () => {
  jest.clearAllMocks();
  mockCommitment.mockReset();
  mockCommitment.mockResolvedValue('0x22');
  await mockTransactions.clear();
});

afterAll(() => mockDb.delete());

it('reads and updates the receipt while the client lock is busy, deriving the key only once', async () => {
  await mockTransactions.add({
    id: 1,
    accountId: 'account',
    type: 'replace-hot-key',
    status: ITransactionStatus.Completed,
    transactionId: 'tx-1',
    extraInputs: { revokedSignerCommitment: '0x22' }
  });

  const { result, unmount } = renderHook(() => useDeviceRevocation('account', 'hot'));
  await waitFor(() => expect(result.current).toBe('tx-1'));

  await act(async () => {
    await mockTransactions.update(1, { transactionId: 'tx-2' });
  });
  await waitFor(() => expect(result.current).toBe('tx-2'));
  expect(mockCommitment).toHaveBeenCalledTimes(1);
  expect(mockCommitment).toHaveBeenCalledWith('hot');
  expect(mockWithWasmClientLock).not.toHaveBeenCalled();
  unmount();
});

it('cancels a pending commitment derivation when the account changes or unmounts', async () => {
  let resolveCommitment: (commitment: string) => void = () => {};
  mockCommitment.mockImplementation(
    () =>
      new Promise<string>(resolve => {
        resolveCommitment = resolve;
      })
  );
  const filter = jest.spyOn(mockTransactions, 'filter');
  const { result, rerender, unmount } = renderHook(({ accountId }) => useDeviceRevocation(accountId, 'hot'), {
    initialProps: { accountId: 'account' }
  });
  const resolvePrevious = resolveCommitment;
  rerender({ accountId: 'other-account' });

  await act(async () => resolvePrevious('0x22'));
  expect(result.current).toBeUndefined();
  expect(filter).not.toHaveBeenCalled();

  unmount();
  await act(async () => resolveCommitment('0x22'));
  expect(filter).not.toHaveBeenCalled();
  filter.mockRestore();
});
