import { TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { summaryToView } from 'app/confirm/decode';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  isVerificationBaseFeeKnownAbsent,
  refreshVerificationBaseFee
} from 'lib/miden-chain/native-asset';

import { ProposalEffectRefusedError, ProposalFeeUnknownError } from './constants';
import {
  assertProposalEffectApproved,
  assertViewEffectApproved,
  executeApprovalOf,
  proposalEffectRefusal
} from './proposal-effect-guard';
import { IApprovedCustomEffects, ITransaction, ITransactionStatus } from '../db/types';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionSummary: { deserialize: jest.fn() }
}));
// The decoder resolves every faucet to bech32; `hex:` is the same faucet spelled the other way, which the
// comparison has to fold like `canonicalWalletAccountId` does.
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: jest.fn((id: string | { __faucet: string }) =>
    typeof id === 'string' ? `bech32:${id}` : `bech32:${id.__faucet}`
  ),
  canonicalWalletAccountId: jest.fn((id: string) => id.replace(/^hex:/, ''))
}));
jest.mock('lib/miden/sdk/nft-asset', () => ({
  toNft: jest.fn((a: { __nft: unknown }) => a.__nft),
  nftKey: jest.fn((a: { __key: string }) => a.__key)
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([String(s).length]))
}));
// The chain charges a fee in its native asset, USDCX here as on testnet, so the fee note is told apart.
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => 'bech32:usdcx'),
  getVerificationBaseFeeSync: jest.fn(() => 2),
  getVerificationBaseFee: jest.fn(async () => 2),
  refreshVerificationBaseFee: jest.fn(async () => 2),
  isVerificationBaseFeeKnownAbsent: jest.fn(() => false)
}));
// By the path the guard imports: a root manual mock shadows the `lib/` spelling of this module.
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: jest.fn(async (fn: (hold: object) => unknown) => fn({}))
}));
jest.mock('lib/i18n/core', () => ({
  getMessage: jest.fn((key: string) => `copy:${key}`)
}));

type Asset = { faucetId: () => { __faucet: string }; amount: () => bigint };
type Nft = { __nft: { faucetId: string; assetId: string }; __key: string };
type StubNote = {
  id: () => { toString: () => string };
  assets: () => { fungibleAssets: () => Asset[]; nonFungibleAssets: () => Nft[] } | undefined;
  metadata?: () => { tag: () => { asU32: () => number } };
};

const fa = (faucet: string, amount: bigint): Asset => ({
  faucetId: () => ({ __faucet: faucet }),
  amount: () => amount
});
const nft = (faucet: string, assetId: string): Nft => ({
  __nft: { faucetId: `bech32:${faucet}`, assetId },
  __key: `${faucet}|${assetId}`
});
let stubNoteCount = 0;
// A note keeps its id across reads, as a real note's id does.
const note = (assets: Asset[], nfts: Nft[] = [], id = `stub-note-${++stubNoteCount}`): StubNote => ({
  id: () => ({ toString: () => id }),
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => nfts })
});
// A note whose assets cannot be read.
const opaqueNote = (id: string): StubNote => ({ id: () => ({ toString: () => id }), assets: () => undefined });
const feeNote = (amount: bigint): StubNote => ({
  ...note([fa('usdcx', amount)]),
  metadata: () => ({ tag: () => ({ asU32: () => 0xfee }) })
});

/**
 * A summary as the SDK hands it over: a NET vault delta (one entry per faucet, `unlisted` more entries it cannot
 * list), the notes consumed and the notes created, the kernel's fee note among them.
 */
const summary = ({
  removed = [],
  added = [],
  inputs = [],
  outputs = [],
  unlisted = 0
}: {
  removed?: Asset[];
  added?: Asset[];
  inputs?: StubNote[];
  outputs?: StubNote[];
  unlisted?: number;
}) => ({
  accountDelta: () => ({
    id: () => 'acct',
    vault: () => ({
      removedFungibleAssets: () => removed,
      addedFungibleAssets: () => added,
      numAssets: () => removed.length + added.length + unlisted
    }),
    storage: () => ({ isEmpty: () => true })
  }),
  inputNotes: () => ({
    numNotes: () => inputs.length,
    notes: () => inputs.map(input => ({ id: input.id, note: () => input }))
  }),
  outputNotes: () => ({ numNotes: () => outputs.length, notes: () => outputs })
});
type Summary = ReturnType<typeof summary>;

