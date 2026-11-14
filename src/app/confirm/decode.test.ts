import { Note, NoteFile, TransactionRequest, TransactionResult, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';
import fs from 'fs';
import path from 'path';

import {
  declaredRequestToView,
  declaredTransactionRequestToView,
  executedBytesToView,
  netOutflowByFaucet,
  toHoldingsView,
  simulatedBytesToView,
  simulatedOutputRecipients,
  summaryBytesToView,
  summaryToView
} from './decode';

// `faucetId()` returns an AccountId object (not a string). Token metadata is
// cached under the BECH32 faucet address, so the decoders must resolve the id
// via `getBech32AddressFromAccountId`, NOT `AccountId.toString()` (hex) — a hex
// key misses the cache and mislabels non-Miden assets as Miden. The stub below
// carries a marker the mocked `getBech32AddressFromAccountId` turns into bech32.
const fa = (faucetId: string, amount: bigint) => ({
  faucetId: () => ({ __faucet: faucetId }),
  amount: () => amount
});
let noteCounter = 0;
const noteId = (id: string) => ({ toString: () => id });
const note = (assets: any[], nfts: any[] = [], id = `n${++noteCounter}`) => ({
  id: () => noteId(id),
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => nfts })
});
// An input wrapper: the id is the wrapper's, the assets are its note's.
const input = (inner: ReturnType<typeof note> | { id?: never; assets: () => undefined }, id = `i${++noteCounter}`) => ({
  id: () => noteId(id),
  note: () => inner
});
// A vault delta that lists its fungible entries and counts `unlisted` more (the NFTs the SDK cannot list).
const vaultOf = (removed: any[], added: any[], unlisted = 0) => ({
  removedFungibleAssets: () => removed,
  addedFungibleAssets: () => added,
  numAssets: () => removed.length + added.length + unlisted
});
// Marker stand-in for an NFT; the mocked `toNft` below turns it into the sheet's identity.
// `key` is the complete value word; two NFTs can share the short `assetId` and still differ in it.
const nft = (faucetId: string, assetId: string, key = `${faucetId}|${assetId}`) => ({
  __nft: { faucetId, assetId },
  __key: key
});
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
  ),
  // Collapses the two spellings the fold has to treat as one faucet. `hex:f1` and `f1` are the
  // same asset written two ways, which is the case a raw-string fold silently misses.
  canonicalWalletAccountId: jest.fn((id: string) => id.replace(/^hex:/, ''))
}));
jest.mock('lib/miden/sdk/nft-asset', () => ({
  toNft: jest.fn((a: any) => a.__nft),
  nftKey: jest.fn((a: any) => a.__key)
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
        vault: () => vaultOf([fa('fA', 10n)], [fa('fB', 3n)]),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [] }),
      // `notes()` too: the summary's output notes go through the fee split now, since
      // `fee::pay_fee` runs inside auth BEFORE the summary is built, so the kernel's fee
      // note is among them exactly as it is on an executed transaction.
      outputNotes: () => ({ numNotes: () => 2, notes: () => [note([]), note([])] })
    };
    expect(summaryToView(ts as any)).toEqual({
      account: 'bech32:acctId',
      outgoing: [{ faucetId: 'bech32:fA', amount: 10n }],
      incoming: [{ faucetId: 'bech32:fB', amount: 3n }],
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: false,
      viewConsumedNotes: expect.any(Array),
      createdNotes: expect.any(Array)
    });
  });

  it('summaryBytesToView deserializes bytes then maps like summaryToView', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([fa('fA', 10n)], [fa('fB', 3n)]),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [] }),
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
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: false,
      viewConsumedNotes: expect.any(Array),
      createdNotes: expect.any(Array)
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
        inputNotes: () => ({ numNotes: () => 1, notes: () => [input(note([fa('fB', 3n)]))] }),
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
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
      inputNotesConsumed: 1,
      outputNotesCreated: 2,
      storageChanged: true,
      viewConsumedNotes: expect.any(Array),
      createdNotes: expect.any(Array)
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
        vault: () => vaultOf([fa('fA', 10n), fa(NATIVE_FAUCET, 5n)], []),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [] }),
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
        vault: () => vaultOf([fa(NATIVE_FAUCET, 2n)], []),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [] }),
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
        vault: () => vaultOf([fa(NATIVE_FAUCET, 8n)], []),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [] }),
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
        vault: () => vaultOf([], [fa(NATIVE_FAUCET, 8n)]),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [] }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(2n)] })
    } as any);

    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 1, notes: () => [input(note([fa(NATIVE_FAUCET, 10n)]))] }),
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
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
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

