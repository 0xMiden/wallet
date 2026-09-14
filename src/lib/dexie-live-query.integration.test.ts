import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { useSwapSettlementNotes } from 'app/templates/history/useSwapSettlementNotes';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { db, transactions } from 'lib/miden/repo';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';
import { useRecentRecipients } from 'screens/send-flow/useRecentRecipients';

jest.mock('lib/miden/activity', () =>
  jest.requireActual<typeof import('lib/miden/transaction/get')>('lib/miden/transaction/get')
);
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/sdk/miden-client', () => ({}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ PswapLineageState: {} }));

let failuresRemaining = 0;
let failedReads = 0;
const readError = new Error('temporary lower-layer read failure');

db.use({
  stack: 'dbcore',
  level: -0.5,
  name: 'TransientReadFailure',
  create: down => ({
    ...down,
    table: name => {
      const table = down.table(name);
      const failRead = (transaction: object) => {
        if (Reflect.get(transaction, 'mode') !== 'readonly' || failuresRemaining === 0) return false;
        failuresRemaining -= 1;
        failedReads += 1;
        return true;
      };
      return {
        ...table,
        query: request => (failRead(request.trans) ? Promise.reject(readError) : table.query(request)),
        openCursor: request => (failRead(request.trans) ? Promise.reject(readError) : table.openCursor(request))
      };
    }
  })
});

const ACCOUNT = 'mtst1apfjwvs5f8mey5f6a6s5llnhp533fe5p';
const RECIPIENT = '0x1111111111111111111111111111111111111111';

function row(overrides: Partial<ITransaction> = {}): ITransaction {
  return {
    id: 'tracked',
    accountId: ACCOUNT,
    secondaryAccountId: RECIPIENT,
    initiatedAt: 100,
    completedAt: 200,
    status: ITransactionStatus.Completed,
    type: 'send',
    displayIcon: 'SEND',
    ...overrides
  };
}

beforeEach(async () => {
  failuresRemaining = 0;
  failedReads = 0;
  await transactions.clear();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  failuresRemaining = 0;
  await transactions.clear();
  jest.restoreAllMocks();
});

describe.each([false, true])('real subscriptions with initial read failure = %s', failInitially => {
  it('observes the transaction without a remount or another write', async () => {
    const saved = row();
    await transactions.add(saved);
    failuresRemaining = Number(failInitially);
    const { result } = renderHook(() => useTransactionRow(saved.id));
    expect(result.current).toEqual({ row: undefined, loaded: false });
    await waitFor(() => expect(failedReads).toBe(Number(failInitially)));
    await waitFor(() => expect(result.current).toEqual({ row: saved, loaded: true }), { timeout: 2500 });
    expect(failedReads).toBe(Number(failInitially));
  });

  it('observes settlement notes without a remount or another write', async () => {
    await transactions.add(
      row({ type: 'consume', noteIds: ['note-1'], extraInputs: { swapOrderTxId: 'swap', swapSettleKind: 'settle' } })
    );
    failuresRemaining = Number(failInitially);
    const { result } = renderHook(() => useSwapSettlementNotes('swap'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(failedReads).toBe(Number(failInitially)));
    await waitFor(() => expect(result.current?.settled).toEqual(['note-1']), { timeout: 2500 });
    expect(failedReads).toBe(Number(failInitially));
  });

  it('observes recent recipients without a remount or another write', async () => {
    await transactions.add(row());
    failuresRemaining = Number(failInitially);
    const { result } = renderHook(() => useRecentRecipients(ACCOUNT));
    expect(result.current).toEqual([]);
    await waitFor(() => expect(failedReads).toBe(Number(failInitially)));
    expect(console.warn).toHaveBeenCalledTimes(Number(failInitially));
    await waitFor(() => expect(result.current.map(recipient => recipient.address)).toEqual([RECIPIENT]), {
      timeout: 2500
    });
    expect(failedReads).toBe(Number(failInitially));
  });
});

it('retains a loaded transaction through a later failed read', async () => {
  const saved = row();
  await transactions.add(saved);
  const { result } = renderHook(() => useTransactionRow(saved.id));
  await waitFor(() => expect(result.current.row).toEqual(saved));
  jest.spyOn(transactions, 'where').mockImplementationOnce(() => {
    throw readError;
  });
  await act(async () => {
    await transactions.put({ ...saved, displayMessage: 'updated' });
  });
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith('[useTransactionRow] Failed to read transaction:', readError)
  );
  expect(result.current).toEqual({ row: saved, loaded: true });
  await waitFor(() => expect(result.current.row?.displayMessage).toBe('updated'), { timeout: 2500 });
});

it('retains settlement notes through a later failed read', async () => {
  await transactions.add(
    row({ type: 'consume', noteIds: ['note-1'], extraInputs: { swapOrderTxId: 'swap', swapSettleKind: 'settle' } })
  );
  const { result } = renderHook(() => useSwapSettlementNotes('swap'));
  await waitFor(() => expect(result.current?.settled).toEqual(['note-1']));
  failuresRemaining = 1;
  await act(async () => {
    await transactions.update('tracked', { noteIds: ['note-2'] });
  });
  await waitFor(() => expect(failedReads).toBe(1));
  expect(result.current?.settled).toEqual(['note-1']);
  await waitFor(() => expect(result.current?.settled).toEqual(['note-2']), { timeout: 2500 });
});

it('cancels an old account retry when the recipient account changes or clears', async () => {
  await transactions.bulkAdd([row(), row({ id: 'second', accountId: 'second-account', secondaryAccountId: '0x2222' })]);
  failuresRemaining = 1;
  const initialProps: { accountId: string | undefined } = { accountId: ACCOUNT };
  const { result, rerender } = renderHook(({ accountId }) => useRecentRecipients(accountId), { initialProps });
  await waitFor(() => expect(failedReads).toBe(1));
  rerender({ accountId: 'second-account' });
  await waitFor(() => expect(result.current.map(recipient => recipient.address)).toEqual(['0x2222']));
  rerender({ accountId: undefined });
  expect(result.current).toEqual([]);
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 1100));
  });
  expect(result.current).toEqual([]);
});
