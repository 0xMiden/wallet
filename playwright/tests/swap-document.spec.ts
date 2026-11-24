import { TEST_TOKEN_IETH, TEST_TOKEN_IMIDEN } from '../../src/lib/miden/swap/testing/registry';
import { eligibilityFixtureUrl } from '../e2e/helpers/feature-eligibility';
import { importWallet } from '../e2e/helpers/import-wallet';
import { openSwapDocument } from '../e2e/helpers/swap-document';
import { expect, test } from '../fixtures/extension';

test('reinstalls Swap tokens after a document change and preserves each Receive input contract', async ({
  extensionContext,
  extensionId
}) => {
  test.setTimeout(240_000);
  const eligibility = eligibilityFixtureUrl();
  await extensionContext.route(url => url.origin === eligibility && url.pathname === '/v1/eligibility', async route => {
    const response = await route.fetch();
    const result = await response.json();
    await route.fulfill({ response, json: { ...result, allowed: { ...result.allowed, swap: true } } });
  });
  // This smoke only exercises the composer; a live solver response is never required.
  await extensionContext.route(
    url => ['/v2/pairs', '/v2/pair-price', '/v2/swap-eta'].includes(url.pathname),
    route => route.abort()
  );
  await importWallet(extensionContext, extensionId);
  const page = await extensionContext.newPage();
  const offer = { ...TEST_TOKEN_IMIDEN, symbol: 'SWPA' };
  const request = { ...TEST_TOKEN_IETH, symbol: 'SWPB' };
  const tokens = [offer, request];

  await openSwapDocument(page, extensionId, 'fullpage', tokens);
  const command = page.getByTestId('command-swap-composer');
  const commandReceive = command.getByTestId('command-swap-receive');
  await expect(command).toBeVisible();
  await command.getByTestId('send-token-selector').click();
  await page.getByTestId('swap-token-SWPA').click();
  await commandReceive.getByRole('button', { name: 'You Receive' }).click();
  await page.getByTestId('swap-token-SWPB').click();
  await expect(command.getByTestId('send-amount-input')).toHaveCount(1);
  await expect(commandReceive.getByTestId('send-amount-input')).toHaveCount(0);

  await openSwapDocument(page, extensionId, 'sidepanel', tokens);
  const pay = page.getByTestId('swap-pay-side');
  const receive = page.getByTestId('swap-receive-side');
  await pay.getByTestId('send-token-selector').click();
  await page.getByTestId('swap-token-SWPA').click();
  await receive.getByTestId('send-token-selector').click();
  await page.getByTestId('swap-token-SWPB').click();
  const exactReceive = receive.getByTestId('send-amount-input');
  await expect(exactReceive).toBeEditable();
  await exactReceive.fill('9.00450226');
  await expect(exactReceive).toHaveValue('9.00450226');
  await expect(page.getByTestId('command-shell')).toHaveCount(0);
});
