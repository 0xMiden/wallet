import { expect, test } from '../fixtures/two-wallets';
import { toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import {
  TxStatus,
  USER_CANCELLED_REASON,
  activityRowFor,
  assertNeverStartedBuilding,
  assertStaysCancelledWithQueueLive,
  openHistory,
  openHistoryDetails,
  plantQueueBlocker,
  readDetailRowFullValue,
  readTransactionRow,
  releaseQueueBlocker,
  waitForSendRow,
  waitForTransactionRow
} from '../helpers/history';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// What `deploy_and_fund` mints to wallet A, in base units (= 1000 TST).
const MINT_BASE_UNITS = 100_000_000_000n;
// The send that gets cancelled — it must never reach the chain.
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);
// Budget for assertions on an ALREADY-rendered page (a store update the UI has
// only to re-render). The default 60s is a chain budget and does not belong on
// these: it inflates the sum of this spec's sub-budgets past its own test
// timeout, which turns any UI regression into "Test timeout exceeded" instead of
// "expected Cancelled, got Sending".
const UI_TIMEOUT_MS = 15_000;

/**
 * Cancelling a pending transaction.
 *
 * The promise a Cancel button makes is a strong one: the money stays put. This
 * spec proves it the only way it can be proven cheaply — by showing the
 * transaction never entered the build pipeline at all (no `stage`, no
 * `processingStartedAt`, so `generateTransaction` provably never ran for it) and
 * that this stays true once the queue is unparked and the loop is free to select
 * again. A balance that "has not moved yet" cannot tell those apart; a row that
 * was never built cannot have moved anything.
 *
 * The row must also reach a terminal failed state carrying the user-cancellation
 * reason — not merely "something other than Completed", which a stuck row and the
 * 30-minute queue reaper both satisfy.
 *
 * ── How the cancellable window is made deterministic ────────────────────────
 *
 * Cancelling while the transaction is still Queued is the only cancel that can
 * promise anything: `updateTransactionStatus` refuses to move a finalized row
 * ("Transaction already in a finalized state"), so a cancel that lands first means
 * `generateTransaction` cannot flip the row to GeneratingTransaction and the
 * transaction provably never builds.
 *
 * The natural queued window, though, is a sub-second race that this harness would
 * lose silently: `ReviewTransaction` enqueues and kicks the service worker in the
 * same tick, and the loop takes the oldest Queued row on its first pass. Losing
 * that race puts a REAL send on chain while the row reads cancelled — a red run on
 * a wallet that works perfectly.
 *
 * So the window is taken from a product invariant instead: the FIFO loop returns
 * early while any row is `GeneratingTransaction`, so `plantQueueBlocker` parks the
 * queue outright and the send below sits Queued for as long as this spec needs.
 * The hold itself is only ever asserted by its EFFECT — the send must still read
 * Queued — because whether `getTransactionsInProgress()` returns the planted row
 * is not observable from the page; the wait that proves it says so on failure, so
 * an inert hold does not get reported as a broken send flow. See
 * helpers/history.ts for the full rationale, including why the cheaper "cancel
 * right after submit" is not shipped.
 */
