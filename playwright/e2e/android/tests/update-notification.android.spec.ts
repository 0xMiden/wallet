import { expect, test } from '../fixtures/two-emulators';

test('shows and acts on an authoritative Android update after onboarding', async ({ walletA, steps }) => {
  await walletA.evaluate(() => {
    const update = {
      platform: 'android',
      currentVersion: '1.16.0',
      availableVersion: '1.17.0',
      summary: 'Safer transfers and faster startup.',
      urgency: 'important'
    } as const;
    window.__MIDEN_E2E_UPDATE__ = update;
    sessionStorage.setItem('__miden_e2e_update__', JSON.stringify(update));
  });

  // Onboarding gating is proven by the provider unit tests, which can observe a
  // check that resolves while the surface is not a normal one; here the card
  // could not render yet whatever the provider did.
  await walletA.createNewWallet();
  await walletA.evaluate(() => {
    (window as unknown as { __UPDATE_ACTION_COUNT__: number }).__UPDATE_ACTION_COUNT__ = 0;
    window.addEventListener('miden:e2e-update-action', () => {
      (window as unknown as { __UPDATE_ACTION_COUNT__: number }).__UPDATE_ACTION_COUNT__ += 1;
    });
  });

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