describe('the declared view of a carried note whose decode traps', () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  const throwTrap = () => {
    throw trap;
  };
  const request = { expectedOutputOwnNotes: () => [] } as unknown as Parameters<
    typeof declaredTransactionRequestToView
  >[0];
  const traps: Record<string, () => void> = {
    'NoteFile.deserialize': () => (NoteFile.deserialize as jest.Mock).mockImplementationOnce(throwTrap),
    'Note.deserialize': () => (Note.deserialize as jest.Mock).mockImplementationOnce(throwTrap),
    'the asset read': () => (Note.deserialize as jest.Mock).mockReturnValueOnce({ assets: throwTrap })
  };

  it.each(Object.keys(traps))('returns no incoming assets when %s traps', name => {
    traps[name]!();
    expect(declaredTransactionRequestToView(request, ['imported']).incoming).toEqual([]);
  });

  it('returns no incoming assets when Note.deserialize fails ordinarily', () => {
    (Note.deserialize as jest.Mock).mockImplementationOnce(() => {
      throw new Error('bad note bytes');
    });
    expect(declaredTransactionRequestToView(request, ['imported']).incoming).toEqual([]);
  });

  it('keeps the trap option out of the declared view', () => {
    const source = fs.readFileSync(path.join(__dirname, 'decode.ts'), 'utf8');
    expect(source).not.toContain('rethrowTraps');
    expect(source).not.toContain('NoteDecodeOptions');
  });
});

describe('simulatedBytesToView', () => {
  // The dry run produces exactly one of these, decided by the ACCOUNT's authorization state:
  // a summary while authorization is pending, an executed transaction for every ordinary
  // single-sig account on 0.16. A consumer that decoded only the summary shape treated every
  // ordinary account as unsimulatable, which hard-refused their dApp custom transactions.
  it('decodes the summary when one was produced', () => {
    (TransactionSummary.deserialize as jest.Mock).mockReturnValueOnce({
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([fa('fA', 10n)], []),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [note([])] })
    });

    expect(simulatedBytesToView({ summaryBytes: 'sumB64' })?.outgoing).toEqual([
      { faucetId: 'bech32:fA', amount: 10n }
    ]);
  });

  it('falls back to the executed transaction when no summary was produced', () => {
    // The ordinary single-sig case on 0.16. A consumer that decoded only the summary shape read
    // this as "unsimulatable" and refused every dApp custom transaction for those accounts.
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
        outputNotes: () => ({ numNotes: () => 1, notes: () => [note([fa('fA', 10n)])] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });

    expect(simulatedBytesToView({ executedBytes: 'execB64' })?.outgoing).toEqual([
      { faucetId: 'bech32:fA', amount: 10n }
    ]);
  });

  it('reports undefined only when the dry run produced neither shape', () => {
    expect(simulatedBytesToView({})).toBeUndefined();
    expect(simulatedBytesToView({ summaryBytes: undefined, executedBytes: undefined })).toBeUndefined();
  });
});

describe('simulatedOutputRecipients', () => {
  const withRecipient = (base: object, digest: string) => ({
    ...base,
    recipientDigest: () => ({ toHex: () => digest })
  });

  it('gives the sorted recipient digests of the user notes of a summary, without the fee note', () => {
    (TransactionSummary.deserialize as jest.Mock).mockReturnValueOnce({
      outputNotes: () => ({
        notes: () => [
          withRecipient(note([fa('fA', 1n)]), '0xbb'),
          withRecipient(feeNote(5n), '0xfee'),
          withRecipient(note([fa('fA', 2n)]), '0xaa')
        ]
      })
    });

    expect(simulatedOutputRecipients({ summaryBytes: 'sumB64' })).toEqual(['0xaa', '0xbb']);
  });

  it('decodes an executed transaction with the same ladder', () => {
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        outputNotes: () => ({ notes: () => [withRecipient(note([fa('fA', 1n)]), '0xcc')] })
      })
    });

    expect(simulatedOutputRecipients({ executedBytes: 'execB64' })).toEqual(['0xcc']);
  });

  it('reports undefined when the dry run produced neither shape', () => {
    expect(simulatedOutputRecipients({})).toBeUndefined();
  });
});

