import { expect, test } from '../fixtures/two-wallets';

test.describe('Public Note Send', () => {
  test.describe.configure({ mode: 'serial' });

  test('wallet A sends tokens publicly to wallet B', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
  }) => {
    let addressA: string;
    let addressB: string;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      await midenCli.createFaucet();
      await midenCli.mint(addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('sync_wallet_a', async () => {
      const balance = await walletA.waitForBalanceAbove(0, 120_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [{ page: walletA.page, label: 'A', extensionId: walletA.extensionId }],
    });

    await steps.step('send_public_note_a_to_b', async () => {
      await walletA.sendTokens({
        recipientAddress: addressB!,
        amount: '500',
        isPrivate: false,
      });
    }, {
      screenshotWallets: [{ page: walletA.page, label: 'A' }],
    });

    await steps.step('verify_receipt_wallet_b', async () => {
      const balance = await walletB.waitForBalanceAbove(0, 180_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [
        { page: walletA.page, label: 'A', extensionId: walletA.extensionId },
        { page: walletB.page, label: 'B', extensionId: walletB.extensionId },
      ],
      screenshotWallets: [
        { page: walletA.page, label: 'A' },
        { page: walletB.page, label: 'B' },
      ],
    });
  });
});
