import { expect, test } from '../fixtures/two-wallets';

test('shows, acts on, dismisses, and refreshes an authoritative Chrome update', async ({ walletA }) => {
  await walletA.page.evaluate(() => {
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'chrome',
      currentVersion: '1.16.0',
      availableVersion: '1.17.0',
      summary: 'Safer transfers and faster startup.',
      urgency: 'important'
    };
    (window as unknown as { __UPDATE_ACTION_COUNT__: number }).__UPDATE_ACTION_COUNT__ = 0;
    window.addEventListener('miden:e2e-update-action', () => {
      (window as unknown as { __UPDATE_ACTION_COUNT__: number }).__UPDATE_ACTION_COUNT__ += 1;
    });
  });

  await expect(walletA.page.getByTestId('update-notification-card')).toHaveCount(0);
  await walletA.createNewWallet();

  const card = walletA.page.getByTestId('update-notification-card');
  await expect(card).toContainText('Version 1.17.0');
  await expect(card).toContainText('Safer transfers and faster startup.');
  await walletA.page.getByTestId('update-notification-action').click();
  await expect
    .poll(() =>
      walletA.page.evaluate(() => (window as unknown as { __UPDATE_ACTION_COUNT__: number }).__UPDATE_ACTION_COUNT__)
    )
    .toBe(1);

  await walletA.page.getByTestId('update-notification-dismiss').click();
  await expect(card).toHaveCount(0);
  await walletA.page.evaluate(() => {
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'chrome',
      currentVersion: '1.16.0',
      availableVersion: '1.18.0',
      summary: 'A later update.',
      urgency: 'critical'
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(walletA.page.getByTestId('update-notification-card')).toContainText('Version 1.18.0');
});
