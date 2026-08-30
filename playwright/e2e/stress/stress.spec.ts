/**
 * Stress suite — real-world random send/claim between two wallets.
 *
 * Runs a single long-lived test that drives `runStressDriver` through
 * `STRESS_NUM_NOTES` successful sends (default 20, ≈15 min on devnet).
 * Configurable via STRESS_* env vars — see `parseOptions` below.
 *
 * Asserts strict balance conservation after the final drain phase: any
 * deviation means a note was lost somewhere and is a real bug worth surfacing.
 */
import * as fs from 'fs';
import * as path from 'path';

import { runStressDriver, type StressOptions } from './stress-driver';
import { expect, test } from '../fixtures/two-wallets';
import { streamIndexedDBToFile } from '../helpers/idb-dump';

const INITIAL_MINT_AMOUNT = 100_000_000_000; // matches mint-and-balance.spec.ts

/**
 * The token this suite trades, and the ONLY asset its conservation identity covers.
 *
 * `midenCli.createFaucet()` defaults to this symbol. Scoping matters: the wallet's
 * balance reads are cross-asset by default, and the native fee asset living inside the
 * conserved total is what made a fee-charging run report its own fees as lost notes.
 */
const TOKEN = 'TST';

function intEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === '') return dflt;
  const v = parseInt(raw, 10);
  if (Number.isNaN(v)) throw new Error(`${key}=${raw} is not an integer`);
  return v;
}

function floatEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === '') return dflt;
  const v = parseFloat(raw);
  if (Number.isNaN(v)) throw new Error(`${key}=${raw} is not a float`);
  return v;
}

function parseOptions(): StressOptions {
  return {
    numNotes: intEnv('STRESS_NUM_NOTES', 20),
    delayMinMs: intEnv('STRESS_DELAY_MIN_MS', 3_000),
    delayMaxMs: intEnv('STRESS_DELAY_MAX_MS', 10_000),
    privateRatio: floatEnv('STRESS_PRIVATE_RATIO', 0.5),
    // Amounts are in DISPLAY units (what the UI input expects, e.g. "5" = 5 TST).
    // Defaults are tiny so wallets stay solvent across long runs:
    //   3 initial mints × 1000 TST = 3000 TST per wallet.
    //   Even 1000 sends × max-10 = 10_000 TST total; both directions split it.
    sendAmountMin: intEnv('STRESS_AMOUNT_MIN', 1),
    sendAmountMax: intEnv('STRESS_AMOUNT_MAX', 10),
    claimAfterSendProb: floatEnv('STRESS_CLAIM_AFTER_SEND_PROB', 0.5),
    idleEvery: intEnv('STRESS_IDLE_EVERY', 10),
    idleMinMs: intEnv('STRESS_IDLE_MIN_MS', 30_000),
    idleMaxMs: intEnv('STRESS_IDLE_MAX_MS', 60_000),
    lockEvery: intEnv('STRESS_LOCK_EVERY', 15),
    reloadEvery: intEnv('STRESS_RELOAD_EVERY', 20),
    concurrentProb: floatEnv('STRESS_CONCURRENT_PROB', 0.15),
    // Generous ceiling: this is a correctness test, not a perf test. A send
    // that takes 60s and succeeds is fine — we log it and move on. Real
    // "broken" is >5 min. Tighter budgets produced false-positive failures
    // from testnet flake + SW suspension pileups.
    perTurnSendTimeoutMs: intEnv('STRESS_SEND_TIMEOUT_MS', 300_000),
    // Probability [0,1] of intercepting and failing the transport call on
    // a private-note send, so the retry loop can be exercised end-to-end.
    // Kept at 0 by default so the default stress run matches historical
    // behavior; set to e.g. 0.1 to validate the transport hardening.
    transportFailProb: floatEnv('STRESS_TRANSPORT_FAIL_PROB', 0),
    seed: intEnv('STRESS_SEED', Date.now() >>> 0)
  };
}

