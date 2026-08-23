import { expect, test } from '../../fixtures/two-wallets';
import {
  maxPendingNoteTotal,
  toBaseUnits,
  waitForPendingNoteTotal,
  waitForVaultBalance
} from '../../helpers/balance-truth';
import {
  TxStatus,
  TRANSACTION_STUCK_REASON,
  openHistoryDetails,
  waitForSendRow,
  waitForTransactionRow
} from '../../helpers/history';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';
import { armRecallBlocks } from '../../helpers/recall';

/**
 * Retrying a send that was cancelled mid-flight must not pay the recipient twice.
 *
 * ── The bug this exists to keep dead ────────────────────────────────────────
 *
 * Nothing aborts a running pipeline when its row is failed out from under it.
 * The Cancel button and the stuck-row reaper (`cancelStuckTransactions`, for a
 * row that outran `MAX_WAIT_BEFORE_CANCEL`) both go through
 * `cancelWhilePipelineMayStillRun`, which writes `Failed` and no stage, and the
 * pipeline runs on and submits anyway. Two writes are then refused because the row is
 * terminal: the `setStage('submitting')` that would have recorded the broadcast,
 * and the completion write that would have captured the transaction id. The row
 * is left frozen at whichever PRE-submit stage it held when the cancel landed,
 * with no id — and Retry reads exactly those two facts as proof that nothing was
 * broadcast. It drops the cached `requestBytes`, the rebuilt request draws a
 * fresh note serial, and the chain has no reason to reject it. The recipient is
 * paid a second time.
 *
 * The cached bytes are the whole defence: they pin the note serial, and the note
 * id derived from that serial is the ONLY reason a duplicate submit is rejected.
 * `markMayHaveSubmitted` is what preserves them — a sticky flag the leaf stamps
 * before broadcasting, deliberately exempt from the terminal-row guard that
 * suppresses the stage write.
 *
 * ── Why this is an E2E and not a unit test ──────────────────────────────────
 *
 * Unit and integration coverage can prove the bytes survive
 * (`double-send.integration.test.ts` runs the real writers against the real
 * Dexie schema). Only a chain can prove what the bytes BUY, because "the
 * duplicate was rejected" is a property of the node, not of the wallet. The
 * assertion here is the recipient's balance.
 *
 * ── Why it is deterministic ─────────────────────────────────────────────────
 *
 * There is no race to win. Reproducing the cancel by timing it against a real
 * prover would be exactly the silent-loss race `plantQueueBlocker` exists to
 * avoid, so the sequence is split: the send below is a REAL recallable guardian
 * send that really lands, and the post-cancel row shape is then written
 * directly (the same harness-writes-product-state trade `plantQueueBlocker`
 * makes, for the same reason). The fields the refused writes account for are
 * what the integration test named above pins, field by field.
 *
 * The shape is nonetheless a deliberate composite rather than a transcript of
 * one production row: it carries the reaper's reason at the INLINE pipeline's
 * stage. A real reaper cancel caught at 'proving' would not persist that string
 * — `cancelTransaction` passes an error through verbatim only for the user
 * cancel and the startup interruption, and remaps everything else, so at
 * 'proving' the stuck reason is rewritten to the prover-failed copy and demoted
 * to `rawError`. Each half is chosen for a reason the other cannot supply, and
 * the pairing is what makes the branch under test both reachable and
 * falsifiable:
 *
 *   - the reason, because it is the only thing that decides whether Retry
 *     exists at all (see the next section);
 *   - the stage, because 'proving' is in `PRE_SUBMIT_STAGES` and 'sending' is
 *     deliberately not. At 'sending' the `!failedPreSubmit` disjunct makes
 *     `submitPossible` true on its own, the cached bytes survive with or
 *     without the crossing stamp, and the first falsifiability claim below
 *     would quietly stop holding — removing the stamp would no longer produce a
 *     double payment.
 *
 * `verifySendLanded` returns `'unknown'` precisely when the row carries no
 * `transactionId` (transaction/cancel.ts), so clearing it is also what forces
 * Retry down the requeue path being tested rather than letting the node-verify
 * shortcut complete the row. That makes the interesting branch reachable every
 * run instead of most runs.
 *
 * ── Which of the two cancel routes is reproduced, and why ───────────────────
 *
 * The reaper's, not the Cancel button's. The two leave an identical row apart
 * from the error string, but that string is load-bearing for this spec: the
 * details screen derives `isCancelled` from it alone
 * (`isUserCancelledTransaction`, matching only the user-cancel text) and drops
 * the Retry button entirely when it is set. Planting the user's reason
 * therefore builds the one state in which the control this spec must click
 * cannot exist, and the wait for it can only time out.
 *
 * A hand-cancelled send being unretryable is deliberate and long-standing (the
 * `!entry.isCancelled` guard arrived with `isUserCancelledTransaction` itself,
 * around 1.15.12, well before the double-pay work), so the reachable form of
 * "cancelled mid-flight and may already have broadcast" is the stuck-row
 * reaper's: it fails the row through the same `cancelWhilePipelineMayStillRun`,
 * leaves Retry on screen, and is the route the guard under test actually has to
 * defend. That is what is planted below.
 *
 * Falsifiability, in both directions:
 *   - Remove the leaf's crossing stamp and the flag is absent, Retry drops the
 *     bytes, a fresh serial is drawn and B is credited TWICE — the balance
 *     assertion goes red.
 *   - If Retry silently did nothing at all, B would trivially stay at one
 *     payment and this spec would be a false green, so it also asserts the row
 *     actually left Failed.
 */

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

