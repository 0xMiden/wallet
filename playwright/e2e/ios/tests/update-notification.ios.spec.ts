import { expect, test } from '../fixtures/two-simulators';

test('shows and acts on an authoritative iOS update after onboarding', async ({ walletA, steps }) => {
  await walletA.evaluate(() => {
    window.__MIDEN_E2E_UPDATE__ = {
      platform: 'ios',
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

  expect(await walletA.locatorText('[data-testid="update-notification-card"]')).toBeNull();
  await walletA.createNewWallet();
  await steps.step(
    'update_notice_renders',
    async () => {
      await walletA.waitFor('[data-testid="update-notification-card"]', { timeoutMs: 30_000 });
      expect(await walletA.locatorText('[data-testid="update-notification-card"]')).toContain('Version 1.17.0');
    },
    { screenshotWallets: [{ target: walletA, label: 'A' }] }
  );

  await walletA.click('[data-testid="update-notification-action"]');
  await expect
    .poll(() =>
      walletA.evaluate(() => (window as unknown as { __UPDATE_ACTION_COUNT__: number }).__UPDATE_ACTION_COUNT__)
    )
    .toBe(1);
});
