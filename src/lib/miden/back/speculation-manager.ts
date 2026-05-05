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

import type { MidenClientInterface } from '../sdk/miden-client-interface';
import { withWasmClientLock } from '../sdk/miden-client';

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

    // Mark any stale active.
    if (this.active) this.active.stale = true;

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
    if (this.active) this.active.stale = true;
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
    const client = await this.getClient();
    // MUST wrap in withWasmClientLock. executeAndProveForSpeculation does
    // `inner.executeTransaction(...)` (touches SW WASM, requires the lock for
    // serialization) and then `yieldWasmClientLock(() => proveViaOffscreen(...))`
    // around the offscreen prove. yieldWasmClientLock assumes the caller
    // currently holds the lock — it does release() → operation() → acquire().
    // Without the wrapper, release() spuriously pops queue waiters and
    // acquire() at the end leaves the lock permanently held by us when this
    // function returns, deadlocking every subsequent withWasmClientLock
    // (including the user's actual send-on-Confirm).
    const entry = await withWasmClientLock(() => client.executeAndProveForSpeculation(params));
    // If we were marked stale while running, throw away the result.
    if (this.active?.stale) return;
    this.completed = entry;
  }
}

/** Module-scoped singleton wired up at SW init. */
let _instance: SpeculationManager | null = null;

export function initSpeculationManager(getClient: () => Promise<MidenClientInterface>): SpeculationManager {
  if (!_instance) _instance = new SpeculationManager(getClient);
  return _instance;
}

export function getSpeculationManager(): SpeculationManager | null {
  return _instance;
}
