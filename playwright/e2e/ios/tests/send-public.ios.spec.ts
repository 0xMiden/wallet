import { expect, test } from '../fixtures/two-simulators';

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

    // iOS divergence: claim before verifying balance — mobile's getBalance
    // only reads consumed balances from the store; it cannot see pending
    // notes the way Chrome's chrome.storage.local-backed getBalance can.
    // See CLAUDE.md "E2E iOS Simulator Test Harness" → "Empirical Status".
    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(180_000);
    });

    await steps.step('sync_wallet_a', async () => {
      const balance = await walletA.waitForBalanceAbove(0, 120_000, timeline);
      expect(balance).toBeGreaterThan(0);
    }, {
      captureStateFrom: [{ target: walletA, label: 'A' }],
    });

    await steps.step('send_public_note_a_to_b', async () => {
      await walletA.sendTokens({
        recipientAddress: addressB!,
        amount: '500',
        isPrivate: false,
      });
    }, {
      screenshotWallets: [{ target: walletA, label: 'A' }],
    });

    // iOS divergence: claim the received note on wallet B before checking
    // its balance — same reason as claim_notes_wallet_a above.
    await steps.step('claim_notes_wallet_b', async () => {
      await walletB.claimAllNotes(180_000);
    });

    await steps.step('verify_receipt_wallet_b', async () => {
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
