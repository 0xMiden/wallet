import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/multi-device';
import {
  expectNoFailedRows,
  readDeviceList,
  readSignerSet,
  sameCommitment,
  setupSharedAccount,
  waitForSignerCount,
  type SignerSet
} from '../../helpers/multi-device';
import { fetchGuardianCommitment, readWriteGuard, sameEndpoint } from '../../helpers/multi-device-roles';

/**
 * A Guardian switch on a three-signer account, started from the added device.
 *
 * Device A creates the account on Guardian operator A (`envConfig.guardianUrl`)
 * and device B joins with "Add this device". B then switches the account to
 * operator B (`envConfig.guardianUrlB`) through Settings, as
 * `guardian-switch.spec.ts` does for one device. The switch changes only the
 * Guardian commitment on chain: the three signers and every threshold stay.
 *
 * Device A did not make the switch. It follows on its own: its drift
 * reconciliation (`resolveGuardianDrift`, `back/guardian-drift.ts`) sees the new
 * commitment on chain, finds the built-in operator that serves it, and stores
 * that operator's endpoint. A's hot key then reads the account from operator B,
 * which proves that the switch registered A's key there too.
 *
 * Skipped on a network with one Guardian operator.
 */
// Skip, not throw: a second operator is a property of the network (see guardian-switch.spec.ts).
const HAS_SECOND_OPERATOR = Boolean(getEnvironmentConfig().guardianUrlB);

test.describe('Multi-device roles: Guardian switch on a three-signer account', () => {
  test.skip(!HAS_SECOND_OPERATOR, 'this network has no second Guardian operator');

  test('the added device switches the Guardian, and the other device follows', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    envConfig
  }) => {
    const operatorA = envConfig.guardianUrl;
    const operatorB = envConfig.guardianUrlB ?? '';
    let address = '';
    let before: SignerSet | undefined;
    let commitmentB = '';

    await steps.step('create_on_a_and_add_b', async () => {
      address = (await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' })).address;
      before = await waitForSignerCount(walletB, address, 3);
      const commitmentA = await fetchGuardianCommitment(operatorA);
      commitmentB = await fetchGuardianCommitment(operatorB);
      expect(sameCommitment(commitmentA, commitmentB), 'the two operators must be distinct').toBe(false);
      expect(sameCommitment(before.guardianCommitment ?? '', commitmentA), 'the account starts on operator A').toBe(
        true
      );
    });

    await steps.step('switch_from_the_added_device', async () => {
      if (before === undefined) throw new Error('no signer set before the switch');
      await walletB.switchGuardian(operatorB);
      const chainNamesOperatorB = async (): Promise<boolean> =>
        sameCommitment((await readSignerSet(walletB, address)).guardianCommitment ?? '', commitmentB);
      await expect.poll(chainNamesOperatorB, { message: 'the chain names operator B', timeout: 180_000 }).toBe(true);
      const after = await readSignerSet(walletB, address);
      expect(after.signerCount, 'the switch keeps the three signers').toBe(3);
      expect(after.threshold, 'the switch keeps the default threshold').toBe(before.threshold);
      expect(after.procedureThresholds, 'the switch keeps every procedure threshold').toEqual(
        before.procedureThresholds
      );
      for (const kept of before.commitments) {
        expect(
          after.commitments.some(commitment => sameCommitment(commitment, kept)),
          `the switch keeps the signer ${kept}`
        ).toBe(true);
      }
      expect(sameEndpoint(await walletB.currentGuardianEndpoint(), operatorB), 'B stores operator B').toBe(true);
    });

    await steps.step('the_first_device_follows', async () => {
      await expect
        .poll(async () => sameEndpoint(await walletA.currentGuardianEndpoint(), operatorB), {
          message: "A's drift reconciliation stores operator B",
          timeout: 300_000,
          intervals: [5_000]
        })
        .toBe(true);
      expect(
        sameCommitment((await readSignerSet(walletA, address)).guardianCommitment ?? '', commitmentB),
        'A reads operator B on chain'
      ).toBe(true);
      expect(await readWriteGuard(walletA), 'A can write on operator B').toEqual({ rotatedOut: false, blocked: false });
      // A read with A's own hot key: operator B serves the account to A.
      const view = await walletA.guardianOperatorView(address, operatorB);
      expect(view.error, 'operator B accepts the hot key of A').toBeUndefined();
      expect(view.commitment, 'operator B holds the account state').toBeTruthy();
    });

    await steps.step('both_devices_after_a_reopen', async () => {
      await walletA.reopen();
      await walletB.reopen();
      expect(sameEndpoint(await walletA.currentGuardianEndpoint(), operatorB), 'A keeps operator B').toBe(true);
      expect(sameEndpoint(await walletB.currentGuardianEndpoint(), operatorB), 'B keeps operator B').toBe(true);
      const devicesA = await readDeviceList(walletA);
      const devicesB = await readDeviceList(walletB);
      expect(devicesA.commitments, 'A lists both devices').toHaveLength(2);
      expect(devicesB.commitments, 'B lists both devices').toHaveLength(2);
      expect(devicesA.current, 'A is a signer').not.toBeNull();
      expect(devicesB.current, 'B is a signer').not.toBeNull();
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
    });
  });
});
