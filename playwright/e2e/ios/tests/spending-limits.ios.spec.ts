import { expect, test } from '../fixtures/two-simulators';
import { SPENDING_LIMIT_CHALLENGE } from '../../helpers/wallet-page';

const TOKEN = 'TST';
const MINT_BASE_UNITS = 100_000_000_000;

/**
 * The cap is one account-scoped figure in USD now, not a per-asset native-unit figure. The E2E
 * build prices the harness's own `TST` fixture faucet at exactly $1.00 per whole unit (see
 * `isE2eFixtureSymbol` in `src/lib/prices/usd.ts`), so the dollar figure below is numerically
 * identical to the native-unit figure it replaces.
 */
const USD_MICRO_SCALE = 1_000_000n;
const toUsdMicro = (dollars: number): string => (BigInt(dollars) * USD_MICRO_SCALE).toString();

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
        dailyLimitUsdMicro: toUsdMicro(100)
      });
      await walletA.prepareSendReview({
        recipientAddress: addressB,
        amount: '200',
        tokenSymbol: TOKEN,
        isPrivate: false
      });
      await walletA.click('[data-testid="send-review-submit"]');
      await walletA.waitFor(SPENDING_LIMIT_CHALLENGE, { timeoutMs: 30_000 });
      const challenge = await walletA.locatorText(SPENDING_LIMIT_CHALLENGE);
      expect(challenge).toContain('Spending limit exceeded');
      expect(challenge).toContain('To raise the limit, go to Settings > Spending limits.');
      await walletA.screenshot({ path: testInfo.outputPath('spending-limit-challenge-ios.png') });
      const cancelled = await walletA.evalJs<boolean>(
        `var button = Array.from(document.querySelectorAll('${SPENDING_LIMIT_CHALLENGE} button'))` +
          `.find(function (candidate) { return (candidate.textContent || '').trim() === 'Cancel'; }); ` +
          `if (!button) return false; button.click(); return true;`
      );
      expect(cancelled).toBe(true);
    });

    // One account-scoped USD cap now, not a per-asset input addressed by the token's own symbol.
    await steps.step('configured_policy_is_visible_in_settings', async () => {
      await walletA.navigateTo('/settings/spending-limits');
      await walletA.waitFor('[data-testid="spending-limits-settings"]', { timeoutMs: 30_000 });
      await expect
        .poll(() =>
          walletA.evalJs<string | null>(
            `var input = document.querySelector('input[aria-label="Daily limit (USD)"]'); ` +
              `return input ? input.value : null;`
          )
        )
        .toBe('100');
      await walletA.evalJs(
        `document.querySelector('input[aria-label="Daily limit (USD)"]')?.scrollIntoView(); return null;`
      );
      await walletA.screenshot({ path: testInfo.outputPath('spending-limit-settings-ios.png') });
    });
  });
});
