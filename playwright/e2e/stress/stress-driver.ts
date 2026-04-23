/**
 * Randomized send/claim driver for the stress test suite.
 *
 * Reuses the regular Chrome E2E fixture (two wallets + observability) and
 * exercises real-world patterns: random sender/receiver, mix of public/private
 * notes, randomized inter-op delays, optional perturbations (lock/unlock, page
 * reload, concurrent sends from both sides), periodic idle windows.
 *
 * The driver treats any lost/stuck notes as real bugs — final-balance
 * conservation is asserted strictly by the caller after the drain phase.
 */
import type { TimelineRecorder } from '../harness/timeline-recorder';
import type { ChromeWalletPageApi } from '../helpers/wallet-page';

export interface StressOptions {
  numNotes: number;
  delayMinMs: number;
  delayMaxMs: number;
  privateRatio: number;
  sendAmountMin: number;
  sendAmountMax: number;
  claimAfterSendProb: number;
  idleEvery: number;
  idleMinMs: number;
  idleMaxMs: number;
  lockEvery: number;
  reloadEvery: number;
  concurrentProb: number;
  perTurnSendTimeoutMs: number;
  seed: number;
}

export interface StressOpRecord {
  idx: number;
  sender: 'A' | 'B';
  receiver: 'A' | 'B';
  isPrivate: boolean;
  amount: number;
  sendMs: number;
  status: 'ok' | 'fail';
  err?: string;
  perturbation?: string;
  concurrent?: boolean;
  // When concurrent=true, a secondary send fires in the reverse direction. The
  // driver awaits it (allSettled) so it doesn't fail the primary, but the
  // result matters for balance conservation — a silently-failed secondary is
  // prime suspect for "tokens lost" reports. Track amount + outcome.
  secondaryAmount?: number;
  secondaryIsPrivate?: boolean;
  secondaryStatus?: 'ok' | 'fail';
  secondaryErr?: string;
  secondarySendMs?: number;
}

export interface StressResult {
  seed: number;
  requested: number;
  completed: number;
  failed: number;
  perturbations: {
    locks: number;
    reloads: number;
    concurrent: number;
    concurrentSecondaryFailed: number;
    idles: number;
  };
  /** First op index where observed balance diverged from expected, or null if none. */
  firstDivergenceOp: number | null;
  /** Final expected deltas vs initial (useful for verifying driver bookkeeping). */
  expectedDeltaA: number;
  expectedDeltaB: number;
  perOp: StressOpRecord[];
}

