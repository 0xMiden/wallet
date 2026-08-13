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
 * NAME from the send flow's contact sheet, and prove the address the product put
 * on the wire is B's.
 *
 * WHERE THIS SPEC STOPS, AND WHY IT DOES NOT SUBMIT
 *
 * It ends at the review route rather than broadcasting. `send-public.spec.ts`
 * already proves review → chain → recipient credited → sender debited, in full,
 * with exact base-unit assertions, for an address that was TYPED. Re-running
 * that mint/claim/prove/send/deliver cycle here would re-prove it for an address
 * that arrived a different way, at the cost of the slowest thing in the suite on
 * a `workers: 1` live-chain config. The genuinely new hop is contact → recipient
 * field → review query string, and that is what is asserted:
 * `review.params.to === addressB`, exactly, plus the address rendered on screen.
 *
 * The mint and claim that remain are NOT coverage — they are the precondition
 * for reaching review at all. `SendManager` errors the amount field when it
 * exceeds `token.balance` and disables Confirm, and the token picker only lists
 * tokens with a settled vault balance, so an unfunded wallet cannot leave the
 * amount step.
 *
 * SCOPE NOTE — the review screen shows the ADDRESS, not the contact name.
 * `ReviewTransaction` parses `to` off `#/send/review?to=…` and performs no
 * contact lookup; `selectedContact` lives only in `SendManager` and only feeds
 * the recipient step. So the contact NAME is asserted where it actually renders
 * (`send-recipient-name`, inside `pickContactByName`), and the review screen is
 * asserted to carry B's EXACT address. Asserting a contact name on review would
 * require adding contact resolution to the review route — a product change, not
 * a test change.
 */
import { expect, test } from '../fixtures/two-wallets';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import {
  addContact,
  advanceToSendReview,
  deleteContact,
  listSendPickerContacts,
  openSendContactPicker,
  openSettingsDrawer,
  pickContactByName,
  reloadWallet
} from '../helpers/contacts-receive-settings';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// What `deploy_and_fund` mints to wallet A, in base units (= 1000 TST).
const MINT_BASE_UNITS = 100_000_000_000n;
// Nominal: nothing is broadcast, so the value only has to clear the amount
// field's `<= balance` validation.
const SEND_AMOUNT = '1';

// Deliberately not a substring of any other picker row's name, so "exactly one
// row carries this name" is a meaningful check.
const CONTACT_NAME = 'Wallet B Savings';

test.describe('Address Book send', () => {
  test.describe.configure({ mode: 'serial' });

  test('saves wallet B as a contact, addresses a send to it by name, then deletes it', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // Above the sum of this test's own waits (240s of explicit timeoutMs,
    // plus the UI waits). It previously ran under the config's 300s default and
    // died mid-click with "Target page, context or browser has been closed" —
    // the test timeout tearing the context down before any wait could report
    // what it was waiting for.
    test.setTimeout(600_000);
    let addressA: string;
    let addressB: string;

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
      // projection settles separately, and the amount step reads THAT — typing an
      // amount before it lands trips the `<= balance` validation and disables
      // Confirm on a wallet that is actually funded.
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
        // addContact's own postcondition is the row rendering under this exact
        // name and address; re-asserting it here would just re-read what it
        // already threw on.
        await addContact(walletA, { name: CONTACT_NAME, address: addressB! });
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step(
      'pick_the_contact_by_name_on_send',
      async () => {
        await openSendContactPicker(walletA);

        // Polled: the sheet's container mounts a commit before its rows, and a
        // one-shot evaluateAll on a plain array does not retry, so reading once
        // here fails on a healthy wallet.
        await expect
          .poll(() => listSendPickerContacts(walletA.page), { timeout: 15_000 })
          .toContainEqual({ name: CONTACT_NAME, address: addressB! });

        // Picks by NAME and proves the name resolves to the address it was saved
        // under, that the recipient step renders the NAME, and that the address
        // landed in the recipient field — all three are pickContactByName's own
        // postconditions, which throw naming what they saw.
        await pickContactByName(walletA, CONTACT_NAME, addressB!);
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step(
      'contact_address_reaches_the_send_wire',
      async () => {
        const review = await advanceToSendReview(walletA, {
          tokenSymbol: TOKEN,
          amount: SEND_AMOUNT,
          isPrivate: false
        });

        // The one hop no other spec covers: the address a user NEVER typed — it
        // came out of the address book — is what the send is addressed to. The
        // review route renders the raw address (no contact lookup lives here), so
        // assert it EXACTLY, both in the route params and on screen. Broadcasting
        // from here is send-public.spec.ts's job, on this same route.
        expect(review.params.to).toBe(addressB!);
        expect(review.text).toContain(addressB!);

        timeline.emit({
          category: 'ui_assertion',
          severity: 'info',
          message:
            `Send-to-contact addressed: picked "${CONTACT_NAME}" from the address book and the review ` +
            `route carries B's exact address (${addressB!}) without it ever being typed`,
          data: { contactName: CONTACT_NAME, recipient: addressB!, amount: SEND_AMOUNT, symbol: TOKEN }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step('delete_the_contact', async () => {
      // Leaving review WITHOUT submitting leaves SendManager's module-scoped send
      // DRAFT behind — only `ReviewTransaction`'s submit path calls
      // `clearSendDraft()`. The next `/send` mount would consume that draft and
      // reopen on the Amount step, where the contact picker does not exist, so the
      // draft has to go the only way a test can drop module state: a real document
      // load. It is load-bearing twice over — `deleteContact` below throws unless
      // the contact came back after the reload, which is the address book's whole
      // job.
      await walletA.navigateTo('/');
      await reloadWallet(walletA);

      await openSettingsDrawer(walletA, 'address-book');
      // Goes through the real ConfirmationModal — removeContact is gated on useConfirm().
      // deleteContact's own postcondition is that exact row reaching state
      // 'detached', so enumerating the same testid prefix here cannot disagree.
      await deleteContact(walletA, addressB!);
    });

    await steps.step('deleted_contact_leaves_the_send_picker', async () => {
      await openSendContactPicker(walletA);

      // The POSITIVE signal first. `send-contacts-list` wraps BOTH branches, so
      // "the sheet is open" says nothing about rows; and every negative assertion
      // below also passes on a picker that lists nothing, ever. Wallet A's own
      // account is filtered out of this list (SendManager), so with its only
      // contact deleted the sheet must render the empty state — and the very same
      // sheet listed this contact two steps ago, which is what makes "zero rows"
      // mean the delete landed rather than the list being broken.
      await expect(walletA.page.getByTestId('send-contacts-empty')).toBeVisible();
      await expect(walletA.page.getByTestId(`send-contact-${addressB!}`)).toHaveCount(0);
    });
  });
});
