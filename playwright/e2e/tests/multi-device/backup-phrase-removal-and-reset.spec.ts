import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/multi-device';
import { addContact, openSettingsDrawer } from '../../helpers/contacts-receive-settings';
import { openForgotPasswordFlow } from '../../helpers/forgot-password';
import {
  answerRecoveryPhraseKeepPrompt,
  expectNoFailedRows,
  readRecoveryPhraseStatus,
  requestBackupRefresh,
  setupSharedAccount,
  waitForBackupSettled,
  waitForRecoveryPhraseKeepPrompt
} from '../../helpers/multi-device';
import {
  accountsRevision,
  contactEntry,
  contactNetworkCode,
  importPublicWalletFromReset,
  openActivity,
  readBackupStateSnapshot,
  readCurrentAccountView,
  readHistoryRecords,
  readStoreAccountNames,
  readStoreContacts,
  readStoredContactNetwork,
  renameCurrentAccount,
  waitForAccountsUpload,
  waitForContactsOnServer,
  waitForCurrentAccountName,
  waitForStoreContacts
} from '../../helpers/multi-device-backup';
import { PASSWORD } from '../../helpers/wallet-page';

/**
 * The backup after the recovery phrase leaves a device, after a lock, and
 * after a wallet reset.
 *
 * Recovery phrase removed. The sync key comes from the recovery phrase
 * (src/lib/backup/sync-key.ts), but the vault stores it in its own entry the
 * first time it is used (`withSyncSecretKey` in src/lib/miden/back/vault.ts),
 * and `removeSeedPhrase` stores it before it removes the phrase ("so the
 * backup continues to work after the removal"). So B keeps the same profile
 * and keeps syncing. The lock and unlock below prove it: the unlock opens a new
 * session, which must sign the login with the stored key.
 *
 * Lock and unlock. A lock drops the session keys (`onBackupLock`). While B is
 * locked, A changes a contact and the account name. The unlock refresh
 * (`refreshBackup('unlock')` from the store's Ready transition) brings both,
 * with no other screen opened on B.
 *
 * Wallet reset. B signs out through the forgot-password flow and imports a
 * DIFFERENT recovery phrase as a public account. The spawn wipes storage
 * (`clearStorage`, which also drops the backup state and device id through
 * `onBackupStorageCleared`) and the transaction table. The new wallet has a
 * new sync key, so a new, empty profile: it shows none of the old names,
 * contacts or receipts, and it writes nothing to the old profile.
 *
 * The account rename goes through the store action `editAccountName`, the one
 * rename path the product keeps (it has no rename screen).
 */

const NETWORK_CODE = contactNetworkCode(getEnvironmentConfig().name);

const SHARED_NAME = 'Locked Rename';
const CONTACT_ADDRESS = `0x${'0'.repeat(36)}10c4`;
const CONTACT_NAME = 'Locked Contact';

