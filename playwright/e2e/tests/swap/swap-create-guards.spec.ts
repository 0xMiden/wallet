import sharp from 'sharp';

import { expect, test } from '../../fixtures/two-wallets';
import { PUBLISHED_BRIDGE_CONFIG_URL } from '../../helpers/fake-bridge-config';
import { fundSwapPair } from '../../helpers/swap';

/** Manual receive entry and create-side guards, without submitting an order. */
test.describe('swap: create-side guards', () => {
  test.describe.configure({ mode: 'serial' });

  test('review is gated by balance and a non-zero requested amount', async (
    { walletA, walletB, midenCli, timeline },
    info
  ) => {
    const { page, extensionId } = walletA;
    const etaUrl = 'https://quotes.test';
    await page.route(`${PUBLISHED_BRIDGE_CONFIG_URL}/localnet.json`, route =>
      route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          network: 'localnet',
          version: 1,
          features: { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false },
          swap: { etaUrl }
        })
      })
    );
    // The solver lists nothing: fundSwapPair sets the registry through `__TEST_SET_SWAP_TOKENS__`.
    await page.route(`${etaUrl}/v2/pairs`, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
        body: JSON.stringify({ tokens: [], pairs: [] })
      })
    );
    // The pair has no price, so the receive field is the user's to fill by hand. The service refuses the
    // price with no_price and still answers the order check; the wallet stops at the refused price.
    await page.route(`${etaUrl}/v2/pair-price?**`, route =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
        body: JSON.stringify({ error: 'no_price', message: 'no valid price for this pair' })
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
          priceBand: null,
          fillStatus: 'none',
          reason: 'no_price',
          fillableOfferedAmount: '0',
          fillableRequestedAmount: '0',
          maxOfferedAmount: null,
          expectedRequestedAmount: null,
          feePpm: 50,
          feeAmount: null,
          marketPrice: null,
          fillPrice: null,
          settlementsRunning: true,
          estimatedSeconds: null,
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
    const offerInput = page.getByTestId('send-amount-input').first();
    const requestInput = page.getByTestId('send-amount-input').nth(1);

    // Guard 1: offer amount exceeds the 1000-SWPA balance -> disabled.
    const noPriceResponse = page.waitForResponse(response => response.url().startsWith(`${etaUrl}/v2/pair-price?`));
    await offerInput.fill('5000');
    const completedQuote = await noPriceResponse;
    expect(completedQuote.status()).toBe(503);
    expect(await completedQuote.json()).toMatchObject({ error: 'no_price' });
    await expect(requestInput).toBeEditable();
    await requestInput.fill('9');
    await expect(review).toBeDisabled();

    // Guard 2: within balance + non-zero request -> enabled.
    await offerInput.fill('5');
    await requestInput.fill('4');
    await expect(review).toBeEnabled();
    const screenshotPath = info.outputPath('swap-manual-receive.png');
    const screenshot = await page.screenshot({ path: screenshotPath, scale: 'css' });
    await sharp(screenshot).resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).toFile(screenshotPath);
    await info.attach('swap-manual-receive', { path: screenshotPath, contentType: 'image/png' });

    // Guard 3: zero requested amount -> disabled again.
    await requestInput.fill('0');
    await expect(review).toBeDisabled();
  });
});
