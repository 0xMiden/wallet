import { expect, test } from '../fixtures/two-simulators';

test.describe('Private Note Send', () => {
  test.describe.configure({ mode: 'serial' });

  test('wallet A sends tokens privately to wallet B via transport layer', async ({
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
    });

    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(120_000);
    });

    await steps.step('send_private_note_a_to_b', async () => {
      await walletA.sendTokens({
        recipientAddress: addressB!,
        amount: '500',
        isPrivate: true, // Private payment toggle ON
      });
    }, {
      screenshotWallets: [{ target: walletA, label: 'A' }],
    });

    await steps.step('verify_receipt_wallet_b_via_transport', async () => {
      // Private notes are delivered via the note transport layer.
      // Wallet B syncs and discovers the private note automatically.
      const balance = await walletB.waitForBalanceAbove(0, 180_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [
        { target: walletA, label: 'A' },
        { target: walletB, label: 'B' },
      ],
      screenshotWallets: [
        { target: walletA, label: 'A' },
        { target: walletB, label: 'B' },
      ],
    });
  });
});
