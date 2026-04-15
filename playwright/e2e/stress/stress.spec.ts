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
    perTurnSendTimeoutMs: intEnv('STRESS_SEND_TIMEOUT_MS', 60_000),
    seed: intEnv('STRESS_SEED', Date.now() >>> 0),
  };
}

test.describe('Stress: random send/claim', () => {
  test.describe.configure({ mode: 'serial' });

  // No per-test timeout — the driver's `numNotes` is the stop condition.
  test.setTimeout(0);

  test('random send/claim between two wallets', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
  }) => {
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
        walletB.waitForBalanceAbove(0, 180_000, timeline),
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
      result = await runStressDriver(
        { walletA, walletB, addressA, addressB },
        timeline,
        opts
      );
    });

    await steps.step('verify_and_report', async () => {
      if (!result) throw new Error('stress driver did not return a result');

      const finalA = await walletA.getBalance();
      const finalB = await walletB.getBalance();
      const finalTotal = finalA + finalB;
      const delta = finalTotal - initialTotal;

      // ── Write artifacts ────────────────────────────────────────────────
      const outDir = timeline.getOutputDir();
      const csvPath = path.join(outDir, 'stress-operations.csv');
      const header = 'idx,sender,receiver,isPrivate,amount,sendMs,status,concurrent,perturbation,error\n';
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
        },
        sendLatencyMs: {
          min: latencies[0] ?? 0,
          p50: pct(0.5),
          p95: pct(0.95),
          max: latencies[latencies.length - 1] ?? 0,
          successful: latencies.length,
        },
      };
      fs.writeFileSync(path.join(outDir, 'stress-summary.json'), JSON.stringify(summary, null, 2));

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
