import { expect, test } from '../../fixtures/multi-device';
import { walletDiscoveredNativeFaucetId } from '../../helpers/balance-truth';
import { describeTransactionRow, readTransactionRows, TxStatus } from '../../helpers/history';
import {
  expectNoFailedRows,
  readDeviceList,
  readDeviceRoleStep,
  recoverToDeviceRoleStep,
  sameCommitment,
  waitForSignerCount,
  type DeviceList,
  type SignerSet
} from '../../helpers/multi-device';
import {
  activationModeOfRow,
  activationRows,
  createFundedGuardianAccount,
  pressDeviceRoleContinue,
  waitForTerminalRow
} from '../../helpers/multi-device-roles';
import { mintFromPublicFaucet, publicFaucetApiUrl } from '../../helpers/public-faucet';
import { pendingNoteIds, setAutoConsume } from '../../helpers/test-dapp';

/** en.json `chooseDeviceRoleDevice`: the count line when one device holds the wallet. */
const ONE_DEVICE_LINE = 'You already have 1 device with this wallet';
/** A small public send of the native asset (USDCX on testnet, 6 decimals). */
const SEND_AMOUNT = '0.1';

/**
 * "Add this device": a second device joins a Guardian account and the first
 * device stays.
 *
 * Device A creates the account. Device B recovers it with the recovery phrase
 * and stops at the device-role step. The step selects "Add this device" by
 * default, so B presses Continue without a choice. The chain then holds three
 * signers (A's hot key, B's hot key, the cold key) and keeps every threshold.
 *
 * Each device then signs a transaction with its own key: B claims a native note
 * (A's automatic claim is off, so only B can take it), and A sends a native note
 * to a third wallet. The other device makes no row for that transaction.
 *
 * Both devices then reopen. Settings > Devices on each lists the same two hot
 * keys, and each marks its own key "This device" (membership, never a slot:
 * repo CLAUDE.md, "Signer identity is membership, never a slot").
 *
 * Wallet C is only the recipient of A's send: a private account with no Guardian.
 */
