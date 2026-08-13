import { expect, test } from '../fixtures/two-wallets';
import { toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';
import {
  TxStatus,
  USER_CANCELLED_REASON,
  activityRowFor,
  assertNeverStartedBuilding,
  assertVaultBalanceUnchanged,
  openHistory,
  openHistoryDetails,
  plantQueueBlocker,
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

/**
 * Cancelling a pending transaction.
 *
 * The promise a Cancel button makes is a strong one: the money stays put. This
 * spec asserts BOTH halves of it — the vault is untouched to the base unit, and
 * the row reaches a terminal failed state carrying the user-cancellation reason
 * (not merely "something other than Completed", which a stuck row also satisfies).
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
 * `assertNeverStartedBuilding` re-checks the hold immediately before and after the
 * click, so if it ever stopped working the spec says exactly that instead of
 * blaming the product for a moved balance. See helpers/history.ts for the full
 * rationale, including why the cheaper "cancel right after submit" is not shipped.
 */
test.describe('Transaction Cancellation', () => {
  test.describe.configure({ mode: 'serial' });

  test('cancelling a queued send leaves the balance untouched and the row terminally cancelled', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
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

        // Enqueued, and — because the queue is parked — still Queued. This wait
        // is on the row itself, so a hold that failed shows up here as a missing
        // Queued row rather than as a mystery balance change later.
        const queued = await waitForSendRow(walletA.page, {
          recipient: addressB!,
          amountBaseUnits: SEND_BASE_UNITS,
          status: TxStatus.Queued,
          timeoutMs: 60_000
        });
        sendRowId = queued.id;
        assertNeverStartedBuilding(queued, 'right after the send was enqueued');
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
        const beforeClick = await readTransactionRow(walletA.page, sendRowId!);
        expect(beforeClick).not.toBeNull();
        assertNeverStartedBuilding(beforeClick!, 'immediately before clicking Cancel');

        await cancelButton.click({ timeout: 30_000 });

        // Terminal, and terminal for the RIGHT reason. "Not Completed" is also
        // true of a row that is merely stuck, so the reason string is the load-
        // bearing half of this assertion.
        const failed = await waitForTransactionRow(walletA.page, sendRowId!, row => row?.status === TxStatus.Failed, {
          what: 'the row to reach Failed after the cancel',
          timeoutMs: 60_000
        });
        expect(failed.error).toBe(USER_CANCELLED_REASON);
        assertNeverStartedBuilding(failed, 'after the cancel landed');

        // The same three facts as the user sees them.
        await expect(walletA.page.getByTestId('history-status-pill')).toHaveText('Cancelled');
        await expect(walletA.page.getByTestId('history-failure-reason')).toHaveText(USER_CANCELLED_REASON);
        // The affordance is gone because the row is no longer pending — a Cancel
        // button still on screen would mean the page never saw the new state.
        await expect(cancelButton).toHaveCount(0);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_activity_row_reads_cancelled',
      async () => {
        await openHistory(walletA);
        const row = activityRowFor(walletA.page, addressB!);
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId('activity-row-title')).toHaveText('Cancelled');
        await expect(row.getByTestId('activity-row-status')).toHaveText('Cancelled');
        // A cancelled row loses its direction, so the amount renders unsigned —
        // still exact, and still naming the token.
        await expect(row.getByTestId('activity-row-amount')).toHaveText(`${SEND_AMOUNT} ${TOKEN}`);
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_balance_unchanged',
      async () => {
        // Unparking FIRST is deliberate: with the queue live again, a row that
        // was not really finalized would be picked up by the very next loop pass
        // and the balance would move inside the window below. Asserting while the
        // queue is still parked would prove far less.
        await releaseQueueBlocker(walletA.page, blockerId!);

        // Home polls `fetchBalances`; a detail page does not, and asserting
        // "unchanged" against a frozen projection asserts nothing at all.
        await walletA.navigateHome();

        await assertVaultBalanceUnchanged(walletA.page, TOKEN, MINT_BASE_UNITS, {
          forMs: 15_000,
          decimals: TOKEN_DECIMALS
        });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `Cancelled ${SEND_AMOUNT} ${TOKEN} send never reached the chain: wallet A still holds exactly ` +
            `${MINT_BASE_UNITS} base units and the row is Failed with "${USER_CANCELLED_REASON}"`,
          data: {
            symbol: TOKEN,
            vaultBaseUnits: MINT_BASE_UNITS.toString(),
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
