import { getEnvironmentConfig } from '../../config/environments';
import { WALLET_API_FAULTS, expect, test } from '../../fixtures/multi-device';
import { addContact, openSettingsDrawer } from '../../helpers/contacts-receive-settings';
import {
  expectNoFailedRows,
  requestBackupRefresh,
  setupSharedAccount,
  waitForBackupSettled
} from '../../helpers/multi-device';
import {
  type BackupHistoryRecord,
  type ContactTriple,
  contactEntry,
  contactNetworkCode,
  openActivity,
  readBackupStateSnapshot,
  readHistoryRecords,
  readStoreContacts,
  readStoredContactNetwork,
  renameContactFromAddressBook,
  sameTransaction,
  sendNativeTo,
  serverHoldsContacts,
  waitForContactsOnServer,
  waitForGuardianHistoryPass
} from '../../helpers/multi-device-backup';

/**
 * The wallet keeps working while the backup service fails, and the changes
 * it could not upload reach the other device once the service is back.
 *
 * B's wallet-api traffic gets, in turn, HTTP 500, HTTP 429 with
 * `Retry-After: 60`, and a refused connection. Under each fault B changes
 * something the backup syncs (a new contact, a send, a renamed contact). The
 * backup has no UI and never fails a transaction: every refresh returns an
 * outcome and never throws (src/lib/backup/refresh.ts), and a completed row
 * only signals a flush (`signalTransactionCompleted`).
 *
 * Retry timing, as the code has it: one timer. The client reads `Retry-After`
 * (src/lib/backup/api-client.ts `parseRetryAfterMs`). A failed refresh
 * schedules one retry in refresh.ts `scheduleBackupRetry`: 30 s, doubled after
 * each failed retry up to 30 min, and never sooner than the `Retry-After`. The
 * "There is no timer poll" sentence of refresh.ts means no periodic poll. The
 * Guardian re-reads at 10, 30 and 60 s run only after a history read that came
 * back unchanged, so a 429 does not start them. Under `Retry-After: 60` the
 * device sends nothing for 60 s after a failed refresh, then retries.
 */

const NETWORK_CODE = contactNetworkCode(getEnvironmentConfig().name);

const CONTACT_ADDRESS = `0x${'0'.repeat(36)}fa17`;
const CONTACT_NAME = 'Fault Contact';
const CONTACT_NAME_EDITED = 'Fault Contact Two';

// An idle window under a 429 with `Retry-After: 60`. It is past the 30 s retry floor and short of the 60 s backoff.
const OBSERVATION_MS = 45_000;

