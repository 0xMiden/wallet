const fa = (faucetId: string, amount: bigint) => ({
  faucetId: () => ({ toString: () => faucetId }),
  amount: () => amount
});
const note = (assets: any[]) => ({ assets: () => ({ fungibleAssets: () => assets }) });

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: jest.fn() },
  TransactionSummary: { deserialize: jest.fn() },
  Note: { deserialize: jest.fn() }
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn(() => 'mtst1account')
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length]))
}));

import { Note, TransactionRequest, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { declaredRequestToView, summaryToView } from './decode';

describe('summaryToView', () => {
  it('maps a TransactionSummary account delta to outgoing/incoming + note counts', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({ removedFungibleAssets: () => [fa('fA', 10n)], addedFungibleAssets: () => [fa('fB', 3n)] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      outputNotes: () => ({ numNotes: () => 2 })
    };
    expect(summaryToView(ts as any)).toEqual({
      account: 'mtst1account',
      outgoing: [{ faucetId: 'fA', amount: 10n }],
      incoming: [{ faucetId: 'fB', amount: 3n }],
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: false
    });
  });
});

describe('declaredRequestToView', () => {
  it('derives outgoing from expected output notes and incoming from imported notes', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({
      expectedOutputOwnNotes: () => [note([fa('fA', 10n)])]
    });
    (Note.deserialize as jest.Mock).mockReturnValueOnce(note([fa('fB', 3n)]));

    const view = declaredRequestToView('reqB64', ['imported']);
    expect(view).toEqual({
      account: undefined,
      outgoing: [{ faucetId: 'fA', amount: 10n }],
      incoming: [{ faucetId: 'fB', amount: 3n }],
      inputNotesConsumed: 1,
      outputNotesCreated: 1,
      storageChanged: false
    });
  });

  it('handles a request with no output/imported notes', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({ expectedOutputOwnNotes: () => [] });
    const view = declaredRequestToView('reqB64');
    expect(view.outgoing).toEqual([]);
    expect(view.incoming).toEqual([]);
    expect(view.outputNotesCreated).toBe(0);
    expect(view.inputNotesConsumed).toBe(0);
  });
});
