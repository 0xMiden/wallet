import type { Page } from '@playwright/test';

import { getEnvironmentConfig } from '../../config/environments';
import { test, expect } from '../../fixtures/two-wallets';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { ensureFeeFunded } from '../../helpers/fee-funding';
import {
  TxStatus,
  describeTransactionRow,
  readTransactionRows,
  waitForTransactionRow,
  type TransactionRowSnapshot
} from '../../helpers/history';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';

/**
 * Guardian resilience: a co-signed CONSUME started while the guardian refuses every connection waits in the queue
 * as ONE row, never fails, and lands once the guardian is back (#779).
 *
 * Operator A is hard-down (`connectionRefused` on every endpoint), the shape a dead operator or a laptop that lost
 * its route takes. A refusal before submit used to fail the row with a raw "Failed to fetch", and every later claim
 * wrote another Failed row. The wallet now requeues a pre-submit row with a 60 s cooldown instead.
 *
 * The claim is driven by `claimAllNotes`, as in the 5xx spec, but started without awaiting it: it cannot drain while
 * the guardian refuses, so it runs across the outage and returns once the claim lands. It clicks Accept All once; a
 * note with a live consume row renders as claiming, so its reloads never click again (and the consume dedup would
 * refuse a second row). Rows are read from Dexie with `readTransactionRows`, the reader
 * cancelled-send-retry-no-double-pay.spec.ts uses.
 *
 * What goes red, and why:
 *   - a Failed row while the guardian refuses: the pre-#779 behaviour;
 *   - a second consume row created by this claim: a failed attempt followed by a fresh claim, or a broken consume
 *     dedup;
 *   - a Completed consume while the guardian refuses: the fault never reached the consume;
 *   - no sample of the row back in Queued at 'creating-proposal': the loop never ran it into the guardian, which would
 *     leave the three checks above passing on a row nobody touched. A first pickup writes 'syncing' while Queued and
 *     reaches 'creating-proposal' only after flipping to GeneratingTransaction, so Queued at 'creating-proposal'
 *     exists only after a requeue at proposal creation. The 409, 429, prover-outage and unauthorized arms requeue
 *     there too, but none can fire under a refused connection: the 409 and 429 need an HTTP answer, and the prover
 *     arm needs the row at 'proving' and the unauthorized arm an executed transaction, both of which follow a
 *     guardian co-signature the refusal never lets through;
 *   - no later sample of that row requeued at 'creating-proposal' again with a strictly larger `nextEligibleAt` while
 *     the guardian still refuses: every requeue rewrites it, so without a larger one the loop never retried the row
 *     during the outage, and the no-Failed check covered only its first refusal;
 *   - zero `networkFaultHits()`: the refusal reached no guardian request. The frontend's guardian sync counts too,
 *     so on its own this proves less than the requeue sample;
 *   - after `clearFaults()`, a drain that never finishes, a vault short of the mint, or anything but one Completed
 *     consume row created by this claim, for the minted amount: the requeued row did not recover once the guardian
 *     answered.
 *
 * The wallet's fee funding is claimed, and its consume row settled, before the baseline read; every count above
 * reads only rows created after that read, except the no-Failed checks, which read every row.
 */
// The fault's `guardianA` target resolves from the same config, so the wallet and the fault cannot disagree on
// which operator is A.
const GUARDIAN_URL = getEnvironmentConfig().guardianUrl;
const MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST

// From the claim trigger to the first requeue: the drain's reload and Accept All click, the loop picking the row,
// its pre-flight sync and the refused proposal. Binds only when the consume never reaches the guardian.
const FIRST_REQUEUE_TIMEOUT_MS = 120_000;
// The longest the outage is held after the first requeue, waiting for the loop to retry the row while the guardian
// still refuses: the row's 60 s cooldown, one 5 s pass of the service worker's processing loop, the retry's pre-flight
// sync and refused proposal, and slack. The hold ends at the sample that sees that retry's requeue.
const OUTAGE_HOLD_MS = 90_000;
// The requeue cooldown (60 s) plus one 5 s pass of the service worker's processing loop and 5 s of slack: the
// longest a requeued row can wait after the guardian is back before the loop runs it again.
const REQUEUE_COOLDOWN_SLACK_MS = 70_000;
// The 5xx spec's landing budget, for the attempt that runs once the guardian answers.
const LANDING_BUDGET_MS = 180_000;
const CLAIM_DRAIN_BUDGET_MS = FIRST_REQUEUE_TIMEOUT_MS + OUTAGE_HOLD_MS + REQUEUE_COOLDOWN_SLACK_MS + LANDING_BUDGET_MS;
const ROW_READ_ATTEMPTS = 10;

