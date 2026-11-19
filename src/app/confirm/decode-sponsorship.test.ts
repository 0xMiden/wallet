/** @jest-environment node */
import { canonicalFeeSponsorshipNoteId } from 'lib/miden/sdk/fee-sponsorship';
import type { UsdcxSponsorshipApproval } from 'lib/usdcx/sponsorship';

import { executedBytesToView, summaryBytesToView } from './decode';

let mockSummary: object;
let mockExecuted: object;
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionSummary: { deserialize: () => mockSummary },
  TransactionResult: { deserialize: () => ({ executedTransaction: () => mockExecuted }) }
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: (id: string) => `bech32:${id}`,
  canonicalWalletAccountId: (id: string) => id
}));
jest.mock('lib/miden/sdk/nft-asset', () => ({ toNft: jest.fn(), nftKey: jest.fn() }));
jest.mock('lib/shared/helpers', () => ({ b64ToU8: () => new Uint8Array([1]) }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => 'bech32:native',
  getVerificationBaseFeeSync: () => 2
}));
jest.mock('lib/miden/sdk/fee-sponsorship', () => ({ canonicalFeeSponsorshipNoteId: jest.fn() }));

const asset = (amount: bigint) => ({ faucetId: () => 'native', amount: () => amount });
const note = (id: string, amount: bigint, tag = 0) => ({
  id: () => ({ toString: () => id }),
  assets: () => ({ fungibleAssets: () => [asset(amount)], nonFungibleAssets: () => [] }),
  metadata: () => ({ tag: () => ({ asU32: () => tag }) })
});
let mockOutputs: ReturnType<typeof note>[];
const approval: UsdcxSponsorshipApproval = {
  accountId: 'bech32:acct',
  faucetId: 'bech32:native',
  noteId: 'burn',
  budget: { faucetId: 'bech32:native', maxAmount: '5', scope: 'already-validated-source' }
};
const caught = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (error) {
    return error;
  }
};

beforeEach(() => {
  jest.mocked(canonicalFeeSponsorshipNoteId).mockReset().mockReturnValue('companion');
  mockOutputs = [note('burn', 100n), note('companion', 3n), note('kernel', 2n, 0xfee)];
  const inputs = { numNotes: () => 0, notes: () => [] };
  const outputs = { notes: () => mockOutputs };
  const storage = { isEmpty: () => true };
  mockSummary = {
    accountDelta: () => ({
      id: () => 'acct',
      storage: () => storage,
      vault: () => ({ removedFungibleAssets: () => [asset(105n)], addedFungibleAssets: () => [], numAssets: () => 1 })
    }),
    inputNotes: () => inputs,
    outputNotes: () => outputs
  };
  mockExecuted = {
    accountId: () => 'acct',
    inputNotes: () => inputs,
    outputNotes: () => outputs,
    accountPatch: () => ({ storage: () => storage })
  };
});

test('both paths keep the approved principal and report the same total native fee', () => {
  for (const view of [summaryBytesToView('bytes', approval), executedBytesToView('bytes', approval)]) {
    expect(view.outgoing).toEqual([{ faucetId: 'bech32:native', amount: 100n }]);
    expect(view.fee).toEqual({ faucetId: 'bech32:native', amount: 5n });
    expect(view.outputNotesCreated).toBe(1);
    expect(view.createdNotes?.map(created => created.id)).toEqual(['burn']);
  }
});

test('neither path grants this exception without recorded route approval', () => {
  for (const view of [summaryBytesToView('bytes'), executedBytesToView('bytes')]) {
    expect(view.outgoing.reduce((sum, item) => sum + item.amount, 0n)).toBe(103n);
    expect(view.fee?.amount).toBe(2n);
    expect(view.outputNotesCreated).toBe(2);
  }
});

test('neither path hides an unrecognized companion under a large fee budget', () => {
  mockOutputs[1] = note('wrong-script-or-metadata', 3n);
  const larger = { ...approval, budget: { ...approval.budget, maxAmount: '1000' } };
  for (const view of [summaryBytesToView('bytes', larger), executedBytesToView('bytes', larger)]) {
    expect(view.outgoing.reduce((sum, item) => sum + item.amount, 0n)).toBe(103n);
    expect(view.outputNotesCreated).toBe(2);
    expect(view.fee?.amount).toBe(2n);
  }
});

test('both paths reject a combined fee above the reviewed cap', () => {
  const smaller = { ...approval, budget: { ...approval.budget, maxAmount: '4' } };
  expect(() => summaryBytesToView('bytes', smaller)).toThrow();
  expect(() => executedBytesToView('bytes', smaller)).toThrow();
});

test('neither path converts a reconstruction trap into approval', () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  jest.mocked(canonicalFeeSponsorshipNoteId).mockImplementation(() => {
    throw trap;
  });
  expect(caught(() => summaryBytesToView('bytes', approval))).toBe(trap);
  expect(caught(() => executedBytesToView('bytes', approval))).toBe(trap);
});
