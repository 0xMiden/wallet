import { TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { summaryToView } from 'app/confirm/decode';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';
import {
  getVerificationBaseFee,
  getVerificationBaseFeeSync,
  isVerificationBaseFeeKnownAbsent
} from 'lib/miden-chain/native-asset';

import { ProposalEffectRefusedError, ProposalFeeUnknownError } from './constants';
import { assertProposalEffectApproved, assertViewEffectApproved, proposalEffectRefusal } from './proposal-effect-guard';
import { ITransaction, ITransactionStatus } from '../db/types';

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
  assets: () => { fungibleAssets: () => Asset[]; nonFungibleAssets: () => Nft[] };
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
const note = (assets: Asset[], nfts: Nft[] = []): StubNote => ({
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => nfts })
});
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
  inputNotes: () => ({ numNotes: () => inputs.length, notes: () => inputs.map(input => ({ note: () => input })) }),
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
const execute = (spentAssetTotals?: { faucetId: string; amount: bigint }[]) =>
  row({ type: 'execute', requestBytes: new Uint8Array([1]), spentAssetTotals });

// The real decoder over the summary: the rule sees the shape the wiring hands it.
const refusalOf = (transaction: ITransaction, ts: Summary) =>
  proposalEffectRefusal(transaction, summaryToView(ts as never));

const givenSummary = (ts: Summary) => jest.mocked(TransactionSummary.deserialize).mockReturnValue(ts as never);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(TransactionSummary.deserialize).mockReset();
  jest.mocked(getVerificationBaseFee).mockReset();
  jest.mocked(getVerificationBaseFee).mockImplementation(async () => 2);
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

