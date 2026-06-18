import { expect, test } from '../fixtures/two-simulators';

test.describe('Wallet Lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  test('create two wallets and extract addresses', async ({ walletA, walletB, steps }) => {
    let addressA: string;
    let addressB: string;

    await steps.step('create_wallet_a', async () => {
      const result = await walletA.createNewWallet();
      addressA = result.address;
      expect(addressA).toBeTruthy();
      expect(addressA).toMatch(/^m(tst|dev)/); // bech32 testnet/devnet prefix
    });

    await steps.step('create_wallet_b', async () => {
      const result = await walletB.createNewWallet();
      addressB = result.address;
      expect(addressB).toBeTruthy();
      expect(addressB).toMatch(/^m(tst|dev)/);
    });

    await steps.step('verify_different_addresses', async () => {
      expect(addressA!).not.toBe(addressB!);
    });
  });

  test('lock and unlock wallet', async ({ walletA, steps }) => {
    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
    });

    await steps.step('lock_wallet', async () => {
      await walletA.lockWallet();
    });

    await steps.step('unlock_wallet', async () => {
      await walletA.unlockWallet();
      // Verify we're back on the Explore page
      await expect
        .poll(async () => (await walletA.locatorText('body'))?.includes('Send') ?? false, {
          timeout: 30_000,
        })
        .toBe(true);
    });
  });
});
