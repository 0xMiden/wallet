/** @jest-environment node */
import type { AssetAmount, ViewNote } from 'app/confirm/decode';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import { canonicalFeeSponsorshipNoteId } from 'lib/miden/sdk/fee-sponsorship';

import { currentUsdcxFeeScope } from './fee-scope';
import { partitionApprovedUsdcxSponsorship, usdcxSponsorshipApprovalOf } from './sponsorship';

let mockScope = 'rpc-a|testnet';
let mockNative: string | null = 'bech32:usdcx';
let mockSynced: string | null = 'bech32:usdcx';
jest.mock('lib/miden-chain/native-asset', () => ({
  cacheScope: () => mockScope,
  getNativeAssetIdSync: () => mockNative,
  getSdkSyncedNativeAssetIdSync: () => mockSynced
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  canonicalWalletAccountId: (id: string) => id.replace(/^bech32:/, 'hex:')
}));
jest.mock('lib/miden/sdk/fee-sponsorship', () => ({ canonicalFeeSponsorshipNoteId: jest.fn() }));

const SCOPE = '0eab4363008ac48565a556005f9429c4a85838ec79dc00c463d15dcbb4c14c5c';
const row = (maxAmount = '300'): ITransaction => ({
  id: 'row',
  type: 'bridged-send',
  accountId: 'acct',
  amount: 100n,
  faucetId: 'bech32:usdcx',
  approvedOutputNoteIds: ['burn'],
  status: ITransactionStatus.GeneratingTransaction,
  initiatedAt: 0,
  displayIcon: 'DEFAULT',
  extraInputs: {
    provider: 'usdcx',
    usdcxBurn: {
      noteId: 'burn',
      destinationDomain: 6,
      phase: 'pending',
      networkFeeBudget: { faucetId: 'bech32:usdcx', maxAmount, scope: SCOPE }
    }
  }
});
const burn: ViewNote = { id: 'burn', amounts: [{ faucetId: 'bech32:usdcx', amount: 100n }], nfts: [] };
const sponsor: ViewNote = { id: 'sponsor', amounts: [{ faucetId: 'bech32:usdcx', amount: 119n }], nfts: [] };
const kernel: AssetAmount = { faucetId: 'bech32:usdcx', amount: 119n };
const partition = (notes = [burn, sponsor], fee: AssetAmount | undefined = kernel, maximum = '300') =>
  partitionApprovedUsdcxSponsorship(notes, fee, usdcxSponsorshipApprovalOf(row(maximum)));

beforeEach(() => {
  mockScope = 'rpc-a|testnet';
  mockNative = 'bech32:usdcx';
  mockSynced = 'bech32:usdcx';
  jest.mocked(canonicalFeeSponsorshipNoteId).mockReset().mockReturnValue('sponsor');
});

test('fingerprints the complete source scope without storing its RPC URL', () => {
  expect(currentUsdcxFeeScope()).toBe(SCOPE);
});

test('excludes only the exact canonical companion and records both native fees', () => {
  expect(partition()).toEqual({ createdNotes: [burn], fee: { ...kernel, amount: 238n } });
  expect(canonicalFeeSponsorshipNoteId).toHaveBeenCalledWith(
    {
      senderAccountId: 'acct',
      targetAccountId: 'hex:usdcx',
      featureNoteId: 'burn',
      feeFaucetId: 'hex:usdcx'
    },
    119n
  );
});

test('counts sponsorship even without an ordinary verification fee', () => {
  const result = partitionApprovedUsdcxSponsorship([burn, sponsor], undefined, usdcxSponsorshipApprovalOf(row('119')));
  expect(result).toEqual({ createdNotes: [burn], fee: kernel });
});

test('permits a genuinely free burn with a zero cap', () => {
  expect(partitionApprovedUsdcxSponsorship([burn], undefined, usdcxSponsorshipApprovalOf(row('0')))).toEqual({
    createdNotes: [burn],
    fee: undefined
  });
});

