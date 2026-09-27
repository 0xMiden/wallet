import { test, expect } from '../../fixtures/two-wallets';
import { RATE_LIMITED_RETRY_AFTER_SECS } from '../../harness/guardian-fault';

/**
 * #906 / #903: a guardian that rate-limits `/configure` during creation must
 * not fail the wallet. `createGuardianAccount` wraps `registerOnGuardian` in
 * `withGuardianRateLimitRetry`, which waits out the guardian's stated cooldown
 * and re-registers.
 *
 * The fault answers like a live limiter on every channel the wallet reads: a
 * 429 with a JSON `rate_limit_exceeded` envelope and a cooldown of
 * RATE_LIMITED_RETRY_AFTER_SECS in both the `Retry-After` header and
 * `meta.retry_after_secs`. It self-clears after two hits, modelling a limiter
 * whose window passes.
 *
 * Falsifiability: without the retry, creation fails on the first 429 and
 * `createGuardianWallet` throws instead of returning an address; a retry that
 * ignored the stated cooldown for the 1 s blind backoff fails the gap assertion.
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
        const hitTimes = walletA.guardianFaultHitTimes();
        expect(hitTimes).toHaveLength(2);
        expect(
          hitTimes[1]! - hitTimes[0]!,
          "the retry must wait the guardian's stated cooldown, not the 1 s blind backoff"
        ).toBeGreaterThanOrEqual(RATE_LIMITED_RETRY_AFTER_SECS * 1000);
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
