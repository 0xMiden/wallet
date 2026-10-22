import type { IntentQuoteResult } from '@epoch-protocol/epoch-intents-sdk';

import {
  getNativeAssetId,
  getNativeAssetMetadata,
  captureNativeAssetSnapshot,
  type NativeAssetChainMetadata
} from 'lib/miden-chain/native-asset';

import {
  quoteEarnWithdrawal,
  assertWithdrawalReviewCurrent,
  assertWithdrawalDelivery,
  assertWithdrawalAllocations
} from './earn-withdraw-quote';
import { fetchEarnPositions } from './positions';

jest.mock('./client', () => ({ buildEpochReadOnlyWalletClient: jest.fn() }));
jest.mock('./bridge', () => ({ normalizeMidenIdToHex: (v: string) => v }));
jest.mock('./positions', () => ({ fetchEarnPositions: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn().mockResolvedValue('0x4cbdcaffe75f0a317482224dae6436'),
  getNativeAssetMetadata: jest.fn().mockResolvedValue({ symbol: 'USDCX', decimals: 6 }),
  cacheScope: () => 'testnet',
  captureNativeAssetSnapshot: jest.fn(() => ({ scope: 'testnet', revision: 1 }))
}));
jest.mock('lib/remote-config/values', () => ({
  getEpochAllocatorUrl: () => 'https://allocator.example',
  getEarnMarket: () => ({
    marketUid: 'DUMMY_LENDING:11155111:0x1111111111111111111111111111111111111111',
    chainId: 11155111
  })
}));
const token = '0x1111111111111111111111111111111111111111';
const position = {
  owner: token,
  marketUid: `DUMMY_LENDING:11155111:${token}`,
  underlyingAddress: token,
  decimals: 18,
  withdrawable: '10'
};
const args = { position, amount: '1.000000000000000001', accountId: 'miden' };
const getTaskData = jest.fn();
const getIntentQuote = jest.fn<Promise<IntentQuoteResult>, []>();
const sdk = { getTaskData, getIntentQuote };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(captureNativeAssetSnapshot).mockReturnValue({ scope: 'testnet', revision: 1 });
  jest.mocked(getNativeAssetMetadata).mockReset().mockResolvedValue({ symbol: 'USDCX', decimals: 6 });
  getTaskData.mockImplementation(async p => ({ taskTypeString: 'task', intentData: p.intentData }));
  getIntentQuote.mockResolvedValue({ success: true, tokenOut: '991822', transactions: [], resourceLockRequired: true });
  jest.mocked(fetchEarnPositions).mockResolvedValue({
    positions: [
      {
        ...position,
        symbol: 'USDC',
        lenderKey: 'DUMMY_LENDING',
        lenderName: 'Dummy',
        chainId: '11155111',
        deposits: '10',
        depositsUSD: 10,
        depositApr: 2,
        priceUsd: 1
      }
    ],
    owners: [token],
    vaults: [],
    totalDepositsUSD: 10,
    errors: []
  });
});