test('enforces the combined fee rather than two independent caps', () => {
  expect(() => partition([burn, sponsor], kernel, '237')).toThrow();
  expect(() => partition([burn], kernel, '118')).toThrow();
});

test('cannot turn an unknown extra note into a fee merely because it is small', () => {
  const unknown = { ...sponsor, id: 'wrong-root' };
  expect(partition([burn, unknown])).toEqual({ createdNotes: [burn, unknown], fee: kernel });
});

test('refuses two distinct canonical companions even when the cap would cover both', () => {
  jest.mocked(canonicalFeeSponsorshipNoteId).mockImplementation((_identity, amount) => `sponsor-${amount}`);
  const first = { ...sponsor, id: 'sponsor-119' };
  const second = { ...sponsor, id: 'sponsor-120', amounts: [{ ...kernel, amount: 120n }] };
  expect(() => partition([burn, first, second], kernel, '1000')).toThrow('ambiguous');
});

test('requires the approved burn alongside its companion', () => {
  expect(() => partition([sponsor])).toThrow();
});

test('leaves opaque, NFT, wrong-asset and malformed-amount notes visible to the effect guard', () => {
  const invalid: ViewNote[] = [
    { ...sponsor, opaque: true },
    { ...sponsor, nfts: [{ faucetId: 'nft', assetId: 'asset' }] },
    { ...sponsor, amounts: [] },
    { ...sponsor, amounts: [kernel, kernel] },
    { ...sponsor, amounts: [{ faucetId: 'other', amount: 119n }] },
    { ...sponsor, amounts: [{ ...kernel, amount: 0n }] },
    { ...sponsor, amounts: [{ ...kernel, amount: -1n }] }
  ];
  for (const note of invalid) expect(partition([burn, note])).toEqual({ createdNotes: [burn, note], fee: kernel });
});

test('does not apply this exception to other transaction types or unapproved notes', () => {
  expect(usdcxSponsorshipApprovalOf({ ...row(), type: 'send' })).toBeUndefined();
  expect(usdcxSponsorshipApprovalOf({ ...row(), approvedOutputNoteIds: [] })).toBeUndefined();
  expect(partitionApprovedUsdcxSponsorship([burn, sponsor], kernel, undefined)).toEqual({
    createdNotes: [burn, sponsor],
    fee: kernel
  });
});

test.each(['', '-1', '1.5', 'NaN', '0002', '99999999999999999999'])('refuses malformed budget %s', maximum => {
  expect(() => usdcxSponsorshipApprovalOf(row(maximum))).toThrow();
});

test('requires the recorded approval and authoritative native identity in the current source scope', () => {
  const tx = row();
  const metadata = tx.extraInputs?.usdcxBurn;
  if (!metadata) throw new Error('missing test burn');
  Reflect.deleteProperty(metadata, 'networkFeeBudget');
  expect(() => usdcxSponsorshipApprovalOf(tx)).toThrow();
  mockScope = 'rpc-b|testnet';
  expect(() => usdcxSponsorshipApprovalOf(row())).toThrow();
  mockScope = 'rpc-a|testnet';
  mockNative = null;
  expect(() => usdcxSponsorshipApprovalOf(row())).toThrow();
  mockNative = 'other';
  expect(() => usdcxSponsorshipApprovalOf(row())).toThrow();
  mockNative = 'bech32:usdcx';
  mockSynced = null;
  expect(() => usdcxSponsorshipApprovalOf(row())).toThrow();
});

test('refuses a kernel fee in an asset outside the reviewed native budget', () => {
  expect(() => partition([burn], { faucetId: 'other', amount: 1n })).toThrow();
});

test('propagates a cryptographic WASM trap rather than forgiving the companion', () => {
  const trap = new WebAssembly.RuntimeError('unreachable');
  jest.mocked(canonicalFeeSponsorshipNoteId).mockImplementation(() => {
    throw trap;
  });
  expect(() => partition()).toThrow(trap);
});
