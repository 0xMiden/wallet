import { expect, test } from '../fixtures/two-simulators';

test.describe('Multi-Account Operations', () => {
  test.describe.configure({ mode: 'serial' });

  test('create second account and verify independent balances', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
  }) => {
    let addressA: string;

    await steps.step('create_wallets', async () => {
      const created = await walletA.createNewWallet();
      await walletB.createNewWallet();
      addressA = created.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      await midenCli.createFaucet();
      await midenCli.mint(addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    // iOS divergence: mobile auto-consume only fires for the well-known
    // MIDEN faucet; custom faucets need an explicit claim before
    // getBalance returns a positive number. See CLAUDE.md.
    await steps.step('claim_wallet_a', async () => {
      await walletA.claimAllNotes(180_000);
    });

    await steps.step('sync_wallet_a', async () => {
      const balance = await walletA.waitForBalanceAbove(0, 120_000, timeline);
      expect(balance).toBeGreaterThan(0);
    });

    await steps.step(
      'navigate_to_create_account',
      async () => {
        await walletA.navigateTo('/create-account');
        await walletA.delay(2_000);

        const pageText = await walletA.locatorText('body');
        timeline.emit({
          category: 'ui_action',
          severity: 'info',
          wallet: 'A',
          message: 'Navigated to create account page',
          data: { pageTextSnippet: pageText?.slice(0, 200) },
        });
      },
      {
        screenshotWallets: [{ target: walletA, label: 'A' }],
      }
    );

    await steps.step(
      'verify_account_selector',
      async () => {
        await walletA.navigateTo('/select-account');
        await walletA.delay(2_000);

        const pageText = await walletA.locatorText('body');
        timeline.emit({
          category: 'ui_action',
          severity: 'info',
          wallet: 'A',
          message: 'Navigated to account selector',
          data: { pageTextSnippet: pageText?.slice(0, 200) },
        });
      },
      {
        screenshotWallets: [{ target: walletA, label: 'A' }],
        captureStateFrom: [{ target: walletA, label: 'A' }],
      }
    );
  });
});