describe('netOutflowByFaucet', () => {
  const view = (outgoing: { faucetId: string; amount: bigint }[]) =>
    ({
      account: 'acct',
      outgoing,
      incoming: [],
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
      inputNotesConsumed: 0,
      outputNotesCreated: outgoing.length,
      fee: undefined,
      storageChanged: false
    }) as ReturnType<typeof summaryToView>;

  it('folds several entries on one faucet into a single total', () => {
    // The executed view flat-maps over output notes, so two notes drawing on one faucet arrive
    // as two entries. Assessed separately, 60 and 60 would each pass a cap of 100.
    expect(
      netOutflowByFaucet(
        view([
          { faucetId: 'f1', amount: 60n },
          { faucetId: 'f1', amount: 60n }
        ])
      )
    ).toEqual([{ faucetId: 'f1', amount: 120n }]);
  });

  it('folds two spellings of one faucet together', () => {
    // A raw-string fold misses this, and the two consumers downstream would then each see an
    // amount under the cap while the real total is over it.
    expect(
      netOutflowByFaucet(
        view([
          { faucetId: 'f1', amount: 60n },
          { faucetId: 'hex:f1', amount: 60n }
        ])
      )
    ).toEqual([{ faucetId: 'f1', amount: 120n }]);
  });

  it('counts only what leaves the view, never crediting the consumed notes', () => {
    // `incoming` is every note consumed, including ones the user already held. Crediting those let a dApp consume a
    // pending 1000 of the user's and send 1050 for a charge of 50; a holdings view counts that note instead.
    const consumed = {
      ...view([{ faucetId: 'f1', amount: 1050n }]),
      incoming: [{ faucetId: 'f1', amount: 1000n }]
    };

    expect(netOutflowByFaucet(consumed)).toEqual([{ faucetId: 'f1', amount: 1050n }]);
  });

  it('keeps distinct faucets apart', () => {
    expect(
      netOutflowByFaucet(
        view([
          { faucetId: 'f1', amount: 50n },
          { faucetId: 'f2', amount: 30n }
        ])
      )
    ).toEqual([
      { faucetId: 'f1', amount: 50n },
      { faucetId: 'f2', amount: 30n }
    ]);
  });
});

