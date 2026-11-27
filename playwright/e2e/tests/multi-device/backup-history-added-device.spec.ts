import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/multi-device';
import { ensureFeeFunded } from '../../helpers/fee-funding';
import { expectNoFailedRows, waitForBackupSettled, waitForSignerCount } from '../../helpers/multi-device';
import {
  type ExpectedTransaction,
  joinAsAddedDevice,
  readOnlyOwnRecord,
  sendNativeTo,
  waitForEachTransactionOnce,
  waitForGuardianHistoryPass
} from '../../helpers/multi-device-backup';

/**
 * History on an added device. Device A makes a claim (the fee funding) and a
 * send. Then device B recovers the account with the recovery phrase and
 * answers "Add this device". B's detached recovery applies A's backup receipts
 * first (`restoreHistoryFromBackup`), then the Guardian history pass
 * (`recoverGuardianHistory`), which must keep each receipt and add no second
 * row for a transaction that B already holds (src/lib/backup/features/
 * history.ts `applyHistoryRows`, src/lib/miden/back/guardian-history-recovery.ts
 * `saveRecord`). Then A makes one more send, and B shows it: B's Guardian sync
 * adopts A's new state and reads the history (`signalGuardianStateAdopted`,
 * then re-reads after 10, 30 and 60 s while nothing new arrived).
 *
 * The sends go to a plain wallet on a third profile, so the recipient address
 * is a real account of this network.
 */

const GUARDIAN_URL = getEnvironmentConfig().guardianUrl;

// Display amounts of the native fee asset. Different amounts tell the two sends apart in a failure.
const FIRST_SEND = '0.01';
const SECOND_SEND = '0.02';

test.describe('Encrypted backup: history on an added device', () => {
  test("an added device holds the first device's receipts once each and follows its next send", async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps
  }) => {
    // Four Guardian transactions on testnet (a claim, two sends, a rotation) and a recovery through the real screens.
    test.setTimeout(1_200_000);

    let recipient = '';
    let address = '';
    let phrase = '';
    const expected: ExpectedTransaction[] = [];

    await steps.step('recipient_wallet_on_c', async () => {
      recipient = (await walletC.createNewWallet()).address;
    });

    await steps.step('create_and_fund_on_a', async () => {
      const created = await walletA.createGuardianWallet(GUARDIAN_URL);
      expect(created.seedPhrase, 'the Guardian account gives a 12-word recovery phrase').toHaveLength(12);
      address = created.address;
      phrase = created.seedPhrase.join(' ');
      walletA.trackGuardianCommitments();
      // The funding claim is A's first transaction: a consume of the faucet note.
      const funded = await ensureFeeFunded(midenCli, walletA, address);
      if (funded > 0n) await walletA.waitForGuardianSettled();
    });

    await steps.step('send_on_a_before_b_joins', async () => {
      const claim = await readOnlyOwnRecord(walletA, 'consume');
      const send = await sendNativeTo(walletA, recipient, FIRST_SEND);
      await walletA.waitForGuardianSettled();
      // B restores what the server holds when it joins: A's receipts must be there first.
      await waitForBackupSettled(walletA);
      expected.push({ label: "A's claim", reference: claim, fromPeer: true });
      expected.push({ label: "A's first send", reference: send, fromPeer: true });
    });

    await steps.step('add_b', async () => {
      await joinAsAddedDevice({ joiner: walletB, phrase, address, guardianUrl: GUARDIAN_URL });
      await waitForGuardianHistoryPass(walletB);
      await waitForBackupSettled(walletB);
      const rotation = await readOnlyOwnRecord(walletB, 'replace-hot-key');
      expected.push({ label: "B's rotation", reference: rotation, fromPeer: false });
    });

    await steps.step('b_holds_each_transaction_once', async () => {
      const problems = await waitForEachTransactionOnce(walletB, expected);
      expect(problems, "B's history: each transaction once, A's as backup receipts").toEqual([]);
    });

    await steps.step('next_send_on_a_reaches_b', async () => {
      // A must hold the signer set that B's rotation wrote before it proposes again.
      await waitForSignerCount(walletA, address, 3);
      const send = await sendNativeTo(walletA, recipient, SECOND_SEND);
      await walletA.waitForGuardianSettled();
      await waitForBackupSettled(walletA);
      expected.push({ label: "A's second send", reference: send, fromPeer: true });
      // No UI action on B: its Guardian sync adoption and the re-reads after it must bring the receipt.
      const problems = await waitForEachTransactionOnce(walletB, expected, 240_000);
      expect(problems, "B's history after A's next send").toEqual([]);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
    });
  });
});
