import { expect, test } from '../../fixtures/multi-device';
import { describeTransactionRow, readTransactionRows, TxStatus } from '../../helpers/history';
import {
  expectNoFailedRows,
  expectNoRotatedOutGate,
  makeThisDeviceMainFromRotatedOutGate,
  readDeviceList,
  readDeviceRoleStep,
  readRotatedOutVerdict,
  sameCommitment,
  waitForRotatedOutGate,
  waitForSignerCount
} from '../../helpers/multi-device';
import {
  activationModeOfRow,
  activationRows,
  createFundedGuardianAccount,
  readWriteGuard,
  waitForRoleStepOrActivation
} from '../../helpers/multi-device-roles';

/**
 * How long a device can take to show the rotated-out sheet. The sheet waits for
 * the Guardian sync's self-heal: three refused requests in a row
 * (`SELF_HEAL_AUTH_FAILURE_THRESHOLD`, `front/guardian-selfheal.ts`) on the ~3 s
 * sync tick, then a chain read that finds no slot with this device's key
 * (`attemptColdReRegisterSelfHeal` in `front/guardian-sync.ts`, which writes the
 * verdict and returns `refused-permanently`). On testnet that is normally under
 * a minute; this budget leaves room for a slow node.
 */
const ROTATED_OUT_TIMEOUT_MS = 300_000;

/**
 * "Make this device the main one", and the way back from the rotated-out sheet.
 *
 * Device A creates the account. Device B recovers it with the recovery phrase
 * and answers the device-role step with "Make this device the main one". The
 * signer set becomes `[B's hot key, cold key]`, and the Guardian takes B's set,
 * so A's hot-signed requests get 401. A then shows the rotated-out sheet
 * (`HotKeyRotatedOutGate`), which no Escape closes, and the product's write
 * guard (`isGuardianSyncBlocked`, the predicate behind `assertGuardianInSync`)
 * refuses every transaction of A.
 *
 * A then presses "Make this device the main one" on that sheet. The documented
 * end state (repo CLAUDE.md, "Rotated-out hot key"): A runs a cold-signed
 * rotation to a new hot key whose re-register revokes B, so A is a signer again
 * and B is rotated out.
 *
 * OPEN QUESTION, recorded and not asserted. After the press, `retireRotatedOutHotKey`
 * (`back/vault.ts`) gives the account the shape of a fresh recovery
 * (`requiresHotKeyRotation`, no hot key), and `HotKeyRotationGate` shows its
 * device-role step again, because A has no activation row whose role it can
 * resume (`resumableActivationMode` in `HotKeyRotationGate.selectors.ts` reads
 * only this device's activation rows, and a created account has none). The step
 * preselects "Add this device" (`ChooseDeviceRole.tsx`, `useState('add')`), so a
 * user who presses Continue at once ADDS a key next to B instead of taking the
 * main role that they just chose. The test records what the gate shows at that
 * point as the `role-step-after-make-main` annotation, then answers "main".
 */
