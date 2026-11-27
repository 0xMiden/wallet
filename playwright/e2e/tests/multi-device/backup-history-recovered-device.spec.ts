import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/multi-device';
import { expectNoFailedRows, setupSharedAccount, waitForBackupSettled } from '../../helpers/multi-device';
import {
  type ExpectedTransaction,
  joinAsAddedDevice,
  readHistoryRecords,
  readOnlyOwnRecord,
  waitForEachTransactionOnce,
  waitForGuardianHistoryPass
} from '../../helpers/multi-device-backup';

/**
 * Recovery on a third clean profile. A creates the account and claims its fee
 * funding; B joins with "Add this device" (a rotation). Then C recovers the
 * same recovery phrase on a clean profile, also with "Add this device".
 *
 * C's detached recovery applies the backup receipts of A and B first
 * (`restoreHistoryFromBackup` in src/lib/miden/back/guardian-recovery.ts),
 * then reads the Guardian history, which holds the same three transactions
 * (A's claim, B's rotation, C's rotation). The two sources must merge: each
 * transaction shows once, a peer's transaction keeps its backup receipt, and
 * C's own rotation stays C's own row.
 *
 * The Guardian pass matches a local row by its final commitment, read from
 * the row's result bytes, or else by its input and output notes
 * (`saveRecord` in src/lib/miden/back/guardian-history-recovery.ts). A backup
 * receipt carries no result bytes, so a receipt of a transaction with no
 * notes can only match by notes it does not have. This spec shows whether
 * that leaves a second row for B's rotation.
 */

const GUARDIAN_URL = getEnvironmentConfig().guardianUrl;

test.describe('Encrypted backup: history on a recovered device', () => {
  test('a third device recovered from the phrase holds each transaction once', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps
  }) => {
    // Three Guardian transactions on testnet (a claim and two rotations) and two recoveries through the real screens.
    test.setTimeout(1_200_000);

    let address = '';
    let phrase = '';
    const expected: ExpectedTransaction[] = [];

    await steps.step('create_on_a_and_add_b', async () => {
      const shared = await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
      address = shared.address;
      phrase = shared.phrase;
    });

    await steps.step('receipts_of_a_and_b_reach_the_server', async () => {
      await waitForBackupSettled(walletA);
      await waitForGuardianHistoryPass(walletB);
      await waitForBackupSettled(walletB);
      expected.push({ label: "A's claim", reference: await readOnlyOwnRecord(walletA, 'consume'), fromPeer: true });
      expected.push({
        label: "B's rotation",
        reference: await readOnlyOwnRecord(walletB, 'replace-hot-key'),
        fromPeer: true
      });
    });

    await steps.step('recover_on_c', async () => {
      await joinAsAddedDevice({ joiner: walletC, phrase, address, guardianUrl: GUARDIAN_URL });
      await waitForGuardianHistoryPass(walletC);
      expected.push({
        label: "C's rotation",
        reference: await readOnlyOwnRecord(walletC, 'replace-hot-key'),
        fromPeer: false
      });
    });

    await steps.step('c_holds_each_transaction_once', async () => {
      const problems = await waitForEachTransactionOnce(walletC, expected);
      expect(problems, "C's history: each transaction once, backup receipts kept").toEqual([]);
      const rows = await readHistoryRecords(walletC);
      expect(
        rows.filter(row => row.type === 'replace-hot-key'),
        'two rotations: B and C'
      ).toHaveLength(2);
      expect(
        rows.filter(row => row.type === 'consume'),
        "one claim: A's fee funding"
      ).toHaveLength(1);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletC);
    });
  });
});