// Filling a stranger's PSWAP order: its offer (100 fB) comes in, the requested 500 fA leaves as the payback note to
// the order's creator, and the 2 USDCX fee leaves as the kernel's fee note.
const PSWAP_FILL = summary({
  removed: [fa('fA', 500n), fa('usdcx', 2n)],
  added: [fa('fB', 100n)],
  inputs: [note([fa('fB', 100n)])],
  outputs: [note([fa('fA', 500n)]), feeNote(2n)]
});

const row = (fields: Partial<ITransaction>): ITransaction => ({
  id: 'tx-1',
  type: 'consume',
  accountId: 'acct',
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 0,
  displayIcon: 'DEFAULT',
  ...fields
});
const claim = row({ type: 'consume', noteId: 'note-1' });
const gcPurchase = (fillAmount: string) =>
  row({
    type: 'consume',
    extraInputs: {
      gcPurchase: {
        saleNoteId: 'sale',
        sellerAccountId: 'seller',
        payFaucetId: 'bech32:usdcx',
        fillAmount,
        gcFaucetId: 'bech32:gc',
        expectedAmount: '1000'
      }
    }
  });
// The real decoder over the summary: the rule sees the shape the wiring hands it.
const viewOf = (ts: Summary) => summaryToView(ts as never);
const refusalOf = (transaction: ITransaction, ts: Summary) => proposalEffectRefusal(transaction, viewOf(ts));

/** The effects an approval recorded: only the note ids matter to the signing check. */
const approvedEffects = (
  ids: Pick<IApprovedCustomEffects, 'introducedNoteIds' | 'approvedOutputNoteIds'>
): IApprovedCustomEffects => ({
  shape: 'summary',
  outgoing: [],
  incoming: [],
  outgoingNfts: [],
  incomingNfts: [],
  unlistedAssets: 0,
  recipients: [],
  inputNotesConsumed: 0,
  outputNotesCreated: 0,
  storageChanged: false,
  ...ids
});
/** A custom transaction row whose approval recorded `introducedNoteIds` and the notes `sent` creates (none without it). */
const execute = (
  spentAssetTotals?: { faucetId: string; amount: bigint }[],
  sent?: Summary,
  introducedNoteIds: string[] = []
) =>
  row({
    type: 'execute',
    requestBytes: new Uint8Array([1]),
    spentAssetTotals,
    approvedEffects: approvedEffects({
      introducedNoteIds,
      approvedOutputNoteIds: sent === undefined ? [] : (viewOf(sent).createdNotes ?? []).map(created => created.id)
    })
  });
/** A custom transaction row queued before approvals recorded any note. */
const legacy = (spentAssetTotals?: { faucetId: string; amount: bigint }[]) =>
  row({ type: 'execute', requestBytes: new Uint8Array([1]), spentAssetTotals });

const givenSummary = (ts: Summary) => jest.mocked(TransactionSummary.deserialize).mockReturnValue(ts as never);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(TransactionSummary.deserialize).mockReset();
  jest.mocked(getVerificationBaseFee).mockReset();
  jest.mocked(getVerificationBaseFee).mockImplementation(async () => 2);
  jest.mocked(refreshVerificationBaseFee).mockReset();
  jest.mocked(refreshVerificationBaseFee).mockImplementation(async () => 2);
  jest.mocked(getVerificationBaseFeeSync).mockReturnValue(2);
  jest.mocked(isVerificationBaseFeeKnownAbsent).mockReset();
  jest.mocked(isVerificationBaseFeeKnownAbsent).mockReturnValue(false);
});

