import { createElement, ReactNode } from 'react';

import { act, renderHook } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';
import { readEpochNoteState } from 'lib/epoch/return-state';
import { ITransactionStatus } from 'lib/miden/db/types';

import { IHistoryEntry } from './IHistoryEntry';
import { epochReturnDisplay, epochReturnNote, useEpochReturnState } from './useEpochReturnState';

jest.mock('lib/epoch/return-state', () => ({ readEpochNoteState: jest.fn() }));
let capturedLiveQuery: (() => unknown) | undefined;
let mockRepoTransactions: unknown = {};
jest.mock('lib/miden/repo', () => ({
  get transactions() {
    return mockRepoTransactions;
  }
}));
jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: (query: () => unknown) => {
    capturedLiveQuery = query;
    return () => undefined;
  }
}));

const mockRead = jest.mocked(readEpochNoteState);

function bridgeEntry(overrides: Partial<IHistoryEntry> = {}): IHistoryEntry {
  return {
    txId: 'tx-1',
    txType: 'bridged-send',
    bridgeProvider: 'epoch',
    status: ITransactionStatus.Failed,
    bridgeEpochStatus: 'failed',
    bridgeReclaimHeight: 1000,
    outputNoteIds: ['note-1'],
    ...overrides
  } as IHistoryEntry;
}

it('uses neutral recovery states for verified unspent notes', () => {
  expect(epochReturnDisplay('waiting', [])).toEqual({ status: 'awaitingReturn', messageKey: 'epochReturnWaiting' });
  expect(epochReturnDisplay('ready', [])).toEqual({ status: 'readyToClaim', messageKey: 'epochReturnReady' });
});
it('does not promise a return for a missing note or a failed read', () => {
  expect(epochReturnDisplay('absent', []).status).toBeUndefined();
  expect(epochReturnDisplay(undefined, []).status).toBeUndefined();
});
it('shows the Epoch payout only when Epoch confirmed the fill', () => {
  expect(epochReturnDisplay('spent', [], true)).toEqual({ status: 'confirmed', messageKey: 'epochReturnPaid' });
});
it('does not call a consumed note paid without a confirmed fill', () => {
  expect(epochReturnDisplay('spent', [], false)).toEqual({ status: 'unconfirmed', messageKey: 'epochReturnSpent' });
});
it('distinguishes a wallet return from an Epoch payout', () => {
  expect(epochReturnDisplay('spent', [{ status: ITransactionStatus.Completed }]).status).toBe('fundsReturned');
  expect(epochReturnDisplay('spent', [{ status: ITransactionStatus.GeneratingTransaction }]).status).toBe(
    'returningFunds'
  );
});
it('allows another claim after a return claim fails', () => {
  expect(epochReturnDisplay('ready', [{ status: ITransactionStatus.Failed }]).status).toBe('readyToClaim');
});

describe('epochReturnNote', () => {
  it('reads no note for a definitive failure, which never sent its note', () => {
    expect(epochReturnNote(bridgeEntry({ bridgeEpochStatus: undefined, isUnconfirmed: false }), false)).toBeUndefined();
  });
  it('reads no stamped note whose submit was never claimed', () => {
    expect(
      epochReturnNote(
        bridgeEntry({
          isUnconfirmed: true,
          bridgeEpochStatus: undefined,
          outputNoteIds: undefined,
          bridgeReclaimNoteId: 'note-stamped'
        }),
        false
      )
    ).toBeUndefined();
  });
  it('reads no note for a restored row', () => {
    expect(epochReturnNote(bridgeEntry(), true)).toBeUndefined();
  });
  it('reads the committed note of a fill-failed Completed row', () => {
    expect(epochReturnNote(bridgeEntry({ status: ITransactionStatus.Completed }), false)).toEqual({
      noteId: 'note-1',
      height: 1000
    });
  });
});

describe('useEpochReturnState note reads', () => {
  beforeEach(() => {
    mockRead.mockReset().mockResolvedValue('waiting');
  });

  it('starts no node read for a definitive failure', async () => {
    renderHook(() =>
      useEpochReturnState(bridgeEntry({ bridgeEpochStatus: undefined, isUnconfirmed: false }), 'acct-1', false)
    );
    await act(async () => undefined);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('keeps a spent note unclaimable while its claim rows load', async () => {
    mockRead.mockResolvedValue('spent');
    const { result } = renderHook(() => useEpochReturnState(bridgeEntry(), 'acct-1', false));
    await act(async () => undefined);
    expect(result.current).toEqual({ status: 'unconfirmed', messageKey: 'epochReturnSpent' });
  });

  it('reads the committed note of a fill-failed Completed row', async () => {
    renderHook(() => useEpochReturnState(bridgeEntry({ status: ITransactionStatus.Completed }), 'acct-1', false));
    await act(async () => undefined);
    expect(mockRead).toHaveBeenCalledWith('note-1', 1000);
  });
});

describe('useEpochReturnState page visibility', () => {
  beforeEach(() => {
    mockRead.mockReset().mockResolvedValue('waiting');
  });

  it('reads the node only while its page is on screen', async () => {
    let active = false;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(PageActiveContext.Provider, { value: active }, children);
    const { rerender } = renderHook(() => useEpochReturnState(bridgeEntry(), 'acct-1', false), { wrapper });
    await act(async () => undefined);
    expect(mockRead).not.toHaveBeenCalled();
    active = true;
    rerender();
    await act(async () => undefined);
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('narrows claim liveQuery onto noteId and noteIds when indexed and falls back on stripped mocks', async () => {
    const actualRepo = jest.requireActual<typeof import('lib/miden/repo')>('lib/miden/repo');
    const prevTransactions = mockRepoTransactions;
    mockRepoTransactions = actualRepo.transactions;
    try {
      await actualRepo.transactions.clear();
      await actualRepo.transactions.bulkAdd([
        {
          id: 'claim-both',
          type: 'consume',
          accountId: 'acct-1',
          status: ITransactionStatus.Completed,
          initiatedAt: 100,
          completedAt: 100,
          displayIcon: 'RECEIVE',
          noteId: 'note-1',
          noteIds: ['note-1']
        },
        {
          id: 'unrelated-send',
          type: 'send',
          accountId: 'acct-1',
          status: ITransactionStatus.Completed,
          initiatedAt: 101,
          completedAt: 101,
          displayIcon: 'SEND'
        }
      ]);
      const whereSpy = jest.spyOn(actualRepo.transactions, 'where');
      capturedLiveQuery = undefined;
      renderHook(() => useEpochReturnState(bridgeEntry(), 'acct-1', false));
      expect(capturedLiveQuery).toBeDefined();
      const rows = (await capturedLiveQuery!()) as Array<{ id: string }>;
      expect(rows.map(r => r.id)).toEqual(['claim-both']);
      expect(whereSpy.mock.calls.map(([arg]) => arg)).toEqual(['noteId', 'noteIds']);
      whereSpy.mockRestore();
      await actualRepo.transactions.clear();

      const fallbackWhere = jest.fn(() => ({
        filter: () => ({ toArray: async () => [] })
      }));
      mockRepoTransactions = { where: fallbackWhere };
      capturedLiveQuery = undefined;
      renderHook(() => useEpochReturnState(bridgeEntry(), 'acct-1', false));
      expect(capturedLiveQuery).toBeDefined();
      await capturedLiveQuery!();
      expect(fallbackWhere).toHaveBeenCalledWith({ accountId: 'acct-1' });
    } finally {
      mockRepoTransactions = prevTransactions;
    }
  });
});
