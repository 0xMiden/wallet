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

import { expect, test } from '../fixtures/two-wallets';

import { runStressDriver, type StressOptions } from './stress-driver';

const INITIAL_MINT_AMOUNT = 100_000_000_000; // matches mint-and-balance.spec.ts

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
    seed: intEnv('STRESS_SEED', Date.now() >>> 0)
  };
}

test.describe('Stress: random send/claim', () => {
  test.describe.configure({ mode: 'serial' });

  // No per-test timeout — the driver's `numNotes` is the stop condition.
  test.setTimeout(0);

  test('random send/claim between two wallets', async ({ walletA, walletB, midenCli, steps, timeline }) => {
    const opts = parseOptions();
    const initialMintsPerWallet = intEnv('STRESS_INITIAL_MINTS', 3);
    const conservationStrict = (process.env.STRESS_CONSERVATION_STRICT ?? 'true') === 'true';

    console.log('\n=== STRESS RUN PARAMETERS ===');
    console.log(JSON.stringify({ ...opts, initialMintsPerWallet, conservationStrict }, null, 2));
    console.log('');

    let addressA = '';
    let addressB = '';

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      await midenCli.createFaucet();
      for (let i = 0; i < initialMintsPerWallet; i++) {
        await midenCli.mint(addressA, INITIAL_MINT_AMOUNT, 'public');
        await midenCli.mint(addressB, INITIAL_MINT_AMOUNT, 'public');
      }
      await midenCli.sync();
    });

    await steps.step('initial_claim', async () => {
      await Promise.all([
        walletA.waitForBalanceAbove(0, 180_000, timeline),
        walletB.waitForBalanceAbove(0, 180_000, timeline)
      ]);
      await walletA.claimAllNotes(180_000);
      await walletB.claimAllNotes(180_000);
    });

    const initialA = await walletA.getBalance();
    const initialB = await walletB.getBalance();
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
      // "submitted" to "committed." Wait up to 5 min for A+B to reach the
      // initial total. If we never converge, that's a true loss and the
      // assertion below will surface it.
      const SETTLE_DEADLINE_MS = 5 * 60 * 1000;
      const SETTLE_POLL_MS = 5_000;
      let finalA = 0;
      let finalB = 0;
      const settleStart = Date.now();
      while (Date.now() - settleStart < SETTLE_DEADLINE_MS) {
        await Promise.all([walletA.triggerSync(), walletB.triggerSync()]);
        // Read full snapshot so we can log *what's* pending if settle gets stuck.
        const [snapA, snapB] = await Promise.all([walletA.quickBalanceSnapshot(), walletB.quickBalanceSnapshot()]);
        finalA = snapA.totalReportable;
        finalB = snapB.totalReportable;
        if (finalA + finalB === initialTotal) {
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
            `pendingTx A=${snapA.pendingTxCount} B=${snapB.pendingTxCount}`,
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
        await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
      }
      const finalTotal = finalA + finalB;
      const delta = finalTotal - initialTotal;

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
      // Full chrome.storage.local from both wallets — includes miden_sync_data
      // (pending notes + vault assets), connectivity-issue flag, cached
      // metadata, and anything else the wallet persists. Snapshot of the
      // wallet's exact view-of-world at the moment the assertion runs.
      try {
        const [storageA, storageB] = await Promise.all([walletA.dumpChromeStorage(), walletB.dumpChromeStorage()]);
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
      // Result is a JSON string (with binary→hex wrappers); wrap per-wallet
      // keys so both fit in one readable file.
      try {
        const [idbA, idbB] = await Promise.all([walletA.dumpIndexedDB(), walletB.dumpIndexedDB()]);
        fs.writeFileSync(path.join(outDir, 'indexeddb-final.json'), `{"A":${idbA},"B":${idbB}}`);
      } catch (e) {
        console.log(`[stress] indexeddb dump failed: ${e instanceof Error ? e.message : String(e)}`);
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

      // Strict conservation: total balance must match initial.
      // Any deviation means a note was lost somewhere — a real bug.
      if (conservationStrict) {
        expect(delta, `balance conservation violated by ${delta}; notes lost`).toBe(0);
      }
    });
  });
});