describe('consume', () => {
  it('refuses a claim whose summary pays out the asset a swap order requested', () => {
    expect(refusalOf(claim, PSWAP_FILL)).toBe('500 of bech32:fA leaves (approved 0)');
  });

  it('passes a plain payment claim that only pays its fee, in the fee asset or another', () => {
    const nativePayment = summary({
      added: [fa('usdcx', 8n)],
      inputs: [note([fa('usdcx', 10n)])],
      outputs: [feeNote(2n)]
    });
    const tokenPayment = summary({
      removed: [fa('usdcx', 2n)],
      added: [fa('fB', 50n)],
      inputs: [note([fa('fB', 50n)])],
      outputs: [feeNote(2n)]
    });
    expect(refusalOf(claim, nativePayment)).toBeUndefined();
    expect(refusalOf(claim, tokenPayment)).toBeUndefined();
  });

  it('refuses a claim when the fee note cannot be told apart, since the fee then reads as an outflow', () => {
    jest.mocked(getVerificationBaseFeeSync).mockReturnValue(null);
    const tokenPayment = summary({
      removed: [fa('usdcx', 2n)],
      added: [fa('fB', 50n)],
      inputs: [note([fa('fB', 50n)])],
      outputs: [feeNote(2n)]
    });
    expect(refusalOf(claim, tokenPayment)).toBe('2 of bech32:usdcx leaves (approved 0)');
  });

  it('refuses a claim that sends an NFT out or changes the vault in a way the summary cannot list', () => {
    const nftOut = summary({
      removed: [fa('usdcx', 2n)],
      outputs: [note([], [nft('fN', 'n1')]), feeNote(2n)],
      unlisted: 1
    });
    expect(refusalOf(claim, nftOut)).toBe('an unapproved NFT of bech32:fN leaves');
    expect(refusalOf(claim, summary({ unlisted: 1 }))).toBe('1 vault change(s) the summary does not list');
  });

  // A GC purchase pays its quoted fill into the sale note, in USDCX, which is also the fee asset.
  const purchase = (paid: bigint, extra: Asset[] = []) =>
    summary({
      removed: [fa('usdcx', paid + 2n), ...extra],
      added: [fa('gc', 1000n)],
      inputs: [note([fa('gc', 5000n)])],
      outputs: [note([fa('usdcx', paid)]), note([fa('gc', 4000n)]), feeNote(2n), ...extra.map(asset => note([asset]))]
    });

  it('passes a GC purchase that pays at most its quoted fill', () => {
    expect(refusalOf(gcPurchase('300'), purchase(300n))).toBeUndefined();
    expect(refusalOf(gcPurchase('300'), purchase(299n))).toBeUndefined();
  });

  it('refuses a GC purchase that pays more than its fill, or pays in another asset', () => {
    expect(refusalOf(gcPurchase('300'), purchase(301n))).toBe('301 of bech32:usdcx leaves (approved 300)');
    expect(refusalOf(gcPurchase('300'), purchase(300n, [fa('fX', 1n)]))).toBe('1 of bech32:fX leaves (approved 0)');
  });
});

describe.each(['send', 'swap', 'earn-deposit'] as const)('%s approved outflow', type => {
  const approved = () =>
    row({
      type,
      faucetId: 'hex:bech32:fA',
      amount: 100n,
      extraInputs: { requestedFaucetId: 'bech32:fB', requestedAmount: 1000n, sourceFaucetId: 'bech32:fA' }
    });
  const sends = (...assets: Asset[]) =>
    summary({
      removed: [...assets, fa('usdcx', 2n)],
      outputs: [...assets.map(asset => note([asset])), feeNote(2n)]
    });

  it('permits only the persisted offered amount, with the kernel fee excluded', () => {
    expect(refusalOf(approved(), sends(fa('fA', 100n)))).toBeUndefined();
    expect(refusalOf(approved(), sends(fa('fA', 99n)))).toBeUndefined();
  });

  it('refuses one unit beyond the offered amount', () => {
    expect(refusalOf(approved(), sends(fa('fA', 101n)))).toBe('101 of bech32:fA leaves (approved 100)');
  });

  it('never treats the requested or received asset as permission to spend it', () => {
    expect(refusalOf(approved(), sends(fa('fA', 100n), fa('fB', 1n)))).toBe('1 of bech32:fB leaves (approved 0)');
  });

  it('refuses an outgoing NFT', () => {
    const outgoing = summary({
      removed: [fa('usdcx', 2n)],
      outputs: [note([], [nft('fN', 'n1')]), feeNote(2n)],
      unlisted: 1
    });
    expect(refusalOf(approved(), outgoing)).toContain('an unapproved NFT of bech32:fN leaves');
  });

  it('refuses effects the summary cannot list', () => {
    expect(refusalOf(approved(), summary({ unlisted: 1 }))).toContain('vault change(s) the summary does not list');
  });

  it('does not sign a row with invalid persisted amount or faucet', async () => {
    givenSummary(sends());
    for (const missing of [{ amount: undefined }, { faucetId: undefined }, { amount: -1n }, { faucetId: '' }]) {
      await expect(assertProposalEffectApproved({ ...approved(), ...missing }, 'sum')).rejects.toThrow(
        ProposalEffectRefusedError
      );
    }
  });
});