const isConsume = (row: TransactionRowSnapshot): boolean => row.type === 'consume';
const isFailed = (row: TransactionRowSnapshot): boolean => row.status === TxStatus.Failed;
const isRequeuedAtProposal = (row: TransactionRowSnapshot): boolean =>
  isConsume(row) && row.status === TxStatus.Queued && row.stage === 'creating-proposal';
// The shared description plus `nextEligibleAt`, which is what the retry proof compares.
const describeRow = (row: TransactionRowSnapshot): string =>
  `${describeTransactionRow(row)} nextEligibleAt=${row.nextEligibleAt ?? '-'}`;
const describeRows = (rows: TransactionRowSnapshot[]): string =>
  rows.length === 0 ? '(no rows)' : rows.map(describeRow).join('\n  ');

// The claim drain reloads the page while it runs, and a read that straddles a reload loses its execution context.
// Retried rather than skipped, so a window never passes on fewer samples than it took.
async function readRows(page: Page): Promise<TransactionRowSnapshot[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readTransactionRows(page);
    } catch (error) {
      if (attempt >= ROW_READ_ATTEMPTS) throw error;
      await page.waitForTimeout(1_000);
    }
  }
}

function expectHeldWhileRefused(rows: TransactionRowSnapshot[], baselineIds: ReadonlySet<string>): void {
  const dump = describeRows(rows);
  // Rows from before the baseline read are the fee funding's; every consume row after it is this claim's.
  const consumes = rows.filter(row => isConsume(row) && !baselineIds.has(row.id));
  expect(
    rows.filter(isFailed),
    `no row may fail while the guardian refuses connections - a pre-submit refusal must requeue:\n  ${dump}`
  ).toHaveLength(0);
  expect(
    consumes.length,
    `the claim must stay ONE consume row across its retries - a second row means an attempt was given up and ` +
      `claimed again:\n  ${dump}`
  ).toBeLessThanOrEqual(1);
  expect(
    consumes.filter(row => row.status === TxStatus.Completed),
    `a guardian consume cannot complete while its guardian refuses every connection - the fault missed it:\n  ${dump}`
  ).toHaveLength(0);
}

