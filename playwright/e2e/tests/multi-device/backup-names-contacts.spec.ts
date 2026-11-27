import { getEnvironmentConfig } from '../../config/environments';
import { WALLET_API_FAULTS, expect, test } from '../../fixtures/multi-device';
import { addContact, deleteContact, openSettingsDrawer } from '../../helpers/contacts-receive-settings';
import { expectNoFailedRows, setupSharedAccount, waitForBackupSettled } from '../../helpers/multi-device';
import {
  type ContactTriple,
  accountsRevision,
  contactEntry,
  contactNetworkCode,
  readCurrentAccountView,
  readStoredContactNetwork,
  renameContactFromAddressBook,
  renameCurrentAccount,
  waitForAccountsEntry,
  waitForAccountsUpload,
  waitForContactsOnServer,
  waitForCurrentAccountName
} from '../../helpers/multi-device-backup';

/**
 * The encrypted backup keeps the account name and the address book in step
 * between two devices of one Guardian account. The backup profile is keyed by
 * the recovery phrase (src/lib/backup/sync-key.ts), so A and B share it.
 *
 * Refresh events (src/lib/backup/refresh.ts, "There is no timer poll"):
 * - A rename reaches the server only on the renaming device's next unlock or
 *   foreground refresh (`refreshOnUnlock` is the only caller of
 *   `syncAccounts`). The peer reads it on its own next unlock or foreground.
 *   Here `reopen()` is that event: a page that opens on an unlocked service
 *   worker turns Ready, and the store sends the `unlock` refresh
 *   (`syncFromBackend` in src/lib/store/index.ts).
 * - A contact write uploads at once (`contacts-changed` from
 *   `Actions.updateSettings`). The peer reads when its address book opens
 *   (`address-book` from `AddressBook.tsx`).
 *
 * Each wait reads the state the wallet persists after an acknowledged request
 * (`backup_state_v1`), never the Worker.
 *
 * The wallet has no rename screen (the v0 UI revamp removed `EditAccountName`),
 * so the renames go through the store action `editAccountName`, the one rename
 * path the product keeps (`renameCurrentAccount`). The contacts go through the
 * real address-book screens.
 */

const NETWORK_CODE = contactNetworkCode(getEnvironmentConfig().name);

// Account names: at most 16 characters (ACCOUNT_NAME_PATTERN in src/app/defaults).
const NAME_FROM_A = 'Alpha Shared';
const NAME_FROM_B = 'Bravo Shared';
const NAME_A_ONLINE = 'Charlie Online';
const NAME_B_OFFLINE = 'Delta Offline';

// Any lowercase 0x address is a valid contact. It must not be one of the wallet's own accounts.
const CONTACT_ADDRESS = `0x${'0'.repeat(36)}b4c1`;
const CONTACT_NAME = 'Backup Friend';
const CONTACT_NAME_EDITED = 'Backup Friend Two';