describe('execute', () => {
  const sends = (...assets: Asset[]) =>
    summary({
      removed: [...assets, fa('usdcx', 2n)],
      outputs: [...assets.map(asset => note([asset])), feeNote(2n)]
    });

  it('passes a custom transaction that moves what its approval showed, spelled either way', () => {
    const sent = sends(fa('fA', 100n));
    expect(refusalOf(execute([{ faucetId: 'bech32:fA', amount: 100n }], sent), sent)).toBeUndefined();
    expect(refusalOf(execute([{ faucetId: 'hex:bech32:fA', amount: 100n }], sent), sent)).toBeUndefined();
  });

  it('refuses one unit over the approved amount', () => {
    const sent = sends(fa('fA', 101n));
    expect(refusalOf(execute([{ faucetId: 'bech32:fA', amount: 100n }], sent), sent)).toBe(
      '101 of bech32:fA leaves (approved 100)'
    );
  });

  it('refuses an asset the approval did not show leaving', () => {
    const sent = sends(fa('fA', 100n), fa('fB', 1n));
    expect(refusalOf(execute([{ faucetId: 'bech32:fA', amount: 100n }], sent), sent)).toBe(
      '1 of bech32:fB leaves (approved 0)'
    );
  });

  // The decoder keys an NFT by its complete identity (`nftKey`), here `fN|n1`.
  const nftOut = summary({
    removed: [fa('usdcx', 2n)],
    outputs: [note([], [nft('fN', 'n1')]), feeNote(2n)],
    unlisted: 1
  });
  const withNfts = (approvedNftOutflow?: string[]) =>
    row({ ...execute([{ faucetId: 'bech32:fA', amount: 100n }], nftOut), approvedNftOutflow });

  it('passes an NFT its approval showed leaving', () => {
    expect(refusalOf(withNfts(['fN|n1']), nftOut)).toBeUndefined();
  });

  it('refuses an NFT its approval did not show, from the same faucet or on a row that recorded none', () => {
    expect(refusalOf(withNfts(['fN|n2']), nftOut)).toBe('an unapproved NFT of bech32:fN leaves');
    expect(refusalOf(withNfts([]), nftOut)).toBe('an unapproved NFT of bech32:fN leaves');
    expect(refusalOf(withNfts(undefined), nftOut)).toBe('an unapproved NFT of bech32:fN leaves');
  });

  it('lets a row approved with unknown effects pay only its fee', () => {
    const feeOnly = sends();
    const sent = sends(fa('fA', 1n));
    for (const totals of [[], undefined]) {
      expect(refusalOf(execute(totals, feeOnly), feeOnly)).toBeUndefined();
      expect(refusalOf(execute(totals, sent), sent)).toBe('1 of bech32:fA leaves (approved 0)');
    }
  });

  // The request consumes a note of 1000 fA and sends 1050 fA: the vault's net change is 50.
  const spendsNote = () => {
    const consumed = note([fa('fA', 1000n)], [], 'n-in');
    return summary({
      removed: [fa('fA', 50n), fa('usdcx', 2n)],
      inputs: [consumed],
      outputs: [note([fa('fA', 1050n)]), feeNote(2n)]
    });
  };
  const approvedFifty = (ts: Summary, introducedNoteIds: string[]) =>
    row({ ...execute([], ts, introducedNoteIds), approvedOutflow: [{ faucetId: 'bech32:fA', amount: 50n }] });

  it('counts a held note the request consumed: consuming a held 1000 fA and sending 1050 fA is refused against an approval of 50', () => {
    const ts = spendsNote();
    expect(refusalOf(approvedFifty(ts, []), ts)).toBe('1050 of bech32:fA leaves (approved 50)');
  });

  it('credits a note the row records as introduced', () => {
    const ts = spendsNote();
    expect(refusalOf(approvedFifty(ts, ['n-in']), ts)).toBeUndefined();
    // Recorded in another case, it is the same note.
    expect(refusalOf(approvedFifty(ts, ['N-IN']), ts)).toBeUndefined();
  });

  it('refuses a created note the approval did not record, and passes when every created note was recorded, the fee note aside', () => {
    const ts = summary({
      removed: [fa('fA', 100n), fa('usdcx', 2n)],
      outputs: [note([fa('fA', 100n)], [], 'out-1'), note([], [], 'out-2'), feeNote(2n)]
    });
    const recording = (approvedOutputNoteIds: string[]) =>
      row({
        ...execute([{ faucetId: 'bech32:fA', amount: 100n }]),
        approvedEffects: approvedEffects({ introducedNoteIds: [], approvedOutputNoteIds })
      });
    expect(refusalOf(recording(['out-1', 'out-2']), ts)).toBeUndefined();
    expect(refusalOf(recording(['out-2', 'unrelated']), ts)).toBe('creates a note that was not approved (out-1)');
    // A recorded note binds by id even when it carries nothing.
    expect(refusalOf(recording([]), ts)).toBe(
      'creates a note that was not approved (out-1); creates a note that was not approved (out-2)'
    );
  });

  // Review Focus 1: a row queued before this build recorded no note, so it may create only notes that carry nothing.
  it('refuses a row queued before notes were recorded when it creates a note carrying assets or passes a carried note through, and passes one creating an empty note', () => {
    const queued = legacy([{ faucetId: 'bech32:fA', amount: 50n }]);
    expect(queued.approvedEffects).toBeUndefined();
    const paying = summary({
      removed: [fa('fA', 50n), fa('usdcx', 2n)],
      outputs: [note([fa('fA', 50n)], [], 'pay'), feeNote(2n)]
    });
    expect(refusalOf(queued, paying)).toBe('creates a note that was not approved (pay)');
    const passThrough = summary({
      removed: [fa('usdcx', 2n)],
      inputs: [note([fa('fB', 100n)], [], 'carried')],
      outputs: [note([fa('fB', 100n)], [], 'onward'), feeNote(2n)]
    });
    expect(refusalOf(queued, passThrough)).toBe(
      '100 of bech32:fB leaves (approved 0); creates a note that was not approved (onward)'
    );
    const withNft = summary({ removed: [fa('usdcx', 2n)], outputs: [note([], [nft('fN', 'n1')], 'nft'), feeNote(2n)] });
    expect(refusalOf({ ...queued, approvedNftOutflow: ['fN|n1'] }, withNft)).toBe(
      'creates a note that was not approved (nft)'
    );
    const unreadable = summary({ removed: [fa('usdcx', 2n)], outputs: [opaqueNote('opaque'), feeNote(2n)] });
    expect(refusalOf(queued, unreadable)).toBe('creates a note that was not approved (opaque)');
    const empty = summary({ removed: [fa('usdcx', 2n)], outputs: [note([], [], 'empty'), feeNote(2n)] });
    expect(refusalOf(queued, empty)).toBeUndefined();
  });

  it('reads the policy totals on a row queued before the approved outflow was recorded', () => {
    const queued = legacy([{ faucetId: 'bech32:fA', amount: 50n }]);
    expect(queued.approvedOutflow).toBeUndefined();
    const burns = (amount: bigint) => summary({ removed: [fa('fA', amount), fa('usdcx', 2n)], outputs: [feeNote(2n)] });
    expect(refusalOf(queued, burns(50n))).toBeUndefined();
    expect(refusalOf(queued, burns(51n))).toBe('51 of bech32:fA leaves (approved 50)');
  });

  it('refuses when a held note does not list its assets, since it cannot be measured', () => {
    const ts = summary({ removed: [fa('usdcx', 2n)], inputs: [opaqueNote('held')], outputs: [feeNote(2n)] });
    expect(refusalOf(execute([], ts), ts)).toBe(
      'the notes it consumes could not be measured (a held note does not list its assets)'
    );
    // Recorded as introduced, it is credited nothing, which can only overstate what leaves.
    expect(refusalOf(execute([], ts, ['held']), ts)).toBeUndefined();
  });

  // A request that consumed a note the wallet already held: the policy withheld its totals, and signing reads the
  // outflow the sheet showed instead.
  const heldNoteApproval = (sent: Summary) =>
    row({
      ...execute([], sent),
      approvedOutflow: [{ faucetId: 'bech32:fA', amount: 50n }]
    });

  it('allows the outflow the sheet showed when the policy totals were withheld, and refuses one unit more', () => {
    const fifty = sends(fa('fA', 50n));
    const fiftyOne = sends(fa('fA', 51n));
    expect(refusalOf(heldNoteApproval(fifty), fifty)).toBeUndefined();
    expect(refusalOf(heldNoteApproval(fiftyOne), fiftyOne)).toBe('51 of bech32:fA leaves (approved 50)');
  });

  it('an approval taken from a view passes that same view', () => {
    const pswapView = viewOf(PSWAP_FILL);
    const offerId = pswapView.viewConsumedNotes?.[0]?.id ?? '';
    for (const introduced of [[offerId], [offerId, offerId], []]) {
      const approval = executeApprovalOf(pswapView, introduced);
      const approved = row({
        ...execute(),
        approvedOutflow: approval.approvedOutflow,
        approvedNftOutflow: approval.approvedNftOutflow,
        approvedEffects: approvedEffects({
          introducedNoteIds: approval.introducedNoteIds,
          approvedOutputNoteIds: approval.approvedOutputNoteIds
        })
      });
      expect(proposalEffectRefusal(approved, pswapView)).toBeUndefined();
    }
    // Brought in, the offer is credited; held, it is spent too.
    expect(executeApprovalOf(pswapView, [offerId])).toEqual({
      approvedOutflow: [{ faucetId: 'bech32:fA', amount: 500n }],
      approvedNftOutflow: [],
      introducedNoteIds: [offerId],
      approvedOutputNoteIds: [pswapView.createdNotes?.[0]?.id]
    });
    expect(executeApprovalOf(pswapView, [offerId, offerId]).introducedNoteIds).toEqual([offerId]);
    expect(executeApprovalOf(pswapView, []).approvedOutflow).toEqual([{ faucetId: 'bech32:fA', amount: 500n }]);

    const heldView = viewOf(spendsNote());
    const heldApproval = executeApprovalOf(heldView, []);
    expect(heldApproval.approvedOutflow).toEqual([{ faucetId: 'bech32:fA', amount: 1050n }]);
    const fromHeld = row({
      ...execute(),
      approvedOutflow: heldApproval.approvedOutflow,
      approvedEffects: approvedEffects({
        introducedNoteIds: heldApproval.introducedNoteIds,
        approvedOutputNoteIds: heldApproval.approvedOutputNoteIds
      })
    });
    expect(proposalEffectRefusal(fromHeld, heldView)).toBeUndefined();
  });

  it('records only keyed NFTs and refuses a view without its notes or one already measured from holdings', () => {
    const nftView = viewOf(nftOut);
    expect(executeApprovalOf(nftView, []).approvedNftOutflow).toEqual(['fN|n1']);
    const unkeyed = {
      ...nftView,
      createdNotes: [{ id: 'x', amounts: [], nfts: [{ faucetId: 'bech32:fN', assetId: 'n9' }] }]
    };
    expect(executeApprovalOf(unkeyed, []).approvedNftOutflow).toEqual([]);
    expect(() => executeApprovalOf({ ...nftView, createdNotes: undefined }, [])).toThrow();
    expect(() => executeApprovalOf({ ...nftView, heldNotesSpent: 0 }, [])).toThrow();
  });
});

