import { expect } from '@playwright/test';

import { test } from '../fixtures/two-wallets';
import { assertConservation, totalAcross } from '../helpers/assertions';
import { pendingNoteTotal, toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import { inspectSentNote } from '../helpers/bridge';
import { TOKEN, TOKEN_DECIMALS } from '../helpers/money-path';
import { armRecallBlocks, recallBlocksForWindow, waitForCompletedRow } from '../helpers/recall';

/**
 * Recall / reclaim — the send half nothing else in this suite touches.
 *
 * Every same-chain send is a P2IDE: ReviewTransaction seeds a 7-day reclaim
 * offset by default and `miden-client-interface.sendTransaction` turns it into
 * the absolute `reclaimAfter` height baked into the note. So "the sender can
 * take an unclaimed send back" is a property of EVERY send this wallet makes,
 * and it is one of only two paths where a user's funds come back at all. Before
 * this spec, `grep -rniI 'recall|reclaim' playwright/` matched only the
 * swap-order and bridge-collateral lineages — different mechanisms, no overlap.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not re-run send-public.spec.ts. B is funded by A here for exactly one
 * reason: so that B NEVER claims and the note is still there to be reclaimed.
 * The recipient-side delivery wait is a PRECONDITION for the gate assertion
 * below, not the thing under test.
 *
 * It also does not assert that the recipient's post-expiry claim FAILS. A P2IDE
 * reclaim height gates the SENDER only — the SDK's own docs on `reclaimAfter`
 * read "Block height after which the sender can reclaim the note", and
 * miden-client's `p2ide_transfer_consumed_by_target` test consumes as the target
 * with a reclaim height set. Recall is a RACE, not an exclusive window; a spec
 * asserting a recipient lockout would be asserting something the protocol does
 * not promise. (And once the sender wins, the recipient's note goes
 * ConsumedExternal and silently drops out of the claimable list — there is no
 * rendered failure to assert either.)
 *
 * The rendered expiration label is not asserted here: ReviewTransaction.test.tsx
 * already pins the label for the 7-day seed, for precise second/minute windows,
 * for "Never", and for the bridge route that renders no row at all. Reaching it
 * from Playwright would mean duplicating `WalletPage.sendTokens` to pause on the
 * review screen, for a strictly weaker assertion than jest already makes.
 *
 * KNOWN COPY BUG THIS SPEC DELIBERATELY DOES NOT PIN. The review screen's
 * `recallReturnsNote` string promises the amount "returns to your wallet
 * AUTOMATICALLY". Nothing automatic happens for a non-native token: background
 * auto-consume is gated on the native faucet (sync-manager.ts), so a reclaimed
 * TST/USDC note sits in Pending until the user claims it by hand — which is why
 * the reclaim step below calls `claimAllNotes`. That manual claim is what the
 * product does today, NOT what the copy promises, and this spec makes no
 * assertion either way. Whoever resolves the discrepancy (fix the string, or
 * auto-consume self-reclaimed notes) should add the assertion then.
 */

// What `deploy_and_fund` mints to wallet A, in base units (= 1000 TST).
const MINT_BASE_UNITS = 100_000_000_000n;
// The send that gets reclaimed.
const RECALL_AMOUNT = '250';
const RECALL_BASE_UNITS = toBaseUnits(RECALL_AMOUNT, TOKEN_DECIMALS);
// The "Never" send. A DIFFERENT amount from the recall send on purpose: the two
// `send` rows are told apart by amount, so equal amounts would make the row
// assertions ambiguous.
const NEVER_AMOUNT = '100';
const NEVER_BASE_UNITS = toBaseUnits(NEVER_AMOUNT, TOKEN_DECIMALS);

/**
 * How long the sent note stays unreclaimable, in WALL-CLOCK ms.
 *
 * Converted to a blocks offset against the cadence this run's node is actually
 * configured with (`MIDEN_NODE_BLOCK_INTERVAL`, default 3s, 500ms on the fast
 * CI leg) — see `recallBlocksForWindow`. A hard-coded block count would be six
 * times shorter on the fast leg, short enough for prove+submit+commit to outrun
 * it, which would fail a perfectly healthy wallet.
 *
 * The floor on this number is the sum of the two waits that must complete INSIDE
 * the window (`SEND_ROW_MS` + `B_DISCOVERY_MS` = 150s worst case): the
 * still-gated assertion has to be made while the note is still gated.
 */
const RECALL_WINDOW_MS = 180_000;
const RECALL_BLOCKS = recallBlocksForWindow(RECALL_WINDOW_MS);

// Per-wait budgets. Summed in the test.setTimeout comment below — a budget under
// the sum of its own waits kills the test with a bare "Test timeout" instead of
// the wait's diagnostic, which is a fake failure reason.
const MINT_DISCOVERY_MS = 120_000;
const CLAIM_MS = 120_000;
const VAULT_SETTLE_MS = 60_000;
const SEND_ROW_MS = 90_000;
const B_DISCOVERY_MS = 60_000;
const EXPIRY_MS = 210_000;
const RECLAIM_CLAIM_MS = 120_000;
const RECLAIM_VAULT_MS = 60_000;
const CONSUME_ROW_MS = 30_000;
const NEVER_ROW_MS = 90_000;

// Executable form of the constraint stated on RECALL_WINDOW_MS: both waits that
// precede the still-gated assertion have to finish while the note is still
// gated. A future edit that shortens the window (or lengthens either wait) past
// this line would not fail loudly — it would produce an occasional red run on a
// wallet that is working perfectly, which is the worst kind of test failure.
if (RECALL_WINDOW_MS <= SEND_ROW_MS + B_DISCOVERY_MS) {
  throw new Error(
    `recall-reclaim.spec: RECALL_WINDOW_MS (${RECALL_WINDOW_MS}) must exceed SEND_ROW_MS + B_DISCOVERY_MS ` +
      `(${SEND_ROW_MS + B_DISCOVERY_MS}), or the "sender still cannot reclaim" assertion can be made after the ` +
      `window has legitimately expired and fail a correct product.`
  );
}

test.describe('Recall and Reclaim', () => {
  test.describe.configure({ mode: 'serial' });

  test('A reclaims an unclaimed send once its recall window passes', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // Budget = the sum of this test's own declared waits (120+120+60+90+60+210+
    // 120+60+30+90 = 960s) plus the two `sendTokens` drives, each of which
    // internally allows 120s for the submit button to detach (240s). 1_200s
    // total, so 1_260s clears it and every wait above can report its own
    // diagnostic before the test timeout fires. Expected runtime is ~6-7 min:
    // the dominant real cost is the recall window itself.
    test.setTimeout(1_260_000);

    let addressA = '';
    let addressB = '';
    let pendingBeforeSend = 0n;
    let totalBefore = 0n;
    let sentNoteId = '';

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
      expect(addressA).not.toBe(addressB);
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, Number(MINT_BASE_UNITS), 'public');
      await midenCli.sync();
    });

    await steps.step(
      'claim_funding_note',
      async () => {
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: MINT_DISCOVERY_MS,
          decimals: TOKEN_DECIMALS
        });
        await walletA.claimAllNotes(CLAIM_MS);
        // The reclaim assertion is an EXACT vault equality, so A's spendable
        // balance has to have settled at the full mint before anything is sent.
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: VAULT_SETTLE_MS,
          decimals: TOKEN_DECIMALS
        });
        // Baseline for the two-wallet conservation check at the end. Taken here,
        // before any send, so the whole send→gate→expiry→reclaim round trip sits
        // inside the window it covers.
        totalBefore = await totalAcross({ page: walletA.page, label: 'A' }, { page: walletB.page, label: 'B' }, TOKEN);
        pendingBeforeSend = await pendingNoteTotal(walletA.page, TOKEN);
      },
      { captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }] }
    );

    await steps.step(
      'send_with_a_short_recall_window',
      async () => {
        // Arm the recall the review page will adopt on mount. There is no click
        // path to a window this short — RecallCalendarDrawer's shortest preset is
        // 30 minutes — so without this hook the reclaim half of a send is
        // unreachable from any E2E run. Armed AFTER claimAllNotes, which reloads
        // the page and would wipe it.
        await armRecallBlocks(walletA.page, RECALL_BLOCKS);
        await walletA.sendTokens({
          recipientAddress: addressB,
          amount: RECALL_AMOUNT,
          // MIDEN (0 balance) sorts above the CLI faucet's row, so the default
          // first-row click would pick the wrong token.
          tokenSymbol: TOKEN,
          isPrivate: false
        });
      },
      { screenshotWallets: [{ target: walletA.page, label: 'A' }] }
    );

    await steps.step('persisted_send_row_carries_the_recall_offset', async () => {
      const row = await waitForCompletedRow(walletA.page, {
        type: 'send',
        match: r => r.amount === RECALL_BASE_UNITS.toString(),
        timeoutMs: SEND_ROW_MS,
        what: `the ${RECALL_AMOUNT} ${TOKEN} send to reach Completed`
      });

      // `extraInputs.recallBlocks` is the RELATIVE offset the review page chose —
      // NOT an absolute height; no absolute reclaim height is persisted for a
      // plain send anywhere. If this is undefined the send went out as a plain
      // P2ID and the money can never come back; if it is anything other than what
      // was chosen, the offset was transformed on the way down — the #308 shape,
      // where a doubled height left funds unrecallable for days.
      expect(row.recallBlocks, `the send row must persist the ${RECALL_BLOCKS}-block recall offset it was given`).toBe(
        RECALL_BLOCKS
      );

      sentNoteId = row.outputNoteIds?.[0] ?? '';
      expect(sentNoteId, 'the completed send must record the note it created').not.toBe('');
    });

    await steps.step('committed_note_is_a_recallable_p2ide', async () => {
      // The on-chain half of the assertion above: a row can carry an offset while
      // the note it produced is a plain P2ID (that is exactly what the guardian
      // bridged-send path used to do, #439). A P2ID here means the review screen
      // showed the user an expiration date for a note that can never be recalled.
      const note = await inspectSentNote(walletA, sentNoteId);
      expect(note.ok, `sent-note inspect failed: ${note.error}`).toBe(true);
      expect(note.isP2ide, 'a send with a recall offset must mint a recallable P2IDE').toBe(true);
      expect(note.isP2id, 'a send with a recall offset must NOT mint a plain P2ID').toBe(false);
    });

    await steps.step(
      'recipient_sees_it_while_the_sender_still_cannot_reclaim',
      async () => {
        // PRECONDITION, not the assertion: B discovering the note proves it is
        // committed and discoverable. Without it, "A cannot see the note" would
        // be satisfied by a note that simply does not exist yet.
        await waitForPendingNoteTotal(walletB.page, TOKEN, RECALL_BASE_UNITS, {
          timeoutMs: B_DISCOVERY_MS,
          decimals: TOKEN_DECIMALS
        });

        // THE ASSERTION: the same note is absent from A's claimable list, because
        // `getConsumableNotes` filters out anything whose `consumableAfterBlock()`
        // is still ahead of the synced height (miden-client-interface.ts, #308).
        // Regressing that filter would let a sender reclaim the instant they sent
        // — i.e. take back money the recipient has already been shown.
        //
        // LIMIT OF THIS CHECK, stated because it is an absence at a moment in
        // time: it cannot false-RED unless the recall window has genuinely
        // elapsed (RECALL_WINDOW_MS is sized above the two waits that precede it
        // for exactly that reason), and it cannot prove the gate is height-based
        // rather than merely slow. What it does catch is the ungated listing,
        // which would show the note here immediately.
        const pendingA = await pendingNoteTotal(walletA.page, TOKEN);
        expect(
          pendingA,
          `the sender's own note must stay hidden until its recall height passes, but A's unconsumed ` +
            `${TOKEN} total moved from ${pendingBeforeSend} to ${pendingA} base units while B already holds the note`
        ).toBe(pendingBeforeSend);
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ]
      }
    );

    await steps.step(
      'reclaim_after_the_window_passes',
      async () => {
        // The expiry signal is CHAIN-DERIVED, never wall-clock: the note enters
        // A's claimable list exactly when the product's own gate finds its
        // reclaim height at or below the synced block height. No sleep, no
        // elapsed-time arithmetic — this waits on the thing being tested.
        await waitForPendingNoteTotal(walletA.page, TOKEN, pendingBeforeSend + RECALL_BASE_UNITS, {
          timeoutMs: EXPIRY_MS,
          decimals: TOKEN_DECIMALS
        });

        await walletA.claimAllNotes(RECLAIM_CLAIM_MS);

        // EXACTLY the pre-send balance, not "at least". Fees are paid in the
        // native asset (the fee faucet comes off the block header), so a reclaim
        // is neutral in the SENT token: a round trip that ends anywhere but
        // MINT_BASE_UNITS means the reclaim returned the wrong amount.
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: RECLAIM_VAULT_MS,
          decimals: TOKEN_DECIMALS
        });

        // The product's own reclaim marker: completeConsumeTransaction compares
        // the note's sender to the consuming account and stamps 'Reclaimed'
        // instead of 'Received'. Mislabelling it is how a reclaim disappears from
        // history and reads as income from a stranger.
        const consumeRow = await waitForCompletedRow(walletA.page, {
          type: 'consume',
          match: r => r.displayMessage === 'Reclaimed',
          timeoutMs: CONSUME_ROW_MS,
          what: "a completed consume row labelled 'Reclaimed'"
        });
        expect(consumeRow.amount, 'the reclaim row records the full note amount').toBe(RECALL_BASE_UNITS.toString());

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `Reclaim verified: ${RECALL_AMOUNT} ${TOKEN} sent with a ${RECALL_BLOCKS}-block recall offset ` +
            `(~${RECALL_WINDOW_MS / 1000}s) came back to A in full`,
          data: {
            symbol: TOKEN,
            recallBlocks: RECALL_BLOCKS,
            recallWindowMs: RECALL_WINDOW_MS,
            reclaimedBaseUnits: RECALL_BASE_UNITS.toString(),
            senderVaultAfter: MINT_BASE_UNITS.toString()
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

    await steps.step('no_tokens_were_created_or_destroyed', async () => {
      // Strict: allowedLoss 0n. The round trip pays its fees in the native asset,
      // so both wallets' combined TST must be bit-for-bit what it was before the
      // send. This is the check that catches a reclaim which credits the sender
      // WITHOUT invalidating the recipient's copy of the note.
      await assertConservation(
        { page: walletA.page, label: 'A' },
        { page: walletB.page, label: 'B' },
        TOKEN,
        TOKEN_DECIMALS,
        totalBefore,
        { allowedLoss: 0n }
      );
    });

    // Runs LAST, deliberately: this send leaves an unclaimed note in flight, so
    // placing it before the conservation check would put its value in neither
    // wallet's vault and make that check unsatisfiable for a correct product.
    await steps.step('never_sends_a_plain_unrecallable_p2id', async () => {
      // `null` = the drawer's "Never": no reclaim height at all.
      await armRecallBlocks(walletA.page, null);
      await walletA.sendTokens({
        recipientAddress: addressB,
        amount: NEVER_AMOUNT,
        tokenSymbol: TOKEN,
        isPrivate: false
      });

      const row = await waitForCompletedRow(walletA.page, {
        type: 'send',
        match: r => r.amount === NEVER_BASE_UNITS.toString(),
        timeoutMs: NEVER_ROW_MS,
        what: `the ${NEVER_AMOUNT} ${TOKEN} "Never" send to reach Completed`
      });
      expect(row.recallBlocks, '"Never" must persist no recall offset at all').toBeUndefined();

      // The promise "Never" makes to the RECIPIENT is that the sender cannot take
      // this back. A P2IDE here would break that promise on chain while the review
      // screen said "Never" — the recipient's money would stay yankable.
      const noteId = row.outputNoteIds?.[0] ?? '';
      expect(noteId, 'the completed "Never" send must record the note it created').not.toBe('');
      const note = await inspectSentNote(walletA, noteId);
      expect(note.ok, `sent-note inspect failed: ${note.error}`).toBe(true);
      expect(note.isP2id, '"Never" must mint a plain P2ID').toBe(true);
      expect(note.isP2ide, '"Never" must NOT mint a recallable P2IDE').toBe(false);
    });
  });
});
