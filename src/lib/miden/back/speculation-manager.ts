// Speculative pre-prove for the wallet's send flow.
//
// When the user reaches the review screen, the popup fires SPECULATE_SEND_REQUEST
// with the form params. The SW kicks off execute + offscreen prove with those
// params and caches the {txResult, proven} bytes. When the user clicks Confirm,
// the existing initiateSendTransaction → SW processor path runs unchanged, but
// MidenClientInterface.proveLocallyViaOffscreen consults this cache before
// kicking off a fresh prove. Cache hit → skip ~5-10s of prove work, go straight
// to submit + apply.
//
// Concurrency:
//   - At most one speculation is "active" (executing/proving) at any time.
//     The offscreen prover singleton serializes prove calls; we serialize at
//     this layer too so submit + apply (later) doesn't race against speculate.
//   - At most one "pending" speculation is queued. Newer speculate() requests
//     replace any queued pending — older params are discarded without ever
//     running.
//   - At most one "completed" cache entry is held. Replaced by each new
//     completion. The pre-prove path (proveLocallyViaOffscreen) consumes the
//     entry on hit (so a stale cache can't be reused for a different tx).
//
// Cache invalidation:
//   - Strict params hash. Any change to recipient / faucet / amount / noteType
//     misses the cache.
//   - SPECULATE_INVALIDATE clears the cache and marks any active as stale
//     (its result will be discarded when it finishes; CPU is already in flight).

import { abortSpeculativeProve, isOffscreenAvailable } from './offscreen-prover';
import { withWasmClientLock } from '../sdk/miden-client';
import type { MidenClientInterface } from '../sdk/miden-client-interface';

export interface SpeculationParams {
  accountId: string;
  recipientAccountId: string;
  faucetId: string;
  noteType: 'public' | 'private';
  amount: bigint;
}

export interface SpeculationCacheEntry {
  paramsHash: string;
  txResultBytes: Uint8Array;
  provenBytes: Uint8Array;
}

function hashParams(p: SpeculationParams): string {
  // Stable string serialization. accountId / recipientAccountId / faucetId
  // are bech32 or hex strings; amount is bigint; noteType is the literal.
  // No floats, no Map iteration order, deterministic.
  return [p.accountId, p.recipientAccountId, p.faucetId, p.noteType, p.amount.toString()].join('|');
}

export class SpeculationManager {
  // The active in-flight speculation. `stale: true` means its result will be
  // discarded when it finishes (some newer call replaced it).
  private active: { paramsHash: string; promise: Promise<void>; stale: boolean } | null = null;

  // The next speculation to run after `active` finishes. New speculate() calls
  // replace any prior pending — only the latest params will actually run.
  private pending: SpeculationParams | null = null;

  // The most recently completed speculation. `proveLocallyViaOffscreen`
  // consumes this on cache-hit (so a stale cache can't be reused).
  private completed: SpeculationCacheEntry | null = null;

  constructor(private getClient: () => Promise<MidenClientInterface>) {}

  /**
   * Kick off a speculation for `params`. Returns immediately — the prove
   * runs in the background. Idempotent: if a speculation for the same
   * params is already running or completed, no-op.
   */
  speculate(params: SpeculationParams): void {
    const hash = hashParams(params);
    if (this.completed?.paramsHash === hash) return; // already cached
    if (this.active && !this.active.stale && this.active.paramsHash === hash) return; // already running

    // Mark any stale active and try to abort its in-flight prove. Without
    // the abort, the rayon-WASM prove would grind to completion (~6s of
    // wasted CPU) before runNext picks up the new pending. Aborting
    // terminates the offscreen doc, rejecting the in-flight prove's
    // sendMessage promise — runNext sees the active promise resolve (the
    // executeAndProve catch swallows) and immediately promotes pending to
    // active, which respawns the doc (~300ms cost) and starts the new
    // prove. abortSpeculativeProve bails silently if a non-speculative
    // prove is also in flight (real send), so the user's actual tx is
    // never interrupted.
    if (this.active) {
      this.active.stale = true;
      void abortSpeculativeProve();
    }

    // Replace pending — newer params win.
    this.pending = params;

    // If nothing is active, start now.
    if (!this.active) {
      void this.runNext();
    }
  }

  /**
   * Drop any cached completion and mark active as stale. Called when the
   * user backs out of the review screen, or when the wallet otherwise wants
   * to discard speculation (e.g. delegate setting flipped on mid-review).
   */
  invalidate(): void {
    if (this.active) {
      this.active.stale = true;
      // Same rationale as speculate(): kill the in-flight prove rather
      // than letting it burn CPU on a result we'll discard.
      void abortSpeculativeProve();
    }
    this.pending = null;
    this.completed = null;
  }

  /**
   * Try to claim a cached speculation matching `params`. Returns the cache
   * entry on hit (and removes it from the cache so it can't be re-used);
   * null on miss. Called by `proveLocallyViaOffscreen` before doing fresh
   * execute + prove.
   */
  consumeCacheHit(params: SpeculationParams): SpeculationCacheEntry | null {
    const hash = hashParams(params);
    if (this.completed?.paramsHash !== hash) return null;
    const entry = this.completed;
    this.completed = null;
    return entry;
  }

