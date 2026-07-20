import { expect, test } from '../../fixtures/two-wallets';
import { fundSwapPair } from '../../helpers/swap';

/**
 * Scenario 3.7 — create-side guards.
 *
 * The swap-create review button (`swap-review-submit`) is gated by
 * `canProceed = !sameToken && hasOfferAmount && !offerAmountExceedsBalance &&
 * requestAmount > 0`. Drives the real form and asserts the button tracks those
 * guards — no order is ever submitted.
 */
test.describe('swap: create-side guards', () => {
  test.describe.configure({ mode: 'serial' });

  test('review is gated by balance and a non-zero requested amount', async ({
    walletA,
    walletB,
    midenCli,
    timeline
  }) => {
    await walletA.createNewWallet();
    await walletB.createNewWallet();

    // A funded with 1000 SWPA (fundSwapPair default); registry + price feed set.
    await fundSwapPair(midenCli, walletA, walletB, { offerSymbol: 'SWPA', requestSymbol: 'SWPB' }, timeline);

    const { page, extensionId } = walletA;
    await page.goto(`chrome-extension://${extensionId}/fullpage.html#/swap`);
    await expect(page.getByTestId('swap-flow')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('send-token-selector').first().click();
    await page.getByTestId('swap-token-SWPA').click();
    await page.getByTestId('send-token-selector').nth(1).click();
    await page.getByTestId('swap-token-SWPB').click();

    const review = page.getByTestId('swap-review-submit');
    const offerInput = page.getByTestId('send-amount-input').first();
    const requestInput = page.getByTestId('send-amount-input').nth(1);

    // Guard 1: offer amount exceeds the 1000-SWPA balance -> disabled.
    await offerInput.fill('5000');
    await requestInput.fill('9');
    await expect(review).toBeDisabled();

    // Guard 2: within balance + non-zero request -> enabled.
    await offerInput.fill('5');
    await requestInput.fill('4');
    await expect(review).toBeEnabled();

    // Guard 3: zero requested amount -> disabled again.
    await requestInput.fill('0');
    await expect(review).toBeDisabled();
  });
});