// ── Seeded RNG (LCG — adequate for scheduling, not for crypto) ──────────────
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function intInRange(min: number, max: number, rng: () => number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Driver ──────────────────────────────────────────────────────────────────
export interface StressDriverInputs {
  walletA: ChromeWalletPageApi;
  walletB: ChromeWalletPageApi;
  addressA: string;
  addressB: string;
  /** Token symbol to send (defaults to the custom-faucet "TST"). */
  tokenSymbol?: string;
}

export async function runStressDriver(
  inputs: StressDriverInputs,
  timeline: TimelineRecorder,
  opts: StressOptions
): Promise<StressResult> {
  const { walletA, walletB, addressA, addressB, tokenSymbol = 'TST' } = inputs;
  const rng = makeRng(opts.seed);
  const wallets: Record<'A' | 'B', ChromeWalletPageApi> = { A: walletA, B: walletB };
  const addrs: Record<'A' | 'B', string> = { A: addressA, B: addressB };
  const perOp: StressOpRecord[] = [];
  const perturbations = { locks: 0, reloads: 0, concurrent: 0, concurrentSecondaryFailed: 0, idles: 0 };
  let completed = 0;
  let failed = 0;
  let idx = 0;

  // Per-op balance tracking: the driver knows each op's intended transfer,
  // so it can maintain expected deltas and compare against the wallet's
  // actual reported state (consumed + pending). First divergent op pinpoints
  // where tokens started going missing.
  const initA = await walletA.quickBalanceSnapshot();
  const initB = await walletB.quickBalanceSnapshot();
  const initialA = initA.totalReportable;
  const initialB = initB.totalReportable;
  let expectedDeltaA = 0;
  let expectedDeltaB = 0;
  let firstDivergenceOp: number | null = null;

  timeline.emit({
    category: 'blockchain_state',
    severity: 'info',
    message: `[bal] driver start initialA=${initialA} initialB=${initialB}`,
    data: { initialA, initialB, phase: 'driver_start' }
  });

  timeline.emit({
    category: 'test_lifecycle',
    severity: 'info',
    message: `[stress] starting driver: numNotes=${opts.numNotes} seed=${opts.seed}`,
    data: { ...opts }
  });

  while (completed < opts.numNotes) {
    idx++;
    const senderLabel: 'A' | 'B' = rng() < 0.5 ? 'A' : 'B';
    const receiverLabel: 'A' | 'B' = senderLabel === 'A' ? 'B' : 'A';
    const isPrivate = rng() < opts.privateRatio;
    const amount = intInRange(opts.sendAmountMin, opts.sendAmountMax, rng);
    const concurrent = rng() < opts.concurrentProb;

    const sender = wallets[senderLabel];
    const receiver = wallets[receiverLabel];
    const receiverAddress = addrs[receiverLabel];

    const start = Date.now();
    let status: 'ok' | 'fail' = 'ok';
    let err: string | undefined;
    let perturbation: string | undefined;

    // Secondary (concurrent) send, captured only when concurrent=true.
    // Previously unobserved — a silently-failed secondary is the leading
    // hypothesis for persistent balance-conservation gaps.
    let secondaryAmount: number | undefined;
    let secondaryIsPrivate: boolean | undefined;
    let secondaryStatus: 'ok' | 'fail' | undefined;
    let secondaryErr: string | undefined;
    let secondarySendMs: number | undefined;

    timeline.emit({
      category: 'stress_op',
      severity: 'info',
      message:
        `[stress] op#${idx} starting: ${senderLabel}->${receiverLabel} ` +
        `${isPrivate ? 'priv' : 'pub'} amt=${amount}${concurrent ? ' concurrent' : ''}`,
      data: { idx, sender: senderLabel, receiver: receiverLabel, isPrivate, amount, concurrent, phase: 'pre_send' }
    });

    try {
      if (concurrent) {
        // Both wallets fire a send at (roughly) the same time — stress the
        // client-side lock discipline. The secondary send is in the OTHER
        // direction and doesn't count toward the note budget (only the primary
        // does); its outcome is recorded for balance-conservation forensics.
        perturbations.concurrent++;
        secondaryAmount = intInRange(opts.sendAmountMin, opts.sendAmountMax, rng);
        secondaryIsPrivate = rng() < opts.privateRatio;
        const secondaryStart = Date.now();
        const [primary, secondary] = await Promise.allSettled([
          withTimeout(
            sender.sendTokens({ recipientAddress: receiverAddress, amount: String(amount), isPrivate, tokenSymbol }),
            opts.perTurnSendTimeoutMs,
            `op#${idx} concurrent primary (${senderLabel}->${receiverLabel})`
          ),
          withTimeout(
            receiver.sendTokens({
              recipientAddress: addrs[senderLabel],
              amount: String(secondaryAmount),
              isPrivate: secondaryIsPrivate,
              tokenSymbol
            }),
            opts.perTurnSendTimeoutMs,
            `op#${idx} concurrent secondary (${receiverLabel}->${senderLabel})`
          )
        ]);
        secondarySendMs = Date.now() - secondaryStart;
        if (secondary.status === 'rejected') {
          secondaryStatus = 'fail';
          secondaryErr = secondary.reason instanceof Error ? secondary.reason.message : String(secondary.reason);
          perturbations.concurrentSecondaryFailed++;
          timeline.emit({
            category: 'stress_op',
            severity: 'warn',
            message:
              `[stress] op#${idx} concurrent secondary ${receiverLabel}->${senderLabel} ` +
              `${secondaryIsPrivate ? 'priv' : 'pub'} amt=${secondaryAmount} FAILED: ${secondaryErr.slice(0, 200)}`,
            data: {
              idx,
              sender: receiverLabel,
              receiver: senderLabel,
              isPrivate: secondaryIsPrivate,
              amount: secondaryAmount,
              sendMs: secondarySendMs,
              phase: 'secondary_failed'
            }
          });
        } else {
          secondaryStatus = 'ok';
        }
        if (primary.status === 'rejected') throw primary.reason;
      } else {
        await withTimeout(
          sender.sendTokens({
            recipientAddress: receiverAddress,
            amount: String(amount),
            isPrivate,
            tokenSymbol
          }),
          opts.perTurnSendTimeoutMs,
          `op#${idx} sendTokens (${senderLabel}->${receiverLabel})`
        );
      }
      completed++;
    } catch (e) {
      status = 'fail';
      err = e instanceof Error ? e.message : String(e);
      failed += 1;
    }
    const sendMs = Date.now() - start;

    perOp.push({
      idx,
      sender: senderLabel,
      receiver: receiverLabel,
      isPrivate,
      amount,
      sendMs,
      status,
      err,
      concurrent,
      secondaryAmount,
      secondaryIsPrivate,
      secondaryStatus,
      secondaryErr,
      secondarySendMs
    });

    // Slow ops aren't failures — log them as warn so they're visible in the
    // timeline but still count as ok. Threshold picked to sit well above the
    // clean-run p95 (~14s) but below anything that would count as truly stuck.
    const SLOW_SEND_MS = 60_000;
    const slow = status === 'ok' && sendMs >= SLOW_SEND_MS;
    timeline.emit({
      category: 'stress_op',
      severity: status === 'ok' ? (slow ? 'warn' : 'info') : 'error',
      message:
        `[stress] op#${idx} ${senderLabel}->${receiverLabel} ` +
        `${isPrivate ? 'priv' : 'pub'} amt=${amount} ${sendMs}ms ${status}` +
        (slow ? ' SLOW' : '') +
        (concurrent ? ' concurrent' : '') +
        (err ? ` err=${err.slice(0, 120)}` : ''),
      data: { idx, sender: senderLabel, receiver: receiverLabel, isPrivate, amount, sendMs, status, concurrent, slow }
    });

    // ── Balance bookkeeping ─────────────────────────────────────────────────
    // Update expected deltas from this op's primary + (if applicable) secondary.
    if (status === 'ok') {
      if (senderLabel === 'A') expectedDeltaA -= amount;
      else expectedDeltaB -= amount;
      if (receiverLabel === 'A') expectedDeltaA += amount;
      else expectedDeltaB += amount;
    }
    if (concurrent && secondaryStatus === 'ok' && secondaryAmount !== undefined) {
      // secondary direction is reversed: sender=receiverLabel, receiver=senderLabel
      if (receiverLabel === 'A') expectedDeltaA -= secondaryAmount;
      else expectedDeltaB -= secondaryAmount;
      if (senderLabel === 'A') expectedDeltaA += secondaryAmount;
      else expectedDeltaB += secondaryAmount;
    }

    // Read actual — parallel, ~100ms total
    const [snapA, snapB] = await Promise.all([walletA.quickBalanceSnapshot(), walletB.quickBalanceSnapshot()]);
    const observedDeltaA = snapA.totalReportable - initialA;
    const observedDeltaB = snapB.totalReportable - initialB;
    const divergenceA = observedDeltaA - expectedDeltaA;
    const divergenceB = observedDeltaB - expectedDeltaB;
    const diverged = divergenceA !== 0 || divergenceB !== 0;
    if (diverged && firstDivergenceOp === null) {
      firstDivergenceOp = idx;
    }
    timeline.emit({
      category: 'blockchain_state',
      severity: diverged ? 'warn' : 'info',
      message:
        `[bal] op#${idx} ` +
        `expΔA=${expectedDeltaA} expΔB=${expectedDeltaB} | ` +
        `obsΔA=${observedDeltaA} obsΔB=${observedDeltaB} | ` +
        `divA=${divergenceA} divB=${divergenceB}` +
        (diverged ? ' DIVERGED' : ''),
      data: {
        idx,
        expectedDeltaA,
        expectedDeltaB,
        observedDeltaA,
        observedDeltaB,
        divergenceA,
        divergenceB,
        diverged,
        actualA: snapA.totalReportable,
        actualB: snapB.totalReportable,
        pendingNotesA: snapA.pendingNotes.length,
        pendingNotesB: snapB.pendingNotes.length,
        pendingTxA: snapA.pendingTxCount,
        pendingTxB: snapB.pendingTxCount,
        latestTxA: snapA.latestTxId,
        latestTxB: snapB.latestTxId,
        firstDivergenceOp
      }
    });

    // Optional immediate claim on the receiver — mimics an attentive user.
    // Budget is generous because this is a correctness test: the new drain
    // loop iterates ~6s per cycle, so 240s = ~40 iterations.
    if (status === 'ok' && rng() < opts.claimAfterSendProb) {
      try {
        await receiver.claimAllNotes(240_000);
      } catch (e) {
        timeline.emit({
          category: 'stress_op',
          severity: 'warn',
          message: `[stress] op#${idx} receiver ${receiverLabel} claim after send failed: ${e}`
        });
      }
    }

    // ── Perturbations (after the op completes, before the delay) ────────────

    // Periodic lock/unlock cycle on a randomly chosen wallet.
    if (opts.lockEvery > 0 && idx % opts.lockEvery === 0) {
      const victimLabel: 'A' | 'B' = rng() < 0.5 ? 'A' : 'B';
      const victim = wallets[victimLabel];
      perturbation = `lock_${victimLabel}`;
      perturbations.locks++;
      timeline.emit({
        category: 'stress_op',
        severity: 'info',
        message: `[stress] perturbation: lock/unlock wallet ${victimLabel} (after op#${idx})`
      });
      try {
        await victim.lockWallet();
        await sleep(intInRange(1000, 3000, rng));
        await victim.unlockWallet();
      } catch (e) {
        timeline.emit({
          category: 'stress_op',
          severity: 'warn',
          message: `[stress] lock/unlock ${victimLabel} failed: ${e}`
        });
      }
    }

    // Periodic page reload on a randomly chosen wallet.
    if (opts.reloadEvery > 0 && idx % opts.reloadEvery === 0) {
      const victimLabel: 'A' | 'B' = rng() < 0.5 ? 'A' : 'B';
      const victim = wallets[victimLabel];
      perturbation = perturbation ? `${perturbation}+reload_${victimLabel}` : `reload_${victimLabel}`;
      perturbations.reloads++;
      timeline.emit({
        category: 'stress_op',
        severity: 'info',
        message: `[stress] perturbation: reload wallet ${victimLabel} page (after op#${idx})`
      });
      try {
        await victim.page.reload({ waitUntil: 'domcontentloaded' });
        // Re-login if reload bounced us to the lock screen.
        const onLock = await victim.page
          .getByRole('button', { name: /unlock/i })
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        if (onLock) {
          await victim.unlockWallet();
        }
      } catch (e) {
        timeline.emit({
          category: 'stress_op',
          severity: 'warn',
          message: `[stress] reload ${victimLabel} failed: ${e}`
        });
      }
    }

    if (perturbation) {
      const last = perOp[perOp.length - 1];
      if (last) last.perturbation = perturbation;
    }

    // ── Delay / idle ────────────────────────────────────────────────────────
    if (opts.idleEvery > 0 && idx % opts.idleEvery === 0) {
      const idleMs = intInRange(opts.idleMinMs, opts.idleMaxMs, rng);
      perturbations.idles++;
      timeline.emit({
        category: 'stress_op',
        severity: 'info',
        message: `[stress] idle ${idleMs}ms (after op#${idx})`
      });
      await sleep(idleMs);
    } else {
      await sleep(intInRange(opts.delayMinMs, opts.delayMaxMs, rng));
    }
  }

  // ── Drain: multiple claim cycles so no note is left in the queue ────────
  // `claimAllNotes` now loops until the consumable-notes cache is empty for
  // two consecutive syncs, so in the steady state each cycle is a fast no-op.
  // The 5-min per-cycle cap only matters when something is genuinely stuck —
  // which is exactly the signal we want surfaced rather than silently clipped.
  timeline.emit({
    category: 'test_lifecycle',
    severity: 'info',
    message: '[stress] driver loop done; starting drain'
  });
  for (let cycle = 0; cycle < 5; cycle++) {
    await Promise.allSettled([walletA.claimAllNotes(300_000), walletB.claimAllNotes(300_000)]);
    await sleep(5_000);
  }

  return {
    seed: opts.seed,
    requested: opts.numNotes,
    completed,
    failed,
    perturbations,
    firstDivergenceOp,
    expectedDeltaA,
    expectedDeltaB,
    perOp
  };
}