test.describe('Encrypted backup: names and contacts', () => {
  test('account names and contacts follow the account between two devices', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    walletApi
  }) => {
    // The destination network that A stores for the `0x` contact. The backup entry carries it.
    let destination: string | undefined;
    const triple = (name: string): ContactTriple => contactEntry(name, CONTACT_ADDRESS, NETWORK_CODE, destination);

    await steps.step('create_on_a_and_add_b', async () => {
      await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
    });

    await steps.step('backups_settle', async () => {
      await waitForBackupSettled(walletA);
      await waitForBackupSettled(walletB);
      const onA = await waitForAccountsEntry(walletA);
      const onB = await waitForAccountsEntry(walletB);
      expect(onB.publicKey, 'one recovery phrase gives one backup profile on both devices').toBe(onA.publicKey);
    });

    await steps.step('rename_on_a_reaches_b', async () => {
      const before = await accountsRevision(walletA);
      await renameCurrentAccount(walletA, NAME_FROM_A);
      // The rename is local until A's next unlock or foreground refresh.
      await walletA.reopen();
      await waitForAccountsUpload(walletA, before);
      await walletB.reopen();
      await waitForCurrentAccountName(walletB, NAME_FROM_A);
    });

    await steps.step('rename_on_b_reaches_a', async () => {
      const before = await accountsRevision(walletB);
      await renameCurrentAccount(walletB, NAME_FROM_B);
      await walletB.reopen();
      await waitForAccountsUpload(walletB, before);
      await walletA.reopen();
      await waitForCurrentAccountName(walletA, NAME_FROM_B);
    });

    await steps.step('contact_added_on_a_reaches_b', async () => {
      await openSettingsDrawer(walletA, 'address-book');
      await addContact(walletA, { name: CONTACT_NAME, address: CONTACT_ADDRESS });
      destination = await readStoredContactNetwork(walletA, CONTACT_ADDRESS);
      await waitForContactsOnServer(walletA, [triple(CONTACT_NAME)]);

      await openSettingsDrawer(walletB, 'address-book');
      const row = walletB.page.getByTestId(`address-book-contact-${CONTACT_ADDRESS}`);
      await expect(row, 'B lists the contact that A added').toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText(CONTACT_NAME);
      expect(
        await readStoredContactNetwork(walletB, CONTACT_ADDRESS),
        'B stores the destination network that A stored for the contact'
      ).toBe(destination);
    });

    await steps.step('contact_edited_on_b_reaches_a', async () => {
      await renameContactFromAddressBook(walletB, CONTACT_ADDRESS, CONTACT_NAME_EDITED);
      await waitForContactsOnServer(walletB, [triple(CONTACT_NAME_EDITED)]);

      await openSettingsDrawer(walletA, 'address-book');
      const row = walletA.page.getByTestId(`address-book-contact-${CONTACT_ADDRESS}`);
      await expect(row, 'A shows the name that B gave the contact').toContainText(CONTACT_NAME_EDITED, {
        timeout: 60_000
      });
    });

    await steps.step('contact_deleted_on_a_leaves_b', async () => {
      await deleteContact(walletA, CONTACT_ADDRESS);
      await waitForContactsOnServer(walletA, []);

      await openSettingsDrawer(walletB, 'address-book');
      await expect(
        walletB.page.getByTestId(`address-book-contact-${CONTACT_ADDRESS}`),
        'B drops the contact that A deleted'
      ).toHaveCount(0, { timeout: 60_000 });
      await expect(walletB.page.getByTestId('address-book-empty')).toBeVisible();
    });

    await steps.step('concurrent_renames_end_on_the_newer_write', async () => {
      // B is offline for the wallet-api only. Both devices rename the account: A first, B later.
      await walletApi.armFault(walletB, WALLET_API_FAULTS.networkDown);

      const beforeA = await accountsRevision(walletA);
      await renameCurrentAccount(walletA, NAME_A_ONLINE);
      await walletA.reopen();
      await waitForAccountsUpload(walletA, beforeA);

      await renameCurrentAccount(walletB, NAME_B_OFFLINE);
      await walletB.reopen();
      // B's refresh tried and the fault answered it, so nothing of A's write reached B.
      await expect.poll(() => walletApi.faultHits(walletB), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      expect((await readCurrentAccountView(walletB))?.name, 'B keeps its own name while offline').toBe(NAME_B_OFFLINE);

      // Back online. The merge (src/lib/backup/features/accounts.ts) keeps the name with the larger `nlu`.
      // A device stamps `nlu` when its backup FIRST SEES the changed name (`nameMarkOf`): for B that is
      // this refresh, after A's upload, so B's write is the newer one and wins on both devices.
      await walletApi.clearFaults(walletB);
      const beforeB = await accountsRevision(walletB);
      await walletB.reopen();
      await waitForAccountsUpload(walletB, beforeB);
      expect((await readCurrentAccountView(walletB))?.name, 'B does not take the older name from A').toBe(
        NAME_B_OFFLINE
      );

      await walletA.reopen();
      await waitForCurrentAccountName(walletA, NAME_B_OFFLINE);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB);
    });
  });
});