describe('NFTs on the approval view (#1600)', () => {
  const nftOut = nft('bech32:nftFaucet', '0xaa11bb22…cc33dd');
  const nftIn = nft('bech32:otherFaucet', '0x01020304…050607');

  it('declared view lists the NFT of an output note and of an imported note, with no fungible amount', () => {
    (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({
      expectedOutputOwnNotes: () => [note([], [nftOut])]
    });
    (Note.deserialize as jest.Mock).mockReturnValueOnce(note([], [nftIn]));

    const view = declaredRequestToView('reqB64', ['imported']);

    expect(view.outgoing).toEqual([]);
    expect(view.outgoingNfts).toEqual([
      { faucetId: 'bech32:nftFaucet', assetId: '0xaa11bb22…cc33dd', key: 'bech32:nftFaucet|0xaa11bb22…cc33dd' }
    ]);
    expect(view.incomingNfts).toEqual([
      { faucetId: 'bech32:otherFaucet', assetId: '0x01020304…050607', key: 'bech32:otherFaucet|0x01020304…050607' }
    ]);
  });

  it('executed view lists the NFT of a created note and of a consumed note', () => {
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 1, notes: () => [input(note([], [nftIn]))] }),
        outputNotes: () => ({ numNotes: () => 1, notes: () => [note([], [nftOut])] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
      })
    });

    const view = executedBytesToView('execB64');

    expect(view.outgoing).toEqual([]);
    expect(view.outgoingNfts).toEqual([
      {
        faucetId: 'bech32:nftFaucet',
        assetId: '0xaa11bb22\u2026cc33dd',
        key: 'bech32:nftFaucet|0xaa11bb22\u2026cc33dd'
      }
    ]);
    expect(view.incomingNfts).toEqual([
      {
        faucetId: 'bech32:otherFaucet',
        assetId: '0x01020304\u2026050607',
        key: 'bech32:otherFaucet|0x01020304\u2026050607'
      }
    ]);
    expect(view.unlistedAssets).toBe(0);
  });

  it('summary view counts a vault change it cannot list instead of dropping it', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        // One fungible entry listed, two more entries (NFTs) the SDK reports only through numAssets.
        vault: () => vaultOf([fa('fA', 10n)], [], 2),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [note([fa('fA', 10n)])] })
    };

    const view = summaryToView(ts as any);

    expect(view.unlistedAssets).toBe(2);
    expect(view.outgoingNfts).toEqual([]);
  });

  it('summary view lists the NFT of a created note as leaving, and counts it as explained', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([], [], 1),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [note([], [nftOut])] })
    };

    const view = summaryToView(ts as any);

    expect(view.outgoingNfts).toEqual([
      {
        faucetId: 'bech32:nftFaucet',
        assetId: '0xaa11bb22\u2026cc33dd',
        key: 'bech32:nftFaucet|0xaa11bb22\u2026cc33dd'
      }
    ]);
    expect(view.unlistedAssets).toBe(0);
  });

  it('summary view lists the NFT of a consumed note as entering', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([], [], 1),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [input(note([], [nftIn]))] }),
      outputNotes: () => ({ numNotes: () => 0, notes: () => [] })
    };

    const view = summaryToView(ts as any);

    expect(view.incomingNfts).toHaveLength(1);
    expect(view.outgoingNfts).toEqual([]);
    expect(view.unlistedAssets).toBe(0);
  });

  it('summary view shows an NFT consumed and re-created in one transaction on neither side', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([], [], 0),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [input(note([], [nftOut]))] }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [note([], [nftOut])] })
    };

    const view = summaryToView(ts as any);

    expect(view.outgoingNfts).toEqual([]);
    expect(view.incomingNfts).toEqual([]);
    expect(view.unlistedAssets).toBe(0);
  });

  it('summary view does not net two distinct NFTs that share a short asset id', () => {
    const created = nft('bech32:nftFaucet', '0xaa11bb22\u2026cc33dd', 'word-one');
    const consumed = nft('bech32:nftFaucet', '0xaa11bb22\u2026cc33dd', 'word-two');
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([], [], 2),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 1, notes: () => [input(note([], [consumed]))] }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [note([], [created])] })
    };

    const view = summaryToView(ts as any);

    // Each keeps its complete identity, which the short id the sheet shows cannot tell apart.
    expect(view.outgoingNfts.map(listed => listed.key)).toEqual(['word-one']);
    expect(view.incomingNfts.map(listed => listed.key)).toEqual(['word-two']);
    expect(view.unlistedAssets).toBe(0);
  });

  it('summary view still counts a delta entry that no note explains beside a listed NFT', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([], [], 2),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
      outputNotes: () => ({ numNotes: () => 1, notes: () => [note([], [nftOut])] })
    };

    const view = summaryToView(ts as any);

    expect(view.outgoingNfts).toHaveLength(1);
    expect(view.unlistedAssets).toBe(1);
  });

  it('summary view reports nothing unlisted when every vault entry is a fungible one it listed', () => {
    const ts = {
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf([fa('fA', 10n)], [fa('fB', 3n)]),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
      outputNotes: () => ({ numNotes: () => 0, notes: () => [] })
    };

    expect(summaryToView(ts as any).unlistedAssets).toBe(0);
  });

  it('spending-limit outflow stays amount-only: an NFT adds nothing to it (option C)', () => {
    const view = {
      outgoing: [{ faucetId: 'f1', amount: 5n }],
      incoming: [],
      outgoingNfts: [{ faucetId: 'bech32:nftFaucet', assetId: '0xaa' }],
      incomingNfts: [],
      unlistedAssets: 1,
      inputNotesConsumed: 0,
      outputNotesCreated: 1,
      storageChanged: false
    };

    expect(netOutflowByFaucet(view)).toEqual([{ faucetId: 'f1', amount: 5n }]);
  });
});

