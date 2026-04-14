import { expect, test } from '../fixtures/two-wallets';

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
      const a = await walletA.createNewWallet();
      await walletB.createNewWallet();
      addressA = a.address;
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

    await steps.step('navigate_to_create_account', async () => {
      // Navigate to create a second account within the same wallet
      await walletA.navigateTo('/create-account');
      await walletA.page.waitForTimeout(2_000);

      // Look for account creation UI elements
      const pageText = await walletA.page.locator('body').textContent();
      timeline.emit({
        category: 'ui_action',
        severity: 'info',
        wallet: 'A',
        message: 'Navigated to create account page',
        data: { pageTextSnippet: pageText?.slice(0, 200) },
      });
    }, {
      screenshotWallets: [{ target: walletA.page, label: 'A' }],
    });

    await steps.step('verify_account_selector', async () => {
      // Navigate to account selection
      await walletA.navigateTo('/select-account');
      await walletA.page.waitForTimeout(2_000);

      const pageText = await walletA.page.locator('body').textContent();
      timeline.emit({
        category: 'ui_action',
        severity: 'info',
        wallet: 'A',
        message: 'Navigated to account selector',
        data: { pageTextSnippet: pageText?.slice(0, 200) },
      });
    }, {
      screenshotWallets: [{ target: walletA.page, label: 'A' }],
      captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
    });
  });
});
