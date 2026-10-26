import { assertSwapVaultBalance } from './balance';

let mockAssets: Array<{ faucetId: () => string; amount: () => bigint }> = [];
let mockScope = 'testnet|rpc';
jest.mock('lib/i18n/core', () => ({ getMessage: (key: string) => key }));
jest.mock('lib/miden/back/miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: async () => ({
      id: () => 'account',
      vault: () => ({ fungibleAssets: () => mockAssets })
    })
  }
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
  getNativeAssetIdSync: () => 'native',
  getVerificationBaseFee: async () => 1,
  getVerificationBaseFeeSync: () => 1
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveFeeFaucetId: () => undefined }));

beforeEach(() => {
  mockAssets = [];
  mockScope = 'testnet|rpc';
});

it('rejects an offer whose balance is split across separate vault slots', async () => {
  mockAssets = [
    { faucetId: () => 'pay', amount: () => 60n },
    { faucetId: () => 'pay', amount: () => 40n },
    { faucetId: () => 'native', amount: () => 100n }
  ];

  await expect(assertSwapVaultBalance('account', 'pay', 100n)).rejects.toThrow('amountMustBeLessThanBalance');
});

it('applies the native reserve to the slot selected for the offered amount', async () => {
  mockAssets = [
    { faucetId: () => 'native', amount: () => 100n },
    { faucetId: () => 'native', amount: () => 200n }
  ];

  await expect(assertSwapVaultBalance('account', 'native', 71n)).rejects.toThrow('amountMustBeLessThanBalance');
});