test.describe('Stress - random send/claim', () => {
  test.describe.configure({ mode: 'serial' });

  // No per-test timeout — the driver's `numNotes` is the stop condition.
  test.setTimeout(0);

  test('random send/claim between two wallets', async ({ walletA, walletB, midenCli, steps, timeline }) => {
    const opts = parseOptions();
    const initialMintsPerWallet = intEnv('STRESS_INITIAL_MINTS', 3);
    const conservationStrict = (process.env.STRESS_CONSERVATION_STRICT ?? 'true') === 'true';

    // When STRESS_GUARDIAN=true, BOTH wallets are guardian-backed: every send
    // and claim co-signs through the external guardian at GUARDIAN_URL. This
    // exercises the guardian send/consume-proposal paths under the full stress
    // matrix (concurrency, reload, lock, idle) — not just the happy path.
    const useGuardian = (process.env.STRESS_GUARDIAN ?? 'false') === 'true';
    const guardianUrl = process.env.GUARDIAN_URL ?? 'http://localhost:3000';
    // Guardian co-signing adds HTTP round-trips, so syncs/claims need a wider
    // window than standard accounts.
    const guardianSyncMs = useGuardian ? 300_000 : 180_000;

    console.log('\n=== STRESS RUN PARAMETERS ===');
    console.log(
      JSON.stringify(
        {
          ...opts,
          initialMintsPerWallet,
          conservationStrict,
          useGuardian,
          guardianUrl: useGuardian ? guardianUrl : null
        },
        null,
        2
      )
    );
    console.log('');

    let addressA = '';
    let addressB = '';

    await steps.step('create_wallets', async () => {
      const a = useGuardian ? await walletA.createGuardianWallet(guardianUrl) : await walletA.createNewWallet();
      const b = useGuardian ? await walletB.createGuardianWallet(guardianUrl) : await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    // Override the global delegate-proving setting so the stress run
    // exercises the local (offscreen-doc) prove path on Chrome. Set via
    // STRESS_LOCAL_PROVING=true at the harness level. The wallet reads
    // `delegate_proof_setting_key` from localStorage on every form
    // render, so the change takes effect on the next send without a
    // reload. Both wallets are flipped because the stress driver sends
    // from BOTH directions.
    //
    // Opt-in only, and on the 0.16 SDK line it will HANG rather than fail: local
    // WASM proving traps on a thread spawn that wasm cannot service, and the trap
    // leaves the prove's promise unsettled forever. See the quarantine note on
    // `send-public-local-prove.spec.ts`. CI never sets this flag, so the stress job
    // is unaffected — but don't set it locally against 0.16 expecting results.
    if (process.env.STRESS_LOCAL_PROVING === 'true') {
      await steps.step('force_local_proving', async () => {
        await walletA.setDelegateProofEnabled(false);
        await walletB.setDelegateProofEnabled(false);
      });
    }

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      for (let i = 0; i < initialMintsPerWallet; i++) {
        await midenCli.mint(faucetId, addressA, INITIAL_MINT_AMOUNT, 'public');
        await midenCli.mint(faucetId, addressB, INITIAL_MINT_AMOUNT, 'public');
      }
      await midenCli.sync();
    });

    await steps.step('initial_claim', async () => {
      await Promise.all([
        walletA.waitForBalanceAbove(0, guardianSyncMs, timeline),
        walletB.waitForBalanceAbove(0, guardianSyncMs, timeline)
      ]);
      await walletA.claimAllNotes(guardianSyncMs);
      await walletB.claimAllNotes(guardianSyncMs);
    });

    // Conserve the TRADED token only. `getBalance()` and an unscoped
    // `quickBalanceSnapshot()` sum EVERY asset the account holds, so on a fee-charging
    // chain the native fee asset sits inside the conserved total and the fees this suite
    // itself pays read back as lost value: the run that exposed this reported
    // "balance conservation violated by -5.13; notes lost" with pending=0 and failed=0 --
    // nothing was lost, ~2.56 MIDEN per wallet had been burned as fees. Worse, the settle
    // loop below waits for `A + B === initialTotal`, a target that can never be reached on
    // such a chain, so every run burned its full settle timeout before failing.
    //
    // Scoping to the token under test keeps the invariant EXACT on any chain, fee or not,
    // and it is the honest statement of what this suite detects: lost NOTES. The fee is
    // not a lost note, and `fee-accounting.spec.ts` proves fee correctness far better.
    const initialA = (await walletA.quickBalanceSnapshot({ symbol: TOKEN })).totalReportable;
    const initialB = (await walletB.quickBalanceSnapshot({ symbol: TOKEN })).totalReportable;
    const initialTotal = initialA + initialB;

    console.log(`\n=== INITIAL BALANCES ===\nA=${initialA}\nB=${initialB}\ntotal=${initialTotal}\n`);

    let result: Awaited<ReturnType<typeof runStressDriver>> | undefined;

    await steps.step('stress_loop', async () => {
      result = await runStressDriver({ walletA, walletB, addressA, addressB }, timeline, opts);
    });

    await steps.step('verify_and_report', async () => {
      if (!result) throw new Error('stress driver did not return a result');

      // Settle loop: wait for conservation before measuring.
      //
      // `sendTokens` returns when the UI shows "transaction initiated" — that
      // is BEFORE on-chain commit. For a send fired near the end of the stress
      // loop, the sender's vault has optimistically decremented but the
      // receiver's sync may not yet have seen the note; total (A+B) transiently
      // reads low until the commit propagates. The drain phase drains
      // CLAIMABLE notes but can't force a pending OUTGOING tx to move from
      // "submitted" to "committed." Wait for A+B to reach the initial total,
      // starting from the base budget below and extending while rows are
      // demonstrably still cooling down, to a hard ceiling. If we never
      // converge, that's a true loss and the assertion below will surface it.
      // Base budget: the wallet's own unauthorized-retry window (180s from the
      // first such failure) plus a last jittered cooldown (15-54s) plus queue
      // drain. It is a FLOOR, not the whole story — the loop extends it below
      // while rows are demonstrably still cooling down, because the wallet's
      // other requeue arms carry no 180s budget at all (a 429 can park a send for
      // up to 300s, and every arm is ultimately bounded only by MAX_QUEUED_AGE).
      // A fixed ceiling would red a run in which nothing is wrong.
      const SETTLE_DEADLINE_MS = 6 * 60 * 1000;
      // Absolute stop, matching the wallet's own terminal cap on a queued row
      // plus slack: past this, no arm can still be legitimately waiting.
      const SETTLE_HARD_CEILING_MS = 32 * 60 * 1000;
      const SETTLE_POLL_MS = 5_000;
      // Guarded like every other end-of-run page read: on a multi-hour run the
      // target can be dead or OOM-killed by now, and an unguarded `page.evaluate`
      // would throw BEFORE any artifact is written, taking the CSV, the summary
      // and both IndexedDB dumps with it. A sentinel keeps the forensics.
      //
      // The sentinel's zeros mean UNKNOWN, never "nothing in flight". Every
      // consumer below has to check `readFailed` first, or a dead page reads as
      // a flawless run — which is the quietest way this whole check could fail.
      const readUnlanded = async (
        w: typeof walletA
      ): Promise<Awaited<ReturnType<typeof walletA.unlandedSendTotals>> & { readFailed?: boolean }> => {
        try {
          return await w.unlandedSendTotals();
        } catch (e) {
          console.log(`[stress] unlandedSendTotals failed: ${e instanceof Error ? e.message : String(e)}`);
          return {
            completed: 0,
            completedCount: 0,
            failed: 0,
            pending: 0,
            failedCount: 0,
            pendingCount: 0,
            totalCount: 0,
            failedMaybeSubmitted: 0,
            failedMaybeSubmittedCount: 0,
            pendingEligibleAtMax: 0,
            storeMissing: false,
            readFailed: true
          };
        }
      };
      let finalA = 0;
      let finalB = 0;
      type UnlandedTotals = Awaited<ReturnType<typeof readUnlanded>>;
      // Sentinels, in case the settle loop cannot run a single iteration. Marked
      // as a failed read for the same reason: unknown, not clean.
      const unreadTotals = (): UnlandedTotals => ({
        completed: 0,
        completedCount: 0,
        failed: 0,
        pending: 0,
        failedCount: 0,
        pendingCount: 0,
        totalCount: 0,
        failedMaybeSubmitted: 0,
        failedMaybeSubmittedCount: 0,
        pendingEligibleAtMax: 0,
        storeMissing: false,
        readFailed: true
      });
      let unlandedA: UnlandedTotals = unreadTotals();
      let unlandedB: UnlandedTotals = unreadTotals();
      const settleStart = Date.now();
      let settleDeadlineMs = SETTLE_DEADLINE_MS;
      // Consecutive clean polls required to exit, not one. `refreshBalances` is
      // best-effort and keeps the previous projection when it fails, so a single
      // poll can pair fresh rows with a stale balance view and read as converged
      // on a send that did land. Two agreeing polls, five seconds apart, cost one
      // extra lap and close that window.
      const SETTLE_STABLE_POLLS = 2;
      let consecutiveClean = 0;
      // When the numbers the assertions below will read were actually taken. A
      // poll that throws leaves the PREVIOUS lap's values in place, so without
      // this the run could be judged on a snapshot minutes old — and a stale
      // snapshot that happened to look clean is the silent pass the measurability
      // checks exist to prevent.
      //
      // An age rather than a boolean, deliberately. Requiring the LAST poll to
      // have succeeded would red a run that converged and then lost its page on
      // the way out, which is a real and benign ending: the numbers from a lap or
      // two earlier still describe it. Requiring only that SOME poll succeeded
      // would let a page that died early carry the whole run. The age
      // distinguishes them, and 0 means no poll ever completed.
      let lastGoodPollAt = 0;
      while (Date.now() - settleStart < Math.min(settleDeadlineMs, SETTLE_HARD_CEILING_MS)) {
        // The WHOLE iteration is guarded, not just the row read. Every call in
        // here touches a page that, hours into a run, may be dead or OOM-killed —
        // `triggerSync` alone ends in `waitForTimeout`, which throws on a closed
        // page. An unguarded throw escapes BEFORE any artifact is written, taking
        // the CSV, the summary and both IndexedDB dumps with it, which is the one
        // outcome that makes a failed run undiagnosable.
        try {
          await Promise.all([walletA.triggerSync(), walletB.triggerSync()]);
          // Rows BEFORE balances, deliberately. The exit condition needs the row
          // scan to be the older of the two reads: if a send completes between
          // them, the rows still call it in flight and the loop takes another lap,
          // whereas the other order would exit on a torn pair — balances showing
          // the value un-sent, rows showing it settled — and report the difference
          // as unexplained skew on a run where nothing went wrong.
          [unlandedA, unlandedB] = await Promise.all([readUnlanded(walletA), readUnlanded(walletB)]);
          // triggerSync's PROCESS_TRANSACTIONS_REQUEST auto-consumes pending
          // notes, moving their value out of `miden_sync_data.notes` and into the
          // account vault. Refresh the Zustand `balances` projection from that
          // vault before snapshotting so consumed value lands in `totalReportable`
          // — the initial baseline (getBalance) refreshes the same way. Without
          // this, every note consumed during settle drops out of the total and
          // strict conservation reports a phantom loss (see refreshBalances()).
          await Promise.all([walletA.refreshBalances(), walletB.refreshBalances()]);
          // Read full snapshot so we can log *what's* pending if settle gets stuck.
          const [snapA, snapB] = await Promise.all([
            walletA.quickBalanceSnapshot({ symbol: TOKEN }),
            walletB.quickBalanceSnapshot({ symbol: TOKEN })
          ]);
          // `quickBalanceSnapshot` swallows its own failures and reports
          // `totalReportable: 0` with an `error` field rather than throwing, so
          // an unchecked read here would put a fabricated zero into the
          // conservation identity and report a dead page as three thousand units
          // of lost value — the wrong-subsystem misdiagnosis this loop's guards
          // exist to prevent. Turn it back into the failed poll it is.
          if (snapA.error !== undefined || snapB.error !== undefined) {
            throw new Error(`balance snapshot failed (A: ${snapA.error ?? 'ok'}, B: ${snapB.error ?? 'ok'})`);
          }
          finalA = snapA.totalReportable;
          finalB = snapB.totalReportable;
          const readable = unlandedA.readFailed !== true && unlandedB.readFailed !== true;
          const sendsInFlight = unlandedA.pendingCount + unlandedB.pendingCount;
          // Follow the rows' own clock rather than guessing: a pending row whose
          // `nextEligibleAt` is still ahead of us is waiting exactly as designed,
          // and giving up on it would be a false failure. One that is past its own
          // eligibility and still has not moved is a genuine stall, and the base
          // budget is what catches it.
          const eligibleAtMax = Math.max(unlandedA.pendingEligibleAtMax, unlandedB.pendingEligibleAtMax);
          if (readable && sendsInFlight > 0 && eligibleAtMax > 0) {
            const waitForCooldownMs = eligibleAtMax * 1000 - settleStart + SETTLE_POLL_MS * 2;
            if (waitForCooldownMs > settleDeadlineMs) settleDeadlineMs = waitForCooldownMs;
          }
          lastGoodPollAt = Date.now();
          const clean = readable && finalA + finalB === initialTotal && sendsInFlight === 0;
          consecutiveClean = clean ? consecutiveClean + 1 : 0;
          if (consecutiveClean >= SETTLE_STABLE_POLLS) {
            timeline.emit({
              category: 'test_lifecycle',
              severity: 'info',
              message: `[stress] settle: A+B converged to ${initialTotal} in ${Math.round((Date.now() - settleStart) / 1000)}s`
            });
            break;
          }
          const pendingSample = (
            s: Awaited<ReturnType<typeof walletA.quickBalanceSnapshot>>,
            label: 'A' | 'B'
          ): string =>
            s.pendingNotes.length === 0
              ? `${label}.pending=[]`
              : `${label}.pending=[${s.pendingNotes
                  .slice(0, 6)
                  .map(n => `${n.id.slice(0, 10)}=${n.amount}`)
                  .join(',')}${s.pendingNotes.length > 6 ? `,…+${s.pendingNotes.length - 6}` : ''}]`;
          timeline.emit({
            category: 'test_lifecycle',
            severity: 'info',
            message:
              `[stress] settle: waiting — A=${finalA} B=${finalB} total=${finalA + finalB} target=${initialTotal} ` +
              `| ${pendingSample(snapA, 'A')} ${pendingSample(snapB, 'B')} ` +
              `pendingTx A=${snapA.pendingTxCount} B=${snapB.pendingTxCount} ` +
              `sendsInFlight A=${unlandedA.pendingCount} B=${unlandedB.pendingCount} ` +
              `readable=${readable} clean=${consecutiveClean}/${SETTLE_STABLE_POLLS} ` +
              `deadline=${Math.round(settleDeadlineMs / 1000)}s`,
            data: {
              finalA,
              finalB,
              target: initialTotal,
              pendingA: snapA.pendingNotes,
              pendingB: snapB.pendingNotes,
              pendingTxA: snapA.pendingTxCount,
              pendingTxB: snapB.pendingTxCount,
              latestTxA: snapA.latestTxId,
              latestTxB: snapB.latestTxId
            }
          });
        } catch (e) {
          // A poll that blew up tells us nothing, so it cannot count toward the
          // exit — and the run continues to the artifact writes below, which is
          // the whole reason for the guard.
          consecutiveClean = 0;
          console.log(`[stress] settle poll failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
      }
      // Captured HERE, the instant the loop ends — not down at the assertion.
      // Between the two sit the CSV, the summary and both wallets' full
      // IndexedDB dumps, which on a 300-op run take longer than the window
      // itself, so measuring there would time the forensics rather than the
      // snapshot and red every healthy run.
      const snapshotAgeMs = lastGoodPollAt === 0 ? Infinity : Date.now() - lastGoodPollAt;
      const finalTotal = finalA + finalB;
      const delta = finalTotal - initialTotal;

      // ── Reconcile where the value ended up against what actually landed ──
      //
      // Both sides come from the wallets themselves: A's balance moved by exactly
      // the value B's table says B sent, minus the value A's table says A sent.
      // Every send in this suite is A↔B, and only `send` rows can move the
      // quantity being compared — a consume just converts a pending note into
      // vault balance, and `totalReportable` counts both — so the identity is
      // complete.
      //
      // Deliberately NOT reconciled against the driver's `expectedDelta*`. The
      // driver counts a send as `ok` the moment `sendTokens` returns, long before
      // the guardian pipeline runs, so its bookkeeping and the wallet's disagree
      // whenever a send fails late — and an earlier version tried to bridge that
      // with a slack term summed from the driver's failed ops. That slack was the
      // problem: a duplicate send and a driver-failed-op-that-actually-landed
      // both make A poorer than expected by the same amount, so any slack big
      // enough to excuse the second was big enough to hide the first — and the
      // first is the specific hazard the retry under test introduces. Comparing
      // wallet to wallet needs no slack for that, and the one term it cannot
      // resolve — a send that failed after possibly crossing submit — is bounded
      // per-wallet and per-direction below rather than granted as a lump sum.
      //
      // A double-send shows up here directly: the chain moved the value twice,
      // the table holds one Completed row, and the difference is the payment the
      // user did not authorize.
      const observedDeltaA = finalA - initialA;
      const rowDeltaA = unlandedB.completed - unlandedA.completed;
      const unexplainedA = observedDeltaA - rowDeltaA;
      // Kept as a diagnostic only — it is the cross-check on the driver's own
      // bookkeeping, which is useful in the artifacts and unsafe as an assertion.
      const driverUnexplainedA =
        observedDeltaA -
        (result.expectedDeltaA + (unlandedA.failed + unlandedA.pending) - (unlandedB.failed + unlandedB.pending));

      // ── Write artifacts ────────────────────────────────────────────────
      const outDir = timeline.getOutputDir();
      const csvPath = path.join(outDir, 'stress-operations.csv');
      const header =
        'idx,sender,receiver,isPrivate,amount,sendMs,status,concurrent,perturbation,error,' +
        'secondaryAmount,secondaryIsPrivate,secondaryStatus,secondarySendMs,secondaryErr\n';
      const rows = result.perOp
        .map(o =>
          [
            o.idx,
            o.sender,
            o.receiver,
            o.isPrivate,
            o.amount,
            o.sendMs,
            o.status,
            o.concurrent ?? false,
            o.perturbation ?? '',
            (o.err ?? '').replace(/[,\n]/g, ' '),
            o.secondaryAmount ?? '',
            o.secondaryIsPrivate ?? '',
            o.secondaryStatus ?? '',
            o.secondarySendMs ?? '',
            (o.secondaryErr ?? '').replace(/[,\n]/g, ' ')
          ].join(',')
        )
        .join('\n');
      fs.writeFileSync(csvPath, header + rows + '\n');

      const latencies = result.perOp
        .filter(o => o.status === 'ok')
        .map(o => o.sendMs)
        .sort((a, b) => a - b);
      const pct = (p: number): number => {
        if (latencies.length === 0) return 0;
        return latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
      };

      const summary = {
        seed: opts.seed,
        options: opts,
        initialMintsPerWallet,
        initialBalances: { A: initialA, B: initialB, total: initialTotal },
        finalBalances: { A: finalA, B: finalB, total: finalTotal },
        balanceDelta: delta,
        conservationHeld: delta === 0,
        driver: {
          requested: result.requested,
          completed: result.completed,
          failed: result.failed,
          perturbations: result.perturbations,
          firstDivergenceOp: result.firstDivergenceOp,
          expectedDeltaA: result.expectedDeltaA,
          expectedDeltaB: result.expectedDeltaB
        },
        // What the wallets themselves say happened to the sends the driver
        // counted as `ok` — the driver cannot see a failure that lands after
        // `sendTokens` returns.
        settlement: {
          unlandedSends: { A: unlandedA, B: unlandedB },
          observedDeltaA,
          rowDeltaA,
          unexplainedA,
          driverUnexplainedA,
          // How the settle loop ended, so a red run can be told apart from an
          // unmeasurable one in the artifact alone, without re-reading a
          // multi-hour console log.
          settleEndedAt: Date.now(),
          lastGoodPollAt,
          consecutiveClean,
          settleDeadlineMs
        },
        sendLatencyMs: {
          min: latencies[0] ?? 0,
          p50: pct(0.5),
          p95: pct(0.95),
          max: latencies[latencies.length - 1] ?? 0,
          successful: latencies.length
        }
      };
      fs.writeFileSync(path.join(outDir, 'stress-summary.json'), JSON.stringify(summary, null, 2));

      // ── Forensic dumps ─────────────────────────────────────────────────
      // Dumps run SEQUENTIALLY (A then B), never concurrently: an 800-loop run
      // accumulates enough IndexedDB that serializing both wallets' full DBs at
      // once tripped the OOM killer on the runner, which killed the Chromium
      // targets mid-dump and left only a "page closed" placeholder. Sequential
      // + store-at-a-time streaming keeps peak memory bounded.

      // Full chrome.storage.local from both wallets — includes miden_sync_data
      // (pending notes + vault assets), connectivity-issue flag, cached
      // metadata, and anything else the wallet persists. Snapshot of the
      // wallet's exact view-of-world at the moment the assertion runs.
      try {
        const storageA = await walletA.dumpChromeStorage();
        const storageB = await walletB.dumpChromeStorage();
        fs.writeFileSync(
          path.join(outDir, 'chrome-storage-final.json'),
          JSON.stringify({ A: storageA, B: storageB }, null, 2)
        );
      } catch (e) {
        console.log(`[stress] chrome.storage dump failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // IndexedDB — where the Miden SDK keeps its authoritative state
      // (transactions, notes, accounts, chain MMR). For "did this tx actually
      // commit?" forensics, the SDK's transactions table is the ground truth.
      // Streamed one store at a time to a per-wallet file so a slow/large dump
      // can't OOM the page, and so a failure on one wallet still leaves the
      // other's file intact. Each call is independently guarded.
      for (const [label, wallet] of [
        ['A', walletA],
        ['B', walletB]
      ] as const) {
        const idbPath = path.join(outDir, `indexeddb-final-${label}.json`);
        try {
          const res = await streamIndexedDBToFile(wallet, idbPath);
          console.log(
            `[stress] indexeddb dump ${label}: ${res.storesDumped} stores, ${res.entriesDumped} entries` +
              (res.storesFailed ? `, ${res.storesFailed} stores FAILED` : '') +
              (res.truncatedStores.length ? `, truncated: ${res.truncatedStores.join(',')}` : '')
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.log(`[stress] indexeddb dump ${label} failed: ${message}`);
          // Leave a labeled marker so the artifact is never silently absent;
          // the retained profile dir (see two-wallets fixture) is the real
          // offline-recovery path when the page died mid-dump.
          try {
            fs.writeFileSync(idbPath, JSON.stringify({ __error: message }));
          } catch {
            // best-effort
          }
        }
      }

      // Extract pending-tx time series from existing GeneratingTransaction
      // browser_console events — zero-cost post-processing of data the
      // wallet already logs. Output: CSV with one row per state change.
      try {
        const timelinePath = path.join(outDir, 'timeline.ndjson');
        if (fs.existsSync(timelinePath)) {
          const txQueueRows: string[] = ['elapsedMs,wallet,txCount,hasStartedProcessing,failedCount'];
          const pattern =
            /\[GeneratingTransaction\] State: \{txCount: (\d+), hasStartedProcessing: (true|false), failedCount: (\d+)/;
          const contents = fs.readFileSync(timelinePath, 'utf-8');
          for (const line of contents.split('\n')) {
            if (!line) continue;
            try {
              const d = JSON.parse(line);
              const m = pattern.exec(String(d.message ?? ''));
              if (!m) continue;
              txQueueRows.push(`${d.elapsedMs},${d.wallet ?? ''},${m[1]},${m[2]},${m[3]}`);
            } catch {
              // malformed line, skip
            }
          }
          fs.writeFileSync(path.join(outDir, 'tx-queue-timeseries.csv'), txQueueRows.join('\n') + '\n');
        }
      } catch (e) {
        console.log(`[stress] tx-queue extraction failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      console.log('\n=== STRESS SUMMARY ===');
      console.log(JSON.stringify(summary, null, 2));
      console.log(`\nArtifacts written to: ${outDir}\n`);

      // ── Invariants ─────────────────────────────────────────────────────
      // At least some sends must have succeeded.
      expect(result.completed, 'no sends succeeded — environment issue').toBeGreaterThan(0);

      // Everything below reads the wallets' own transaction tables, so establish
      // FIRST that those reads describe reality. Both failure modes are silent
      // and both look like a flawless run: a page that died returns the sentinel,
      // and `indexedDB.open` with no version CREATES an empty database rather
      // than failing, so a read against the wrong origin succeeds with zeros.
      // The driver initiated at least `result.completed` sends, so a scan that
      // saw no send rows at all is reading something other than the wallet.
      expect(
        unlandedA.readFailed === true || unlandedB.readFailed === true,
        'could not read the wallets’ send rows — the run is unmeasurable, not clean'
      ).toBe(false);
      expect(
        unlandedA.storeMissing || unlandedB.storeMissing,
        'wallet transactions store missing — reading the wrong origin?'
      ).toBe(false);
      // Corroborated against the driver, not merely non-empty: every send the
      // driver counted as ok left a row, and concurrent secondaries only add to
      // that. A scan that returned one row of three hundred would satisfy a
      // non-empty check and then let the bucket identity below balance trivially
      // at 1 === 1.
      expect(
        unlandedA.totalCount + unlandedB.totalCount,
        `send-row scan saw ${unlandedA.totalCount + unlandedB.totalCount} send rows ` +
          `while the driver completed ${result.completed} — reading the wrong origin, or a partial scan?`
      ).toBeGreaterThanOrEqual(result.completed);
      // Three consecutive failed polls means the numbers below are at least
      // fifteen seconds stale and the page has stopped answering — judge nothing
      // on them. One failed poll after a good one is tolerated: a page that dies
      // on the way out of a converged run is a real and benign ending.
      const SETTLE_MAX_SNAPSHOT_AGE_MS = SETTLE_POLL_MS * 3;
      expect(
        snapshotAgeMs,
        lastGoodPollAt === 0
          ? 'no settle poll ever completed — the run is unmeasurable, not clean'
          : `the numbers below were taken ${Math.round(snapshotAgeMs / 1000)}s ago and every poll since threw ` +
              `— unmeasurable, not clean`
      ).toBeLessThanOrEqual(SETTLE_MAX_SNAPSHOT_AGE_MS);
      // The bucket counts are what the checks below actually read, but only
      // `totalCount` is independently corroborated (against the driver, above).
      // Pinning the split to it means a bucket that silently reads zero — the one
      // way an unbounded-requeue regression could slip past the in-flight check —
      // cannot also balance.
      for (const [label, u] of [
        ['A', unlandedA],
        ['B', unlandedB]
      ] as const) {
        expect(
          u.completedCount + u.failedCount + u.pendingCount + u.failedMaybeSubmittedCount,
          `wallet ${label}'s send-row buckets do not add up to its ${u.totalCount} send rows`
        ).toBe(u.totalCount);
      }

      // A Failed send the wallet flagged as possibly-submitted may or may not
      // have moved value, so it is the one term the reconciliation below cannot
      // resolve. Computed and reported HERE, ahead of every assertion, because
      // the run where it matters is the run where an assertion throws — behind
      // one of them it would be printed only when nobody needed it.
      const maybeSubmitted = unlandedA.failedMaybeSubmittedCount + unlandedB.failedMaybeSubmittedCount;
      const maybeSubmittedValue = unlandedA.failedMaybeSubmitted + unlandedB.failedMaybeSubmitted;
      if (maybeSubmitted > 0) {
        console.log(
          `[stress] WARNING: ${maybeSubmitted} failed send(s) may already have been submitted ` +
            `(${maybeSubmittedValue} in value: ${unlandedA.failedMaybeSubmitted} A's, ` +
            `${unlandedB.failedMaybeSubmitted} B's) — the per-wallet reconciliation below tolerates ` +
            `each wallet's own share in its own direction, not the sum in both`
        );
      }

      // Strict conservation: total balance must match initial.
      // Any deviation means a note was lost somewhere — a real bug.
      if (conservationStrict) {
        // A send still Queued or generating after settle has not finished, so
        // nothing measured after it describes a completed run. Asserted FIRST:
        // an unfinished run would otherwise trip the balance identity below and
        // be reported as value loss, pointing at the wrong subsystem entirely.
        // Under the same flag as the balance checks because it is the same kind
        // of claim about the environment, and the flag exists to run against an
        // environment known to be degraded.
        //
        // Exempted from no-conditional-expect: `conservationStrict` is a run-mode
        // flag read from the environment before the test starts, not a fact derived
        // from the behaviour under test, so this cannot become the silent feature
        // check that rule exists to catch. It shares the flag with the balance
        // identity directly below it, which the baseline already records.
        // eslint-disable-next-line no-conditional-expect -- run-mode flag, not a behaviour check
        expect(
          unlandedA.pendingCount + unlandedB.pendingCount,
          `sends still in flight after ${Math.round((Date.now() - settleStart) / 1000)}s of settle ` +
            `(A: ${unlandedA.pendingCount}, B: ${unlandedB.pendingCount})`
        ).toBe(0);

        expect(delta, `balance conservation violated by ${delta}; notes lost`).toBe(0);

        // Per-wallet placement, which the total alone cannot see: A and B can sum
        // to the right number while value sits on the wrong side. Both sides are
        // the wallets' own records, so the only slack is the ambiguous bucket —
        // exact on a run that produces none, and bounded per-direction otherwise.
        //
        // The driver's own view is logged rather than asserted when the two
        // disagree, which happens whenever a send failed after `sendTokens`
        // returned. That is a fact about the driver's optimism, not about where
        // value went.
        if (driverUnexplainedA !== unexplainedA) {
          timeline.emit({
            category: 'test_lifecycle',
            severity: 'info',
            message:
              `[stress] driver bookkeeping differs from the wallets' own: ` +
              `unexplainedA=${unexplainedA} driverUnexplainedA=${driverUnexplainedA} ` +
              `(driverFailed=${result.failed}, secondaryFailed=${result.perturbations.concurrentSecondaryFailed}, ` +
              `maybeSubmitted=${unlandedA.failedMaybeSubmittedCount}/${unlandedB.failedMaybeSubmittedCount})`,
            data: { unexplainedA, driverUnexplainedA, observedDeltaA, rowDeltaA }
          });
        }
        // Bounded SEPARATELY IN EACH DIRECTION, because the two sources of
        // honest skew are per-wallet and push opposite ways. A maybe-submitted
        // row is one that failed after its submit crossing and may therefore
        // have landed: the balance side counts it, the row side (Completed rows
        // only) does not. One of A's makes A poorer — a negative contribution,
        // bounded by A's own maybe-submitted value. One of B's makes A richer —
        // positive, bounded by B's. So the honest interval is
        // [-A.failedMaybeSubmitted, +B.failedMaybeSubmitted], and both ends are
        // zero on a run that produces none, which keeps the check exact where it
        // can be.
        //
        // A symmetric bound on the sum would be twice as loose in the direction
        // that matters. A duplicate send FROM A is negative, and A's own
        // ambiguity is all that can honestly explain a negative — allowing
        // B's as well hands away a factor of two on precisely the catastrophic
        // side. The two failure messages differ for the same reason: one means
        // more value left A than any completed send explains, the other means
        // more arrived at A than B says it sent.
        //
        // The total ambiguity is itself capped, by the failed-send ceiling
        // below: maybe-submitted rows count toward that rate, so a run cannot
        // quietly accumulate enough of them to hide an arbitrary duplicate.
        // eslint-disable-next-line no-conditional-expect -- run-mode flag, not a behaviour check
        expect(
          unexplainedA,
          `per-wallet balance unexplained by ${unexplainedA}: A's balance moved ${observedDeltaA}, ` +
            `but the wallets' own tables account for ${rowDeltaA} ` +
            `(A completed ${unlandedA.completedCount} sends worth ${unlandedA.completed}, ` +
            `B completed ${unlandedB.completedCount} worth ${unlandedB.completed}). ` +
            `More value left A than any completed send explains, beyond the ` +
            `${unlandedA.failedMaybeSubmitted} A had in maybe-submitted sends — a duplicate send.`
        ).toBeGreaterThanOrEqual(-unlandedA.failedMaybeSubmitted);
        // eslint-disable-next-line no-conditional-expect -- run-mode flag, not a behaviour check
        expect(
          unexplainedA,
          `per-wallet balance unexplained by ${unexplainedA}: more value arrived at A than B's table ` +
            `says B sent (${rowDeltaA}), beyond the ${unlandedB.failedMaybeSubmitted} B had in ` +
            `maybe-submitted sends — a duplicate send from B, or value from outside the pair.`
        ).toBeLessThanOrEqual(unlandedB.failedMaybeSubmitted);
      }

      // Sends the wallet itself later marked Failed. These are invisible to
      // `result.failed`, which counts only what `sendTokens` threw on, so
      // without this a run reports 300/300 while a large fraction never reached
      // the chain — which is exactly how the failure that motivated the retry
      // under test went unnoticed for a whole 300-op run.
      //
      // Asserted, not merely logged, so a regression that re-terminalizes the
      // guardian race reds a run instead of printing a line into a multi-hour log.
      //
      // TWO ceilings, because the two buckets support different claims and only
      // one of them is environment-shaped.
      //
      // The combined one counts BOTH buckets. Excluding the ambiguous bucket
      // would make it vacuous on exactly the runs it exists for: on a guardian
      // build `mayHaveSubmitted` is stamped BEFORE the offscreen pipeline is
      // dispatched, not at the submit crossing — deliberately, as a pessimistic
      // retry gate — so nearly every recallable send that fails lands in
      // `failedMaybeSubmitted` and the plain bucket reads zero however bad the
      // run was. A send the wallet did not complete is a failed send whatever
      // its submit fate. It is non-zero in BOTH run modes, because that same
      // pre-dispatch stamping is not guardian-specific — `stageStampFor` stamps
      // any send that reaches `submitting`, and `cancelTransactionAfterPipelineStopped`
      // stamps one evicted by a poisoned or aborted client — so the ambiguous
      // bucket can fill on a run with no guardian in it.
      //
      // It stays at ZERO there anyway. A send the wallet did not complete is a
      // real signal on a hermetic localnet whatever its submit fate, and the
      // nightly's own header asks for a first failure to reach a human rather
      // than be absorbed. If eviction on the two-core runner turns out to make
      // that noisy in practice, the answer is an explicit
      // `STRESS_MAX_FAILED_SEND_RATE` on the job with the observed rate behind
      // it — not a ceiling guessed at here, ahead of the evidence.
      //
      // The second, plain-bucket assertion is not redundant with that zero: it
      // stays meaningful if the combined ceiling is ever raised, and it says
      // which bucket failed without needing the summary.
      const plainFailed = unlandedA.failedCount + unlandedB.failedCount;
      const failedSends = plainFailed + maybeSubmitted;
      // Denominator is every send ROW, not `result.completed` — the latter
      // counts only primaries, so a concurrent secondary's failure could push
      // the rate past 100%.
      const totalSendRows = unlandedA.totalCount + unlandedB.totalCount;
      const failedSendRate = failedSends / Math.max(totalSendRows, 1);
      if (failedSends > 0) {
        console.log(
          `[stress] WARNING: ${failedSends} send(s) the driver counted as ok were later marked Failed ` +
            `by the wallet (${(100 * failedSendRate).toFixed(1)}% of counted sends, ` +
            `${maybeSubmitted} of them possibly submitted) — see settlement.unlandedSends in the summary`
        );
      }
      // Via floatEnv, not Number(process.env.X ?? default): `??` does not fire on
      // an empty string, so `STRESS_MAX_FAILED_SEND_RATE=` in a CI env file would
      // silently mean 0 — the strictest possible ceiling, on exactly the guardian
      // run that needs the loosest — and a typo would mean NaN, which reds every
      // run including a flawless one.
      const maxFailedSendRate = floatEnv('STRESS_MAX_FAILED_SEND_RATE', useGuardian ? 0.05 : 0);
      // Range-checked, because `floatEnv` rejects only a value that parses to
      // NaN — `parseFloat('5%')` is 5, which would silently raise this ceiling to
      // 500% and disable the check while looking like it had been tightened.
      if (!(maxFailedSendRate >= 0 && maxFailedSendRate <= 1)) {
        throw new Error(`STRESS_MAX_FAILED_SEND_RATE=${maxFailedSendRate} is not a rate in [0,1]`);
      }
      expect(
        failedSendRate,
        `${failedSends}/${totalSendRows} sends were marked Failed by the wallet ` +
          `(${(100 * failedSendRate).toFixed(1)}%), over the ${(100 * maxFailedSendRate).toFixed(1)}% ceiling — ` +
          `raise STRESS_MAX_FAILED_SEND_RATE to run against a knowingly degraded environment. ` +
          `The 300-send run that motivated the guardian retry sat at 14%.`
      ).toBeLessThanOrEqual(maxFailedSendRate);
      if (!useGuardian) {
        // eslint-disable-next-line no-conditional-expect -- run-mode flag, not a behaviour check
        expect(
          plainFailed,
          `${plainFailed} send(s) failed without ever reaching submit, on a run with no guardian ` +
            `in it — there is no race to blame, so this is the wallet or the localnet`
        ).toBe(0);
      }
    });
  });
});