  /**
   * Synchronous peek: is there an in-flight (active or pending) speculation
   * whose params match? Used by `proveLocallyViaOffscreen` on cache miss to
   * decide whether to wait — if there's nothing matching in flight, fall
   * through to a fresh execute + prove immediately. Stale active is treated
   * as no-match because its result will be discarded when it finishes.
   */
  hasInFlightMatching(params: SpeculationParams): boolean {
    const hash = hashParams(params);
    if (this.active && !this.active.stale && this.active.paramsHash === hash) return true;
    if (this.pending && hashParams(this.pending) === hash) return true;
    return false;
  }

  /**
   * Wait until either a matching cached entry is available or the manager
   * has definitively moved past `params` (active finished, pending dropped,
   * etc.). After this resolves, the caller should call `consumeCacheHit`
   * to claim the result; if it returns null the speculation either failed
   * or was made stale, and the caller should fall through to fresh prove.
   *
   * Loops: a `pending` matching `params` might be promoted to `active`
   * while we wait on the current active. We re-evaluate after each await
   * step until we either see a matching `completed` or there's nothing
   * more to wait for.
   *
   * IMPORTANT: the caller MUST NOT hold the WASM client lock during this
   * await — speculation's `executeAndProveForSpeculation` acquires the
   * same lock to do its execute step. Wrap the call in
   * `yieldWasmClientLock` if the caller holds the lock (which
   * `proveLocallyViaOffscreen` does).
   */
  async awaitMatching(params: SpeculationParams): Promise<void> {
    const hash = hashParams(params);
    while (true) {
      if (this.completed?.paramsHash === hash) return;
      const active = this.active;
      if (active && !active.stale && active.paramsHash === hash) {
        await active.promise;
        continue;
      }
      if (this.pending && hashParams(this.pending) === hash) {
        if (active) {
          await active.promise;
        } else {
          // pending exists but runNext hasn't picked it up yet; yield to
          // the event loop so the microtask scheduling that promotes
          // pending → active can run.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        continue;
      }
      return;
    }
  }

  private async runNext(): Promise<void> {
    while (this.pending) {
      const params = this.pending;
      this.pending = null;
      const hash = hashParams(params);
      const promise = this.executeAndProve(params).catch(err => {
        // Speculation failures are non-fatal — they just mean the user pays
        // full prove time on Confirm. Log once for diagnostics; don't
        // propagate.
        console.warn('[speculation] prove failed:', err);
      });
      this.active = { paramsHash: hash, promise, stale: false };
      try {
        await promise;
      } finally {
        // If the active was marked stale during the run, drop the result
        // (don't write to completed). Otherwise the result was already
        // stashed by executeAndProve.
        this.active = null;
      }
    }
  }

  private async executeAndProve(params: SpeculationParams): Promise<void> {
    // Resolved INSIDE the lock: recovery can dispose the client singletons at any
    // moment (it runs from a timer and an error listener), so a reference taken
    // before queueing for the mutex can be terminated by the time we own it
    // (issue #775). The resolve is a memoized singleton read, so paying it here
    // costs nothing.
    // MUST wrap in withWasmClientLock. executeAndProveForSpeculation does
    // `inner.executeTransaction(...)` (touches SW WASM, requires the lock for
    // serialization) and then `yieldWasmClientLock(() => proveViaOffscreen(...))`
    // around the offscreen prove. yieldWasmClientLock assumes the caller
    // currently holds the lock — it does release() → operation() → acquire().
    // Without the wrapper, release() spuriously pops queue waiters and
    // acquire() at the end leaves the lock permanently held by us when this
    // function returns, deadlocking every subsequent withWasmClientLock
    // (including the user's actual send-on-Confirm).
    const entry = await withWasmClientLock(async () => (await this.getClient()).executeAndProveForSpeculation(params));
    // If we were marked stale while running, throw away the result.
    if (this.active?.stale) return;
    this.completed = entry;
  }
}

/** Module-scoped singleton wired up at SW init. */
let _instance: SpeculationManager | null = null;

/**
 * Can a speculation produced HERE still be consumed?
 *
 * Only if the send that would claim it runs in this same realm. With the
 * offscreen client enabled (`MIDEN_USE_OFFSCREEN_CLIENT`, which
 * `vite.background.config.ts` defaults ON for the service worker) it does not:
 * `midenClientProxy.sendTransaction` dispatches the whole
 * execute→prove→submit→apply chain as one OFFSCREEN_CALL, and inside that
 * document `isOffscreenAvailable()` is false (the `isInOffscreenDocument()`
 * recursion guard), so `shouldUseOffscreenProver()` returns false and the send
 * takes `MidenClientInterface`'s staged in-realm branch — which never consults
 * the cache. Meanwhile `_instance` is only ever set here, in the SW, so the
 * offscreen realm's `getSpeculationManager()` is null regardless.
 *
 * `isOffscreenAvailable()` is the second term ONLY to keep flag-on non-Chrome
 * behaviour byte-identical to today — it is not a claim that speculation works
 * there. It does not: speculation is Chrome-only on BOTH ends independently of this
 * flag, since the producer `executeAndProveForSpeculation` throws outright without
 * `chrome.offscreen`, and the consumer sits behind `shouldUseOffscreenProver`, which
 * requires it too. So on Firefox/Safari this gate preserves nothing but the status
 * quo: a manager that gets wired, takes the WASM lock once per debounced edit of the
 * send form (`SendManager`'s speculate effect, not the review screen), and
 * logs `[speculation] prove failed:`. That is a pre-existing, flag-independent dead
 * end (it behaves identically flag-OFF), so fixing it here would be a partial fix to
 * an unrelated defect; the term keeps this change scoped to the realm split, which
 * is a flag-on Chrome problem.
 *
 * Read per-call rather than as a module const, matching
 * `shouldRouteGuardianLeafOffscreen` in `transaction/index.ts`: the routing
 * decision must be togglable in tests, and this module is imported by the
 * consumer path anyway so there is no dead-code-elimination to win.
 */
function speculationIsConsumableInThisRealm(): boolean {
  return !(process.env.MIDEN_USE_OFFSCREEN_CLIENT === 'true' && isOffscreenAvailable());
}

/**
 * Wire the singleton, or return null when speculation cannot be consumed in this
 * realm — in which case `getSpeculationManager()` stays null and every consumer's
 * existing null branch turns the feature off end to end (the two SPECULATE
 * handlers in `back/main.ts` no-op; `proveLocallyViaOffscreen` falls through to a
 * fresh execute + prove).
 *
 * TRADEOFF (issue #260 realm split). On the configuration this gate actually changes
 * — flag-on Chrome, the service worker's default — it gives up no REALIZED saving,
 * and that is the fact that decides whether rehosting is worth doing. It holds
 * whatever reclaim the user picked, because the cache lookup is not merely skipped
 * there, it is unreachable: `MidenClientInterface.sendTransaction` constructs
 * `cacheParams` INSIDE its `shouldUseOffscreenProver` branch — the branch that
 * dispatches a prove TO the offscreen document — and flag-on the send is already
 * executing inside that document, where `isOffscreenAvailable()` is false (the
 * `isInOffscreenDocument()` recursion guard). The send takes the staged in-realm
 * branch and `cacheParams` is never constructed at all.
 *
 * The flag-off / non-Chrome branch this gate deliberately preserves is a near-dead
 * end too, for a second and independent reason: there `cacheParams` IS on the taken
 * branch, but only when `reclaimAfter == null`, and `ReviewTransaction` seeds every
 * same-chain send with a 7-day reclaim by default — so only a send whose reclaim the
 * user explicitly edited to "Never" can ever claim a speculation (`SendManager`
 * already records this as a known gap). So rehosting into the offscreen realm is only
 * worth doing TOGETHER with carrying `recallBlocks` into `SpeculationParams`; on its
 * own it would buy nothing on the default send path.
 *
 * With that established: this turns the feature off on the extension's default
 * configuration rather than rehosting it, because speculating anyway is not merely
 * wasted work — it is actively harmful there:
 *
 *   - The result would be suspect even if it could be claimed.
 *     `executeAndProveForSpeculation` executes against THIS realm's client, and
 *     flag-on every `syncState` is dispatched to the offscreen realm instead — so
 *     this client's view of the account drifts away from the state the real send
 *     will execute against.
 *   - `speculate()`/`invalidate()` call `abortSpeculativeProve()`, which CLOSES the
 *     offscreen document. Flag-on that document owns the live client: closing it
 *     aborts in-flight reads and discards a ~120-150 MB warm realm. Its guard only
 *     spares CRITICAL ops, so an ordinary sync or balance read is fair game.
 *   - The prove itself burns the offscreen doc's rayon pool for seconds next to the
 *     writes that realm is there to run.
 *
 * Rehosting it into the offscreen realm was considered and rejected as a much larger
 * change than this defect warrants: it needs a new cross-realm producer channel for
 * SPECULATE, an in-realm prove path inside `executeAndProveForSpeculation` (which
 * today hard-requires `isOffscreenAvailable()`), cache consultation added to the
 * staged in-realm send branch, and — the blocker — a replacement for abort, since
 * "kill the document" cannot mean "kill my own realm". Without abort, a superseded
 * speculation would hold the single offscreen WASM mutex for seconds and DELAY the
 * user's real send, which is worse than not speculating at all.
 */
export function initSpeculationManager(getClient: () => Promise<MidenClientInterface>): SpeculationManager | null {
  if (!speculationIsConsumableInThisRealm()) return null;
  if (!_instance) _instance = new SpeculationManager(getClient);
  return _instance;
}

export function getSpeculationManager(): SpeculationManager | null {
  return _instance;
}
