import { Note, NoteFile, TransactionRequest, TransactionResult, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { declaredRequestToView, executedBytesToView, summaryBytesToView, summaryToView } from './decode';

// `faucetId()` returns an AccountId object (not a string). Token metadata is
// cached under the BECH32 faucet address, so the decoders must resolve the id
// via `getBech32AddressFromAccountId`, NOT `AccountId.toString()` (hex) — a hex
// key misses the cache and mislabels non-Miden assets as Miden. The stub below
// carries a marker the mocked `getBech32AddressFromAccountId` turns into bech32.
const fa = (faucetId: string, amount: bigint) => ({
  faucetId: () => ({ __faucet: faucetId }),
  amount: () => amount
});
const note = (assets: any[]) => ({ assets: () => ({ fungibleAssets: () => assets }) });

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: jest.fn() },
  TransactionResult: { deserialize: jest.fn() },
  TransactionSummary: { deserialize: jest.fn() },
  Note: { deserialize: jest.fn() },
  // NoteFile is tried FIRST for importNotes (mirroring importNoteBytes); it
  // throws by default ("bare Note, not a NoteFile") so the Note path is
  // exercised by the existing tests. NoteFile-format tests override it.
  NoteFile: {
    deserialize: jest.fn(() => {
      throw new Error('not a NoteFile');
    })
  }
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  // Input-aware: the account delta id is a bare string; faucet ids are the
  // `{ __faucet }` stubs above. Both must go through this helper (bech32).
  getBech32AddressFromAccountId: jest.fn((id: any) =>
    typeof id === 'string' ? `bech32:${id}` : `bech32:${id.__faucet}`
  )
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length]))
}));

describe('summaryToView', () => {
  it('maps a TransactionSummary account delta to bech32 outgoing/incoming + note counts', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({ removedFungibleAssets: () => [fa('fA', 10n)], addedFungibleAssets: () => [fa('fB', 3n)] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      // `notes()` too: the summary's output notes go through the fee split now, since
      // `fee::pay_fee` runs inside auth BEFORE the summary is built, so the kernel's fee
      // note is among them exactly as it is on an executed transaction.
      outputNotes: () => ({ numNotes: () => 2, notes: () => [note([]), note([])] })
    };
    expect(summaryToView(ts as any)).toEqual({
      account: 'bech32:acctId',
      outgoing: [{ faucetId: 'bech32:fA', amount: 10n }],
      incoming: [{ faucetId: 'bech32:fB', amount: 3n }],
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: false
    });
  });

  it('summaryBytesToView deserializes bytes then maps like summaryToView', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({ removedFungibleAssets: () => [fa('fA', 10n)], addedFungibleAssets: () => [fa('fB', 3n)] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      // `notes()` too: the summary's output notes go through the fee split now, since
      // `fee::pay_fee` runs inside auth BEFORE the summary is built, so the kernel's fee
      // note is among them exactly as it is on an executed transaction.
      outputNotes: () => ({ numNotes: () => 2, notes: () => [note([]), note([])] })
    };
    (TransactionSummary.deserialize as jest.Mock).mockReturnValueOnce(ts);
    const view = summaryBytesToView('sumB64');
    expect(TransactionSummary.deserialize).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(view).toEqual({
      account: 'bech32:acctId',
      outgoing: [{ faucetId: 'bech32:fA', amount: 10n }],
      incoming: [{ faucetId: 'bech32:fB', amount: 3n }],
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: false
    });
  });
});

describe('executedBytesToView', () => {
  // Used when the account was already fully authorized so web-sdk 0.16 produced
  // no TransactionSummary (`executeForSummary` rejects TRANSACTION_ALREADY_
  // AUTHORIZED) — i.e. every ordinary single-sig account. Assets come from the
  // notes the execution really consumed/created, because 0.16's `accountPatch()`
  // reports ABSOLUTE final balances, not a delta.
  it('maps an executed transaction to bech32 outgoing/incoming + note counts', () => {
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 1, notes: () => [{ note: () => note([fa('fB', 3n)]) }] }),
        outputNotes: () => ({ numNotes: () => 2, notes: () => [note([fa('fA', 10n)]), note([])] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => false }) })
      })
    });

    const view = executedBytesToView('execB64');

    expect(TransactionResult.deserialize).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(view).toEqual({
      account: 'bech32:acctId',
      outgoing: [{ faucetId: 'bech32:fA', amount: 10n }],
      incoming: [{ faucetId: 'bech32:fB', amount: 3n }],
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: true
    });
  });
});

describe('declaredRequestToView', () => {
  it('derives bech32 outgoing from expected output notes and incoming from imported notes', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({
      expectedOutputOwnNotes: () => [note([fa('fA', 10n)])]
    });
    (Note.deserialize as jest.Mock).mockReturnValueOnce(note([fa('fB', 3n)]));

    const view = declaredRequestToView('reqB64', ['imported']);
    expect(view).toEqual({
      account: undefined,
      outgoing: [{ faucetId: 'bech32:fA', amount: 10n }],
      incoming: [{ faucetId: 'bech32:fB', amount: 3n }],
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

  it('contributes [] for an output note whose assets() returns undefined', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({
      expectedOutputOwnNotes: () => [{ assets: () => undefined }]
    });
    const view = declaredRequestToView('reqB64');
    expect(view.outgoing).toEqual([]);
    expect(view.outputNotesCreated).toBe(1);
  });

  it('derives incoming assets from a NoteFile-serialized importNote (Note parse would throw)', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({ expectedOutputOwnNotes: () => [] });
    (NoteFile.deserialize as jest.Mock).mockReturnValueOnce({
      note: () => note([fa('fB', 3n)]),
      noteDetails: () => undefined
    });
    const view = declaredRequestToView('reqB64', ['nf']);
    expect(view.incoming).toEqual([{ faucetId: 'bech32:fB', amount: 3n }]);
    expect(view.inputNotesConsumed).toBe(1);
  });

  it('falls back to NoteFile.noteDetails() assets when note() is undefined', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({ expectedOutputOwnNotes: () => [] });
    (NoteFile.deserialize as jest.Mock).mockReturnValueOnce({
      note: () => undefined,
      noteDetails: () => note([fa('fC', 7n)])
    });
    const view = declaredRequestToView('reqB64', ['nf']);
    expect(view.incoming).toEqual([{ faucetId: 'bech32:fC', amount: 7n }]);
  });

  it('yields [] incoming for an importNote that is neither NoteFile nor Note', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({ expectedOutputOwnNotes: () => [] });
    (Note.deserialize as jest.Mock).mockImplementationOnce(() => {
      throw new Error('not a Note either');
    });
    const view = declaredRequestToView('reqB64', ['bad']);
    expect(view.incoming).toEqual([]);
    expect(view.inputNotesConsumed).toBe(1);
  });
});