describe('the notes a verified view lists', () => {
  const summaryOf = (inputs: any[], outputs: any[], removed: any[], added: any[] = []) =>
    ({
      accountDelta: () => ({
        id: () => 'acctId',
        vault: () => vaultOf(removed, added),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => inputs.length, notes: () => inputs }),
      outputNotes: () => ({ numNotes: () => outputs.length, notes: () => outputs })
    }) as any;
  const executedOf = (inputs: any[], outputs: any[]) => ({
    executedTransaction: () => ({
      accountId: () => 'acctId',
      inputNotes: () => ({ numNotes: () => inputs.length, notes: () => inputs }),
      outputNotes: () => ({ numNotes: () => outputs.length, notes: () => outputs }),
      accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) })
    })
  });
  const executedView = (inputs: any[], outputs: any[]) => {
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce(executedOf(inputs, outputs));
    return executedBytesToView('execB64');
  };
  const nftIn = nft('bech32:nftFaucet', 'in', 'k-in');

  it('lists consumed and created notes with ids, amounts and NFTs on the summary path, without the fee note', () => {
    const view = summaryToView(
      summaryOf(
        [input(note([fa('fB', 3n)], [nftIn], 'x'), 'IN-A'), input({ assets: () => undefined }, 'in-b')],
        [note([fa('fA', 10n)], [], 'out-1'), feeNote(2n)],
        [fa('fA', 10n)]
      )
    );

    expect(view.viewConsumedNotes).toEqual([
      {
        id: 'in-a',
        amounts: [{ faucetId: 'bech32:fB', amount: 3n }],
        nfts: [expect.objectContaining({ key: 'k-in' })]
      },
      { id: 'in-b', amounts: [], nfts: [], opaque: true }
    ]);
    expect(view.createdNotes).toEqual([{ id: 'out-1', amounts: [{ faucetId: 'bech32:fA', amount: 10n }], nfts: [] }]);
  });

  it('lists them on the executed path the same way', () => {
    const view = executedView(
      [input(note([fa('fB', 3n)], [nftIn]), 'IN-A'), input({ assets: () => undefined }, 'in-b')],
      [note([fa('fA', 10n)], [], 'out-1'), feeNote(2n)]
    );

    expect(view.viewConsumedNotes).toEqual([
      {
        id: 'in-a',
        amounts: [{ faucetId: 'bech32:fB', amount: 3n }],
        nfts: [expect.objectContaining({ key: 'k-in' })]
      },
      { id: 'in-b', amounts: [], nfts: [], opaque: true }
    ]);
    expect(view.createdNotes).toEqual([{ id: 'out-1', amounts: [{ faucetId: 'bech32:fA', amount: 10n }], nfts: [] }]);
  });

  it('fails the whole decode when a note id cannot be read', () => {
    const broken = {
      id: () => {
        throw new Error('no id');
      },
      note: () => note([])
    };
    expect(() => executedView([broken], [])).toThrow('no id');
  });

  describe('toHoldingsView', () => {
    const heldView = () =>
      summaryToView(
        summaryOf(
          [input(note([fa('X', 1000n)], [], 'v'), 'n-held')],
          [note([fa('X', 1050n)], [], 'out')],
          [fa('X', 50n)]
        )
      );

    it('counts a held consumed note as leaving: consuming a held 1000 X and sending 1050 X shows 1050 leaving', () => {
      const view = toHoldingsView(heldView(), []);

      expect(view.outgoing).toEqual([{ faucetId: 'bech32:X', amount: 1050n }]);
      expect(view.incoming).toEqual([]);
      expect(view.heldNotesSpent).toBe(1);
    });

    it('credits only a consumed note the request introduced', () => {
      const view = toHoldingsView(heldView(), ['N-HELD']);

      expect(view.outgoing).toEqual([{ faucetId: 'bech32:X', amount: 50n }]);
      expect(view.heldNotesSpent).toBe(0);
    });

    it('agrees between the summary and executed paths for one transaction', () => {
      const inputs = () => [
        input(note([fa('X', 30n)], [], 'v1'), 'held'),
        input(note([fa('X', 100n)], [], 'v2'), 'introduced')
      ];
      const outputs = () => [note([fa('X', 150n)], [], 'out'), feeNote(2n)];
      const fromSummary = toHoldingsView(
        summaryToView(summaryOf(inputs(), outputs(), [fa('X', 20n), fa(NATIVE_FAUCET, 2n)])),
        ['introduced']
      );
      const fromExecuted = toHoldingsView(executedView(inputs(), outputs()), ['introduced']);

      expect(fromSummary.outgoing).toEqual([{ faucetId: 'bech32:X', amount: 50n }]);
      expect(fromExecuted.outgoing).toEqual([{ faucetId: 'bech32:X', amount: 50n }]);
      expect(fromSummary.incoming).toEqual([]);
      expect(fromExecuted.incoming).toEqual([]);
    });

    it('counts an NFT from a held note as leaving and one from an introduced note as passing through', () => {
      const heldNft = nft('bech32:nftFaucet', 'h', 'k-held');
      const passNft = nft('bech32:nftFaucet', 'p', 'k-pass');
      const inputs = () => [input(note([], [heldNft], 'v1'), 'held'), input(note([], [passNft], 'v2'), 'intro')];
      const outputs = () => [note([], [heldNft], 'o1'), note([], [passNft], 'o2')];
      const view = toHoldingsView(executedView(inputs(), outputs()), ['intro']);

      expect(view.outgoingNfts.map(n => n.key)).toEqual(['k-held']);
      expect(view.incomingNfts).toEqual([]);
    });

    it('lists an introduced NFT that is not re-created as incoming, and always counts a keyless created NFT', () => {
      const keyless = { __nft: { faucetId: 'bech32:nftFaucet', assetId: 'z' }, __key: undefined };
      const view = toHoldingsView(
        executedView([input(note([], [nftIn], 'v1'), 'intro')], [note([], [keyless], 'o1')]),
        ['intro']
      );

      expect(view.incomingNfts.map(n => n.key)).toEqual(['k-in']);
      expect(view.outgoingNfts).toHaveLength(1);
    });

    it('throws when a held consumed note does not list its assets', () => {
      const view = executedView([input({ assets: () => undefined }, 'held-opaque')], [note([fa('X', 1050n)], [], 'o')]);

      expect(() => toHoldingsView(view, [])).toThrow('a held note does not list its assets');
    });

    it('does not throw for an introduced consumed note that does not list its assets', () => {
      const view = executedView([input({ assets: () => undefined }, 'intro-opaque')], [note([fa('X', 50n)], [], 'o')]);

      expect(toHoldingsView(view, ['intro-opaque']).outgoing).toEqual([{ faucetId: 'bech32:X', amount: 50n }]);
    });

    it('throws for a view that lists no notes', () => {
      (TransactionRequest.deserialize as jest.Mock).mockReturnValueOnce({ expectedOutputOwnNotes: () => [] });
      const declared = declaredRequestToView('reqB64');
      expect(() => toHoldingsView(declared, [])).toThrow('the view does not list its notes');
    });

    it('folds hex and bech32 spellings and keeps the bech32 one', () => {
      const view = toHoldingsView(
        {
          ...heldView(),
          outgoing: [
            { faucetId: 'bech32:f1', amount: 60n },
            { faucetId: 'hex:bech32:f1', amount: 40n }
          ],
          incoming: [],
          viewConsumedNotes: [],
          createdNotes: []
        },
        []
      );

      expect(view.outgoing).toEqual([{ faucetId: 'bech32:f1', amount: 100n }]);
    });

    it('moves a net-negative faucet to incoming, negated', () => {
      const view = toHoldingsView(executedView([input(note([fa('X', 80n)], [], 'v'), 'intro')], []), ['intro']);

      expect(view.outgoing).toEqual([]);
      expect(view.incoming).toEqual([{ faucetId: 'bech32:X', amount: 80n }]);
    });
  });
});

describe('executedBytesToView fee rate', () => {
  it('executedBytesToView keeps a fee-tagged native note in the outflow on a block that charges nothing', () => {
    (TransactionResult.deserialize as jest.Mock).mockReturnValueOnce({
      executedTransaction: () => ({
        accountId: () => 'acctId',
        inputNotes: () => ({ numNotes: () => 0, notes: () => [] }),
        outputNotes: () => ({ numNotes: () => 1, notes: () => [feeNote(7n)] }),
        accountPatch: () => ({ storage: () => ({ isEmpty: () => true }) }),
        blockHeader: () => ({ verificationBaseFee: () => 0 })
      })
    });
    const view = executedBytesToView('execB64');
    expect(view.outgoing).toEqual([{ faucetId: 'bech32:native', amount: 7n }]);
    expect(view.outputNotesCreated).toBe(1);
  });
});
