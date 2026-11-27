import { expect, test } from '../../fixtures/multi-device';
import { toBaseUnits, vaultBalance, waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';
import { expectNoFailedRows, setupSharedAccount, waitForSignerCount } from '../../helpers/multi-device';
import {
  CLAIMED_ELSEWHERE_CHECK_SEC,
  PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC,
  acceptNote,
  claimRowsNaming,
  describeClaimRow,
  describeClaimRows,
  namesNote,
  pollUntil,
  readClaimRows,
  toJsonText,
  waitForClaimRow,
  waitForNotesListed,
  waitForNotesUnlisted,
  type ClaimRow
} from '../../helpers/multi-device-claims';
import { armRecallBlocks, waitForCompletedRow } from '../../helpers/recall';

/**
 * A note that its sender takes back while the shared account's device B has a claim of it queued.
 *
 * C is a separate wallet (a single-key account) that sends a recallable note (P2IDE) of a fresh token to the shared
 * Guardian account. B taps Accept. The harness holds B's claim in the queue before it can make a proposal: the
 * Guardian answers B's `POST /delta*` with its real `409 conflict_pending_delta`, and the transaction loop puts a
 * pre-submit row back in the queue on that (the backpressure arm). Then C takes the note back.
 *
 * The next attempt of B finds the note consumed. The multisig client refuses to authenticate a consumed note
 * (`ConsumeNoteNotAuthenticatedError`, code `consume_notes_note_not_authenticated`, message "consume_notes: note …
 * could not be authenticated: …"). `settleClaimMadeElsewhere` (src/lib/miden/transaction/index.ts) then sees the note
 * `ConsumedExternal`, but the account's Guardian history does not name it (C consumed it, not the account), so it
 * must NOT remove the row: it puts the row back in the queue with `claimedElsewhereCheckUntil` = first sight + 90 s,
 * asks again every 15 s, and once no attempt fits before that deadline, the row fails with that error.
 *
 * Asserted: the row is never removed, it is seen waiting with `claimedElsewhereCheckUntil`, it fails with the
 * authentication error no earlier than the deadline less one cooldown, the shared account receives nothing, and C
 * has its whole amount back.
 *
 * Accounts: the shared account, C, the CLI faucet. Fee-paying transactions of the wallets: A's fee-funding claim,
 * B's add rotation, C's claim of its mint and funding notes, C's send, and C's reclaim. B's claim makes none.
 */

const C_MINT = toBaseUnits('100', TOKEN_DECIMALS);
const RECALL_AMOUNT = '25';
const RECALL_BASE_UNITS = toBaseUnits(RECALL_AMOUNT, TOKEN_DECIMALS);
// A short reclaim height. The order of B's claim and C's reclaim is set by the test, not by the window, and the
// "C can take it back" signal is the note on C's own claimable list, which the product shows only past that height.
const RECALL_BLOCKS = 20;

const C_MINT_LISTED_MS = 300_000;
const C_CLAIM_MS = 300_000;
const BALANCE_MS = 240_000;
const SEND_ROW_MS = 360_000;
const LISTED_MS = 300_000;
const RECLAIMABLE_MS = 900_000;
const B_HELD_MS = 240_000;
const UNLISTED_MS = 300_000;
// B's backpressure cooldown doubles up to 240 s (`GUARDIAN_REQUEUE_BACKOFF_CAP_SEC`); the next attempt after the
// reclaim can be that far away, plus the loop pass and the attempt itself.
const CHECK_SEEN_MS = 420_000;
const TEST_BUDGET_MS = 3_600_000;

/** The message of `ConsumeNoteNotAuthenticatedError` (@openzeppelin/miden-multisig-client), or its name or code. */
const NOTE_NOT_AUTHENTICATED =
  /could not be authenticated|ConsumeNoteNotAuthenticated|consume_notes_note_not_authenticated/i;

test.describe('Multi-device claims: a note its sender takes back', () => {
  test('a claim of a note the sender took back waits for the Guardian history, then fails and is not removed', async ({
    walletA,
    walletB,
    walletC,
    midenCli,
    steps,
    timeline
  }) => {
    test.setTimeout(TEST_BUDGET_MS);
    let address = '';
    let addressC = '';
    let noteId = '';
    let rowId = '';
    let deadline = 0;

    await steps.step('create_on_a_and_add_b', async () => {
      const shared = await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
      address = shared.address;
      await waitForSignerCount(walletB, address, 3);
    });

    await steps.step('sender_c_holds_the_token', async () => {
      addressC = (await walletC.createNewWallet()).address;
      expect(addressC, 'C is another account').not.toBe(address);
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      // `mint` first sends C the native asset for fees; C's claim takes both notes.
      await midenCli.mint(faucetId, addressC, C_MINT, 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletC.page, TOKEN, C_MINT, {
        timeoutMs: C_MINT_LISTED_MS,
        decimals: TOKEN_DECIMALS
      });
      await walletC.claimAllNotes(C_CLAIM_MS);
      await waitForVaultBalance(walletC.page, TOKEN, C_MINT, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
    });

    await steps.step('c_sends_a_recallable_note_to_the_shared_account', async () => {
      // Armed after the claim drain, which reloads the page.
      await armRecallBlocks(walletC.page, RECALL_BLOCKS);
      await walletC.sendTokens({
        recipientAddress: address,
        amount: RECALL_AMOUNT,
        tokenSymbol: TOKEN,
        isPrivate: false
      });
      const sent = await waitForCompletedRow(walletC.page, {
        type: 'send',
        match: row => row.amount === RECALL_BASE_UNITS.toString(),
        timeoutMs: SEND_ROW_MS,
        what: `C's send of ${RECALL_AMOUNT} ${TOKEN}`
      });
      expect(sent.recallBlocks, 'the send carries the recall offset').toBe(RECALL_BLOCKS);
      noteId = sent.outputNoteIds?.[0] ?? '';
      expect(noteId, 'the send records the note it made').not.toBe('');
    });

    await steps.step('both_devices_list_the_note_and_c_can_take_it_back', async () => {
      await waitForNotesListed(walletA, [noteId], LISTED_MS);
      await waitForNotesListed(walletB, [noteId], LISTED_MS);
      // Chain-derived: C lists its own note only once the reclaim height is behind the synced block.
      await waitForPendingNoteTotal(walletC.page, TOKEN, RECALL_BASE_UNITS, {
        timeoutMs: RECLAIMABLE_MS,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'b_claim_waits_in_the_queue',
      async () => {
        // Every proposal post of B gets the Guardian's real 409 while this is armed. The count is far above the
        // attempts this step can make, so the fault stays on until the test clears it.
        walletB.armGuardianFault({ path: 'delta', method: 'POST', mode: 'conflictPendingDelta', count: 10_000 });
        await acceptNote(walletB, noteId, LISTED_MS);
        const held = await waitForClaimRow(
          walletB,
          noteId,
          row =>
            row.status === 'Queued' &&
            row.stage === 'creating-proposal' &&
            row.guardianBusy &&
            row.claimedElsewhereCheckUntil === null,
          "B's claim back in the queue on the Guardian's 409",
          B_HELD_MS
        );
        rowId = held.id;
        expect(walletB.guardianFaultHits(), "the 409 reached B's proposal post").toBeGreaterThanOrEqual(1);
        expect(await vaultBalance(walletB.page, TOKEN), 'the shared account holds no TST').toBe(0n);
      },
      { captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }] }
    );

    await steps.step('c_takes_the_note_back', async () => {
      await walletC.claimAllNotes(C_CLAIM_MS);
      await waitForVaultBalance(walletC.page, TOKEN, C_MINT, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
      // `completeConsumeTransaction` labels a consume of one's own note 'Reclaimed'.
      await waitForCompletedRow(walletC.page, {
        type: 'consume',
        match: row => row.displayMessage === 'Reclaimed',
        timeoutMs: BALANCE_MS,
        what: "C's 'Reclaimed' consume row"
      });
      // B and A see the note spent.
      await waitForNotesUnlisted(walletB, [noteId], UNLISTED_MS);
      await waitForNotesUnlisted(walletA, [noteId], UNLISTED_MS);
    });

    await steps.step(
      'b_claim_is_not_removed_and_fails_after_the_check_window',
      async () => {
        const checking = await waitForClaimRow(
          walletB,
          noteId,
          row => row.id === rowId && row.claimedElsewhereCheckUntil !== null,
          "B's claim waiting for the Guardian history to name the note",
          CHECK_SEEN_MS
        );
        deadline = checking.claimedElsewhereCheckUntil ?? 0;
        timeline.emit({
          category: 'ui_assertion',
          severity: 'info',
          wallet: 'B',
          message: `B's claim waits for the Guardian history until ${new Date(deadline * 1000).toISOString()}`,
          data: { row: describeClaimRow(checking) }
        });

        // Watch the same row to its end. A removed row is the defect this case guards against.
        const samples: ClaimRow[] = [checking];
        const final = await pollUntil(
          walletB.page,
          async () => {
            const current = (await readClaimRows(walletB)).find(row => row.id === rowId) ?? null;
            if (current !== null) samples.push(current);
            return current;
          },
          current => current === null || current.status === 'Failed' || current.status === 'Completed',
          {
            what: "B's claim reaches its end",
            timeoutMs: Math.max(deadline * 1000 - Date.now(), 0) + 180_000,
            intervalMs: 2_000,
            describe: current => (current === null ? '(row removed)' : describeClaimRow(current))
          }
        );
        await test.info().attach('b-claim-samples.json', {
          body: toJsonText(samples),
          contentType: 'application/json'
        });

        expect(final, 'B must keep its claim row: the account did not consume the note, the sender did').not.toBeNull();
        const finalText = final === null ? '' : describeClaimRow(final);
        expect(final?.status, `B's claim fails with its own error: ${finalText}`).toBe('Failed');
        expect(
          `${final?.error ?? ''} ${final?.rawError ?? ''}`,
          'the failure is the multisig client refusing to authenticate the consumed note'
        ).toMatch(NOTE_NOT_AUTHENTICATED);
        expect(final?.claimedElsewhereCheckUntil, 'the check deadline is set once and kept').toBe(deadline);
        // The row fails only once no attempt fits before the deadline: `now + cooldown >= deadline`.
        expect(
          (final?.completedAt ?? 0) + PENDING_CONFLICT_REQUEUE_COOLDOWN_SEC,
          `B's claim must wait the ${CLAIMED_ELSEWHERE_CHECK_SEC} s check window before it fails`
        ).toBeGreaterThanOrEqual(deadline);
        expect(
          samples.some(row => row.status === 'Queued' && row.claimedElsewhereCheckUntil === deadline),
          'the claim was seen back in the queue during the check window'
        ).toBe(true);
      },
      { captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }] }
    );

    await steps.step('the_money_stays_with_the_sender', async () => {
      await walletB.clearFaults();
      expect(await vaultBalance(walletA.page, TOKEN), 'A received nothing').toBe(0n);
      expect(await vaultBalance(walletB.page, TOKEN), 'B received nothing').toBe(0n);
      await waitForVaultBalance(walletC.page, TOKEN, C_MINT, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
      const rowsA = await readClaimRows(walletA);
      const rowsB = await readClaimRows(walletB);
      expect(claimRowsNaming(rowsA, noteId), `A never claimed the note:\n  ${describeClaimRows(rowsA)}`).toEqual([]);
      expect(
        claimRowsNaming(rowsB, noteId).map(row => row.id),
        `B has the one claim row, and no other:\n  ${describeClaimRows(rowsB)}`
      ).toEqual([rowId]);
      await expectNoFailedRows(walletA);
      await expectNoFailedRows(walletB, row => !namesNote(row.noteIds, noteId));
      await expectNoFailedRows(walletC);
    });
  });
});
