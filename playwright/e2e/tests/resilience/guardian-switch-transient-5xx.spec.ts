import { getEnvironmentConfig } from '../../config/environments';
import { test, expect } from '../../fixtures/two-wallets';
import { ensureFeeFunded } from '../../helpers/fee-funding';

/**
 * Gap 15 (design plan Task 3.2): a guardian STRUCTURAL op must survive a
 * transient guardian 5xx — the wallet's `registerOnGuardianWithRetry` retries
 * the `/configure` register call rather than failing the whole rotation.
 *
 * A switch-guardian re-registers the account's state on the NEW guardian via
 * `POST /configure` (Multisig.registerOnGuardian → registerOnGuardianWithRetry).
 * This faults the first couple of those calls with a 500, then lets them through
 * — a guardian briefly unavailable mid-rotation. The switch must still reach
 * Completed (the `switchGuardian` POM throws on Failed/timeout), not surface
 * "Failed to switch guardian".
 *
 * Faulted via the guardian `context.route` seam (proven to reach SW guardian
 * HTTP). `guardianFaultHits()` proves the fault actually fired — a switch that
 * completed with zero hits would be a false green.
 *
 * This is a TDD guard: if it goes RED, the register-retry does not cover a
 * transient 5xx on this path and the product needs the fix (gap 15).
 */
// Guardian operators for the SELECTED network, from the same source
// guardian-switch.spec.ts uses. The ad-hoc `process.env.GUARDIAN_URL_B ??
// 'http://localhost:3001'` this replaced defaulted to the LOCALNET container on
// every network that doesn't export that variable — and no workflow does — so on
// testnet this spec asked the picker for `http://localhost:3001` and failed with
// "no guardian picker option with endpoint http://localhost:3001" while its 47
// siblings passed.
const envConfig = getEnvironmentConfig();
const GUARDIAN_A_URL = envConfig.guardianUrl;
// `?? ''` rather than a non-null assertion at the call sites: the describe below
// skips on the empty string, so every use downstream is an ordinary string.
const GUARDIAN_B_URL = envConfig.guardianUrlB ?? '';
const NO_SECOND_GUARDIAN = `E2E_NETWORK=${envConfig.name} has no second guardian (guardianUrlB) — a switch needs two operators`;

test.describe('infra resilience — transient guardian 5xx during a structural op', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(() => !GUARDIAN_B_URL, NO_SECOND_GUARDIAN);

  test('switch-guardian survives a transient 5xx on the register call and completes', async ({
    walletA,
    midenCli,
    steps
  }) => {
    test.setTimeout(600_000);

    await steps.step('create_guardian_wallet', async () => {
      const a = await walletA.createGuardianWallet(GUARDIAN_A_URL);
      expect(a.address).toMatch(/^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i);
      // This spec never mints, so on a fee-charging chain the account has nothing to pay
      // the switch with: `switch-guardian` is a real transaction and `fee::pay_fee` takes
      // the native asset from this account's own vault. No-op on a zero-fee chain.
      await ensureFeeFunded(midenCli, walletA, a.address);
    });

    await steps.step(
      'switch_survives_transient_register_5xx',
      async () => {
        // The first two `/configure` register calls (registerOnGuardianWithRetry)
        // answer 500, then clear — a guardian briefly unavailable mid-rotation.
        walletA.armGuardianFault({ path: 'configure', mode: 'failFirstN', count: 2 });

        // Drives the real RotateGuardian flow and awaits the switch-guardian tx to
        // Completed; throws on Failed or timeout.
        await walletA.switchGuardian(GUARDIAN_B_URL);

        // Prove the fault actually fired during the switch — else the switch just
        // succeeded normally and this asserts nothing about the retry.
        const hits = walletA.guardianFaultHits();
        expect(
          hits,
          'the transient 5xx must have fired on the register call — 0 hits means the fault never reached the structural op'
        ).toBeGreaterThanOrEqual(1);

        // The switch landed: the current account now points at guardian B.
        const endpoint = await walletA.currentGuardianEndpoint();
        expect(endpoint, 'the account must now be on guardian B after a switch that survived a transient 5xx').toBe(
          GUARDIAN_B_URL
        );
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step('clear', async () => {
      await walletA.clearFaults();
    });
  });
});
