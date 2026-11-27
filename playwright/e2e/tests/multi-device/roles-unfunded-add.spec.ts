import { expect, test } from '../../fixtures/multi-device';
import { vaultBalanceByFaucetId, walletDiscoveredNativeFaucetId } from '../../helpers/balance-truth';
import { describeTransactionRow, readTransactionRows, TxStatus } from '../../helpers/history';
import {
  expectNoFailedRows,
  readDeviceList,
  readHistory,
  sameCommitment,
  waitForSignerCount,
  type DeviceList
} from '../../helpers/multi-device';
import { activationModeOfRow, activationRows, readWriteGuard } from '../../helpers/multi-device-roles';

/**
 * "Add this device" on an account whose vault holds no fee asset (#805).
 *
 * Device A creates the account and funds nothing. Then A's whole browser
 * stops, so A cannot claim the funding note with its own key (that is another
 * flow, as in `guardian-unfunded-recovery.spec.ts`). Device B recovers the
 * account with the recovery phrase and answers "Add this device". The add
 * cannot pay its fee, so the rotation gate shows its funding panel with the
 * account address. The harness then funds that address. The gate claims the
 * note with the recovery key and runs the add again, still in the add role.
 *
 * Then A's browser starts again from its profile. A is still a signer, and its
 * Devices page lists the same two hot keys as B's.
 */
test.describe('Multi-device roles: add on an unfunded account', () => {
  test('the add waits for fee funding, then adds the device and keeps the first one', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    envConfig
  }) => {
    let address = '';
    let phrase = '';
    let devicesB: DeviceList | undefined;

    await steps.step('create_on_a_without_funds', async () => {
      const created = await walletA.createGuardianWallet(envConfig.guardianUrl);
      expect(created.seedPhrase, 'the created account gives a 12-word recovery phrase').toHaveLength(12);
      address = created.address;
      phrase = created.seedPhrase.join(' ');
      await midenCli.init();
      // On a chain that charges nothing the add cannot fall short, and this test proves nothing.
      expect(await midenCli.chainCharges(), 'this test needs a fee-charging chain').toBe(true);
    });

    // Not in a step: a step's failure screenshot would target the page this closes.
    await walletA.killBrowser();

    await steps.step('recover_on_b_as_add_until_the_funding_panel', async () => {
      walletB.trackGuardianCommitments();
      await walletB.recoverGuardianFromSeed(phrase, {
        viaUI: true,
        guardianUrl: envConfig.guardianUrl,
        role: 'add',
        rotation: 'await-funding'
      });
      const funding = await walletB.waitForHotKeyRotationFunding();
      expect(funding.address, 'the funding panel shows the account address').toBe(address);
      await expect(walletB.page.getByTestId('hot-key-rotation-funding')).toHaveAttribute(
        'data-funding-reason',
        'rotation-shortfall',
        { timeout: 180_000 }
      );
      const rotations = activationRows(await readTransactionRows(walletB.page));
      expect(rotations.map(describeTransactionRow), 'the add ran once and fell short').toHaveLength(1);
      expect(rotations[0]?.status, 'the short add failed').toBe(TxStatus.Failed);
      expect(rotations.map(activationModeOfRow), 'the short row keeps the add role').toEqual(['add']);
      const nativeFaucetId = await walletDiscoveredNativeFaucetId(walletB.page);
      if (nativeFaucetId === null) throw new Error('B must discover the native fee faucet before funding');
      expect(await vaultBalanceByFaucetId(walletB.page, nativeFaucetId), 'the vault holds no fee asset').toBe(0n);
    });

    await steps.step('fund_the_account', async () => {
      await midenCli.fundAccountForFees(address);
    });

    await steps.step('the_gate_claims_and_adds_the_device', async () => {
      await walletB.completeHotKeyRotation({ fundingExpected: true, role: 'add', timeoutMs: 300_000 });
      const rows = await readTransactionRows(walletB.page);
      const claims = rows.filter(row => row.type === 'consume');
      expect(claims.map(describeTransactionRow), 'one claim: the gate funding claim').toHaveLength(1);
      expect(claims[0], 'the funding claim landed').toMatchObject({
        rotationFunding: true,
        status: TxStatus.Completed
      });
      const rotations = activationRows(rows).sort(
        (a, b) => (a.processingStartedAt ?? 0) - (b.processingStartedAt ?? 0)
      );
      expect(
        rotations.map(row => row.status),
        'one add fell short, the one after the claim landed'
      ).toEqual([TxStatus.Failed, TxStatus.Completed]);
      expect(rotations.map(activationModeOfRow), 'both rows keep the add role').toEqual(['add', 'add']);
      await waitForSignerCount(walletB, address, 3);
      devicesB = await readDeviceList(walletB);
      expect(devicesB.commitments, 'B lists both devices').toHaveLength(2);
      expect(devicesB.current, 'B is a signer').not.toBeNull();
    });

    await steps.step('the_first_device_is_still_a_signer', async () => {
      const relaunched = await walletA.reopen();
      expect(relaunched, 'killBrowser() must force the relaunch path of reopen()').toBe(true);
      // A was offline during the add: its Devices page shows both keys once it synced the account.
      await expect
        .poll(async () => (await readDeviceList(walletA)).commitments.length, {
          message: "A's Devices page lists both devices",
          timeout: 180_000
        })
        .toBe(2);
      const devicesA = await readDeviceList(walletA);
      if (devicesB === undefined || devicesA.current === null || devicesB.current === null) {
        throw new Error('both devices must be signers after the add');
      }
      expect(sameCommitment(devicesA.current, devicesB.current), 'each device marks its own key').toBe(false);
      for (const commitment of devicesA.commitments) {
        expect(
          devicesB.commitments.some(other => sameCommitment(other, commitment)),
          `both devices list ${commitment}`
        ).toBe(true);
      }
      expect(await readWriteGuard(walletA), 'A can still write').toEqual({ rotatedOut: false, blocked: false });
    });

    await steps.step('no_failed_rows_but_the_short_add', async () => {
      // The backup gives A a receipt of B's add that fell short, with its Failed status. A has no Failed row of its own.
      await expectNoFailedRows(walletA, row => !row.restoredFromBackup);
      // An empty list would pass an every() check, so the poll requires the receipt to arrive.
      await expect
        .poll(
          async () =>
            (await readHistory(walletA))
              .filter(row => row.restoredFromBackup && row.status === 'Failed')
              .map(row => row.type),
          { message: "the only Failed receipt A holds is B's short add", timeout: 120_000 }
        )
        .toEqual(['replace-hot-key']);
      // The one Failed row on B is the add that fell short, asserted above.
      await expectNoFailedRows(walletB, row => row.type !== 'replace-hot-key');
    });
  });
});
