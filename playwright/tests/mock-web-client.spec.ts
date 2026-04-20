import { expect, test as base } from '../fixtures/mockWebClient';

const TEST_SEED = new Uint8Array(Array.from({ length: 32 }, (_, idx) => idx + 1));

const test = base.extend({
  mockClient: async ({ sdk }: any, use: any) => {
    const client = await sdk.MidenClient.createMock({ seed: TEST_SEED });
    await use(client);
    client.terminate();
  }
});

test('creates a wallet and syncs state via MidenClient.createMock', async ({ sdk, mockClient }) => {
  // Defaults to a mutable wallet when `type` is omitted.
  const wallet = await mockClient.accounts.create({
    storage: sdk.StorageMode.Public,
    seed: TEST_SEED
  });

  const walletAddress = sdk.Address.fromAccountId(wallet.id(), 'BasicWallet').toBech32(sdk.NetworkId.testnet());
  expect(walletAddress).toBeTruthy();

  const syncSummary = await mockClient.sync();
  expect(syncSummary.blockNum()).toBeGreaterThanOrEqual(0);

  const accounts = await mockClient.accounts.list();
  const accountIds = accounts.map((account: any) =>
    sdk.Address.fromAccountId(account.id(), 'BasicWallet').toBech32(sdk.NetworkId.testnet())
  );
  expect(accountIds).toContain(walletAddress);
});
