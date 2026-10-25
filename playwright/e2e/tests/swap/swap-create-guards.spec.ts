import sharp from 'sharp';

import { IS_LOCALNET } from '../../config/environments';
import { expect, test } from '../../fixtures/two-wallets';
import { forgetFixtureConfig, setEligibilityFixtureConfig } from '../../helpers/feature-eligibility';
import { fundSwapPair } from '../../helpers/swap';

/** Exact receive and create-side guards, without submitting an order. */
test.describe('swap: create-side guards', () => {
  test.describe.configure({ mode: 'serial' });

  test('review is gated by balance and a non-zero requested amount', async ({
    walletA,
    walletB,
    midenCli,
    timeline
  }, info) => {
    const { page, extensionId } = walletA;
    const etaUrl = 'https://quotes.test';
    if (IS_LOCALNET) {
      await setEligibilityFixtureConfig({
        network: 'localnet',
        version: 1,
        features: { earn: false, nearIntents: false, fastBridge: false, bridgeIn: false, bridgeOut: false },
        swap: { etaUrl }
      });
      await forgetFixtureConfig(page, 'localnet');
    }
    // The solver lists nothing: fundSwapPair sets the registry through `__TEST_SET_SWAP_TOKENS__`.
    await page.route(`${etaUrl}/v2/pairs`, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
        body: JSON.stringify({ tokens: [], pairs: [] })
      })
    );
    let priceAvailable = false;
    await page.route(`${etaUrl}/v2/pair-price?**`, route =>
      route.fulfill({
        status: priceAvailable ? 200 : 503,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
        body: JSON.stringify(
          priceAvailable
            ? {
                offeredFaucet: new URL(route.request().url()).searchParams.get('offered_faucet'),
                requestedFaucet: new URL(route.request().url()).searchParams.get('requested_faucet'),
                marketPrice: '1',
                fillPrice: '1',
                feePpm: 0,
                offeredDecimals: 8,
                requestedDecimals: 8,
                asOf: Math.floor(Date.now() / 1000)
              }
            : { error: 'no_price', message: 'no valid price for this pair' }
        )
      })
    );
    await page.route(`${etaUrl}/v2/swap-eta?**`, route => {
      const query = new URL(route.request().url()).searchParams;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
        body: JSON.stringify({
          offeredFaucet: query.get('offered_faucet'),
          requestedFaucet: query.get('requested_faucet'),
          offeredAmount: query.get('offered_amount'),
          requestedAmount: query.get('requested_amount'),
          priceBand: 'at_market',
          fillStatus: 'full',
          reason: null,
          fillableOfferedAmount: query.get('offered_amount'),
          fillableRequestedAmount: query.get('requested_amount'),
          maxOfferedAmount: query.get('offered_amount'),
          expectedRequestedAmount: query.get('requested_amount'),
          feePpm: 0,
          feeAmount: '0',
          marketPrice: '1',
          fillPrice: '1',
          settlementsRunning: true,
          estimatedSeconds: 30,
          median24hSeconds: null
        })
      });
    });
    await page.reload();
    await walletA.createNewWallet();
    await walletB.createNewWallet();

    // A funded with 1000 SWPA (fundSwapPair default); registry set. The document and quote answers are the ones above.
    await fundSwapPair(
      midenCli,
      walletA,
      walletB,
      { offerSymbol: 'SWPA', requestSymbol: 'SWPB', stubQuoteService: false },
      timeline
    );

    await page.goto(`chrome-extension://${extensionId}/fullpage.html#/swap`);
    await expect(page.getByTestId('swap-flow')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('send-token-selector').first().click();
    await page.getByTestId('swap-token-SWPA').click();
    await page.getByTestId('send-token-selector').nth(1).click();
    await page.getByTestId('swap-token-SWPB').click();

    const review = page.getByTestId('swap-review-submit');
    const offerInput = page.getByTestId('swap-pay-side').getByTestId('send-amount-input');
    const requestInput = page.getByTestId('swap-receive-side').getByTestId('send-amount-input');

    // Guard 1: offer amount exceeds the 1000-SWPA balance -> disabled.
    const noPriceResponse = page.waitForResponse(response => response.url().startsWith(`${etaUrl}/v2/pair-price?`));
    await offerInput.fill('5000');
    const completedQuote = await noPriceResponse;
    expect(completedQuote.status()).toBe(503);
    expect(await completedQuote.json()).toMatchObject({ error: 'no_price' });
    await expect(requestInput).toBeEditable();
    await requestInput.fill('9');
    await expect(review).toBeDisabled();

    // With a valid quote, balance still gates review independently of service availability.
    priceAvailable = true;
    await offerInput.fill('5000');
    await expect(requestInput).toHaveValue('4997.5');
    await expect(review).toBeDisabled();

    await offerInput.fill('5');
    await expect(requestInput).toHaveValue('4.9975');
    await expect(review).toBeEnabled();

    // Exact receive keeps 4 and derives ceil(4 * 1e8 / 0.9995) base units to pay.
    await requestInput.fill('4');
    await expect(offerInput).toHaveValue('4.00200101');
    await expect(requestInput).toHaveValue('4');
    await expect(review).toBeEnabled();
    const screenshotPath = info.outputPath('swap-exact-receive.png');
    const screenshot = await page.screenshot({ path: screenshotPath, scale: 'css' });
    await sharp(screenshot).resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).toFile(screenshotPath);
    await info.attach('swap-exact-receive', { path: screenshotPath, contentType: 'image/png' });

    // Guard 3: zero requested amount -> disabled again.
    await requestInput.fill('0');
    await expect(review).toBeDisabled();
  });
});
