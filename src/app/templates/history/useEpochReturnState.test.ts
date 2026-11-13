import { createElement, ReactNode } from 'react';

import { act, renderHook } from '@testing-library/react';

import { PageActiveContext } from 'app/layouts/page-active';
import { readEpochNoteState } from 'lib/epoch/return-state';
import { ITransactionStatus } from 'lib/miden/db/types';

import { IHistoryEntry } from './IHistoryEntry';
import { epochReturnDisplay, epochReturnNote, useEpochReturnState } from './useEpochReturnState';

jest.mock('lib/epoch/return-state', () => ({ readEpochNoteState: jest.fn() }));
jest.mock('lib/miden/repo', () => ({ transactions: {} }));
jest.mock('lib/dexie-live-query', () => ({ subscribeToLiveQuery: () => () => undefined }));

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
it('shows the Epoch payout when the note was consumed', () => {
  expect(epochReturnDisplay('spent', []).status).toBe('confirmed');
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
});