test.describe('Multi-device roles: add this device', () => {
  test('an added device keeps the first one, both sign with their own keys, both survive a reopen', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps,
    envConfig
  }) => {
    let address = '';
    let phrase = '';
    let before: SignerSet | undefined;
    let devicesBefore: DeviceList | undefined;
    let recipient = '';

    await steps.step('create_and_fund_on_a', async () => {
      const account = await createFundedGuardianAccount(walletA, midenCli, envConfig.guardianUrl);
      address = account.address;
      phrase = account.phrase;
      before = await waitForSignerCount(walletA, address, 2);
      devicesBefore = await readDeviceList(walletA);
      expect(devicesBefore.commitments, 'a created account has one device').toHaveLength(1);
      expect(devicesBefore.current, 'the creator is a signer').not.toBeNull();
      // The recipient of A's send later. A private account needs no funds to receive.
      recipient = (await walletC.createNewWallet()).address;
    });

    await steps.step('recover_on_b_to_the_role_step', async () => {
      walletB.trackGuardianCommitments();
      await recoverToDeviceRoleStep(walletB, phrase);
      const view = await readDeviceRoleStep(walletB);
      expect(view.selected, '"Add this device" is the default role').toBe('add');
      // The count line needs a non-blocking chain read, which can be busy; it is not the subject here.
      await expect
        .soft(walletB.page.getByTestId('choose-device-role'), 'the step names the one device that holds the wallet')
        .toContainText(ONE_DEVICE_LINE);
    });

    await steps.step('continue_with_the_default_role', async () => {
      // No option is clicked: Continue takes the default.
      await pressDeviceRoleContinue(walletB);
      await walletB.completeHotKeyRotation({ role: 'add', timeoutMs: 300_000 });
      expect(await walletB.getAccountAddress(), 'the recovery phrase restores the same account').toBe(address);
      const rotations = activationRows(await readTransactionRows(walletB.page));
      expect(rotations.map(describeTransactionRow), 'one activation row').toHaveLength(1);
      expect(rotations.map(activationModeOfRow), 'the default role queued an add').toEqual(['add']);
      expect(rotations[0]?.status, 'the add landed').toBe(TxStatus.Completed);
      await walletB.waitForGuardianSettled();
    });

    await steps.step('chain_holds_three_signers', async () => {
      if (before === undefined) throw new Error('no signer set before the add');
      const onB = await waitForSignerCount(walletB, address, 3);
      const onA = await waitForSignerCount(walletA, address, 3);
      // An add changes only the signer list.
      expect(onB.threshold, 'the default threshold stays').toBe(before.threshold);
      expect(onB.procedureThresholds, 'every procedure threshold stays').toEqual(before.procedureThresholds);
      expect(onA.threshold, 'both devices read the same threshold').toBe(onB.threshold);
      for (const kept of before.commitments) {
        expect(
          onB.commitments.some(commitment => sameCommitment(commitment, kept)),
          `the add keeps the signer ${kept}`
        ).toBe(true);
      }
    });

    await steps.step('b_claims_a_note_with_its_own_key', async () => {
      const faucetApi = publicFaucetApiUrl(envConfig.name);
      if (faucetApi === undefined) throw new Error(`E2E_NETWORK=${envConfig.name} has no public faucet`);
      // Only B may claim: A's automatic claim of native notes is off, and A never presses Accept.
      await setAutoConsume(walletA, false);
      const { noteId } = await mintFromPublicFaucet(faucetApi, address);
      // B's own automatic claim can take the note first; then this finds nothing, which is fine.
      await walletB.claimAllNotes(180_000).catch(() => undefined);
      const claim = await waitForTerminalRow(
        walletB.page,
        row => row.type === 'consume' && (row.noteIds ?? []).some(id => sameCommitment(id, noteId)),
        `B's claim of ${noteId}`,
        300_000
      );
      expect(claim.status, `B's claim must land: ${describeTransactionRow(claim)}`).toBe(TxStatus.Completed);
      expect(claim.transactionId, 'the claim has an on-chain transaction').toBeTruthy();
      const claimsOnA = (await readTransactionRows(walletA.page)).filter(
        row => row.type === 'consume' && (row.noteIds ?? []).some(id => sameCommitment(id, noteId))
      );
      expect(claimsOnA.map(describeTransactionRow), 'A made no claim of the note').toEqual([]);
      // A follows B's claim: the note leaves A's pending list.
      await expect
        .poll(async () => (await pendingNoteIds(walletA.page)).some(id => sameCommitment(id, noteId)), {
          message: 'A no longer lists the note B claimed',
          timeout: 180_000
        })
        .toBe(false);
      await walletB.waitForGuardianSettled();
    });

    await steps.step('a_sends_a_note_with_its_own_key', async () => {
      const nativeFaucetId = await walletDiscoveredNativeFaucetId(walletA.page);
      if (nativeFaucetId === null) throw new Error('A has not discovered the native fee faucet');
      await walletA.sendTokens({
        recipientAddress: recipient,
        amount: SEND_AMOUNT,
        isPrivate: false,
        tokenId: nativeFaucetId
      });
      const send = await waitForTerminalRow(
        walletA.page,
        row => row.type === 'send' && row.secondaryAccountId === recipient,
        `A's send to ${recipient}`,
        300_000
      );
      expect(send.status, `A's send must land: ${describeTransactionRow(send)}`).toBe(TxStatus.Completed);
      expect(send.transactionId, 'the send has an on-chain transaction').toBeTruthy();
      const sendsOnB = (await readTransactionRows(walletB.page)).filter(
        row => row.type === 'send' && row.secondaryAccountId === recipient
      );
      expect(sendsOnB.map(describeTransactionRow), 'B made no send').toEqual([]);
      await walletA.waitForGuardianSettled();
    });

    await steps.step('both_devices_survive_a_reopen', async () => {
      await walletA.reopen();
      await walletB.reopen();
      // The rotation finished before the reopen: neither the gate nor the role step comes back.
      await expect(walletB.page.getByTestId('hot-key-rotation-gate')).toHaveCount(0);
      await expect(walletB.page.getByTestId('choose-device-role')).toHaveCount(0);

      const onA = await readDeviceList(walletA);
      const onB = await readDeviceList(walletB);
      const signers = await waitForSignerCount(walletA, address, 3);
      expect(onA.commitments, 'A lists both devices').toHaveLength(2);
      expect(onB.commitments, 'B lists both devices').toHaveLength(2);
      for (const commitment of onA.commitments) {
        expect(
          onB.commitments.some(other => sameCommitment(other, commitment)),
          `both devices list ${commitment}`
        ).toBe(true);
      }
      if (onA.current === null || onB.current === null) {
        throw new Error(`each device must mark itself: A ${onA.current ?? 'none'}, B ${onB.current ?? 'none'}`);
      }
      expect(sameCommitment(onA.current, onB.current), 'each device marks its own key').toBe(false);
      const createdKey = devicesBefore?.current ?? '';
      expect(sameCommitment(onA.current, createdKey), 'A keeps the hot key it was created with').toBe(true);
      for (const own of [onA.current, onB.current]) {
        expect(
          signers.commitments.some(commitment => sameCommitment(commitment, own)),
          `${own} is a signer on chain`
        ).toBe(true);
      }
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
    });
  });
});
