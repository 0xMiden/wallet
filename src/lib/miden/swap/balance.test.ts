import { assertSwapVaultBalance } from './balance';

let mockHeld = 0n;
let mockFeeHeld = 100n;
let mockFee: number | null = 1;
let mockScope = 'testnet|rpc';
let mockMissing = false;
let mockAccountId = 'account';
const mockGetAccount = jest.fn(async (_accountId: string) =>
  mockMissing
    ? undefined
    : {
        id: () => mockAccountId,
        vault: () => ({
          fungibleAssets: () => [
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
  getNativeAssetId: async () => 'native',
  getVerificationBaseFee: async () => mockFee
}));
beforeEach(() => {
  mockAccountId = 'account';
  mockHeld = 100n;
  mockFeeHeld = 100n;
  mockFee = 1;
  mockScope = 'testnet|rpc';
  mockMissing = false;
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