// Review Focus 5: a claim takes in, so it is measured on the net rule and the notes it creates are not bound.
describe('consume measurement', () => {
  it('leaves a claim of held notes on the net rule with no output binding', () => {
    // The sale note is the seller's, consumed by this account: counted as held it would read as 4000 GC leaving.
    const purchase = summary({
      removed: [fa('usdcx', 302n)],
      added: [fa('gc', 1000n)],
      inputs: [note([fa('gc', 5000n)], [], 'sale')],
      outputs: [note([fa('usdcx', 300n)], [], 'payment'), note([fa('gc', 4000n)], [], 'remainder'), feeNote(2n)]
    });
    expect(refusalOf(gcPurchase('300'), purchase)).toBeUndefined();
    const heldClaim = summary({
      removed: [fa('usdcx', 2n)],
      added: [fa('fB', 50n)],
      inputs: [note([fa('fB', 50n)], [], 'held')],
      outputs: [note([], [], 'created'), feeNote(2n)]
    });
    expect(refusalOf(claim, heldClaim)).toBeUndefined();
  });
});

describe('assertProposalEffectApproved', () => {
  it.each([
    { type: 'consume', transaction: claim },
    { type: 'execute', transaction: execute([{ faucetId: 'bech32:fA', amount: 100n }]) },
    ...(['send', 'swap', 'earn-deposit'] as const).map(type => ({
      type,
      transaction: row({ type, faucetId: 'bech32:fA', amount: 100n })
    }))
  ])('refuses a $type proposal with no summary to check', async ({ transaction }) => {
    givenSummary(summary({}));
    await expect(assertProposalEffectApproved(transaction, undefined)).rejects.toThrow(ProposalEffectRefusedError);
    await expect(assertProposalEffectApproved(transaction, '')).rejects.toThrow('carries no transaction summary');
    expect(TransactionSummary.deserialize).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'consume', transaction: claim },
    { type: 'execute', transaction: execute([{ faucetId: 'bech32:fA', amount: 100n }]) },
    ...(['send', 'swap', 'earn-deposit'] as const).map(type => ({
      type,
      transaction: row({ type, faucetId: 'bech32:fA', amount: 100n })
    }))
  ])('refuses a $type proposal whose summary does not decode, a trap included', async ({ transaction }) => {
    jest.mocked(TransactionSummary.deserialize).mockImplementation(() => {
      throw new Error('unexpected end of input');
    });
    await expect(assertProposalEffectApproved(transaction, 'garbage')).rejects.toThrow(
      'the proposal summary could not be read'
    );
    const trap = new WebAssembly.RuntimeError('unreachable');
    jest.mocked(TransactionSummary.deserialize).mockImplementation(() => {
      throw trap;
    });
    const refused = await assertProposalEffectApproved(transaction, 'garbage').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProposalEffectRefusedError);
    expect(refused).toMatchObject({ cause: trap });
  });

  it('passes a kill of the decoding hold through unchanged', async () => {
    const kill = new WasmClientPoisonedError('watchdog');
    jest.mocked(TransactionSummary.deserialize).mockImplementation(() => {
      throw kill;
    });
    await expect(assertProposalEffectApproved(claim, 'sum')).rejects.toBe(kill);
  });

  it('refuses with the type, what would leave, and the localized sentence the row shows', async () => {
    givenSummary(PSWAP_FILL);
    const refused = await assertProposalEffectApproved(claim, 'sum').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProposalEffectRefusedError);
    expect(refused).toMatchObject({
      transactionType: 'consume',
      message: 'Refused to sign this consume transaction: 500 of bech32:fA leaves (approved 0)',
      displayMessage: 'copy:proposalEffectRefused'
    });
  });

  it('refuses a row whose approved amounts do not parse', async () => {
    givenSummary(summary({}));
    await expect(assertProposalEffectApproved(gcPurchase('three hundred'), 'sum')).rejects.toThrow(
      'its approved amounts could not be read'
    );
  });

  // Review Focus 3: a fee cached by another realm's read may be stale, so the check reads the chain again.
  it('reads a fresh chain fee before decoding, and rejects ProposalFeeUnknownError when that read fails although a fee is cached', async () => {
    const order: string[] = [];
    jest.mocked(refreshVerificationBaseFee).mockImplementationOnce(async () => {
      order.push('fee');
      return 2;
    });
    jest.mocked(TransactionSummary.deserialize).mockImplementation(() => {
      order.push('decode');
      return summary({}) as never;
    });
    await assertProposalEffectApproved(claim, 'sum');
    expect(order).toEqual(['fee', 'decode']);
    expect(getVerificationBaseFee).not.toHaveBeenCalled();

    jest.mocked(refreshVerificationBaseFee).mockResolvedValueOnce(null);
    const refused = await assertProposalEffectApproved(claim, 'sum').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProposalFeeUnknownError);
    expect(getVerificationBaseFeeSync()).toBe(2);
    expect(TransactionSummary.deserialize).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown fee before it reads the summary', async () => {
    jest.mocked(refreshVerificationBaseFee).mockResolvedValueOnce(null);
    jest.mocked(isVerificationBaseFeeKnownAbsent).mockReturnValueOnce(false);
    givenSummary(
      summary({
        removed: [fa('usdcx', 2n)],
        added: [fa('fB', 50n)],
        inputs: [note([fa('fB', 50n)])],
        outputs: [feeNote(2n)]
      })
    );
    await expect(assertProposalEffectApproved(claim, 'sum')).rejects.toBeInstanceOf(ProposalFeeUnknownError);
    expect(TransactionSummary.deserialize).not.toHaveBeenCalled();
  });

  it('decodes a fee of 0, and refuses a known-absent fee the summary still counts as leaving', async () => {
    jest.mocked(refreshVerificationBaseFee).mockResolvedValueOnce(0);
    jest.mocked(getVerificationBaseFeeSync).mockReturnValue(0);
    givenSummary(summary({}));
    await expect(assertProposalEffectApproved(claim, 'sum')).resolves.toBeUndefined();
    expect(TransactionSummary.deserialize).toHaveBeenCalledTimes(1);

    jest.mocked(refreshVerificationBaseFee).mockResolvedValueOnce(null);
    jest.mocked(isVerificationBaseFeeKnownAbsent).mockReturnValueOnce(true);
    jest.mocked(getVerificationBaseFeeSync).mockReturnValue(null);
    givenSummary(
      summary({
        removed: [fa('usdcx', 2n)],
        added: [fa('fB', 50n)],
        inputs: [note([fa('fB', 50n)])],
        outputs: [feeNote(2n)]
      })
    );
    const refused = await assertProposalEffectApproved(claim, 'sum').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProposalEffectRefusedError);
    expect(refused).toMatchObject({
      message: 'Refused to sign this consume transaction: 2 of bech32:usdcx leaves (approved 0)'
    });
    expect(TransactionSummary.deserialize).toHaveBeenCalledTimes(2);
  });

  it('passes a plain claim and a custom transaction within its approval', async () => {
    givenSummary(summary({ added: [fa('fB', 50n)], removed: [fa('usdcx', 2n)], outputs: [feeNote(2n)] }));
    await expect(assertProposalEffectApproved(claim, 'sum')).resolves.toBeUndefined();
  });

  it('leaves an unchecked type alone without reading its summary', async () => {
    givenSummary(PSWAP_FILL);
    const unchecked = row({ type: 'bridged-receive', faucetId: 'bech32:fA', amount: 500n });
    await expect(assertProposalEffectApproved(unchecked, undefined)).resolves.toBeUndefined();
    await expect(assertProposalEffectApproved(unchecked, 'sum')).resolves.toBeUndefined();
    expect(TransactionSummary.deserialize).not.toHaveBeenCalled();
    expect(refreshVerificationBaseFee).not.toHaveBeenCalled();
  });
});