test.describe('infra resilience - a consume while the guardian refuses connections', () => {
  test.describe.configure({ mode: 'serial' });

  test('a co-signed consume under a refused guardian keeps one row and lands once the guardian returns', async ({
    walletA,
    midenCli,
    steps,
    timeline
  }) => {
    // The 5xx spec's budget, plus the outage and cooldown this spec holds on top of an ordinary claim.
    test.setTimeout(600_000 + FIRST_REQUEUE_TIMEOUT_MS + OUTAGE_HOLD_MS + REQUEUE_COOLDOWN_SLACK_MS);

    let addressA = '';
    let baselineIds: ReadonlySet<string> = new Set();
    // Settles to the drain's error rather than rejecting: it runs across two steps, and a rejection nobody is
    // awaiting yet would be reported as unhandled.
    let claimDrain: Promise<Error | null> | undefined;

    await steps.step('create_and_fund_guardian_wallet', async () => {
      const a = await walletA.createGuardianWallet(GUARDIAN_URL);
      addressA = a.address;
      // Funded and claimed here, so the fee note's own consume settles before the baseline read instead of racing
      // this spec's claim; mint's own fee funding then does nothing.
      await ensureFeeFunded(midenCli, walletA, addressA);
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'consume_waits_while_guardian_refuses',
      async () => {
        // The fee funding's consume can still be finishing its post-completion guardian sync; let it settle so no
        // row from before the fault changes after the baseline read.
        for (const row of (await readRows(walletA.page)).filter(isConsume)) {
          await waitForTransactionRow(
            walletA.page,
            row.id,
            settled => settled?.status === TxStatus.Completed || settled?.status === TxStatus.Failed,
            { what: 'the fee funding consume to reach a terminal status', timeoutMs: 120_000 }
          );
        }
        const baseline = await readRows(walletA.page);
        expect(
          baseline.filter(row => isFailed(row) || (isConsume(row) && row.status !== TxStatus.Completed)),
          `before the fault no row may have failed and every consume must be settled:\n  ${describeRows(baseline)}`
        ).toHaveLength(0);
        baselineIds = new Set(baseline.map(row => row.id));

        await walletA.armNetworkFault({ target: 'guardianA', mode: 'connectionRefused' });
        const armedAt = Date.now();

        claimDrain = walletA.claimAllNotes(CLAIM_DRAIN_BUDGET_MS).then(
          () => null,
          (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
        );

        let firstRequeue: { seenAt: number; id: string; nextEligibleAt: number } | undefined;
        let retriedAt: number | undefined;
        let samples = 0;
        let rows: TransactionRowSnapshot[] = [];
        for (;;) {
          rows = await readRows(walletA.page);
          samples++;
          expectHeldWhileRefused(rows, baselineIds);
          const requeued = rows.find(row => isRequeuedAtProposal(row) && !baselineIds.has(row.id));
          if (requeued?.nextEligibleAt !== undefined) {
            if (firstRequeue === undefined) {
              firstRequeue = { seenAt: Date.now(), id: requeued.id, nextEligibleAt: requeued.nextEligibleAt };
            } else if (requeued.id === firstRequeue.id && requeued.nextEligibleAt > firstRequeue.nextEligibleAt) {
              retriedAt = Date.now();
              break;
            }
          }
          if (firstRequeue === undefined && Date.now() - armedAt >= FIRST_REQUEUE_TIMEOUT_MS) {
            throw new Error(
              `the consume was never seen back in the queue at 'creating-proposal' within ` +
                `${FIRST_REQUEUE_TIMEOUT_MS}ms of the outage - the loop never ran it into the guardian, so the ` +
                `checks above held on a row nobody attempted:\n  ${describeRows(rows)}`
            );
          }
          if (firstRequeue !== undefined && Date.now() - firstRequeue.seenAt >= OUTAGE_HOLD_MS) {
            throw new Error(
              `the consume was not requeued again with a later nextEligibleAt than its first requeue ` +
                `(${firstRequeue.nextEligibleAt}) within ${OUTAGE_HOLD_MS}ms while the guardian refused - the loop ` +
                `never retried it during the outage, so the checks above held on its first refusal only:\n  ` +
                describeRows(rows)
            );
          }
          // Sample spacing, matched to the processing loop's 5 s pass. Every sample asserts, so this spaces checks
          // rather than standing in for one.
          // eslint-disable-next-line no-long-bare-wait -- inter-sample spacer, every lap re-asserts the rows
          await walletA.page.waitForTimeout(5_000);
        }

        // Read before clearFaults(), which resets the counter.
        const hits = await walletA.networkFaultHits();
        expect(
          hits,
          'the guardian-A refusal must have refused at least one request - 0 hits means the fault never landed'
        ).toBeGreaterThanOrEqual(1);

        const firstSeenAt = firstRequeue?.seenAt ?? armedAt;
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message:
            `[resilience] guardian consume held as one queued row under a refused guardian and was retried and ` +
            `requeued again during the outage, with no Failed row (${samples} samples, ${hits} refused requests)`,
          data: {
            firstRequeueAfterMs: String(firstSeenAt - armedAt),
            secondRequeueAfterMs: String((retriedAt ?? firstSeenAt) - firstSeenAt),
            samples: String(samples),
            refusedRequests: String(hits),
            rows: describeRows(rows)
          }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'consume_lands_after_guardian_returns',
      async () => {
        await walletA.clearFaults();

        if (!claimDrain) throw new Error('the claim drain was never started');
        const drainError = await claimDrain;
        if (drainError) {
          throw new Error(`the requeued claim did not land after the guardian came back: ${drainError.message}`);
        }
        await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });

        const landed = await readRows(walletA.page);
        const consumeRow = landed.find(row => isConsume(row) && !baselineIds.has(row.id));
        if (!consumeRow) throw new Error(`no consume row is left after the claim landed:\n  ${describeRows(landed)}`);
        // A guardian consume runs its post-completion guardian sync before the row is stamped Completed, so the
        // drain can see the note consumed while the row is still GeneratingTransaction.
        await waitForTransactionRow(
          walletA.page,
          consumeRow.id,
          row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
          { what: 'the consume row to reach a terminal status', timeoutMs: 120_000 }
        );

        const rows = await readRows(walletA.page);
        const dump = describeRows(rows);
        const consumes = rows.filter(row => isConsume(row) && !baselineIds.has(row.id));
        expect(consumes, `the outage must leave exactly one consume row behind:\n  ${dump}`).toHaveLength(1);
        expect(consumes[0]?.status, `the one consume row must end Completed:\n  ${dump}`).toBe(TxStatus.Completed);
        expect(consumes[0]?.amount, `the one consume row must be the minted note's claim:\n  ${dump}`).toBe(
          MINT_BASE_UNITS.toString()
        );
        expect(rows.filter(isFailed), `no row may have failed across the outage:\n  ${dump}`).toHaveLength(0);

        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `[resilience] the requeued consume landed once the guardian answered and settled the vault at ${MINT_BASE_UNITS} base units`,
          data: { mintBaseUnits: MINT_BASE_UNITS.toString() }
        });
      },
      {
        captureStateFrom: [{ target: walletA.page, label: 'A', extensionId: walletA.extensionId }],
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );
  });
});