test.describe('Encrypted backup: service faults', () => {
  test('the wallet works through 500, 429 and a refused connection, and delivers the changes after', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps,
    walletApi
  }) => {
    let recipient = '';
    // The destination network that B stores for the `0x` contact. The backup entry carries it.
    let destination: string | undefined;

    await steps.step('recipient_wallet_on_c', async () => {
      recipient = (await walletC.createNewWallet()).address;
    });

    await steps.step('create_on_a_and_add_b', async () => {
      await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
    });

    await steps.step('backups_settle', async () => {
      await waitForBackupSettled(walletA);
      await waitForGuardianHistoryPass(walletB);
      await waitForBackupSettled(walletB);
    });

    await steps.step('server_error_contact_saves_locally', async () => {
      await walletApi.armFault(walletB, WALLET_API_FAULTS.serverError);
      // Opening the address book and saving the contact each start a contacts refresh; both get a 500.
      await openSettingsDrawer(walletB, 'address-book');
      await addContact(walletB, { name: CONTACT_NAME, address: CONTACT_ADDRESS });
      await expect.poll(() => walletApi.faultHits(walletB), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      expect(await readStoreContacts(walletB), 'the contact is saved on B').toContainEqual({
        name: CONTACT_NAME,
        address: CONTACT_ADDRESS
      });
      // The entry carries the destination network that B stores for the `0x` contact.
      destination = await readStoredContactNetwork(walletB, CONTACT_ADDRESS);
      const pending: ContactTriple = contactEntry(CONTACT_NAME, CONTACT_ADDRESS, NETWORK_CODE, destination);
      expect(serverHoldsContacts(await readBackupStateSnapshot(walletB), [pending]), 'no upload under a 500').toBe(
        false
      );
    });

    let sendRow: BackupHistoryRecord | undefined;

    await steps.step('rate_limited_send_completes_and_the_device_backs_off', async () => {
      await walletApi.armFault(walletB, WALLET_API_FAULTS.rateLimited(60));
      sendRow = await sendNativeTo(walletB, recipient, '0.01');
      await walletB.waitForGuardianSettled();
      // The completed row asked for a history flush, and the 429 answered it.
      await expect.poll(() => walletApi.faultHits(walletB), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      expect(
        (await readBackupStateSnapshot(walletB))?.dirtyHistoryChunks.length,
        "the send's receipt waits for the server"
      ).toBeGreaterThanOrEqual(1);

      await walletB.navigateHome();
      // A failed refresh restarts the retry timer at the 60 s Retry-After, so the window below ends before it.
      expect(await requestBackupRefresh(walletB, 'foreground'), 'the refresh meets the 429').toBe('failed');
      const before = walletApi.requestCount(walletB);
      // An observation window, not a wait for state: a dirty chunk stays dirty under a 429 whether or not a retry ran,
      // so only the count of attempts shows the backoff.
      await walletB.page.waitForTimeout(OBSERVATION_MS);
      expect(
        walletApi.requestCount(walletB) - before,
        `no wallet-api attempt in ${OBSERVATION_MS} ms of a 60 s backoff`
      ).toBe(0);
      // The timer retries once the 60 s have passed (the 429 still answers it, and the next wait is longer).
      await expect
        .poll(() => walletApi.requestCount(walletB) - before, {
          message: 'the device retries after the Retry-After has passed',
          timeout: 30_000
        })
        .toBeGreaterThan(0);
    });

    await steps.step('network_down_contact_edit_saves_locally', async () => {
      await walletApi.armFault(walletB, WALLET_API_FAULTS.networkDown);
      await openSettingsDrawer(walletB, 'address-book');
      await renameContactFromAddressBook(walletB, CONTACT_ADDRESS, CONTACT_NAME_EDITED);
      await expect.poll(() => walletApi.faultHits(walletB), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      expect(await readStoreContacts(walletB), 'the edit is saved on B').toContainEqual({
        name: CONTACT_NAME_EDITED,
        address: CONTACT_ADDRESS
      });
    });

    await steps.step('the_wallet_still_works', async () => {
      await expectNoFailedRows(walletB);
      expect(sendRow?.status, 'the send under the 429 completed').toBe('Completed');
      await walletB.navigateHome();
      await expect(walletB.page.getByTestId('command-shell'), 'the home surface is usable').toBeVisible();
    });

    await steps.step('clear_faults_and_deliver', async () => {
      await walletApi.clearFaults(walletB);
      // The next event after the outage: the wallet opens again, and its unlock refresh uploads what waited.
      await walletB.reopen();
      await waitForBackupSettled(walletB);
      await waitForContactsOnServer(walletB, [
        contactEntry(CONTACT_NAME_EDITED, CONTACT_ADDRESS, NETWORK_CODE, destination)
      ]);
    });

    await steps.step('a_receives_the_pending_changes', async () => {
      await openSettingsDrawer(walletA, 'address-book');
      await expect(
        walletA.page.getByTestId(`address-book-contact-${CONTACT_ADDRESS}`),
        'A lists the contact as B last named it'
      ).toContainText(CONTACT_NAME_EDITED, { timeout: 60_000 });

      // A's Guardian adoption of B's send may have read the history while B could not upload. Activity
      // opening is the next history event.
      await openActivity(walletA);
      const reference = sendRow;
      if (reference === undefined) throw new Error('no send row from B');
      await expect
        .poll(
          async () =>
            (await readHistoryRecords(walletA)).filter(
              row => sameTransaction(row, reference) && row.restoredFromBackup && row.status === 'Completed'
            ).length,
          { message: "B's send receipt on A", timeout: 120_000 }
        )
        .toBe(1);
      await expectNoFailedRows(walletA);
    });
  });
});
