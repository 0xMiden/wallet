/**
 * Address book → send-to-contact → delete.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DOES
 *
 * Every existing send spec (`send-public`, `send-private`,
 * `send-public-local-prove`) drives the send through `WalletPage.sendTokens`,
 * which types the recipient address straight into `send-recipient-input`. The
 * address book, the contact picker, and the contact-name render on the recipient
 * step are therefore completely unexercised — a wallet that saved contacts under
 * the wrong address, listed them under the wrong name, or refused to delete them
 * would pass the entire existing suite.
 *
 * This spec walks the human path: save wallet B under a NAME, then choose that
 * NAME from the send flow's contact sheet, and prove the money landed in B.
 *
 * SCOPE NOTE — the review screen shows the ADDRESS, not the contact name.
 * `ReviewTransaction` parses `to` off `#/send/review?to=…` and performs no
 * contact lookup; `selectedContact` lives only in `SendManager` and only feeds
 * the recipient step. So the contact NAME is asserted where it actually renders
 * (`send-recipient-name`), and the review screen is asserted to carry B's EXACT
 * address. Asserting a contact name on review would require adding contact
 * resolution to the review route — a product change, not a test change.
 */
import { expect, test } from '../fixtures/two-wallets';
import { snapshotTransfer, type TransferSnapshot } from '../helpers/assertions';
import {
  fromBaseUnits,
  toBaseUnits,
  waitForPendingNoteTotal,
  waitForVaultBalance,
  waitForVaultDebit
} from '../helpers/balance-truth';
import {
  addContact,
  advanceToSendReview,
  deleteContact,
  listAddressBookContacts,
  listSendPickerContacts,
  openSendContactPicker,
  openSettingsDrawer,
  pickContactByName,
  submitSendReview
} from '../helpers/contacts-receive-settings';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// What `deploy_and_fund` mints to wallet A, in base units (= 1000 TST).
const MINT_BASE_UNITS = 100_000_000_000n;
const SEND_AMOUNT = '250';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);

// Deliberately not a substring of any other picker row's name, so "exactly one
// row carries this name" is a meaningful check.
const CONTACT_NAME = 'Wallet B Savings';

test.describe('Address Book send', () => {
  test.describe.configure({ mode: 'serial' });

  test('saves wallet B as a contact, sends to it by name, then deletes it', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    let addressA: string;
    let addressB: string;
    let beforeSend: TransferSnapshot;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
      // The address book silently drops any contact whose address matches one of
      // THIS wallet's own accounts (use-filtered-contacts.hook.ts deletes it during
      // render), so the contact under test has to be the other wallet.
      expect(addressA).not.toBe(addressB);
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step('sync_wallet_a', async () => {
      // The mint arrives as a NOTE — unconsumed, not yet spendable.
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(120_000);
      // claimAllNotes returns once the PENDING list reads empty; the balances
      // projection settles separately, and snapshotting before it does reads the
      // vault as 0 and makes the sender-debit assertion go negative.
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'save_wallet_b_as_contact',
      async () => {
        // Settings → Address Book is a DRAWER tab: a direct hash nav to
        // /settings/address-book falls back to the Settings root list and shows
        // nothing. openSettingsDrawer clicks the row, which is the only way in.
        await openSettingsDrawer(walletA, 'address-book');
        const row = await addContact(walletA, { name: CONTACT_NAME, address: addressB! });

        await expect(row).toContainText(CONTACT_NAME);
        expect(await listAddressBookContacts(walletA.page)).toContain(addressB!);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step(
      'pick_the_contact_by_name_on_send',
      async () => {
        await openSendContactPicker(walletA);

        const pickerRows = await listSendPickerContacts(walletA.page);
        expect(pickerRows).toContainEqual({ name: CONTACT_NAME, address: addressB! });

        // Picks by NAME and proves the name resolves to the address it was saved
        // under, that the recipient step renders the NAME, and that the address
        // landed in the recipient field.
        await pickContactByName(walletA, CONTACT_NAME, addressB!);
        await expect(walletA.page.getByTestId('send-recipient-name')).toHaveText(CONTACT_NAME);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step(
      'send_to_the_contact',
      async () => {
        beforeSend = await snapshotTransfer(
          { page: walletA.page, label: 'A' },
          { page: walletB.page, label: 'B' },
          TOKEN,
          TOKEN_DECIMALS
        );

        const review = await advanceToSendReview(walletA, {
          tokenSymbol: TOKEN,
          amount: SEND_AMOUNT,
          isPrivate: false
        });

        // The review route renders the raw address (no contact lookup lives on
        // this route) — assert the EXACT address the contact pick put on the wire,
        // both in the route params and on screen.
        expect(review.params.to).toBe(addressB!);
        expect(review.text).toContain(addressB!);

        await submitSendReview(walletA);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step(
      'verify_wallet_b_credited',
      async () => {
        // B never claims here, so the delivered public note is PENDING for B, not
        // spendable — the exact assertion belongs on the unconsumed-note total.
        await waitForPendingNoteTotal(walletB.page, TOKEN, beforeSend.toPending + SEND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });

        // The other half of a transfer: A must actually have been debited. At
        // least the sent amount, not exactly it — a fee may also leave.
        const debited = await waitForVaultDebit(walletA.page, TOKEN, beforeSend.fromVault, SEND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `Send-to-contact verified: picked "${CONTACT_NAME}" from the address book, ` +
            `B credited exactly ${SEND_AMOUNT} ${TOKEN} as an unconsumed note, ` +
            `A debited ${fromBaseUnits(debited, TOKEN_DECIMALS)} ${TOKEN}`,
          data: {
            symbol: TOKEN,
            contactName: CONTACT_NAME,
            sentBaseUnits: SEND_BASE_UNITS.toString(),
            senderVaultBefore: beforeSend.fromVault.toString(),
            recipientPendingBefore: beforeSend.toPending.toString()
          }
        });
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ],
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );

    await steps.step('delete_the_contact', async () => {
      await openSettingsDrawer(walletA, 'address-book');
      // Goes through the real ConfirmationModal — removeContact is gated on useConfirm().
      await deleteContact(walletA, addressB!);
      expect(await listAddressBookContacts(walletA.page)).not.toContain(addressB!);
    });

    await steps.step('deleted_contact_leaves_the_send_picker', async () => {
      await openSendContactPicker(walletA);

      const pickerRows = await listSendPickerContacts(walletA.page);
      expect(pickerRows.map(row => row.name)).not.toContain(CONTACT_NAME);
      expect(pickerRows.map(row => row.address)).not.toContain(addressB!);
      await expect(walletA.page.getByTestId(`send-contact-${addressB!}`)).toHaveCount(0);
    });
  });
});
