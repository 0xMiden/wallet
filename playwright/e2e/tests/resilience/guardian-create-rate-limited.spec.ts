import { test, expect } from '../../fixtures/two-wallets';

/**
 * #906 / #903: a guardian that rate-limits `/configure` during creation must
 * not fail the wallet. `createGuardianAccount` wraps `registerOnGuardian` in
 * `withGuardianRateLimitRetry`, which waits out the guardian's
 * `meta.retry_after_secs` and re-registers.
 *
 * The fault is the real 429 envelope (`{ code: 'rate_limit_exceeded', meta }`),
 * not a generic 500, so it exercises the same `isGuardianRateLimited` branch a
 * live limiter's 429 would. It self-clears after two hits, modelling a rate
 * limiter whose window passes.
 *
 * Falsifiability: without the retry, creation fails on the first 429 and
 * `createGuardianWallet` throws instead of returning an address.
 */
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

test.describe('infra resilience - guardian rate-limits creation', () => {
  test.describe.configure({ mode: 'serial' });

  test('a Guardian wallet is created when the guardian rate-limits its registration twice', async ({
    walletA,
    steps
  }) => {
    test.setTimeout(300_000);

    await steps.step(
      'create_under_rate_limit',
      async () => {
        walletA.armGuardianFault({ target: 'A', path: 'configure', mode: 'rateLimited', count: 2 });

        const created = await walletA.createGuardianWallet(GUARDIAN_URL);
        expect(created.address).toBeTruthy();

        // Two hits prove both rejections reached the wallet's registration and it
        // came back for a third call; fewer means the fault never fired.
        expect(walletA.guardianFaultHits(), 'the 429 fault must have answered two /configure calls').toBe(2);
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('clear', async () => {
      await walletA.clearFaults();
    });
  });
});
