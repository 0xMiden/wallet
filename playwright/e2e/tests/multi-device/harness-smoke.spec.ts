import { expect, test } from '../../fixtures/multi-device';
import {
  assertBackupReachesWalletApi,
  expectNoFailedRows,
  readDeviceList,
  setupSharedAccount,
  waitForSignerCount
} from '../../helpers/multi-device';

/**
 * The foundation of the multi-device suite, and the reference for its specs.
 *
 * Device A creates a Guardian account. Device B recovers it with the recovery
 * phrase and answers the device-role step with "Add this device". The chain
 * then holds three signers (A's hot key, B's hot key and the cold key), the
 * `update_guardian` threshold stays where it was, and both devices are signers.
 * The backup guard proves that the running extension talks to the local
 * wallet-api Worker.
 */
test.describe('Multi-device harness', () => {
  test('a recovery with role "add" keeps the first device and adds the second', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    walletApi
  }) => {
    let address = '';

    await steps.step('create_on_a_and_add_b', async () => {
      const shared = await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
      address = shared.address;
    });

    await steps.step('chain_holds_three_signers', async () => {
      const onB = await waitForSignerCount(walletB, address, 3);
      const onA = await waitForSignerCount(walletA, address, 3);
      // An add changes only the signer list. The update_guardian override stays at 2 (repo CLAUDE.md,
      // "Signer identity is membership"), as for a created account.
      expect(onB.updateGuardianThreshold, 'an add keeps the update_guardian threshold').toBe(2);
      expect(onB.threshold, 'both devices read the same default threshold').toBe(onA.threshold);
      expect(new Set(onA.commitments.map(c => c.toLowerCase()))).toEqual(
        new Set(onB.commitments.map(c => c.toLowerCase()))
      );
    });

    await steps.step('both_devices_are_signers', async () => {
      const devicesB = await readDeviceList(walletB);
      const devicesA = await readDeviceList(walletA);
      expect(devicesB.commitments, 'the Devices page lists both hot keys').toHaveLength(2);
      expect(devicesB.current, 'B is a signer').not.toBeNull();
      expect(devicesA.current, 'A is still a signer after the add').not.toBeNull();
      expect(devicesA.current, 'A and B hold different hot keys').not.toBe(devicesB.current);
    });

    await steps.step('backup_reaches_the_local_worker', async () => {
      await assertBackupReachesWalletApi(walletA, walletApi);
      await assertBackupReachesWalletApi(walletB, walletApi);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
    });
  });
});
