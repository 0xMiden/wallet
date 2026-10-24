import {
  assertSwapAccountBalance,
  assertSwapFeeContextMatches,
  assertSwapVaultBalance,
  readSwapFeeContext
} from './balance';

let mockHeld = 0n;
let mockFeeHeld = 100n;
let mockFee: number | null = 1;
let mockScope = 'testnet|rpc';
let mockMissing = false;
let mockAccountId = 'account';
let mockFeeFaucetId: string | undefined;
let mockVaultAssets: Array<{ faucetId: () => string; amount: () => bigint }> | null = null;
const mockGetAccount = jest.fn(async (_accountId: string) =>
  mockMissing
    ? undefined
    : {
        id: () => mockAccountId,
        vault: () => ({
          fungibleAssets: () =>
            mockVaultAssets ?? [
              { faucetId: () => 'pay', amount: () => mockHeld },
              { faucetId: () => 'native', amount: () => mockFeeHeld }
            ]
        })
      }
);
jest.mock('lib/i18n/core', () => ({ getMessage: (key: string) => key }));
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: { getAccount: (accountId: string) => mockGetAccount(accountId) }
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  getBech32AddressFromAccountId: (id: string) => id,
  sameWalletAccountId: (a: string, b: string) => a === b
}));
jest.mock('./faucet-ids', () => ({ canonicalFaucetId: (id: string) => id }));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: (hold: object) => unknown) => fn({}),
  assertWasmHoldCurrent: jest.fn()
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  cacheScope: () => mockScope,
  getNativeAssetId: async () => mockFeeFaucetId ?? 'native',
  getNativeAssetIdSync: () => mockFeeFaucetId ?? 'native',
  getVerificationBaseFee: async () => mockFee,
  getVerificationBaseFeeSync: () => mockFee
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveFeeFaucetId: () => mockFeeFaucetId
}));

beforeEach(() => {
  mockAccountId = 'account';
  mockHeld = 100n;
  mockFeeHeld = 100n;
  mockFee = 1;
  mockScope = 'testnet|rpc';
  mockMissing = false;
  mockFeeFaucetId = undefined;
  mockVaultAssets = null;
  mockGetAccount.mockClear();
});
it('rejects a payment against zero actual vault even when the display cache says two tokens', async () => {
  mockHeld = 0n;
  await expect(assertSwapVaultBalance('account', 'pay', 40060070075077579n)).rejects.toThrow(
    'amountMustBeLessThanBalance'
  );
});
it('admits exact base-unit equality, refuses one more without Number rounding', async () => {
  mockHeld = 1000000000000000000n;
  await expect(assertSwapVaultBalance('account', 'pay', mockHeld)).resolves.toBeUndefined();
  await expect(assertSwapVaultBalance('account', 'pay', mockHeld + 1n)).rejects.toThrow('amountMustBeLessThanBalance');
});
it('reads the vault again after review rather than retaining the earlier balance', async () => {
  await expect(assertSwapVaultBalance('account', 'pay', 50n)).resolves.toBeUndefined();
  mockHeld = 49n;
  await expect(assertSwapVaultBalance('account', 'pay', 50n)).rejects.toThrow('amountMustBeLessThanBalance');
});
it('requires a fee asset for non-native offers', async () => {
  mockFeeHeld = 0n;
  await expect(assertSwapVaultBalance('account', 'pay', 1n)).rejects.toThrow('insufficientFeeAsset');
});
it('reserves thirty base fees when offering the native asset', async () => {
  mockFeeHeld = 100n;
  await expect(assertSwapVaultBalance('account', 'native', 70n)).resolves.toBeUndefined();
  await expect(assertSwapVaultBalance('account', 'native', 71n)).rejects.toThrow('amountMustBeLessThanBalance');
});
it('rejects an offer whose balance is split across separate vault slots', async () => {
  mockVaultAssets = [
    { faucetId: () => 'pay', amount: () => 60n },
    { faucetId: () => 'pay', amount: () => 40n },
    { faucetId: () => 'native', amount: () => 100n }
  ];

  await expect(assertSwapVaultBalance('account', 'pay', 100n)).rejects.toThrow('amountMustBeLessThanBalance');
});
it('applies the native reserve to the slot selected for the offered amount', async () => {
  mockVaultAssets = [
    { faucetId: () => 'native', amount: () => 100n },
    { faucetId: () => 'native', amount: () => 200n }
  ];

  await expect(assertSwapVaultBalance('account', 'native', 71n)).rejects.toThrow('amountMustBeLessThanBalance');
});
it('allows a known zero-fee network', async () => {
  mockFee = 0;
  mockFeeHeld = 0n;
  await expect(assertSwapVaultBalance('account', 'pay', 100n)).resolves.toBeUndefined();
});
it('fails closed when the account or fee is unavailable', async () => {
  mockMissing = true;
  await expect(assertSwapVaultBalance('account', 'pay', 1n)).rejects.toThrow('swapBalanceUnavailable');
  mockMissing = false;
  mockFee = null;
  await expect(assertSwapVaultBalance('account', 'pay', 1n)).rejects.toThrow('swapBalanceUnavailable');
});
it('refuses a network change since review', async () => {
  await expect(assertSwapVaultBalance('account', 'pay', 1n, 'other|rpc')).rejects.toThrow('swapBalanceUnavailable');
});

