import { IS_LOCALNET } from '../../config/environments';
import { expect, test } from '../../fixtures/two-wallets';

test.describe('Command unsigned Send drafts in the existing localnet E2E job', () => {
  test.skip(!IS_LOCALNET, 'isolated localnet account only; do not add faucet grants to public-network jobs');

  test('two fullpage tabs isolate unsigned Send amounts and a reload clears the first tab', async ({ walletA }) => {
    test.setTimeout(180_000);
    const { address } = await walletA.createNewWallet();
    await walletA.navigateTo('/send');
    const first = walletA.page.getByTestId('command-shell').getByTestId('command-workbench');
    const firstComposer = first.getByTestId('command-send-composer');
    await expect(firstComposer).toBeVisible();
    await firstComposer.getByTestId('send-recipient-input').fill(address);
    await firstComposer.getByTestId('send-amount-input').fill('1.234500');

    const secondTab = await walletA.page.context().newPage();
    try {
      await secondTab.goto(`chrome-extension://${walletA.extensionId}/fullpage.html#/send`);
      const secondComposer = secondTab
        .getByTestId('command-shell')
        .getByTestId('command-workbench')
        .getByTestId('command-send-composer');
      await expect(secondComposer).toBeVisible({ timeout: 30_000 });
      await expect(secondComposer.getByTestId('send-recipient-input')).toHaveValue('');
      await expect(secondComposer.getByTestId('send-amount-input')).toHaveValue('');
      await expect(firstComposer.getByTestId('send-recipient-input')).toHaveValue(address);
      await expect(firstComposer.getByTestId('send-amount-input')).toHaveValue('1.234500');
      await walletA.page.reload();
      await expect(first.getByTestId('command-send-composer')).toBeVisible({ timeout: 30_000 });
      await expect(first.getByTestId('send-amount-input')).toHaveValue('');
      await expect(first.getByTestId('command-footer').getByTestId('command-send-review')).toBeDisabled();
    } finally {
      await secondTab.close();
    }
  });
});