describe('assertViewEffectApproved', () => {
  it('refuses an execute whose view moves more than approved, after the fee lookup', async () => {
    const order: string[] = [];
    jest.mocked(refreshVerificationBaseFee).mockImplementationOnce(async () => {
      order.push('fee');
      return 2;
    });
    const decode = () => {
      order.push('decode');
      return summaryToView(PSWAP_FILL as never);
    };
    const transaction = execute([{ faucetId: 'bech32:fA', amount: 100n }]);
    const refused = await assertViewEffectApproved(transaction, decode).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProposalEffectRefusedError);
    expect((refused as Error).message).toContain('500 of bech32:fA leaves (approved 100)');
    expect(order).toEqual(['fee', 'decode']);
  });

  it('refuses when the decode fails', async () => {
    const failure = new Error('unexpected end of input');
    const refused = await assertViewEffectApproved(claim, () => {
      throw failure;
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProposalEffectRefusedError);
    expect(refused).toMatchObject({
      message: 'Refused to sign this consume transaction: the transaction summary could not be read',
      cause: failure
    });
  });

  it('passes a refusal from the decode through as the same error', async () => {
    const inner = new ProposalEffectRefusedError('consume', 'the proposal summary could not be read', 'copy');
    await expect(
      assertViewEffectApproved(claim, () => {
        throw inner;
      })
    ).rejects.toBe(inner);
  });

  it('passes a kill of the decoding hold through unchanged', async () => {
    const kill = new WasmClientPoisonedError('watchdog');
    await expect(
      assertViewEffectApproved(claim, async () => {
        throw kill;
      })
    ).rejects.toBe(kill);
  });

  it('rejects an unknown fee without calling the decode', async () => {
    jest.mocked(refreshVerificationBaseFee).mockResolvedValueOnce(null);
    const decode = jest.fn(() => summaryToView(PSWAP_FILL as never));
    const refused = assertViewEffectApproved(claim, decode);
    await expect(refused).rejects.toBeInstanceOf(ProposalFeeUnknownError);
    await expect(refused).rejects.toMatchObject({ displayMessage: 'copy:chainFeeUnknown' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('leaves an unchecked type alone without calling the decode', async () => {
    const decode = jest.fn(() => summaryToView(PSWAP_FILL as never));
    const incoming = row({ type: 'bridged-receive', faucetId: 'bech32:fA', amount: 500n });
    await expect(assertViewEffectApproved(incoming, decode)).resolves.toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    expect(refreshVerificationBaseFee).not.toHaveBeenCalled();
  });
});