it('refuses a returned vault belonging to a different account', async () => {
  mockAccountId = 'other';
  await expect(assertSwapVaultBalance('account', 'pay', 1n)).rejects.toThrow('swapBalanceUnavailable');
});
it('refuses a network switch while the SDK read is in flight', async () => {
  mockGetAccount.mockImplementationOnce(async () => {
    mockScope = 'other|rpc';
    return undefined;
  });
  await expect(assertSwapVaultBalance('account', 'pay', 1n)).rejects.toThrow('swapBalanceUnavailable');
});

it('rejects a fee context when the active fee faucet changes before swap execution', async () => {
  mockFeeFaucetId = 'fee-a';
  const fee = await readSwapFeeContext();
  mockFeeFaucetId = 'fee-b';
  const account = {
    id: () => 'account',
    vault: () => ({
      fungibleAssets: () => [
        { faucetId: () => 'fee-a', amount: () => 100n },
        { faucetId: () => 'pay', amount: () => 100n }
      ]
    })
  };

  expect(() => assertSwapAccountBalance(account as any, 'account', 'pay', 1n, fee)).toThrow('swapBalanceUnavailable');
});

it('rejects a fee context from a different queued balance scope', async () => {
  const fee = await readSwapFeeContext();
  const account = {
    id: () => 'account',
    vault: () => ({ fungibleAssets: () => [{ faucetId: () => 'native', amount: () => 100n }] })
  };

  expect(() => assertSwapAccountBalance(account as any, 'account', 'pay', 1n, fee, 'other|rpc')).toThrow(
    'swapBalanceUnavailable'
  );
});

it('rejects a base fee that changes after balance context discovery', async () => {
  const fee = await readSwapFeeContext();
  mockFee = 2;
  const account = {
    id: () => 'account',
    vault: () => ({ fungibleAssets: () => [{ faucetId: () => 'native', amount: () => 100n }] })
  };

  expect(() => assertSwapAccountBalance(account as any, 'account', 'pay', 1n, fee)).toThrow('swapBalanceUnavailable');
});

it('requires the queued fee asset identity to match the fresh offscreen context', () => {
  const queued = {
    scope: 'testnet|rpc',
    nativeAssetId: 'native-a',
    feeFaucetId: null,
    baseFee: 1n
  };
  const changedNativeAsset = { ...queued, nativeAssetId: 'native-b' };
  const changedOverride = { ...queued, feeFaucetId: 'override-b' };

  expect(() => assertSwapFeeContextMatches(queued, changedNativeAsset)).toThrow('swapBalanceUnavailable');
  expect(() => assertSwapFeeContextMatches(queued, changedOverride)).toThrow('swapBalanceUnavailable');
});

it('rejects a changed base fee when the queued fee asset identity still matches', () => {
  const queued = {
    scope: 'testnet|rpc',
    nativeAssetId: 'native',
    feeFaucetId: null,
    baseFee: 1n
  };
  const current = { ...queued, baseFee: 9n };

  expect(() => assertSwapFeeContextMatches(queued, current)).toThrow('swapBalanceUnavailable');
});