// Long enough that the note stays un-reclaimable for the whole run on either
// block cadence — this spec is about duplicate payment, and a window that
// expired mid-run would let a recall confuse the balance it asserts on.
const RECALL_BLOCKS = 100_000;

// How long B's balance is watched after the retry. A second payment costs a
// prove + submit + commit, so the window has to be wide enough for one to show
// up; `maxPendingNoteTotal` samples throughout rather than reading once at the
// end, so a second note that arrives and is then reclaimed still trips it.
const DOUBLE_PAY_WATCH_MS = 120_000;

const TX_DB = 'TridentMain';
const TX_STORE = 'transactions';

/** The two fields that decide the guard, neither of which `TransactionRowSnapshot` carries. */
interface GuardFields {
  mayHaveSubmitted?: boolean;
  hasRequestBytes: boolean;
}

async function readGuardFields(page: import('@playwright/test').Page, rowId: string): Promise<GuardFields> {
  return page.evaluate(
    async ({ dbName, storeName, id }) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = idb.open(dbName);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        const row: Record<string, unknown> | undefined = await new Promise((res, rej) => {
          const r = db.transaction(storeName, 'readonly').objectStore(storeName).get(id);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const bytes = row?.requestBytes as ArrayLike<number> | undefined;
        return {
          mayHaveSubmitted: row?.mayHaveSubmitted as boolean | undefined,
          hasRequestBytes: bytes !== undefined && bytes !== null && bytes.length > 0
        };
      } finally {
        db.close();
      }
    },
    { dbName: TX_DB, storeName: TX_STORE, id: rowId }
  );
}

/**
 * Rewrite a landed send into the row a mid-flight cancel leaves behind — the
 * stuck-row reaper's, whose error string leaves Retry reachable (see the
 * header, which also covers why this pairing is a composite).
 *
 * Only the fields the refused writes account for are touched: the status and
 * error a cancel writes, the stage frozen where the cancel caught it, and the
 * completion evidence (`transactionId`, `outputNoteIds`, `completedAt`) that was
 * never captured because the completion write threw. `requestBytes` and
 * `mayHaveSubmitted` are deliberately left EXACTLY as the real pipeline wrote
 * them — they are the subject of the test, and planting them would be assuming
 * the answer.
 *
 * Two things a real reaper cancel also does are left out, both inert here.
 * `cancelWhilePipelineMayStillRun` stamps `cancelledInFlightAt` for a send, and
 * `cancelTransaction` sets `displayIcon`. Nothing on the path under test reads
 * the icon, and no reader reaches `cancelledInFlightAt` either: the only
 * consumer is the unverifiable-send refusal, which is gated on
 * `requestBytes === undefined` and this row keeps its bytes. Omitting the marker
 * is equivalent to planting an expired one — a user who retries after the window
 * has passed, which is the state this spec means to exercise.
 */
async function plantCancelledMidFlightShape(page: import('@playwright/test').Page, rowId: string): Promise<void> {
  const planted = await page.evaluate(
    async ({ dbName, storeName, id, reason }) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const r = idb.open(dbName);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        const store = () => db.transaction(storeName, 'readwrite').objectStore(storeName);
        const row: Record<string, unknown> | undefined = await new Promise((res, rej) => {
          const r = store().get(id);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (!row) return false;

        row.status = 3; // ITransactionStatus.Failed
        row.error = reason;
        row.displayMessage = 'Failed';
        // Frozen mid-prove: `setTransactionStage` refused to advance it once the
        // cancel made the row terminal.
        row.stage = 'proving';
        // Never captured — `updateTransactionStatus` threw on the terminal row.
        delete row.transactionId;
        delete row.outputNoteIds;
        delete row.completedAt;

        await new Promise<void>((res, rej) => {
          const r = store().put(row);
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        });
        return true;
      } finally {
        db.close();
      }
    },
    { dbName: TX_DB, storeName: TX_STORE, id: rowId, reason: TRANSACTION_STUCK_REASON }
  );

  if (!planted) {
    throw new Error(`plantCancelledMidFlightShape: no row "${rowId}" in ${TX_DB}.${TX_STORE} to rewrite.`);
  }
}

