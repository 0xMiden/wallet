import { getEnvironmentConfig } from '../../config/environments';
import { WALLET_API_FAULTS, expect, test } from '../../fixtures/multi-device';
import { addContact, openSettingsDrawer } from '../../helpers/contacts-receive-settings';
import { expectNoFailedRows, setupSharedAccount, waitForBackupSettled } from '../../helpers/multi-device';
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
 * Retry timing, as the code has it: there is none. The client does not read
 * `Retry-After` and retries nothing on a timer (src/lib/backup/api-client.ts
 * `send`/`failure`; refresh.ts "There is no timer poll"). A failed upload
 * stays dirty until the next event (an unlock, a foreground, the address book
 * or Activity opening, a completed row). The only timer is the re-read after
 * a Guardian adoption, and it stops after a read that failed. So under a 429
 * the device sends nothing until the user does something.
 */

const NETWORK_CODE = contactNetworkCode(getEnvironmentConfig().name);

const CONTACT_ADDRESS = `0x${'0'.repeat(36)}fa17`;
const CONTACT_NAME = 'Fault Contact';
const CONTACT_NAME_EDITED = 'Fault Contact Two';

// An idle window under a 429. A client that retried on its own would send a request every few seconds.
const OBSERVATION_MS = 45_000;
// A Guardian adoption on B can still start one history read in the window, and a CORS preflight can double it.
const MAX_REQUESTS_IN_IDLE_WINDOW = 4;

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
      const before = walletApi.requestCount(walletB);
      // An observation window, not a wait for state: it counts what an idle device sends under a 429.
      await walletB.page.waitForTimeout(OBSERVATION_MS);
      const sent = walletApi.requestCount(walletB) - before;
      expect(sent, `requests to the wallet-api in ${OBSERVATION_MS} ms of idle time under a 429`).toBeLessThanOrEqual(
        MAX_REQUESTS_IN_IDLE_WINDOW
      );
      expect(
        (await readBackupStateSnapshot(walletB))?.dirtyHistoryChunks.length,
        'nothing retried the upload in the window'
      ).toBeGreaterThanOrEqual(1);
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
