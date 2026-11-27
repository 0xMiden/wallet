import { expect, test } from '../../fixtures/multi-device';
import { describeTransactionRow, readTransactionRows, TxStatus } from '../../helpers/history';
import {
  answerRecoveryPhraseKeepPrompt,
  expectNoFailedRows,
  readDeviceList,
  readDeviceRoleStep,
  recoverToDeviceRoleStep,
  sameCommitment,
  waitForRecoveryPhraseKeepPrompt,
  waitForSignerCount
} from '../../helpers/multi-device';
import {
  activationModeOfRow,
  activationRows,
  createFundedGuardianAccount,
  isTerminalRow,
  pressDeviceRoleContinue,
  signArbitraryInputsFromTestDapp,
  waitForRoleStepOrActivation,
  waitForRotationGateCleared,
  waitWithoutRoleStep
} from '../../helpers/multi-device-roles';
import { ECDSA_SCHEME_TAG } from '../../helpers/signature-recovery';
import { dismissTelemetryConsent } from '../../helpers/telemetry-consent';

/**
 * How long the harness holds the add's post-commit re-register (`POST /configure`
 * on the account's Guardian). While it is held, the activation row cannot reach
 * a terminal state, so the kill below lands mid-rotation by construction.
 */
const HELD_REREGISTER_MS = 60_000;

/**
 * A reload and a kill during an add, then a dApp signature from the added device.
 *
 * Device A creates the account. Device B recovers it and presses Continue on
 * the device-role step with "Add this device". Before the press, the harness
 * holds every `/configure` of B for 60 s (as `guardian-recovery-stress.spec.ts`
 * does), so the add commits on chain and then waits in its re-register.
 *
 * - B's page reloads while the activation row is live.
 * - B's page is killed and reopened while the re-register is held.
 *
 * After each interruption the rotation gate adopts the row that exists
 * (`ensureRotationTx` with `adoptExisting`) and never shows the device-role
 * step again. The row completes and the chain holds three signers.
 *
 * Then the added device signs for a dApp. An add appends B's hot key, so B's
 * key is not in slot 0, and a dApp signs with the first commitment that
 * connect gives (`resolvePublicKeyCommitments` puts this device's own key
 * first). The connect key must be B's own, and the signature must verify
 * against it.
 */
test.describe('Multi-device roles: interrupted add', () => {
  test('a reload and a kill during an add do not ask for the role again, and the added device signs for a dApp', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    envConfig
  }) => {
    let address = '';
    let phrase = '';
    let heldHits = 0;

    await steps.step('create_and_fund_on_a', async () => {
      const account = await createFundedGuardianAccount(walletA, midenCli, envConfig.guardianUrl);
      address = account.address;
      phrase = account.phrase;
    });

    await steps.step('recover_on_b_to_the_role_step', async () => {
      walletB.trackGuardianCommitments();
      await recoverToDeviceRoleStep(walletB, phrase);
      expect((await readDeviceRoleStep(walletB)).selected, '"Add this device" is the default role').toBe('add');
    });

    await steps.step('continue_with_a_held_reregister', async () => {
      // Before Continue, so the first re-register of the add is already held.
      walletB.armGuardianFault({ target: 'A', path: 'configure', mode: 'delay', delayMs: HELD_REREGISTER_MS });
      await pressDeviceRoleContinue(walletB);
      const first = await waitForRoleStepOrActivation(walletB, new Set());
      expect(first, 'Continue queues the add without a second role step').toBe('activation-row');
    });

    await steps.step('reload_while_the_rotation_runs', async () => {
      const rows = activationRows(await readTransactionRows(walletB.page));
      expect(rows.map(describeTransactionRow), 'one activation row').toHaveLength(1);
      expect(rows.some(isTerminalRow), 'the add is still live at the reload').toBe(false);
      await walletB.page.reload({ waitUntil: 'domcontentloaded' });
      await walletB.page.waitForSelector('#root > *', { timeout: 60_000 });
      await expect(
        walletB.page.getByTestId('hot-key-rotation-gate'),
        'the gate comes back after the reload'
      ).toBeVisible({ timeout: 60_000 });
    });

    await steps.step('kill_while_the_reregister_is_held', async () => {
      await waitWithoutRoleStep(
        walletB,
        async () => walletB.guardianFaultHits() > 0,
        'the add reached its held re-register',
        300_000
      );
      heldHits = walletB.guardianFaultHits();
      const rows = activationRows(await readTransactionRows(walletB.page));
      expect(rows.some(isTerminalRow), 'the add is still live at the kill').toBe(false);
      await walletB.kill();
      await walletB.reopen();
      await walletB.clearFaults();
    });

    await steps.step('the_gate_adopts_the_add_and_finishes', async () => {
      expect(heldHits, 'the held re-register was reached before the kill').toBeGreaterThanOrEqual(1);
      await waitForRotationGateCleared(walletB, { timeoutMs: 360_000, failOnRoleStep: true });
      // Continue armed the keep prompt, and no Keep handler is installed: answer it, then the telemetry prompt.
      await waitForRecoveryPhraseKeepPrompt(walletB);
      await answerRecoveryPhraseKeepPrompt(walletB, 'keep');
      await dismissTelemetryConsent(walletB.page);
      const rows = activationRows(await readTransactionRows(walletB.page));
      expect(rows.map(describeTransactionRow), 'the interruptions queued no second activation').toHaveLength(1);
      expect(rows.map(activationModeOfRow), 'the row keeps the add role').toEqual(['add']);
      expect(rows[0]?.status, 'the add landed').toBe(TxStatus.Completed);
      await waitForSignerCount(walletB, address, 3);
      await walletB.waitForGuardianSettled();
    });

    await steps.step('dapp_signature_from_the_added_device', async () => {
      const signers = await waitForSignerCount(walletB, address, 3);
      const devicesA = await readDeviceList(walletA);
      const devicesB = await readDeviceList(walletB);
      const hotA = devicesA.current;
      const hotB = devicesB.current;
      if (hotA === null || hotB === null) throw new Error('both devices must be signers after the add');
      // The case under test: B's key is not the first slot, so a slot-0 reading would hand out another key.
      expect(
        signers.commitments.findIndex(commitment => sameCommitment(commitment, hotB)),
        "an add appends B's hot key after the first slot"
      ).toBeGreaterThanOrEqual(1);

      const evidence = await signArbitraryInputsFromTestDapp(walletB, {
        network: envConfig.name,
        rpcUrl: envConfig.rpcUrl,
        storeName: `test-dapp-multi-device-roles-${test.info().testId}`
      });
      expect(evidence.schemeTag, 'a Guardian hot key signs with ECDSA').toBe(ECDSA_SCHEME_TAG);
      expect(sameCommitment(evidence.connectCommitment, hotB), "connect gives the dApp B's own key").toBe(true);
      expect(sameCommitment(evidence.connectCommitment, hotA), "connect does not give the dApp A's key").toBe(false);
      expect(evidence.verifies, 'the signature verifies against the domain commitment').toBe(true);
      expect(
        sameCommitment(evidence.signerCommitment, evidence.connectCommitment),
        'the key that signed is the key that connect gave'
      ).toBe(true);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
    });
  });
});
