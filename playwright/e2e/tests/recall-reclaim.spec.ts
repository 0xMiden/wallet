import { expect } from '@playwright/test';

import { test } from '../fixtures/two-wallets';
import {
  maxPendingNoteTotal,
  pendingNoteTotal,
  toBaseUnits,
  waitForPendingNoteTotal,
  waitForVaultBalance
} from '../helpers/balance-truth';
import { inspectSentNote } from '../helpers/bridge';
import { TOKEN, TOKEN_DECIMALS, fundAndClaim } from '../helpers/money-path';
import {
  IS_FAST_BLOCKS,
  IS_LOCALNET,
  armRecallBlocks,
  recallBlocksForWindow,
  waitForCompletedRow
} from '../helpers/recall';

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
 * LOCALNET ONLY. The recall window is chosen in BLOCKS and waited out in wall
 * clock, so sizing it needs the chain's block cadence. The only cadence this
 * process can know is the one it configures (`MIDEN_NODE_BLOCK_INTERVAL`, which
 * docker-compose.local.yml hands the node). On devnet/testnet that variable is
 * unset and the real cadence is whatever the public network runs; assuming 3s
 * there produces a FALSE RED on a healthy wallet whenever the network is slower.
 * See `recallBlocksForWindow`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not re-run send-public.spec.ts. B is funded by A here for exactly one
 * reason: so that B NEVER claims and the note is still there to be reclaimed.
 * The recipient-side delivery wait is a PRECONDITION for the gate assertion
 * below, not the thing under test. The fund-and-claim prologue is the shared
 * `fundAndClaim` helper rather than a fourth copy of that block.
 *
 * It also does not assert that the recipient's post-expiry claim FAILS. A P2IDE
 * reclaim height gates the SENDER only — the SDK's own docs on `reclaimAfter`
 * read "Block height after which the sender can reclaim the note", and
 * miden-client's `p2ide_transfer_consumed_by_target` test consumes as the target
 * with a reclaim height set. Recall is a RACE, not an exclusive window; a spec
 * asserting a recipient lockout would be asserting something the protocol does
 * not promise. What IS asserted (and is the double-spend check) is that once the
 * sender wins the race the recipient's copy stops being claimable.
 *
 * The rendered expiration label is not asserted here: ReviewTransaction.test.tsx
 * already pins the label for the 7-day seed, for precise second/minute windows,
 * for "Never", and for the bridge route that renders no row at all. Reaching it
 * from Playwright would mean duplicating `WalletPage.sendTokens` to pause on the
 * review screen, for a strictly weaker assertion than jest already makes.
 *
 * COPY BUG THIS SPEC FOUND, NOW FIXED IN THE PRODUCT. The review screen's
 * `recallReturnsNote` string used to promise the amount "returns to your wallet
 * AUTOMATICALLY". Nothing automatic happens for a non-native token: background
 * auto-consume is gated on the native faucet (sync-manager.ts), so a reclaimed
 * TST/USDC note sits in Pending until the user claims it by hand — which is why
 * the reclaim step below calls `claimAllNotes`. The string now says the sender
 * can reclaim it, which is what the product does; `src/lib/i18n/recall-copy.test.ts`
 * pins that so it cannot drift back.
 */

// What the funding prologue mints to wallet A, in base units (= 1000 TST).
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
 * configured with — see `recallBlocksForWindow`, and the LOCALNET ONLY note
 * above. A hard-coded block count would be six times shorter on the fast leg,
 * short enough for prove+submit+commit to outrun it, which would fail a
 * perfectly healthy wallet.
 *
 * The floor on this number is everything that must complete INSIDE the window —
 * see `PRE_GATE_BUDGET_MS` and the guard below.
 */
const RECALL_WINDOW_MS = 180_000;

// Per-wait budgets. Summed in the test.setTimeout comment below — a budget under
// the sum of its own waits kills the test with a bare "Test timeout" instead of
// the wait's diagnostic, which is a fake failure reason.
const MINT_DISCOVERY_MS = 120_000;
const CLAIM_MS = 120_000;
const VAULT_SETTLE_MS = 60_000;
const B_DISCOVERY_MS = 60_000;
const DEBIT_MS = 30_000;
const GATE_HOLD_MS = 10_000;
const SEND_ROW_MS = 60_000;
const INSPECT_MS = 60_000;
const EXPIRY_MS = 210_000;
const RECLAIM_CLAIM_MS = 120_000;
const RECLAIM_VAULT_MS = 60_000;
const CONSUME_ROW_MS = 30_000;
const B_INVALIDATION_MS = 60_000;
const NEVER_ROW_MS = 90_000;