test.describe('infra resilience — a cancelled send is not paid twice on retry', () => {
  test.describe.configure({ mode: 'serial' });

  test('retrying a send that was cancelled after it broadcast credits the recipient exactly once', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline
  }) => {
    // Guardian onboarding, a funded mint, a claim, a full co-signed send, and
    // then a two-minute balance watch. The default 300s budget would kill the
    // spec before its own waits could report anything.
    test.setTimeout(900_000);

    let addressA = '';
    let addressB = '';
    let sendRowId = '';

    await steps.step('create_wallets', async () => {
      const a = await walletA.createGuardianWallet(GUARDIAN_URL);
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
      expect(addressA).not.toBe(addressB);
    });

    await steps.step('fund_and_claim', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      await walletA.claimAllNotes(180_000);
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'recallable_send_that_really_lands',
      async () => {
        // Recallable, because a plain send never caches `requestBytes` — the
        // guardian recallable path is the only send that has anything to protect
        // (`ensureGuardianRecallableSendRequestBytes`). `claimAllNotes` reloads
        // the page, so this must be armed after it.
        await armRecallBlocks(walletA.page, RECALL_BLOCKS);

        await walletA.sendTokens({
          recipientAddress: addressB,
          amount: SEND_AMOUNT,
          tokenSymbol: TOKEN,
          isPrivate: false
        });

        const completed = await waitForSendRow(walletA.page, {
          recipient: addressB,
          amountBaseUnits: SEND_BASE_UNITS,
          status: TxStatus.Completed,
          timeoutMs: 300_000
        });
        sendRowId = completed.id;

        // ONE payment on chain. Everything after this asserts it stays one.
        await waitForPendingNoteTotal(walletB.page, TOKEN, SEND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS - SEND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ]
      }
    );

    await steps.step('the_leaf_recorded_its_submit_crossing', async () => {
      // The round-6 fix, observed on a real device rather than in a mock: the
      // guardian leaf stamps the crossing before broadcasting. If this is absent
      // the retry below is testing the unfixed code, so it is asserted here
      // where the diagnosis is obvious rather than three steps later as a
      // mysterious double payment.
      const guard = await readGuardFields(walletA.page, sendRowId);
      expect(
        guard.mayHaveSubmitted,
        'the guardian leaf must stamp mayHaveSubmitted before it submits — without it, Retry has nothing to ' +
          'distinguish a broadcast send from one that died while proving'
      ).toBe(true);
      expect(guard.hasRequestBytes, 'a recallable send must cache the requestBytes that pin its note serial').toBe(
        true
      );
    });

    await steps.step('plant_the_row_a_mid_flight_cancel_leaves', async () => {
      await plantCancelledMidFlightShape(walletA.page, sendRowId);
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message:
          `Send row ${sendRowId} rewritten to a reaper cancel-mid-flight shape: Failed with the stuck-row ` +
          `reaper's reason at the inline pipeline's stage 'proving', no transactionId, cached requestBytes and ` +
          `mayHaveSubmitted left as the pipeline wrote them`,
        data: { rowId: sendRowId, sentBaseUnits: SEND_BASE_UNITS.toString() }
      });
    });

    await steps.step(
      'retry_and_watch_for_a_second_payment',
      async () => {
        await openHistoryDetails(walletA, sendRowId);
        const retryButton = walletA.page.getByTestId('history-retry-button');
        await retryButton.waitFor({ state: 'visible', timeout: 60_000 });
        await retryButton.click({ timeout: 30_000 });

        // Falsifiability: a Retry that threw or no-opped would leave B at one
        // payment for reasons that have nothing to do with the guard. The row
        // must actually be picked back up. (`requeueFailedTransaction` used to
        // throw here for a DIFFERENT reason — its landed-verdict branch called
        // `updateTransactionStatus` on the Failed row it is defined over — which
        // is why the error surface is asserted too.)
        await expect(
          walletA.page.getByTestId('history-retry-error'),
          'Retry reported an error instead of requeueing the row'
        ).toHaveCount(0, { timeout: 15_000 });

        // Either Queued or GeneratingTransaction — which one is caught depends on
        // how fast the loop picks it up, and the point is only that it left the
        // terminal state the plant put it in.
        await waitForTransactionRow(walletA.page, sendRowId, row => row !== null && row.status !== TxStatus.Failed, {
          what: 'the retried row to leave Failed — if it never does, this spec proves nothing about the guard',
          timeoutMs: 60_000
        });

        // THE ASSERTION. The resubmit reuses the cached request, so the note id
        // is the one already on chain and the node rejects the duplicate. B is
        // never credited a second time. Sampled across the window rather than
        // read once at the end, so a second note that lands and is then
        // reclaimed still trips it.
        const peak = await maxPendingNoteTotal(walletB.page, TOKEN, { forMs: DOUBLE_PAY_WATCH_MS });
        expect(
          peak,
          `B must be credited exactly ${SEND_AMOUNT} ${TOKEN} once. A higher peak means the retry rebuilt the ` +
            `request with a fresh note serial and paid the recipient again.`
        ).toBe(SEND_BASE_UNITS);

        // The sender's side of the same fact: one debit, not two.
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS - SEND_BASE_UNITS, {
          timeoutMs: 60_000,
          decimals: TOKEN_DECIMALS
        });

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `Retry of a cancelled-mid-flight send reused its cached request: B peaked at ${peak} base units ` +
            `(one payment) and A stayed debited exactly once`,
          data: { peakBaseUnits: peak.toString(), sentBaseUnits: SEND_BASE_UNITS.toString() }
        });
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
