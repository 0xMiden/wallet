import { act, renderHook, waitFor } from '@testing-library/react';

import { ITransaction, ITransactionStatus, IUsdcxBurn } from 'lib/miden/db/types';

import { findUsdcxDestinationTransaction } from './destination-transaction';
import { useUsdcxDestinationTransaction } from './use-destination-transaction';

jest.mock('./destination-transaction', () => ({ findUsdcxDestinationTransaction: jest.fn() }));
const find = jest.mocked(findUsdcxDestinationTransaction);
const hash = `0x${'a'.repeat(64)}`;

function row(overrides: Partial<IUsdcxBurn> = {}): ITransaction {
  return {
    id: 'row',
    type: 'bridged-send',
    accountId: 'sender',
    initiatedAt: 1,
    status: ITransactionStatus.Completed,
    displayIcon: 'SEND',
    amount: 1000000n,
    extraInputs: {
      provider: 'usdcx',
      destinationNetwork: 5042002,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      usdcxBurn: {
        noteId: 'note',
        destinationDomain: 26,
        phase: 'confirmed',
        destinationBalanceBefore: { balance: '0', blockNumber: '100' },
        destinationBalanceConfirmed: { balance: '1000000', blockNumber: '101' },
        ...overrides
      }
    }
  };
}

beforeEach(() => find.mockReset().mockResolvedValue(hash));

it('searches once and keeps the result through row refreshes', async () => {
  const { result, rerender } = renderHook(({ tx }) => useUsdcxDestinationTransaction(tx), {
    initialProps: { tx: row() }
  });
  await waitFor(() => expect(result.current).toBe(hash));
  rerender({ tx: row() });
  expect(find).toHaveBeenCalledTimes(1);
});

it('waits for destination confirmation and does not search restored rows', () => {
  const { result, rerender } = renderHook(({ tx }) => useUsdcxDestinationTransaction(tx), {
    initialProps: { tx: row({ destinationBalanceConfirmed: undefined }) }
  });
  expect(result.current).toBeUndefined();
  rerender({ tx: { ...row(), restoredFromBackup: true } });
  expect(find).not.toHaveBeenCalled();
});

it('does not show a late response on another transaction', async () => {
  let finish: (value: string) => void = () => {};
  find.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const { result, rerender } = renderHook(({ tx }) => useUsdcxDestinationTransaction(tx), {
    initialProps: { tx: row() }
  });
  rerender({ tx: { ...row({ destinationBalanceConfirmed: undefined }), id: 'other' } });
  await act(async () => finish(hash));
  expect(result.current).toBeUndefined();
});

it('leaves the hash absent when the RPC fails', async () => {
  find.mockRejectedValueOnce(new Error('timeout'));
  const { result } = renderHook(() => useUsdcxDestinationTransaction(row()));
  await act(async () => {});
  expect(result.current).toBeUndefined();
});