test.describe('Encrypted backup: recovery phrase removal, lock and reset', () => {
  test('a device without its recovery phrase keeps syncing, and a reset wallet starts a clean profile', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    let address = '';
    let sharedKey = '';

    await steps.step('create_on_a_and_add_b_leaving_the_keep_sheet', async () => {
      const shared = await setupSharedAccount({
        creator: walletA,
        joiner: walletB,
        midenCli,
        role: 'add',
        recoveryPhrasePrompt: 'leave'
      });
      address = shared.address;
    });

    await steps.step('remove_the_recovery_phrase_on_b', async () => {
      await waitForRecoveryPhraseKeepPrompt(walletB);
      await answerRecoveryPhraseKeepPrompt(walletB, 'remove');
      await expect.poll(() => readRecoveryPhraseStatus(walletB), { timeout: 60_000 }).toBe('removed');
    });

    await steps.step('b_keeps_the_same_profile', async () => {
      await waitForBackupSettled(walletA);
      await waitForBackupSettled(walletB);
      const onA = await readBackupStateSnapshot(walletA);
      const onB = await readBackupStateSnapshot(walletB);
      sharedKey = onA?.publicKey ?? '';
      expect(onB?.publicKey, 'B still syncs with the profile of the recovery phrase').toBe(sharedKey);
      // The open session of this unlock still holds its keys; the lock below makes the next one sign again.
      expect(['updated', 'unchanged']).toContain(await requestBackupRefresh(walletB, 'foreground'));
    });

    await steps.step('lock_b_change_on_a_unlock_b', async () => {
      await walletB.lockWallet();

      await openSettingsDrawer(walletA, 'address-book');
      await addContact(walletA, { name: CONTACT_NAME, address: CONTACT_ADDRESS });
      // The entry carries the destination network that A stores for the `0x` contact.
      const destination = await readStoredContactNetwork(walletA, CONTACT_ADDRESS);
      await waitForContactsOnServer(walletA, [contactEntry(CONTACT_NAME, CONTACT_ADDRESS, NETWORK_CODE, destination)]);
      const before = await accountsRevision(walletA);
      await renameCurrentAccount(walletA, SHARED_NAME);
      await walletA.reopen();
      await waitForAccountsUpload(walletA, before);

      // The unlock opens a new backup session: B signs the login with the sync key the vault stored.
      await walletB.unlockWallet();
      await waitForStoreContacts(
        walletB,
        contacts => contacts.some(contact => contact.address === CONTACT_ADDRESS && contact.name === CONTACT_NAME),
        "A's contact on B after the unlock"
      );
      await waitForCurrentAccountName(walletB, SHARED_NAME);
      expect(await readRecoveryPhraseStatus(walletB), 'the phrase stays removed').toBe('removed');
      expect((await readBackupStateSnapshot(walletB))?.publicKey, 'the same profile after the unlock').toBe(sharedKey);
    });

    let profileEtagBefore: string | null = null;

    await steps.step('a_backup_before_the_reset', async () => {
      await waitForBackupSettled(walletB);
      // One refresh, for its outcome: it brings A's record of the profile ETag up to the server's.
      await requestBackupRefresh(walletA, 'foreground');
      profileEtagBefore = (await readBackupStateSnapshot(walletA))?.profileEtag ?? null;
      expect(profileEtagBefore, 'A recorded the profile ETag').not.toBeNull();
    });

    await steps.step('reset_b_and_import_another_wallet', async () => {
      await walletB.lockWallet();
      await openForgotPasswordFlow(walletB);
      await importPublicWalletFromReset(walletB, generateMnemonic(wordlist), PASSWORD);
    });

    await steps.step('the_new_wallet_shows_nothing_of_the_old_profile', async () => {
      const newAccount = await readCurrentAccountView(walletB);
      expect(newAccount?.publicKey, 'the import made another account').not.toBe(address);
      // The new wallet's unlock refresh opens a session on its own profile.
      await expect
        .poll(
          async () => {
            const snapshot = await readBackupStateSnapshot(walletB);
            return snapshot !== null && snapshot.salt !== null && snapshot.publicKey !== sharedKey;
          },
          { message: 'a backup session on the new profile', timeout: 120_000 }
        )
        .toBe(true);

      // Both product reads of the new profile: the address book and Activity.
      await openSettingsDrawer(walletB, 'address-book');
      await expect(walletB.page.getByTestId(`address-book-contact-${CONTACT_ADDRESS}`)).toHaveCount(0);
      await expect(walletB.page.getByTestId('address-book-empty'), 'no contact of the old profile').toBeVisible();
      await openActivity(walletB);

      expect(await readStoreContacts(walletB), 'no contact of the old profile').toEqual([]);
      expect(await readStoreAccountNames(walletB), 'no name of the old profile').not.toContain(SHARED_NAME);
      expect(await readHistoryRecords(walletB), 'no receipt of the old profile: the new wallet made nothing').toEqual(
        []
      );
    });

    await steps.step('a_backup_is_unchanged', async () => {
      // A 304 on the profile index: nobody wrote to the old profile since A's last refresh.
      expect(await requestBackupRefresh(walletA, 'foreground')).toBe('unchanged');
      expect((await readBackupStateSnapshot(walletA))?.profileEtag, 'the old profile ETag').toBe(profileEtagBefore);
      expect(await readStoreContacts(walletA)).toContainEqual({ name: CONTACT_NAME, address: CONTACT_ADDRESS });
      expect((await readCurrentAccountView(walletA))?.name).toBe(SHARED_NAME);
    });

    await steps.step('no_failed_rows', async () => {
      await expectNoFailedRows(walletA);
    });
  });
});
