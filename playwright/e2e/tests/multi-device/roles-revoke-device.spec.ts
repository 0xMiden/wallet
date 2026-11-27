import { expect, test } from '../../fixtures/multi-device';
import { describeTransactionRow, readTransactionRows, TxStatus } from '../../helpers/history';
import {
  expectNoFailedRows,
  expectNoRotatedOutGate,
  readDeviceList,
  readRotatedOutVerdict,
  sameCommitment,
  setupSharedAccount,
  waitForRotatedOutGate,
  waitForSignerCount
} from '../../helpers/multi-device';
import {
  readWriteGuard,
  revokeDeviceFromSettings,
  revokedCommitmentOf,
  waitForTerminalRow
} from '../../helpers/multi-device-roles';

/** See `ROTATED_OUT_TIMEOUT_MS` in roles-make-main.spec.ts: the sheet waits for the self-heal's 401 streak. */
const ROTATED_OUT_TIMEOUT_MS = 300_000;

/**
 * Revoke a device from Settings > Devices (`DeviceSettings.tsx`).
 *
 * Device A creates the account and device B joins with "Add this device", so
 * the chain holds three signers. On A, the Revoke action of B's row opens a
 * confirm dialog, then a password step (`StrictActionAuthentication`), then
 * queues a `replace-hot-key` row whose target list is the signer set without
 * B (`revokedSignerCommitment`, `deviceSignersAfterRevocation`).
 *
 * First the two cancel paths: Cancel in the dialog and Cancel on the password
 * step. Neither queues a row, the chain keeps B, B still lists itself as a
 * signer, and B shows no rotated-out sheet.
 *
 * Then the real revocation. The row lands, the chain holds A's hot key and the
 * cold key, A's Devices page no longer lists B, and B shows the rotated-out
 * sheet with its writes blocked.
 */
test.describe('Multi-device roles: revoke a device from settings', () => {
  test('a cancelled revocation keeps the device, a confirmed one rotates it out', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    let address = '';
    let hotA = '';
    let hotB = '';

    await steps.step('create_on_a_and_add_b', async () => {
      address = (await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' })).address;
      await waitForSignerCount(walletA, address, 3);
      const devicesA = await readDeviceList(walletA);
      const devicesB = await readDeviceList(walletB);
      if (devicesA.current === null || devicesB.current === null) {
        throw new Error('both devices must be signers after the add');
      }
      hotA = devicesA.current;
      hotB = devicesB.current;
      expect(devicesA.commitments, 'A lists both devices').toHaveLength(2);
    });

    await steps.step('cancel_at_the_dialog', async () => {
      const outcome = await revokeDeviceFromSettings(walletA, hotB, 'cancel-at-dialog');
      expect(outcome.kind).toBe('cancelled');
    });

    await steps.step('cancel_at_the_password_step', async () => {
      const outcome = await revokeDeviceFromSettings(walletA, hotB, 'cancel-at-authentication');
      expect(outcome.kind).toBe('cancelled');
    });

    await steps.step('a_cancelled_revocation_changes_nothing', async () => {
      const revocations = (await readTransactionRows(walletA.page)).filter(
        row => revokedCommitmentOf(row) !== undefined
      );
      expect(revocations.map(describeTransactionRow), 'no cancel queues a revocation').toEqual([]);
      const signers = await waitForSignerCount(walletA, address, 3);
      expect(
        signers.commitments.some(commitment => sameCommitment(commitment, hotB)),
        'B stays a signer'
      ).toBe(true);
      const devicesA = await readDeviceList(walletA);
      expect(
        devicesA.commitments.some(commitment => sameCommitment(commitment, hotB)),
        "A's Devices page still lists B"
      ).toBe(true);
      const devicesB = await readDeviceList(walletB);
      expect(devicesB.current, 'B still marks itself as a signer').not.toBeNull();
      await expectNoRotatedOutGate(walletB);
      expect(await readRotatedOutVerdict(walletB), 'B has no rotated-out verdict').toBe(false);
    });

    await steps.step('revoke_b_from_a', async () => {
      const outcome = await revokeDeviceFromSettings(walletA, hotB, 'confirm');
      if (outcome.kind !== 'queued') throw new Error('the confirmed revocation must queue a row');
      const row = await waitForTerminalRow(
        walletA.page,
        entry => entry.id === outcome.rowId,
        'the revocation',
        300_000
      );
      expect(row.status, `the revocation must land: ${describeTransactionRow(row)}`).toBe(TxStatus.Completed);
      expect(row.type).toBe('replace-hot-key');
      expect(sameCommitment(revokedCommitmentOf(row) ?? '', hotB), 'the row revokes B').toBe(true);
      await walletA.waitForGuardianSettled();
    });

    await steps.step('chain_and_devices_page_drop_b', async () => {
      const signers = await waitForSignerCount(walletA, address, 2);
      expect(
        signers.commitments.some(commitment => sameCommitment(commitment, hotB)),
        'B left the signer set'
      ).toBe(false);
      expect(
        signers.commitments.some(commitment => sameCommitment(commitment, hotA)),
        'A stays a signer'
      ).toBe(true);
      const devicesA = await readDeviceList(walletA);
      expect(devicesA.commitments, "A's Devices page lists only A").toHaveLength(1);
      expect(sameCommitment(devicesA.current ?? '', hotA), 'A marks itself').toBe(true);
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
