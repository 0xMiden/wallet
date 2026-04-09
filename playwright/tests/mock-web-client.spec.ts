import { WalletType } from 'screens/onboarding/types';

import { expect, test as base } from '../fixtures/mockWebClient';

const TEST_SEED = new Uint8Array(Array.from({ length: 32 }, (_, idx) => idx + 1));

const test = base.extend({
  mockWebClient: async ({ sdk }: any, use: any) => {
    const client = await sdk.MockWebClient.createClient(undefined, undefined, TEST_SEED);
    await use(client);
    // See fixtures/mockWebClient.ts — 0.13.3's Proxy classifier throws
    // on `client.free()` so we reach the wasm-bindgen destructor via
    // the underlying wasmWebClient field directly.
    const inner = (client as any).wasmWebClient;
    if (inner && typeof inner.free === 'function') {
      inner.free();
    }
  }
});

test('creates a wallet and syncs state via MockWebClient', async ({ sdk, mockWebClient }) => {
  const accountStorageMode =
    WalletType.OnChain === WalletType.OnChain ? sdk.AccountStorageMode.public() : sdk.AccountStorageMode.private();

  const wallet = await mockWebClient.newWallet(accountStorageMode, true, 0, TEST_SEED);
  const walletAddress = sdk.Address.fromAccountId(wallet.id(), 'BasicWallet').toBech32(sdk.NetworkId.testnet());
  expect(walletAddress).toBeTruthy();

  const syncSummary = await mockWebClient.syncState();
  expect(syncSummary.blockNum()).toBeGreaterThanOrEqual(0);

  const accounts = await mockWebClient.getAccounts();
  const accountIds = accounts.map((account: any) =>
    sdk.Address.fromAccountId(account.id(), 'BasicWallet').toBech32(sdk.NetworkId.testnet())
  );
  expect(accountIds).toContain(walletAddress);
});
