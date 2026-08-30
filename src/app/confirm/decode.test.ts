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
// A note the fee split will actually recognize. The plain `note()` above has no
// `metadata()`, so every fixture built from it was invisible to `partitionFeeNote` and the
// fee behaviour on this security screen went untested in both directions: nothing proved
// the fee was excluded from the totals, and nothing proved a user note was NOT mistaken for
// one. `0xfee` is the kernel's tag; the faucet must be the chain's native one to corroborate.
const NATIVE_FAUCET = 'native';
const feeNote = (amount: bigint, faucetId = NATIVE_FAUCET) => ({
  ...note([fa(faucetId, amount)]),
  metadata: () => ({ tag: () => ({ asU32: () => 0xfee }) })
});

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
// The fee split corroborates the tag against the chain's native faucet, so the discovered
// id has to be controllable here — with it left `null` the split falls back to tag-alone and
// the corroboration itself is what goes untested.
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => 'bech32:native'),
  // A fee note only exists on a chain that charges, so the split reads this too — and both
  // readers failing closed is what stops a dApp's tagged note erasing itself from the sheet.
  getVerificationBaseFeeSync: jest.fn(() => 10000)
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

// The fee is a real cost shown on the approval sheet, and both decoders must agree on what
// `outgoing` means or the same request renders differently for two account kinds under one
// "verified" label. These pin BOTH halves: the fee is reported, and it is reported once.
describe('the network fee, on both decode paths', () => {
  it('excludes the fee note from the summary path total and reports it separately', () => {
    // The summary's total comes from the account DELTA, which is net of the fee — so unlike
    // the executed path there is no note to drop and the fee has to be subtracted back out.
    // Here the account sent 10 fA and paid 2 native, and the delta removed both.
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({
          removedFungibleAssets: () => [fa('fA', 10n), fa(NATIVE_FAUCET, 5n)],
          addedFungibleAssets: () => []
        }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      outputNotes: () => ({ numNotes: () => 2, notes: () => [note([fa('fA', 10n)]), feeNote(2n)] })
    };

    const view = summaryToView(ts as any);

    expect(view.fee).toEqual({ faucetId: 'bech32:native', amount: 2n });
    expect(view.outgoing).toEqual([
      { faucetId: 'bech32:fA', amount: 10n },
      { faucetId: 'bech32:native', amount: 3n }
    ]);
    // The kernel's note is not one the user created.
    expect(view.outputNotesCreated).toBe(1);
  });

  it('drops a native row the fee entirely accounts for, rather than showing a zero send', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({ removedFungibleAssets: () => [fa(NATIVE_FAUCET, 2n)], addedFungibleAssets: () => [] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(2n)] })
    };

    const view = summaryToView(ts as any);

    expect(view.outgoing).toEqual([]);
    expect(view.fee).toEqual({ faucetId: 'bech32:native', amount: 2n });
  });

  it('reports a net RECEIPT as incoming when the fee made the delta look like a send', () => {
    // The delta is NET. An account that consumed a 1-native note and paid a 9 fee nets 8
    // REMOVED — but only 9 of that is the fee, so the transaction received 1. Adjusting the
    // removed side alone left this as `outgoing: []`, silently dropping a receipt; the
    // executed path calls the same transaction `incoming: 1`.
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({ removedFungibleAssets: () => [fa(NATIVE_FAUCET, 8n)], addedFungibleAssets: () => [] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(9n)] })
    };

    const view = summaryToView(ts as any);

    expect(view.outgoing).toEqual([]);
    expect(view.incoming).toEqual([{ faucetId: 'bech32:native', amount: 1n }]);
  });

  it('agrees with the executed path on a consume that also paid a fee', () => {
    // The case that adjusting only the removed side got wrong: consume a 10-native note,
    // pay 2. The delta nets +8 RECEIVED; the executed path sees the whole 10 arrive as an
    // input note. Both must say the same thing, because one renderer shows both under one
    // "verified" label and the account kind is what decides which path runs.
    const summary = summaryToView({
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => ({ removedFungibleAssets: () => [], addedFungibleAssets: () => [fa(NATIVE_FAUCET, 8n)] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1 }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(2n)] })
    } as any);

    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 1, notes: () => [{ note: () => note([fa(NATIVE_FAUCET, 10n)]) }] }),
        outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(2n)] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });
    const executed = executedBytesToView('execB64');

    expect(summary.incoming).toEqual(executed.incoming);
    expect(summary.outgoing).toEqual(executed.outgoing);
    expect(summary.fee).toEqual(executed.fee);
  });

  it('excludes the fee note from the executed path total and reports it separately', () => {
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
        outputNotes: () => ({ numNotes: () => 2, notes: () => [note([fa('fA', 10n)]), feeNote(2n)] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });

    const view = executedBytesToView('execB64');

    // Same request, same numbers as the summary case above: that agreement is the point.
    expect(view.fee).toEqual({ faucetId: 'bech32:native', amount: 2n });
    expect(view.outgoing).toEqual([{ faucetId: 'bech32:fA', amount: 10n }]);
    expect(view.outputNotesCreated).toBe(1);
  });

  it('identifies NOTHING as the fee when the realm has not discovered the native faucet', () => {
    // The confirm popup is its OWN JS realm and `getNativeAssetIdSync` reads a module-scope
    // cache with no synchronous hydration, so it starts null on every open. Trusting the tag
    // in that window let a site's tagged note delete itself from the sheet's totals.
    const nativeAsset = jest.requireMock('lib/miden-chain/native-asset');
    nativeAsset.getNativeAssetIdSync.mockReturnValueOnce(null);
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
        outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(500n)] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });

    const view = executedBytesToView('execB64');

    expect(view.fee).toBeUndefined();
    expect(view.outgoing).toEqual([{ faucetId: 'bech32:native', amount: 500n }]);
  });

  it('identifies NOTHING as the fee on a chain that charges nothing', () => {
    // No race and no cold cache needed: at base fee 0 the kernel emits no fee note, so a
    // single NATIVE tagged note satisfies every other corroboration. Testnet is such a chain.
    const nativeAsset = jest.requireMock('lib/miden-chain/native-asset');
    nativeAsset.getVerificationBaseFeeSync.mockReturnValueOnce(0);
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
        outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(500n)] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });

    const view = executedBytesToView('execB64');

    expect(view.fee).toBeUndefined();
    expect(view.outgoing).toEqual([{ faucetId: 'bech32:native', amount: 500n }]);
  });

  it('does not let a dApp note wearing the fee tag erase itself from the totals', () => {
    // A dApp's `transactionRequest` reaches the wallet verbatim, and `0xfee` is a plain u32
    // anything can set. A tagged note drawn on a NON-native faucet is not a fee, and
    // treating it as one would hide an asset transfer from the approval sheet.
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
        outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(500n, 'attackerFaucet')] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });

    const view = executedBytesToView('execB64');

    expect(view.fee).toBeUndefined();
    expect(view.outgoing).toEqual([{ faucetId: 'bech32:attackerFaucet', amount: 500n }]);
    expect(view.outputNotesCreated).toBe(1);
  });

  it('treats NEITHER note as the fee when two carry the tag, keeping both in the totals', () => {
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
        outputNotes: () => ({ numNotes: () => 2, notes: () => [feeNote(2n), feeNote(7n)] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });

    const view = executedBytesToView('execB64');

    expect(view.fee).toBeUndefined();
    expect(view.outgoing).toEqual([
      { faucetId: 'bech32:native', amount: 2n },
      { faucetId: 'bech32:native', amount: 7n }
    ]);
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