/**
 * Everything that has to happen between the note's reclaim height being fixed
 * and the still-gated assertion being made, at its declared worst case.
 *
 * The reclaim height is stamped at BUILD time (`reclaimAfter = blockNum() +
 * recallBlocks`, miden-client-interface.ts) — i.e. when the service worker's FIFO
 * loop picks the queued row up, which is AFTER `sendTokens` returns (the submit
 * button detaches as soon as the row is enqueued, before any proving). So the
 * clock starts inside the B-discovery wait, and only the waits listed here can
 * eat the window.
 *
 * Every wait added between the send and the assertion MUST be added here, or the
 * guard silently stops covering it — which is how this spec previously claimed a
 * check "cannot false-RED" while an unbounded `inspectSentNote` sat inside the
 * window.
 */
const PRE_GATE_BUDGET_MS = B_DISCOVERY_MS + DEBIT_MS + GATE_HOLD_MS;
// Headroom for what is NOT a declared wait: prove + submit + commit between the
// build stamping the height and B first seeing the note, plus poll granularity.
const GATE_MARGIN_MS = 60_000;

if (RECALL_WINDOW_MS < PRE_GATE_BUDGET_MS + GATE_MARGIN_MS) {
  throw new Error(
    `recall-reclaim.spec: RECALL_WINDOW_MS (${RECALL_WINDOW_MS}) must be at least PRE_GATE_BUDGET_MS + ` +
      `GATE_MARGIN_MS (${PRE_GATE_BUDGET_MS + GATE_MARGIN_MS}), or the "sender still cannot reclaim" assertion ` +
      `can be made after the window has legitimately expired and fail a correct product.`
  );
}
// The expiry wait starts after the gate assertion, so in the worst case the
// whole window is still ahead of it; it also has to absorb one sync round for
// the newly-reclaimable note to surface.
if (EXPIRY_MS < RECALL_WINDOW_MS + 30_000) {
  throw new Error(
    `recall-reclaim.spec: EXPIRY_MS (${EXPIRY_MS}) must exceed RECALL_WINDOW_MS (${RECALL_WINDOW_MS}) by a sync ` +
      `round, or a healthy reclaim can be reported as "the note never became reclaimable".`
  );
}

