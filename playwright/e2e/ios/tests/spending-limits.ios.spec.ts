import { expect, test } from '../fixtures/two-simulators';

const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
const MINT_BASE_UNITS = 100_000_000_000;
const toBaseUnits = (amount: number): string => (BigInt(amount) * 10n ** BigInt(TOKEN_DECIMALS)).toString();

test.describe('Spending limits', () => {
  test.describe.configure({ mode: 'serial' });

  test('renders the configured policy and exact-authentication challenge', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }, testInfo) => {
    let addressA = '';
    let addressB = '';
    let faucetId = '';

    await steps.step('create_and_fund_wallets', async () => {
      addressA = (await walletA.createNewWallet()).address;
      addressB = (await walletB.createNewWallet()).address;
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
      await walletA.claimAllNotes(180_000, [faucetId]);
      expect(await walletA.waitForBalanceAbove(900, 120_000, timeline, TOKEN)).toBeGreaterThan(900);
    });

    await steps.step('over_limit_send_requires_exact_authentication', async () => {
      await walletA.configureSpendingLimitForTest({
        tokenSymbol: TOKEN,
        dailyLimitBaseUnits: toBaseUnits(100)
      });
      await walletA.prepareSendReview({
        recipientAddress: addressB,
        amount: '200',
        tokenSymbol: TOKEN,
        isPrivate: false
      });
      await walletA.click('[data-testid="send-review-submit"]');
      await walletA.waitFor('[data-slot="drawer-content"]', { timeoutMs: 30_000 });
      const challenge = await walletA.locatorText('[data-slot="drawer-content"]');
      expect(challenge).toContain('Spending limit exceeded');
      expect(challenge).toContain('To raise the limit, go to Settings > Spending limits.');
      await walletA.screenshot({ path: testInfo.outputPath('spending-limit-challenge-ios.png') });
      const cancelled = await walletA.evalJs<boolean>(
        `var button = Array.from(document.querySelectorAll('[data-slot="drawer-content"] button'))` +
          `.find(function (candidate) { return (candidate.textContent || '').trim() === 'Cancel'; }); ` +
          `if (!button) return false; button.click(); return true;`
      );
      expect(cancelled).toBe(true);
    });

    await steps.step('configured_policy_is_visible_in_settings', async () => {
      await walletA.navigateTo('/settings/spending-limits');
      await walletA.waitFor('[data-testid="spending-limits-settings"]', { timeoutMs: 30_000 });
      await expect
        .poll(() =>
          walletA.evalJs<string | null>(
            `var input = document.querySelector('input[aria-label="TST Rolling 24-hour limit"]'); ` +
              `return input ? input.value : null;`
          )
        )
        .toBe('100');
      await walletA.evalJs(
        `document.querySelector('input[aria-label="TST Rolling 24-hour limit"]')?.scrollIntoView(); return null;`
      );
      await walletA.screenshot({ path: testInfo.outputPath('spending-limit-settings-ios.png') });
    });
  });
});