test.describe('Transaction Cancellation', () => {
  test.describe.configure({ mode: 'serial' });

  test('cancelling a queued send never builds the transaction and leaves the row terminally cancelled', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // The waits below add up to ~765s in the worst case (three 120s funding waits
    // alone eat 360s), well past the config's 300s default. Under that default the
    // spec is killed by its own budget before its own timeouts can fire, so every
    // failure reads "Test timeout of 300000ms exceeded" and none of the diagnostics
    // these helpers exist to print ever run.
    test.setTimeout(900_000);

    let addressA: string;
    let addressB: string;
    let blockerId: string;
    let sendRowId: string;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      // B is only a recipient address to send TO. It is never funded and never
      // receives anything — the whole point is that the note is never created.
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, 100_000_000_000, 'public');
      await midenCli.sync();
    });

    await steps.step(
      'sync_wallet_a',
      async () => {
        // The mint creates a NOTE, so its value is UNCONSUMED until the claim
        // below — it is not spendable yet and asserting the vault here would be
        // wrong.
        await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }]
      }
    );

    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(120_000);
      // The spendable vault is the baseline every later assertion compares
      // against, so wait for the projection to actually hold the claimed amount
      // rather than snapshotting a number that is still catching up.
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step('hold_transaction_queue', async () => {
      blockerId = await plantQueueBlocker(walletA.page);
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Transaction queue parked by blocker row ${blockerId} — the send below will stay Queued`,
        data: { blockerId }
      });
    });

    await steps.step(
      'queue_send_that_will_be_cancelled',
      async () => {
        await walletA.sendTokens({
          recipientAddress: addressB!,
          amount: SEND_AMOUNT,
          // Devnet's native MIDEN row (0 balance) renders above the CLI faucet's
          // row, so the default first-row click would pick the wrong token.
          tokenSymbol: TOKEN,
          isPrivate: false
        });

        // Enqueued, and — because the queue is parked — still Queued. This is the
        // assertion that proves the hold WORKS: `plantQueueBlocker` can only
        // verify it wrote a row, not that `getTransactionsInProgress()` returns
        // it, so an inert hold surfaces here and nowhere else. The rethrow says so,
        // because from the send flow's side "never reached Queued" and "the loop
        // grabbed it immediately" are the same missing row.
        const queued = await waitForSendRow(walletA.page, {
          recipient: addressB!,
          amountBaseUnits: SEND_BASE_UNITS,
          status: TxStatus.Queued,
          timeoutMs: 60_000
        }).catch((cause: unknown) => {
          throw new Error(
            `The send never showed up as Queued. Suspect the queue hold (blocker row ${blockerId}) before the ` +
              `send flow: \`generateTransactionsLoop\` only parks while \`getTransactionsInProgress()\` ` +
              `(src/lib/miden/transaction/get.ts) can SEE the blocker, and that query has no account filter ` +
              `today — if one were added, the blocker's deliberately-foreign accountId would hide it, the loop ` +
              `would build this send for real, and the row would race straight past Queued.\n` +
              `  underlying: ${cause instanceof Error ? cause.message : String(cause)}`
          );
        });
        sendRowId = queued.id;
        assertNeverStartedBuilding(queued, 'right after the send was enqueued', TxStatus.Queued);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'cancel_from_transaction_details',
      async () => {
        // The ONLY reachable cancel affordance in the shipped app. The inline
        // Cancel on `HistoryItem` is dead code — `HistoryView` renders it only
        // when `fullHistory` is false and both `<History>` call sites pass true —
        // so a spec that cancelled "from the history row" could not work.
        await openHistoryDetails(walletA, sendRowId!);
        const cancelButton = walletA.page.getByTestId('history-cancel-button');
        await cancelButton.waitFor({ state: 'visible', timeout: 60_000 });

        // Re-read immediately before the click: this is the assertion that makes
        // the "no funds moved" claim below meaningful, because a row that had
        // already started building could reach the chain regardless of the cancel.
        // Still QUEUED specifically, not merely "not building" — a row the
        // 30-minute reaper (`cancelStaleQueuedTransactions`) or a restart
        // (`failInterruptedTransactions`) already terminated would also carry no
        // stage and no processingStartedAt, and the cancel below would then be
        // asserting against somebody else's terminal state.
        const beforeClick = await readTransactionRow(walletA.page, sendRowId!);
        expect(beforeClick).not.toBeNull();
        assertNeverStartedBuilding(beforeClick!, 'immediately before clicking Cancel', TxStatus.Queued);

        await cancelButton.click({ timeout: 30_000 });

        // Terminal, and terminal for the RIGHT reason. "Not Completed" is also
        // true of a row that is merely stuck, so the reason string is the load-
        // bearing half of this assertion.
        const failed = await waitForTransactionRow(walletA.page, sendRowId!, row => row?.status === TxStatus.Failed, {
          what: 'the row to reach Failed after the cancel',
          timeoutMs: 60_000
        });
        expect(failed.error).toBe(USER_CANCELLED_REASON);
        assertNeverStartedBuilding(failed, 'after the cancel landed', TxStatus.Failed);

        // The same three facts as the user sees them.
        await expect(walletA.page.getByTestId('history-status-pill')).toHaveText('Cancelled', {
          timeout: UI_TIMEOUT_MS
        });
        await expect(walletA.page.getByTestId('history-failure-reason')).toHaveText(USER_CANCELLED_REASON, {
          timeout: UI_TIMEOUT_MS
        });
        // The affordance is gone because the row is no longer pending — a Cancel
        // button still on screen would mean the page never saw the new state.
        await expect(cancelButton).toHaveCount(0, { timeout: UI_TIMEOUT_MS });

        // The From/To card renders for a cancelled row too, and it must still
        // read outward. `cancelTransaction` rewrites `displayMessage` to 'Failed',
        // so a detail page that derives the direction from that message shows
        // "To: <your own account>" on a send you just cancelled — the recipient
        // and the sender swapped on the one screen a worried user opens.
        expect(await readDetailRowFullValue(walletA.page, 'history-detail-to', UI_TIMEOUT_MS)).toBe(addressB!);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_activity_row_reads_cancelled',
      async () => {
        await openHistory(walletA, UI_TIMEOUT_MS);
        // By row id, not by the truncated recipient — see activityRowFor.
        const row = await activityRowFor(walletA.page, sendRowId!, UI_TIMEOUT_MS);
        await expect(row.getByTestId('activity-row-title')).toHaveText('Cancelled', { timeout: UI_TIMEOUT_MS });
        await expect(row.getByTestId('activity-row-status')).toHaveText('Cancelled', { timeout: UI_TIMEOUT_MS });
        // A cancelled row loses its direction, so the amount renders unsigned —
        // still exact, and still naming the token.
        await expect(row.getByTestId('activity-row-amount')).toHaveText(`${SEND_AMOUNT} ${TOKEN}`, {
          timeout: UI_TIMEOUT_MS
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_the_live_queue_does_not_resurrect_it',
      async () => {
        // Everything up to here was asserted with the queue PARKED, where "never
        // started building" is nearly free. Unparking is what makes the claim
        // mean something: the loop is now running, unblocked, and free to select.
        await releaseQueueBlocker(walletA.page, blockerId!);

        // Home drives the wallet's normal polling (and, on mobile/desktop, the
        // transaction driver itself), so the loop really does get its passes in
        // during the window below rather than sitting idle on a detail page.
        await walletA.navigateHome();

        // Deliberately NOT a balance watch. A balance can only move a whole
        // prove+submit+commit after a pickup — far outside any window a spec can
        // afford — whereas `generateTransaction` stamps `stage`/`processingStartedAt`
        // in its first two statements, so a pickup is visible on the row within a
        // poll. Watching the row is the fast, falsifiable version of "the money
        // stayed put"; watching the balance for 15s would pass even if the send
        // had just been picked up.
        await assertStaysCancelledWithQueueLive(walletA.page, sendRowId!, USER_CANCELLED_REASON, { forMs: 15_000 });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `Cancelled ${SEND_AMOUNT} ${TOKEN} send never entered the build pipeline, and stayed out of it ` +
            `after the queue was unparked: the row is Failed with "${USER_CANCELLED_REASON}" and carries ` +
            `neither stage nor processingStartedAt`,
          data: {
            symbol: TOKEN,
            vaultBaseUnitsAtBaseline: MINT_BASE_UNITS.toString(),
            cancelledAmountBaseUnits: SEND_BASE_UNITS.toString(),
            rowId: sendRowId!
          }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