test.describe('Recall and Reclaim', () => {
  test.describe.configure({ mode: 'serial' });
  // Runs ONLY on the 500ms-block leg. On the default 3s leg this same window
  // costs 6x the blocks and shares a 45-minute job with the entire core suite,
  // so its budget could not fit; the fast leg runs almost nothing else.
  test.skip(
    !IS_FAST_BLOCKS,
    'recall-reclaim needs the 500ms-block leg (MIDEN_NODE_BLOCK_INTERVAL=500ms) to bound the expiry wait'
  );
  test.skip(
    !IS_LOCALNET,
    'recall windows are sized in blocks against a cadence only the local stack configures — see the header'
  );

  test('A reclaims an unclaimed send once its recall window passes', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // BUDGET, in full — every term, not just the spec's own waits:
    //
    //   this test's declared timeoutMs values                     1_150s
    //     120 mint discovery + 120 claim +  60 vault settle
    //     + 60 B discovery   +  30 debit +  10 gate hold
    //     + 60 send row      +  60 inspect + 210 expiry
    //     + 120 reclaim claim + 60 reclaim vault + 30 consume row
    //     + 60 B invalidation + 90 never row + 60 never inspect
    //   two `sendTokens` drives, at their REAL internal worst        694s
    //     15s send-flow mount + 7 x 30s STEP_TIMEOUT_MS steps
    //     + 120s submit-detach + 2s hash wait = 347s each.
    //     The earlier version of this comment counted only the
    //     120s detach and called the arithmetic complete.
    //   two `claimAllNotes` prologues, which run BEFORE that          162s
    //     helper starts its own deadline: reload + `#root > *`
    //     + store + navigate + store = 30+15+3+30+3 = 81s each,
    //     the reload and navigate bounded only by the page
    //     defaults set immediately below (0 = unbounded otherwise)
    //                                                             --------
    //                                                              2_006s
    //
    // 2_280s clears that with ~4 min to spare. DELIBERATELY NOT SUMMED, same as
    // unlock-lockout.spec.ts: the two `createNewWallet` drives (60s + 120s of
    // explicit waits each) and the CLI's faucet deploy/mint/sync (180s/60s/60s
    // ceilings). Each of those carries its own bounded timeout and throws its
    // own message, so a hang inside one reports what hung — the "bare Test
    // timeout instead of a diagnostic" failure this budget exists to prevent
    // needs the budget to be short of the waits that would otherwise print, and
    // those print regardless. Expected runtime is ~7 min; the dominant real
    // cost is waiting out the recall window itself.
    // Fits its job because this spec now runs ONLY on the fast-blocks leg, which
    // carries two specs — not the default leg, which shares `timeout-minutes: 45`
    // with the entire core suite. A 38-minute ceiling there could not fit and
    // would have cost the run its artifacts on a job timeout.
    test.setTimeout(2_280_000);

    // Bound the helper chain. @playwright/test defaults actionTimeout and
    // navigationTimeout to 0, so an unbounded `goto`/`reload`/`fill` inside
    // claimAllNotes or createNewWallet would burn the whole budget above with
    // nothing naming the step that hung. Explicit per-call timeouts still win.
    for (const page of [walletA.page, walletB.page]) {
      page.setDefaultTimeout(30_000);
      page.setDefaultNavigationTimeout(30_000);
    }

    // Resolved here, not at module scope: off localnet this throws, and the
    // describe-level skip above has already excluded those legs.
    const recallBlocks = recallBlocksForWindow(RECALL_WINDOW_MS);

    let addressA = '';
    let addressB = '';
    let pendingBeforeSend = 0n;
    let sentNoteId = '';

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
      // Not decorative: the fixture handing back one wallet twice would make
      // every "A sent to B" assertion below a self-send.
      expect(addressA).not.toBe(addressB);
    });

    await fundAndClaim(walletA, midenCli, steps, {
      address: addressA,
      mintBaseUnits: MINT_BASE_UNITS,
      discoveryMs: MINT_DISCOVERY_MS,
      claimMs: CLAIM_MS,
      vaultSettleMs: VAULT_SETTLE_MS,
      captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
    });

    await steps.step(
      'send_with_a_short_recall_window',
      async () => {
        // Baseline for the still-gated assertion. Deterministically 0n here —
        // `fundAndClaim` drained the pending list and pinned the vault to the
        // full mint — but read rather than hard-coded so the assertion below
        // names the quantity it compares.
        pendingBeforeSend = await pendingNoteTotal(walletA.page, TOKEN);

        // Arm the recall the review page will adopt on mount. There is no click
        // path to a window this short — RecallCalendarDrawer's shortest preset is
        // 30 minutes — so without this hook the reclaim half of a send is
        // unreachable from any E2E run. Armed AFTER claimAllNotes, which reloads
        // the page and would wipe it.
        await armRecallBlocks(walletA.page, recallBlocks);
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

    await steps.step(
      'recipient_sees_it_while_the_sender_still_cannot_reclaim',
      async () => {
        // PRECONDITION 1 — the note is committed and discoverable. Without it,
        // "A cannot see the note" would be satisfied by a note that simply does
        // not exist yet.
        await waitForPendingNoteTotal(walletB.page, TOKEN, RECALL_BASE_UNITS, {
          timeoutMs: B_DISCOVERY_MS,
          decimals: TOKEN_DECIMALS
        });

        // PRECONDITION 2, the positive control — A's own view has moved PAST the
        // send. The service worker writes `vaultAssets` and `notes` into one
        // chrome.storage record per sync cycle, so once A's spendable balance
        // shows the debit, every snapshot the pending read can see was produced
        // by a cycle that already knew about this send. Without this, "absent
        // from A's list" is indistinguishable from "A's sync has not run yet".
        //
        // It is also the down leg of the round trip: the reclaim assertion later
        // pins the vault back at MINT_BASE_UNITS, which is ALSO the pre-send
        // value — so without an anchor here a projection that never moved would
        // satisfy it on its first poll.
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS - RECALL_BASE_UNITS, {
          timeoutMs: DEBIT_MS,
          decimals: TOKEN_DECIMALS
        });

        // THE ASSERTION: the same note is absent from A's claimable list, because
        // `getConsumableNotes` filters out anything whose `consumableAfterBlock()`
        // is still ahead of the synced height (miden-client-interface.ts, #308).
        // Regressing that filter would let a sender reclaim the instant they sent
        // — i.e. take back money the recipient has already been shown.
        //
        // Held across several sync cycles rather than sampled once: an ungated
        // listing would surface the note on the next cycle, and a single read
        // could land in the gap before it.
        //
        // LIMIT OF THIS CHECK, stated because it is an absence: it cannot prove
        // the gate is height-based rather than merely slow — only that no cycle
        // in this window listed A's own note while B already held it. The
        // height-based half comes from the expiry wait below, which surfaces the
        // same note with no action other than blocks passing.
        const pendingA = await maxPendingNoteTotal(walletA.page, TOKEN, { forMs: GATE_HOLD_MS });
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

    // Everything from here to the reclaim is OUTSIDE the window budget above —
    // it asserts properties of a note that do not change with height, so it must
    // not sit between the send and the absence assertion.
    await steps.step('persisted_send_row_carries_the_recall_offset', async () => {
      const row = await waitForCompletedRow(walletA.page, {
        type: 'send',
        match: r => r.amount === RECALL_BASE_UNITS.toString(),
        timeoutMs: SEND_ROW_MS,
        what: `the ${RECALL_AMOUNT} ${TOKEN} send to reach Completed`
      });

      // WHAT THIS PROVES, precisely: the offset survives review-page state ->
      // `initiateSendTransaction` -> Dexie unchanged. `extraInputs.recallBlocks`
      // is a RELATIVE offset — no absolute reclaim height is persisted for a
      // plain send anywhere — so a transform on the way down (the #308 shape,
      // where a doubled height left funds unrecallable for days) fails here, and
      // an offset dropped entirely means the send went out as a plain P2ID.
      //
      // WHAT IT DOES NOT PROVE: the value came from `armRecallBlocks`, not from
      // the UI, so the drawer's date -> `dateTimeToRecallBlocks` conversion and
      // the 7-day default seeding are NOT exercised here (the E2E hook sets
      // `recallTouchedRef` precisely to suppress the default). Those are pinned
      // by RecallCalendarDrawer.test.tsx and ReviewTransaction.test.tsx.
      expect(row.recallBlocks, `the send row must persist the ${recallBlocks}-block recall offset it was given`).toBe(
        recallBlocks
      );

      sentNoteId = row.outputNoteIds?.[0] ?? '';
      expect(sentNoteId, 'the completed send must record the note it created').not.toBe('');
    });

    await steps.step('committed_note_is_a_recallable_p2ide', async () => {
      // The on-chain half of the assertion above: a row can carry an offset while
      // the note it produced is a plain P2ID (that is exactly what the guardian
      // bridged-send path used to do, #439). A P2ID here means the review screen
      // showed the user an expiration date for a note that can never be recalled.
      //
      // Only the positive half is asserted: `isP2id` and `isP2ide` are both
      // derived from the SAME script root in test-hooks.ts, so one root cannot
      // satisfy both and `isP2id === false` is entailed by `isP2ide === true`.
      const note = await inspectSentNote(walletA, sentNoteId, { timeoutMs: INSPECT_MS });
      expect(note.ok, `sent-note inspect failed: ${note.error}`).toBe(true);
      expect(note.isP2ide, 'a send with a recall offset must mint a recallable P2IDE').toBe(true);
    });

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
        // MINT_BASE_UNITS means the reclaim returned the wrong amount. The
        // debit anchor above is what makes this a down-then-up rather than a
        // terminal equality the starting state also satisfies.
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
            `Reclaim verified: ${RECALL_AMOUNT} ${TOKEN} sent with a ${recallBlocks}-block recall offset ` +
            `(~${RECALL_WINDOW_MS / 1000}s) came back to A in full`,
          data: {
            symbol: TOKEN,
            recallBlocks,
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

    await steps.step('the_recipients_copy_stops_being_claimable', async () => {
      // THE DOUBLE-SPEND CHECK. A won the race, so the note's nullifier is on
      // chain and B's copy goes ConsumedExternal and drops out of B's claimable
      // list. A reclaim that credited the sender while leaving the recipient's
      // copy claimable would put the SAME 250 TST in two places — and no
      // vault-only check can see it, because B's copy lives in the pending list,
      // not in B's vault. (This is what the previous "conservation" step here
      // could not detect: it summed two vaults, one of which was pinned to the
      // mint one statement earlier and the other of which is always 0.)
      await waitForPendingNoteTotal(walletB.page, TOKEN, 0n, {
        timeoutMs: B_INVALIDATION_MS,
        decimals: TOKEN_DECIMALS
      });
    });

    // Runs LAST, deliberately: this send leaves an unclaimed note in flight, so
    // placing it earlier would put its value in neither wallet's vault and
    // invalidate B's zero above.
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
      // screen said "Never" — the recipient's money would stay yankable. Positive
      // half only, for the same single-script-root reason as above.
      const noteId = row.outputNoteIds?.[0] ?? '';
      expect(noteId, 'the completed "Never" send must record the note it created').not.toBe('');
      const note = await inspectSentNote(walletA, noteId, { timeoutMs: INSPECT_MS });
      expect(note.ok, `sent-note inspect failed: ${note.error}`).toBe(true);
      expect(note.isP2id, '"Never" must mint a plain P2ID').toBe(true);
    });
  });
});
