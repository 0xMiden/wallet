import { getEnvironmentConfig } from '../../config/environments';
import { test, expect } from '../../fixtures/two-wallets';

/**
 * The OUTGOING guardian is fully OFFLINE (connection refused on every
 * endpoint) — the switch-guardian rotation must still complete, via the
 * direct on-chain fallback (`src/lib/miden/guardian/direct-switch.ts`).
 *
 * The normal switch flow uses the OLD guardian's HTTP API as a coordination
 * mailbox (`MultisigService` load + proposal push + cold co-sign), so a dead
 * operator used to block the very rotation meant to escape it. The fallback
 * (`generateDirectSwitchGuardianTransaction`) builds the `update_guardian`
 * request locally, signs with both device keys, submits on-chain, and
 * registers the post-switch state on the NEW guardian only.
 *
 * Distinct from `guardian-switch-transient-5xx.spec.ts`, which faults the NEW
 * guardian's `/configure` register with a transient 5xx and exercises
 * `registerOnGuardianWithRetry` — the proposal flow itself still runs there.
 * Here the OLD guardian is hard-down for the entire rotation, so the proposal
 * flow CANNOT succeed: a switch that reaches Completed while
 * `networkFaultHits()` proves guardian-A traffic was actually refused can only
 * have gone through the direct path. That pair of assertions is the whole
 * point — Completed alone would be a false green if the fault never reached
 * the old guardian.
 *
 * Faulted via the whole-infra route seam (`armNetworkFault`, target
 * `guardianA`), which reaches guardian HTTP issued from the extension's
 * service worker — same seam the guardian 5xx specs use, but scoped to
 * operator A with no path narrowing so EVERY old-guardian endpoint
 * (`/pubkey`, `/configure`, `/delta*`, `getState`) is refused, modeling a
 * dead operator rather than a flaky endpoint.
 */
// Guardian operators for the SELECTED network, from the same source
// guardian-switch.spec.ts uses (see the sibling 5xx spec for why the ad-hoc
// GUARDIAN_URL_B env default was wrong).
const envConfig = getEnvironmentConfig();
const GUARDIAN_A_URL = envConfig.guardianUrl;
// `?? ''` rather than a non-null assertion at the call sites: the describe below
// skips on the empty string, so every use downstream is an ordinary string.
const GUARDIAN_B_URL = envConfig.guardianUrlB ?? '';
const NO_SECOND_GUARDIAN = `E2E_NETWORK=${envConfig.name} has no second guardian (guardianUrlB) — a switch needs two operators`;

test.describe('infra resilience — outgoing guardian offline during a switch', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(() => !GUARDIAN_B_URL, NO_SECOND_GUARDIAN);

  test('switch-guardian completes via the direct on-chain fallback with the old guardian down', async ({
    walletA,
    steps
  }) => {
    test.setTimeout(600_000);

    await steps.step('create_guardian_wallet', async () => {
      const a = await walletA.createGuardianWallet(GUARDIAN_A_URL);
      expect(a.address).toMatch(/^m[a-z]{1,4}1[a-z0-9]+(_[a-z0-9]+)?$/i);
    });

    await steps.step(
      'switch_completes_with_old_guardian_offline',
      async () => {
        // The OLD guardian goes hard-down: every request to operator A is
        // refused at the socket (server down / RST), for the whole rotation.
        // Operator B stays reachable — the direct path registers there.
        await walletA.armNetworkFault({ target: 'guardianA', mode: 'connectionRefused' });

        // Drives the real RotateGuardian flow and awaits the switch-guardian tx
        // to Completed; throws on Failed or timeout. With A refused, only the
        // direct on-chain fallback can get it there.
        await walletA.switchGuardian(GUARDIAN_B_URL);

        // Prove the outage actually fired on old-guardian traffic — 0 hits
        // means the wallet never contacted A and the spec asserted nothing
        // about the fallback (a false green).
        const hits = await walletA.networkFaultHits();
        expect(
          hits,
          'the guardian-A outage must have refused at least one request — 0 hits means the fault never reached the rotation'
        ).toBeGreaterThanOrEqual(1);

        // The rotation landed: the account now points at guardian B.
        const endpoint = await walletA.currentGuardianEndpoint();
        expect(endpoint, 'the account must be on guardian B after a switch that survived a dead old guardian').toBe(
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