it('quotes the exact underlying amount, preserving native payout identity and a positive 1% floor', async () => {
  const q = await quoteEarnWithdrawal(args, sdk);
  expect(getTaskData.mock.calls[0]?.[0].intentData.tokenInAmount).toBe('1000000000000000001');
  expect(q).toMatchObject({
    amount: args.amount,
    amountAtomic: '1000000000000000001',
    expectedAtomic: '991822',
    minimumAtomic: '981903',
    destinationDecimals: 6,
    destinationSymbol: 'USDCX'
  });
  await expect(assertWithdrawalReviewCurrent(q)).resolves.toBeUndefined();
});
it.each(['0', '1', undefined])('refuses a missing, zero, or zero-floor payout %p', async out => {
  getIntentQuote.mockResolvedValue({ success: true, tokenOut: out, transactions: [], resourceLockRequired: true });
  await expect(quoteEarnWithdrawal(args, sdk)).rejects.toThrow('earnWithdrawQuoteUnavailable');
});
it('refuses an unsuccessful quote', async () => {
  getIntentQuote.mockResolvedValue({ success: false, tokenOut: '100', transactions: [], resourceLockRequired: true });
  await expect(quoteEarnWithdrawal(args, sdk)).rejects.toThrow(new Error('earnWithdrawQuoteUnavailable'));
});
const unusableMetadata: Array<[string, NativeAssetChainMetadata | null]> = [
  ['no metadata', null],
  ['an unknown scale', { symbol: 'USDCX', decimals: 6, scaleIsUnknown: true }],
  ['fractional decimals', { symbol: 'USDCX', decimals: 6.5 }],
  ['negative decimals', { symbol: 'USDCX', decimals: -1 }],
  ['decimals above 12', { symbol: 'USDCX', decimals: 13 }],
  ['no symbol', { symbol: '', decimals: 6 }]
];
it.each(unusableMetadata)('refuses a successful quote when the native asset has %s', async (_case, metadata) => {
  jest.mocked(getNativeAssetMetadata).mockResolvedValue(metadata);
  await expect(quoteEarnWithdrawal(args, sdk)).rejects.toThrow(new Error('earnWithdrawQuoteUnavailable'));
});
const withWithdrawable = (withdrawable: string) => {
  const read = jest.mocked(fetchEarnPositions).getMockImplementation();
  if (!read) throw new Error('the positions read has no implementation');
  jest.mocked(fetchEarnPositions).mockImplementationOnce(async request => {
    const fresh = await read(request);
    return { ...fresh, positions: fresh.positions.map(p => ({ ...p, withdrawable })) };
  });
};
it.each([
  ['rose', '40'],
  ['fell but still covers the reviewed amount', '2'],
  ['equals the reviewed amount', '1.000000000000000001']
])('keeps a review whose availability %s', async (_case, withdrawable) => {
  const q = await quoteEarnWithdrawal(args, sdk);
  withWithdrawable(withdrawable);
  await expect(assertWithdrawalReviewCurrent(q)).resolves.toBeUndefined();
});
it('requires refresh once availability falls below the reviewed amount', async () => {
  const q = await quoteEarnWithdrawal(args, sdk);
  withWithdrawable('1');
  await expect(assertWithdrawalReviewCurrent(q)).rejects.toThrow('earnWithdrawRefresh');
});
it('requires refresh on expiry, a malformed reviewed amount, payout identity or failed position read', async () => {
  const q = await quoteEarnWithdrawal(args, sdk);
  await expect(assertWithdrawalReviewCurrent({ ...q, expiresAt: 0 })).rejects.toThrow('earnWithdrawRefresh');
  await expect(assertWithdrawalReviewCurrent({ ...q, amountAtomic: '1e18' })).rejects.toThrow('earnWithdrawRefresh');
  jest.mocked(getNativeAssetId).mockResolvedValueOnce('different');
  await expect(assertWithdrawalReviewCurrent(q)).rejects.toThrow('earnWithdrawRefresh');
  jest.mocked(fetchEarnPositions).mockResolvedValueOnce({
    positions: [],
    owners: [token],
    vaults: [],
    totalDepositsUSD: 0,
    errors: [{ owner: token, error: 'offline' }]
  });
  await expect(assertWithdrawalReviewCurrent(q)).rejects.toThrow('earnWithdrawRefresh');
});
it('reads the fresh position without the vault catalogue', async () => {
  const q = await quoteEarnWithdrawal(args, sdk);
  await assertWithdrawalReviewCurrent(q);
  expect(fetchEarnPositions).toHaveBeenCalledWith({ accountId: 'miden', owners: [token], skipCatalog: true });
});
it("accepts a position in any market on the route's chain, and refuses one on another chain", async () => {
  // A market of another lender than the default market, on the default market's chain.
  const otherMarket = { ...position, marketUid: `MORPHO_BLUE_${'ab'.repeat(32)}:11155111:${token}` };
  jest.mocked(fetchEarnPositions).mockResolvedValue({
    positions: [
      {
        ...otherMarket,
        symbol: 'USDC',
        lenderKey: `MORPHO_BLUE_${'ab'.repeat(32)}`,
        lenderName: 'Morpho',
        chainId: '11155111',
        deposits: '10',
        depositsUSD: 10,
        depositApr: 2,
        priceUsd: 1
      }
    ],
    owners: [token],
    vaults: [],
    totalDepositsUSD: 10,
    errors: []
  });
  const q = await quoteEarnWithdrawal({ ...args, position: otherMarket }, sdk);
  await expect(assertWithdrawalReviewCurrent(q)).resolves.toBeUndefined();

  const offRoute = { ...q, position: { ...q.position, marketUid: `MORPHO_BLUE_${'ab'.repeat(32)}:8453:${token}` } };
  await expect(assertWithdrawalReviewCurrent(offRoute)).rejects.toThrow('earnWithdrawRefresh');
});
it('binds the prepared delivery to the reviewed source amount, underlying and minimum', async () => {
  const q = await quoteEarnWithdrawal(args, sdk);
  const mandate = { tokenIn: token, tokenInAmount: q.amountAtomic, minTokenOut: q.minimumAtomic };
  expect(() => assertWithdrawalDelivery(q, mandate)).not.toThrow();
  for (const bad of [
    { ...mandate, tokenInAmount: '2' },
    { ...mandate, tokenIn: 'wrong' },
    { ...mandate, minTokenOut: '0' }
  ]) {
    expect(() => assertWithdrawalDelivery(q, bad)).toThrow('earnWithdrawRefresh');
  }
});
it('binds every allocation: one withdraw leg for the reviewed input and the delivery', async () => {
  const q = await quoteEarnWithdrawal(args, sdk);
  const leg = { tokenIn: token, tokenInAmount: q.amountAtomic, minTokenOut: '0' };
  const delivery = { ...leg, minTokenOut: q.minimumAtomic };
  expect(() => assertWithdrawalAllocations(q, [leg, delivery], 1)).not.toThrow();
  const refused: Array<[Array<typeof leg | undefined>, number]> = [
    [[leg, delivery], 2],
    [[undefined, delivery], 1],
    [[delivery], 0],
    [[leg, leg, delivery], 2],
    [[{ ...leg, tokenInAmount: '2' }, delivery], 1],
    [[leg, { ...delivery, minTokenOut: '0' }], 1]
  ];
  for (const [mandates, deliveryIndex] of refused) {
    expect(() => assertWithdrawalAllocations(q, mandates, deliveryIndex)).toThrow(new Error('earnWithdrawRefresh'));
  }
});