describe('execute', () => {
  const sends = (...assets: Asset[]) =>
    summary({
      removed: [...assets, fa('usdcx', 2n)],
      outputs: [...assets.map(asset => note([asset])), feeNote(2n)]
    });

  it('passes a custom transaction that moves what its approval showed, spelled either way', () => {
    expect(refusalOf(execute([{ faucetId: 'bech32:fA', amount: 100n }]), sends(fa('fA', 100n)))).toBeUndefined();
    expect(refusalOf(execute([{ faucetId: 'hex:bech32:fA', amount: 100n }]), sends(fa('fA', 100n)))).toBeUndefined();
  });

  it('refuses one unit over the approved amount', () => {
    expect(refusalOf(execute([{ faucetId: 'bech32:fA', amount: 100n }]), sends(fa('fA', 101n)))).toBe(
      '101 of bech32:fA leaves (approved 100)'
    );
  });

  it('refuses an asset the approval did not show leaving', () => {
    expect(refusalOf(execute([{ faucetId: 'bech32:fA', amount: 100n }]), sends(fa('fA', 100n), fa('fB', 1n)))).toBe(
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
    row({ ...execute([{ faucetId: 'bech32:fA', amount: 100n }]), approvedNftOutflow });

  it('passes an NFT its approval showed leaving', () => {
    expect(refusalOf(withNfts(['fN|n1']), nftOut)).toBeUndefined();
  });

  it('refuses an NFT its approval did not show, from the same faucet or on a row that recorded none', () => {
    expect(refusalOf(withNfts(['fN|n2']), nftOut)).toBe('an unapproved NFT of bech32:fN leaves');
    expect(refusalOf(withNfts([]), nftOut)).toBe('an unapproved NFT of bech32:fN leaves');
    expect(refusalOf(withNfts(undefined), nftOut)).toBe('an unapproved NFT of bech32:fN leaves');
  });

  it('lets a row approved with unknown effects pay only its fee', () => {
    for (const unknown of [execute([]), execute(undefined)]) {
      expect(refusalOf(unknown, sends())).toBeUndefined();
      expect(refusalOf(unknown, sends(fa('fA', 1n)))).toBe('1 of bech32:fA leaves (approved 0)');
    }
  });

  it('credits no note the request brought in: the net delta already counts it', () => {
    // A carried 100 fA note comes in and 150 fA leaves: 50 of the user's own fA is the outflow the user saw.
    const carried = summary({
      removed: [fa('fA', 50n), fa('usdcx', 2n)],
      inputs: [note([fa('fA', 100n)])],
      outputs: [note([fa('fA', 150n)]), feeNote(2n)]
    });
    expect(refusalOf(execute([{ faucetId: 'bech32:fA', amount: 50n }]), carried)).toBeUndefined();
    expect(refusalOf(execute([]), carried)).toBe('50 of bech32:fA leaves (approved 0)');
  });

  // A request that consumed a note the wallet already held: the policy withheld its totals, and signing reads the
  // outflow the sheet showed instead.
  const heldNoteApproval = row({
    ...execute([]),
    approvedOutflow: [{ faucetId: 'bech32:fA', amount: 50n }]
  });

  it('allows the outflow the sheet showed when the policy totals were withheld, and refuses one unit more', () => {
    expect(refusalOf(heldNoteApproval, sends(fa('fA', 50n)))).toBeUndefined();
    expect(refusalOf(heldNoteApproval, sends(fa('fA', 51n)))).toBe('51 of bech32:fA leaves (approved 50)');
  });

  it('reads the policy totals on a row queued before the approved outflow was recorded', () => {
    const legacy = execute([{ faucetId: 'bech32:fA', amount: 50n }]);
    expect(legacy.approvedOutflow).toBeUndefined();
    expect(refusalOf(legacy, sends(fa('fA', 50n)))).toBeUndefined();
    expect(refusalOf(legacy, sends(fa('fA', 51n)))).toBe('51 of bech32:fA leaves (approved 50)');
  });
});

describe('assertProposalEffectApproved', () => {
  it.each([
    ['consume', claim],
    ['execute', execute([{ faucetId: 'bech32:fA', amount: 100n }])]
  ])('refuses a %s proposal with no summary to check', async (_type, transaction) => {
    givenSummary(summary({}));
    await expect(assertProposalEffectApproved(transaction, undefined)).rejects.toThrow(ProposalEffectRefusedError);
    await expect(assertProposalEffectApproved(transaction, '')).rejects.toThrow('carries no transaction summary');
    expect(TransactionSummary.deserialize).not.toHaveBeenCalled();
  });

  it.each([
    ['consume', claim],
    ['execute', execute([{ faucetId: 'bech32:fA', amount: 100n }])]
  ])('refuses a %s proposal whose summary does not decode, a trap included', async (_type, transaction) => {
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

  it('looks the chain fee up before it reads the summary', async () => {
    const order: string[] = [];
    jest.mocked(getVerificationBaseFee).mockImplementationOnce(async () => {
      order.push('fee');
      return 2;
    });
    jest.mocked(TransactionSummary.deserialize).mockImplementation(() => {
      order.push('decode');
      return summary({}) as never;
    });
    await assertProposalEffectApproved(claim, 'sum');
    expect(order).toEqual(['fee', 'decode']);
  });

  it('rejects an unknown fee before it reads the summary', async () => {
    jest.mocked(getVerificationBaseFee).mockResolvedValueOnce(null);
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
    jest.mocked(getVerificationBaseFee).mockResolvedValueOnce(0);
    jest.mocked(getVerificationBaseFeeSync).mockReturnValue(0);
    givenSummary(summary({}));
    await expect(assertProposalEffectApproved(claim, 'sum')).resolves.toBeUndefined();
    expect(TransactionSummary.deserialize).toHaveBeenCalledTimes(1);

    jest.mocked(getVerificationBaseFee).mockResolvedValueOnce(null);
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
    const send = row({ type: 'send', faucetId: 'bech32:fA', amount: 500n });
    await expect(assertProposalEffectApproved(send, undefined)).resolves.toBeUndefined();
    await expect(assertProposalEffectApproved(send, 'sum')).resolves.toBeUndefined();
    expect(TransactionSummary.deserialize).not.toHaveBeenCalled();
    expect(getVerificationBaseFee).not.toHaveBeenCalled();
  });
});

describe('assertViewEffectApproved', () => {
  it('refuses an execute whose view moves more than approved, after the fee lookup', async () => {
    const order: string[] = [];
    jest.mocked(getVerificationBaseFee).mockImplementationOnce(async () => {
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
});