test.describe('Multi-device roles: make this device the main one', () => {
  test('a main device rotates the other one out, and the other one takes the main role back from the sheet', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    envConfig
  }) => {
    let address = '';
    let phrase = '';
    let oldHotA = '';
    let hotB = '';

    await steps.step('create_and_fund_on_a', async () => {
      const account = await createFundedGuardianAccount(walletA, midenCli, envConfig.guardianUrl);
      address = account.address;
      phrase = account.phrase;
      const devices = await readDeviceList(walletA);
      if (devices.current === null) throw new Error('the creator must be a signer');
      oldHotA = devices.current;
    });

    await steps.step('recover_on_b_as_main', async () => {
      walletB.trackGuardianCommitments();
      await walletB.recoverGuardianFromSeed(phrase, { viaUI: true, guardianUrl: envConfig.guardianUrl, role: 'main' });
      expect(await walletB.getAccountAddress(), 'the recovery phrase restores the same account').toBe(address);
      const rotations = activationRows(await readTransactionRows(walletB.page));
      expect(rotations.map(activationModeOfRow), 'B queued one replace').toEqual(['replace']);
      expect(rotations[0]?.status, 'the replace landed').toBe(TxStatus.Completed);
      await walletB.waitForGuardianSettled();
    });

    await steps.step('chain_holds_b_and_the_cold_key', async () => {
      const signers = await waitForSignerCount(walletB, address, 2);
      const devicesB = await readDeviceList(walletB);
      if (devicesB.current === null) throw new Error('B must be a signer after its replace');
      hotB = devicesB.current;
      expect(devicesB.commitments, 'B lists only itself').toHaveLength(1);
      expect(
        signers.commitments.some(commitment => sameCommitment(commitment, hotB)),
        'B is a signer'
      ).toBe(true);
      expect(
        signers.commitments.some(commitment => sameCommitment(commitment, oldHotA)),
        "A's hot key left the signer set"
      ).toBe(false);
    });

    await steps.step('a_shows_the_rotated_out_sheet_and_its_writes_are_blocked', async () => {
      await waitForRotatedOutGate(walletA, ROTATED_OUT_TIMEOUT_MS);
      expect(await readRotatedOutVerdict(walletA), 'A persisted the rotated-out verdict').toBe(true);
      expect(await readWriteGuard(walletA), 'the write guard refuses every transaction of A').toEqual({
        rotatedOut: true,
        blocked: true
      });
      // A holds the cold key (created account), so the sheet offers the way back.
      await expect(walletA.page.getByTestId('hot-key-rotated-out-make-main')).toBeVisible();
      // The sheet cannot be dismissed.
      await walletA.page.keyboard.press('Escape');
      await expect(walletA.page.getByTestId('hot-key-rotated-out-make-main')).toBeVisible();
    });

    await steps.step('a_takes_the_main_role_back_from_the_sheet', async () => {
      const known = new Set(activationRows(await readTransactionRows(walletA.page)).map(row => row.id));
      await makeThisDeviceMainFromRotatedOutGate(walletA);
      const first = await waitForRoleStepOrActivation(walletA, known);
      switch (first) {
        case 'role-step': {
          const view = await readDeviceRoleStep(walletA);
          test.info().annotations.push({
            type: 'role-step-after-make-main',
            description:
              `The rotation gate asked for the device role again after "Make this device the main one". ` +
              `Preselected: ${view.selected ?? 'none'}. Text: ${view.text}`
          });
          break;
        }
        case 'activation-row':
          test.info().annotations.push({
            type: 'role-step-after-make-main',
            description: 'The rotation gate started a rotation without the device-role step.'
          });
          break;
      }
      // Answers the role step with "main" when the gate shows it.
      await walletA.completeHotKeyRotation({ role: 'main', timeoutMs: 300_000 });
      const rotations = activationRows(await readTransactionRows(walletA.page));
      expect(rotations.map(describeTransactionRow), "A's one activation row").toHaveLength(1);
      expect(rotations.map(activationModeOfRow), 'A took the main role').toEqual(['replace']);
      expect(rotations[0]?.status, "A's replace landed").toBe(TxStatus.Completed);
      await walletA.waitForGuardianSettled();
    });

    await steps.step('a_is_a_signer_again', async () => {
      const signers = await waitForSignerCount(walletA, address, 2);
      const devicesA = await readDeviceList(walletA);
      if (devicesA.current === null) throw new Error('A must be a signer after it took the main role');
      const newHotA = devicesA.current;
      expect(sameCommitment(newHotA, oldHotA), 'A signs with a new hot key').toBe(false);
      expect(
        signers.commitments.some(commitment => sameCommitment(commitment, newHotA)),
        'A is a signer'
      ).toBe(true);
      expect(
        signers.commitments.some(commitment => sameCommitment(commitment, hotB)),
        "B's hot key left the signer set"
      ).toBe(false);
      await expectNoRotatedOutGate(walletA);
      expect(await readWriteGuard(walletA), 'A can write again').toEqual({ rotatedOut: false, blocked: false });
    });

    await steps.step('b_is_rotated_out', async () => {
      await waitForRotatedOutGate(walletB, ROTATED_OUT_TIMEOUT_MS);
      expect(await readRotatedOutVerdict(walletB), 'B persisted the rotated-out verdict').toBe(true);
      expect(await readWriteGuard(walletB), 'the write guard refuses every transaction of B').toEqual({
        rotatedOut: true,
        blocked: true
      });
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
    });
  });
});