it('accepts the first positive payout-floor boundary', async () => {
  getIntentQuote.mockResolvedValue({ success: true, tokenOut: '2', transactions: [], resourceLockRequired: true });
  expect((await quoteEarnWithdrawal(args, sdk)).minimumAtomic).toBe('1');
});
it('refuses a quote for another input amount or scale', async () => {
  getIntentQuote.mockResolvedValue({
    success: true,
    tokenIn: '2',
    tokenOut: '100',
    transactions: [],
    resourceLockRequired: true
  });
  await expect(quoteEarnWithdrawal(args, sdk)).rejects.toThrow('earnWithdrawQuoteUnavailable');
  getIntentQuote.mockResolvedValue({
    success: true,
    tokenInDecimals: 6,
    tokenOut: '100',
    transactions: [],
    resourceLockRequired: true
  });
  await expect(quoteEarnWithdrawal(args, sdk)).rejects.toThrow('earnWithdrawQuoteUnavailable');
});
it('accepts a quote for the reviewed input amount at the position scale', async () => {
  getIntentQuote.mockResolvedValue({
    success: true,
    tokenIn: '1000000000000000001',
    tokenInDecimals: 18,
    tokenOut: '991822',
    transactions: [],
    resourceLockRequired: true
  });
  await expect(quoteEarnWithdrawal(args, sdk)).resolves.toMatchObject({
    amountAtomic: '1000000000000000001',
    expectedAtomic: '991822',
    minimumAtomic: '981903'
  });
});

it('rejects a native-asset identity change while the fresh position read is pending', async () => {
  const q = await quoteEarnWithdrawal(args, sdk);
  const fresh = await fetchEarnPositions({ accountId: args.accountId, owners: [token] });
  jest.mocked(fetchEarnPositions).mockImplementationOnce(async () => {
    jest.mocked(captureNativeAssetSnapshot).mockReturnValue({ scope: 'testnet', revision: 2 });
    return fresh;
  });
  await expect(assertWithdrawalReviewCurrent(q)).rejects.toThrow('earnWithdrawRefresh');
});
it('rejects a native-asset identity change while the delivery quote is pending', async () => {
  getIntentQuote.mockImplementationOnce(async () => {
    jest.mocked(captureNativeAssetSnapshot).mockReturnValue({ scope: 'testnet', revision: 2 });
    return { success: true, tokenOut: '991822', transactions: [], resourceLockRequired: true };
  });
  await expect(quoteEarnWithdrawal(args, sdk)).rejects.toThrow('earnWithdrawQuoteUnavailable');
});
