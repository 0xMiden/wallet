import { act, renderHook, waitFor } from '@testing-library/react';

import { type ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { useRotationGateRows } from './HotKeyRotationFunding';

const ACCOUNT = 'mtst1rotationaccount';

const makeRow = (id: string, over: Partial<ITransaction>): ITransaction =>
  ({
    id,
    type: 'send',
    accountId: ACCOUNT,
    status: ITransactionStatus.Completed,
    initiatedAt: 1_700_000_000,
    completedAt: 1_700_000_000,
    displayIcon: 'SEND',
    ...over
  }) as unknown as ITransaction;

describe('useRotationGateRows', () => {
  beforeEach(async () => {
    await Repo.transactions.clear();
  });

  it('reads replacement and funding rows via the type index and updates reactively on new writes', async () => {
    await Repo.transactions.bulkAdd([
      makeRow('rot-1', {
        type: 'replace-hot-key',
        status: ITransactionStatus.Failed,
        initiatedAt: 100,
        completedAt: 100
      }),
      makeRow('revocation-ignored', {
        type: 'replace-hot-key',
        status: ITransactionStatus.Completed,
        initiatedAt: 101,
        completedAt: 101,
        extraInputs: { revokedSignerCommitment: '0x22' }
      }),
      makeRow('fund-1', {
        type: 'consume',
        rotationFunding: true,
        status: ITransactionStatus.Completed,
        initiatedAt: 102,
        completedAt: 102
      }),
      makeRow('send-ignored', {
        type: 'send',
        initiatedAt: 103
      })
    ]);

    const whereSpy = jest.spyOn(Repo.transactions, 'where');
    const filterSpy = jest.spyOn(Repo.transactions, 'filter');
    try {
      const { result, unmount } = renderHook(() => useRotationGateRows(ACCOUNT));
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.rotationRows.map(r => r.id)).toEqual(['rot-1']);
      expect(result.current.fundingRows.map(r => r.id)).toEqual(['fund-1']);
      expect(whereSpy).toHaveBeenCalledWith('type');
      expect(filterSpy).not.toHaveBeenCalled();

      await act(async () => {
        await Repo.transactions.add(
          makeRow('fund-2', {
            type: 'consume',
            rotationFunding: true,
            status: ITransactionStatus.Queued,
            initiatedAt: 200,
            completedAt: undefined
          })
        );
      });
      await waitFor(() => expect(result.current.fundingRows.map(r => r.id).sort()).toEqual(['fund-1', 'fund-2']));
      unmount();
    } finally {
      whereSpy.mockRestore();
      filterSpy.mockRestore();
    }
  });

  it('falls back to Repo.transactions.filter when schema lacks the type index', async () => {
    const fallbackRows = [
      makeRow('rot-fallback', { type: 'replace-hot-key', status: ITransactionStatus.Failed, initiatedAt: 100 }),
      makeRow('fund-fallback', { type: 'consume', rotationFunding: true, initiatedAt: 101 })
    ];
    const origSchema = Repo.transactions.schema;
    const filterSpy = jest.spyOn(Repo.transactions, 'filter').mockImplementation(((
      predicate: (row: ITransaction) => boolean
    ) => ({
      toArray: async () => fallbackRows.filter(predicate)
    })) as unknown as typeof Repo.transactions.filter);
    Object.defineProperty(Repo.transactions, 'schema', {
      configurable: true,
      value: { ...origSchema, idxByName: {} }
    });
    try {
      const { result, unmount } = renderHook(() => useRotationGateRows(ACCOUNT));
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.rotationRows.map(r => r.id)).toEqual(['rot-fallback']);
      expect(result.current.fundingRows.map(r => r.id)).toEqual(['fund-fallback']);
      expect(filterSpy).toHaveBeenCalled();
      unmount();
    } finally {
      filterSpy.mockRestore();
      Object.defineProperty(Repo.transactions, 'schema', { configurable: true, value: origSchema });
    }
  });
});
