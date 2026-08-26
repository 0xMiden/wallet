// This import must stay ABOVE the `./miden-client-interface` one: that import
// forms a cycle (via `speculation-manager`), and the re-exported poison
// bindings below must already be initialized when the cycle re-enters this
// module — see `wasm-client-poison.ts`.
import {
  WASM_LOCK_MIN_WATCHDOG_MS,
  WASM_LOCK_PAUSED_WATCHDOG_MS,
  WASM_LOCK_WATCHDOG_MS,
  WasmClientPoisonedError,
  bumpWasmClientGeneration
} from './wasm-client-poison';
// eslint-disable-next-line import/order -- must load AFTER wasm-client-poison (TDZ safety, see above)
import { MidenClientInterface, MidenClientCreateOptions } from './miden-client-interface';

export { WASM_LOCK_WATCHDOG_MS, WasmClientPoisonedError };

/**
 * Simple async mutex to prevent concurrent WASM client operations.
 * The WASM client cannot handle concurrent calls - they cause
 * "recursive use of an object detected which would lead to unsafe aliasing in rust" errors.
 *
 * Supports an idle queue for low-priority background tasks that run only when
 * no high-priority operations are pending.
 */
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];
  private idleQueue: Array<() => Promise<void>> = [];
  private drainingIdle = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
      // Run idle tasks immediately - deduplication is handled by callers
      this.drainIdleQueue();
    }
  }

  /** True while an operation currently holds the mutex. */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Non-blocking acquire: takes the lock and returns `true` if it was free,
   * otherwise returns `false` without waiting. The check-and-set is atomic in
   * single-threaded JS (no `await` between the read and the write).
   */
  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  /**
   * Queue a low-priority task to run when the mutex is idle.
   * Idle tasks run after all high-priority (withWasmClientLock) operations complete.
   * Idle tasks do NOT hold the lock - they should use withWasmClientLock internally if needed.
   */
  queueIdleTask(task: () => Promise<void>): void {
    this.idleQueue.push(task);
    // Run immediately if idle - deduplication is handled by callers
    if (!this.locked && this.queue.length === 0 && !this.drainingIdle) {
      this.drainIdleQueue();
    }
  }

  private drainIdleQueue(): void {
    // Don't drain if: nothing to drain, already draining, lock held, or high-priority work waiting
    if (this.idleQueue.length === 0 || this.drainingIdle || this.locked || this.queue.length > 0) {
      return;
    }
    const tasks = this.idleQueue.splice(0);
    this.runIdleTasks(tasks);
  }

  private runIdleTasks(tasks: Array<() => Promise<void>>): void {
    this.drainingIdle = true;
    // Run idle tasks sequentially without holding the lock.
    // Each task is responsible for acquiring locks via withWasmClientLock if needed.
    const runNext = (index: number): void => {
      if (index >= tasks.length) {
        this.drainingIdle = false;
        // Check if more idle tasks were queued while we were running
        if (this.idleQueue.length > 0 && !this.locked) {
          this.drainIdleQueue();
        }
        return;
      }
      // Check if high-priority work is waiting - if so, pause idle tasks
      /* c8 ignore next 5 -- requires concurrent lock contention during idle drain */
      if (this.locked || this.queue.length > 0) {
        // Re-queue remaining tasks and stop
        this.idleQueue.unshift(...tasks.slice(index));
        this.drainingIdle = false;
        return;
      }
      const task = tasks[index];
      /* c8 ignore next 4 -- defensive guard for sparse array */
      if (!task) {
        runNext(index + 1);
        return;
      }
      task()
        .catch(err => console.warn('Idle task failed:', err))
        .finally(() => runNext(index + 1));
    };
    runNext(0);
  }
}

// Global mutex for all WASM client operations
const wasmClientMutex = new AsyncMutex();

/**
 * The current `withWasmClientLock` holder. At most one exists at a time (the
 * mutex serializes holds); `null` while the lock is free or while a holder has
 * yielded it via `yieldWasmClientLock`.
 */
interface LockHolder {
  /** Set by recovery: the holder was evicted and the mutex already re-released. */
  killed: boolean;
  /** Depth of `withWasmLockWatchdogPaused` brackets currently open. */
  pauseCount: number;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Unpaused wall-clock this hold has already spent, and when the current
   * unpaused segment began (`null` while a pause bracket is open). Together they
   * make the normal ceiling a bound on the HOLD rather than on the current
   * segment: re-arming the full ceiling at every bracket close would let a flow
   * that opens and closes brackets in a loop run forever unwatched, which is the
   * stop-the-clock behaviour the relaxed pause exists to avoid.
   */
  unpausedElapsedMs: number;
  segmentStartedAt: number | null;
  /** Rejects the race in `withWasmClientLock`, unblocking the caller. */
  abort: (err: Error) => void;
  aborted: Promise<never>;
}

/**
 * Monotonic-where-available clock for the lock's own bookkeeping (the recovery
 * cooldown, the watchdog's elapsed accounting). `Date.now()` is wall-clock, so
 * an NTP correction or a manual clock change can expire a window early or
 * stretch it; every consumer here only ever measures a short local interval.
 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Opaque identity for one `withWasmClientLock` hold, handed to the operation so
 * it can prove ownership later (issue #775).
 *
 * Needed because eviction ABANDONS an operation rather than cancelling it: an
 * evicted flow keeps running, and the lock it still believes it holds now
 * belongs to somebody else. `yieldWasmClientLock` and
 * `withWasmLockWatchdogPaused` used to infer ownership from the module-global
 * `currentHolder` at the moment they were called, which cannot tell "I am the
 * holder" from "somebody else is" — so a corpse could release an innocent
 * holder's mutex into a concurrent WASM call, or silence its watchdog. Passing
 * the hold makes the two cases distinguishable.
 *
 * Treat the value as opaque; only reference equality is meaningful.
 */
export type WasmLockHold = LockHolder;

let currentHolder: LockHolder | null = null;

/**
 * The hold that currently owns the mutex, or `null` when it is free.
 *
 * Safe to call at the very START of a locked operation's body — no `await` has
 * elapsed since the hold was created, so the value IS this flow's own hold.
 * Capturing it later is meaningless: by then an eviction may have handed the
 * slot to somebody else, which is the whole ambiguity {@link WasmLockHold}
 * exists to resolve.
 */
export function getCurrentWasmLockHold(): WasmLockHold | null {
  return currentHolder;
}

/**
 * Is `hold` still the live owner of the mutex? A `null`/omitted hold means the
 * caller did not supply an identity, so we fall back to the pre-#775 behaviour
 * of trusting whatever holds the lock.
 */
function holdIsCurrent(hold: WasmLockHold | null | undefined): boolean {
  return hold == null || hold === currentHolder;
}

/**
 * Does an uncaught realm error look like a WebAssembly trap? The main-realm
 * case carries the actual `WebAssembly.RuntimeError`; an error propagated up
 * from the SDK's method worker loses the error object in transit, so fall back
 * to matching the message/filename. Deliberately narrow — an unrelated app
 * error sharing the realm (mobile runs the whole React app in the client's
 * window) must not evict a healthy holder.
 */
function looksLikeWasmTrap(event: ErrorEvent): boolean {
  return isTrapShaped(event.error, event.message, event.filename);
}

/**
 * The predicate itself, over the three things a delivery mechanism can give us.
 * Split out because a trap does not always arrive as an `ErrorEvent`: an
 * unhandled REJECTION carries only a reason, with no message or filename of its
 * own.
 */
function isTrapShaped(error: unknown, rawMessage?: unknown, rawFilename?: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) {
    return true;
  }
  const message =
    typeof rawMessage === 'string' && rawMessage.length > 0 ? rawMessage : error instanceof Error ? error.message : '';
  // No bare "wasm" match here: on mobile the whole React app shares the realm,
  // and an unrelated error merely mentioning wasm must not evict a holder.
  //
  // Each alternative is a full trap phrase, never a lone English word. An
  // earlier revision matched `\bunreachable\b`, which fires on this codebase's
  // own connectivity wording — "node unreachable", "network unreachable",
  // "prover unreachable", "guardian unreachable" — and bought nothing, since
  // engines render the trap as `RuntimeError: unreachable`, already covered by
  // the first alternative. A false positive here is expensive: it evicts a
  // healthy holder and disposes a live client.
  //
  // Both engines' wordings are listed, because the trap text is NOT portable and
  // iOS is where the recorded #775 freeze happened: V8 says "memory access out
  // of bounds" and "divide by zero", JavaScriptCore says "Out of bounds memory
  // access" and "Division by zero". Matching only one engine's phrasing leaves
  // the other platform with no fast path at all.
  if (
    /\bRuntimeError\b|unreachable executed|Unreachable code should not be executed|memory access out of bounds|out of bounds memory access|divide by zero|division by zero|integer overflow/i.test(
      message
    )
  ) {
    return true;
  }
  // A genuine `.wasm` module URL only — anchored, because `\b` is satisfied by a
  // following dot and so matched wasm-glue JS (`*.wasm.js`) and sourcemaps
  // (`*.wasm.map`), letting any ordinary TypeError thrown from glue code evict a
  // holder.
  const filename = typeof rawFilename === 'string' ? rawFilename : '';
  return /\.wasm(?:$|[?#])/i.test(filename);
}

/**
 * Suppress realm-error evictions for a window after any recovery. An evicted
 * holder's operation is abandoned, not cancelled — if it was still alive (a
 * watchdog false positive), its next call against the disposed client can trap,
 * and that corpse trap must not be attributed to the innocent next holder or
 * dispose the freshly built client (a cascade). A genuine second trap inside
 * the window still gets the watchdog. Guarded against clock rewinds (and fake
 * timers): a negative delta counts as expired.
 */
const REALM_ERROR_COOLDOWN_MS = 10_000;
// Null, not 0: on the monotonic clock 0 IS a valid stamp (it is the time origin),
// so a sentinel of 0 would silently disarm the cooldown for a recovery in the
// realm's first millisecond.
let lastRecoveryAt: number | null = null;

function inRecoveryCooldown(): boolean {
  if (lastRecoveryAt === null) return false;
  const sinceRecovery = monotonicNow() - lastRecoveryAt;
  return sinceRecovery >= 0 && sinceRecovery < REALM_ERROR_COOLDOWN_MS;
}

/**
 * Clear the cooldown stamp. Test-only: the stamp is monotonic-clock based, and
 * jest's fake timers restart that clock at 0 on every install, so a stamp left
 * by an earlier test lands in the next test's future. Production has one clock
 * per realm and never needs this.
 */
export function __resetRecoveryCooldownForTests(): void {
  lastRecoveryAt = null;
}

/** Holders currently suspended inside a `yieldWasmClientLock` window. */
let yieldedHolderCount = 0;

/**
 * Realm-local listeners run after recovery has disposed the client singletons
 * (issue #775).
 *
 * `midenClientSingleton` is not the only place a realm keeps a client: the
 * offscreen document builds its own via `MidenClientInterface.create()` and
 * caches it in a module-local, so `disposeAllInstances()` reaches nothing there
 * and the next call would be handed the same trapped client — defeating
 * recovery in the one realm where the recorded #775 trap happened. A realm with
 * its own client registers here to drop it.
 *
 * Listeners must be synchronous and must not throw; a throwing listener would
 * otherwise abort recovery before the mutex is released, re-creating the wedge.
 */
type WasmClientPoisonedListener = () => void;
const poisonedListeners = new Set<WasmClientPoisonedListener>();

/** Register a realm-local disposer; returns an unsubscribe for tests. */
export function onWasmClientPoisoned(listener: WasmClientPoisonedListener): () => void {
  poisonedListeners.add(listener);
  return () => poisonedListeners.delete(listener);
}

function notifyWasmClientPoisoned(): void {
  // Bumped first: a listener may synchronously start work that reads the
  // generation, and every branch that notifies has already replaced the client.
  bumpWasmClientGeneration();
  for (const listener of poisonedListeners) {
    try {
      listener();
    } catch (err) {
      console.warn('[miden-client] a poisoned-client listener threw (continuing):', err);
    }
  }
}

function onRealmError(event: ErrorEvent): void {
  if (!looksLikeWasmTrap(event)) return;
  recoverFromTrap(event.error ?? new Error(event.message || 'unknown WASM trap'));
}

/**
 * A trap that reached the realm as a REJECTION rather than an uncaught error.
 * The abandoned-future case #775 is named for settles nothing at all, so it can
 * only ever arrive as an `error` — but a trap that DOES reject its call is
 * unhandled whenever the caller is a flow that has already been evicted (its
 * awaiter is gone), and on JavaScriptCore this is the shape the trap arrives in.
 * Same predicate, so the same narrowness argument applies: a rejection carries
 * no filename, and its reason must independently look like a trap.
 */
function onRealmRejection(event: PromiseRejectionEvent): void {
  if (!isTrapShaped(event.reason)) return;
  recoverFromTrap(event.reason);
}

function recoverFromTrap(cause: unknown): void {
  if (inRecoveryCooldown()) {
    console.error('[miden-client] WASM trap within recovery cooldown — ignoring (likely an evicted corpse):', cause);
    return;
  }
  if (currentHolder) {
    recoverFromWedgedHolder(currentHolder, 'realm-error', cause);
  } else if (yieldedHolderCount > 0) {
    // A holder is suspended mid-yield (e.g. awaiting an offscreen prove).
    // TERMINATING the client would pull it out from under that flow when it
    // reacquires — past its point-of-no-return that would falsely Fail a
    // transaction that may well have landed. But leaving the singleton in
    // place is not an option either: the trap aborted the module, and nothing
    // else in this realm ever disposes it, so every later getMidenClient()
    // would be handed the dead client — a permanently poisoned realm with no
    // second recovery path (the suspended flow's own failure just rejects that
    // flow). So DETACH instead: future callers rebuild, the suspended flow
    // keeps the reference it is already using, and it fails on its own next
    // call exactly as it would have anyway.
    console.error('[miden-client] WASM trap while a holder is mid-yield — detaching client singletons:', cause);
    lastRecoveryAt = monotonicNow();
    midenClientSingleton.detachAllInstances();
    notifyWasmClientPoisoned();
  } else {
    // No holder to evict, but the trap still aborted the module instance —
    // dispose so the next getMidenClient() constructs a fresh client instead
    // of handing out the poisoned one.
    console.error('[miden-client] WASM trap with no lock holder — disposing client singletons:', cause);
    lastRecoveryAt = monotonicNow();
    midenClientSingleton.disposeAllInstances();
    notifyWasmClientPoisoned();
  }
}

/**
 * Register the trap listeners on this realm (issue #775). The abandoned-future
 * case surfaces as an uncaught `error`, since its promise never settles; a trap
 * that does reject its call surfaces as an `unhandledrejection` whenever the
 * awaiting flow is gone, which is also the shape JavaScriptCore tends to
 * deliver. Both go through the same narrow predicate. This module is
 * instantiated once per realm, so installing here covers every realm that owns
 * a client (service worker, offscreen document, mobile/desktop main window,
 * extension UI pages) with no per-realm wiring.
 *
 * Caveat: where the client runs inside the SDK's method worker (desktop, and
 * any UI page that builds its own client — the extension SW has no `Worker` and
 * falls back in-realm), a worker trap reaches neither listener: the SDK attaches
 * no `error`/`messageerror` handler to the worker, and an abandoned future posts
 * no message back, so the parent's request simply never settles. There the
 * watchdog is the ONLY recovery, which is why a paused watchdog is relaxed
 * rather than stopped (see `WASM_LOCK_PAUSED_WATCHDOG_MS`). On mobile — where
 * the recorded #775 freeze happened — the client runs on this realm's main
 * thread and the fast path sees the trap.
 */
let realmErrorListenerInstalled = false;
function ensureRealmErrorListener(): void {
  if (realmErrorListenerInstalled) return;
  if (typeof globalThis.addEventListener !== 'function') return;
  globalThis.addEventListener('error', onRealmError);
  globalThis.addEventListener('unhandledrejection', onRealmRejection);
  realmErrorListenerInstalled = true;
}

/**
 * (Re-)arm this holder's watchdog at the ceiling its current pause state calls
 * for: the normal one while it is running, the long one while a pause bracket
 * is open. Always clears any timer already on the holder, so it is safe to call
 * from every transition (hold start, pause open/close, yield resume) without
 * leaking a timer or stacking two.
 */
function armWatchdogFor(holder: LockHolder): void {
  if (holder.watchdogTimer) clearTimeout(holder.watchdogTimer);
  let ceiling: number;
  if (holder.pauseCount > 0) {
    // A pause is a fresh relaxed ceiling: the wait it brackets is the thing
    // that is legitimately unbounded, so unpaused time already spent is not
    // charged against it.
    ceiling = WASM_LOCK_PAUSED_WATCHDOG_MS;
  } else {
    // Charge only time this hold spent RUNNING, so the normal ceiling bounds the
    // hold rather than the segment since the last transition. Floored well above
    // zero so a hold that has already exhausted its budget still gets a slice to
    // finish in rather than being evicted the instant a bracket closes.
    ceiling = Math.max(WASM_LOCK_WATCHDOG_MS - holder.unpausedElapsedMs, WASM_LOCK_MIN_WATCHDOG_MS);
  }
  holder.watchdogTimer = setTimeout(() => {
    recoverFromWedgedHolder(holder, 'watchdog');
  }, ceiling);
}

/**
 * Close the hold's current unpaused segment (a pause is opening, or the hold is
 * yielding the mutex), banking what it spent running.
 */
function endUnpausedSegment(holder: LockHolder): void {
  if (holder.segmentStartedAt === null) return;
  holder.unpausedElapsedMs += Math.max(monotonicNow() - holder.segmentStartedAt, 0);
  holder.segmentStartedAt = null;
}

/** Start a new unpaused segment (the hold is running again). */
function startUnpausedSegment(holder: LockHolder): void {
  if (holder.segmentStartedAt === null) holder.segmentStartedAt = monotonicNow();
}

function beginHold(): LockHolder {
  let abort!: (err: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });
  const holder: LockHolder = {
    killed: false,
    pauseCount: 0,
    watchdogTimer: null,
    unpausedElapsedMs: 0,
    segmentStartedAt: monotonicNow(),
    abort,
    aborted
  };
  // A non-null holder here means the mutex admitted two owners at once — the
  // invariant this type documents is broken, and the WASM client is about to be
  // double-borrowed. Unobservable before, so say so loudly rather than
  // silently overwriting the evidence.
  if (currentHolder) {
    console.error('[miden-client] BUG: taking the WASM lock while another holder is still registered');
  }
  armWatchdogFor(holder);
  currentHolder = holder;
  return holder;
}

/**
 * Close out a hold on the normal path. Returns whether the caller still owns
 * the mutex and must release it — `false` means recovery already evicted this
 * holder and released the lock, and releasing again would corrupt the queue.
 */
function endHold(holder: LockHolder): boolean {
  if (holder.watchdogTimer) clearTimeout(holder.watchdogTimer);
  holder.watchdogTimer = null;
  if (currentHolder === holder) {
    currentHolder = null;
  }
  return !holder.killed;
}

/**
 * Evict a wedged holder (issue #775): reject its pending race with a named
 * error and release the mutex so the queue drains. The abandoned operation's
 * promise stays pending forever — that is exactly the failure mode this
 * recovers from.
 */
function recoverFromWedgedHolder(holder: LockHolder, reason: 'watchdog' | 'realm-error', cause?: unknown): void {
  // Stale trigger: the holder already finished, was already killed, or is
  // mid-yield (not currently holding the lock).
  if (holder.killed || holder !== currentHolder) return;
  holder.killed = true;
  lastRecoveryAt = monotonicNow();
  if (holder.watchdogTimer) clearTimeout(holder.watchdogTimer);
  holder.watchdogTimer = null;
  currentHolder = null;
  const error = new WasmClientPoisonedError(reason, cause);
  console.error('[miden-client] evicting wedged WASM lock holder:', error);
  holder.abort(error);
  // A trap aborts the WASM module instance — every later call against it
  // fails, so releasing the mutex alone would hand the next operation a dead
  // client. Dispose first (deliberately NOT via resetMidenClient(), which
  // takes this same lock and would deadlock), then release so the queue
  // drains onto a freshly constructed client.
  midenClientSingleton.disposeAllInstances();
  notifyWasmClientPoisoned();
  wasmClientMutex.release();
}

/**
 * Execute an operation with the WASM client mutex held.
 * This ensures only one WASM client operation runs at a time across the entire app.
 *
 * The operation receives its own {@link WasmLockHold}. Passing that hold to
 * `yieldWasmClientLock` / `withWasmLockWatchdogPaused` is what lets those
 * distinguish this flow from an evicted corpse (issue #775) — a flow that
 * ignores the argument keeps the older, ownership-blind behaviour.
 */
export async function withWasmClientLock<T>(operation: (hold: WasmLockHold) => Promise<T>): Promise<T> {
  await wasmClientMutex.acquire();
  const holder = beginHold();
  try {
    return await Promise.race([operation(holder), holder.aborted]);
  } finally {
    if (endHold(holder)) {
      wasmClientMutex.release();
    }
  }
}

/**
 * True while any `withWasmClientLock` operation is in progress.
 *
 * Background pollers that deliberately bypass `withWasmClientLock` (currently
 * the balance poll, `fetchBalances` → `getAccount`) MUST check this and skip
 * their WASM read while it is true.
 *
 * Rationale: a transaction holds this lock across the SDK's
 * `_withInnerWebClient` window, and during that window the SDK runs any OTHER
 * client call INLINE (skipping its own `_serializeWasmCall` chain), on the
 * documented assumption that the caller holds an external mutex over every
 * other WASM path. An un-locked read fired inside that window therefore runs
 * inline too and double-borrows wasm-bindgen's RefCell — panicking the WASM
 * client (`web-client/src/platform.rs` "RefCell already borrowed"), which on
 * mobile hangs guardian consumes forever. Skipping a poll cycle costs one
 * delayed balance refresh; racing the lock crashes the client.
 */
export function isWasmClientBusy(): boolean {
  return wasmClientMutex.isLocked;
}

/**
 * Run `operation` under the WASM client lock ONLY if the lock can be taken
 * without waiting; otherwise skip it and resolve to `{ ran: false }`.
 *
 * For background reads that intentionally bypass `withWasmClientLock` for
 * responsiveness (the balance poll's `getAccount`) but must still be atomic
 * against transactions: a plain un-locked read fired during a transaction's
 * `_withInnerWebClient` window runs inline and double-borrows the WASM client's
 * RefCell (crash). Acquiring the lock around the read closes that window, and
 * using a NON-blocking try (skip, don't queue) preserves the reason the read
 * bypassed the lock in the first place — it must not stall behind long writes
 * like `syncState`. Callers treat `{ ran: false }` as "skip this refresh, keep
 * prior data, retry next cycle."
 *
 * Unlike a plain `isWasmClientBusy()` check, this is atomic with the borrow:
 * there is no check-then-act gap in which the lock could be taken by a
 * transaction between the guard and the read.
 */
export async function tryWithWasmClientLock<T>(
  operation: (hold: WasmLockHold) => Promise<T>
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!wasmClientMutex.tryAcquire()) return { ran: false };
  const holder = beginHold();
  try {
    return { ran: true, value: await Promise.race([operation(holder), holder.aborted]) };
  } finally {
    if (endHold(holder)) {
      wasmClientMutex.release();
    }
  }
}

/**
 * Run `operation` with the current lock holder's watchdog relaxed to
 * `WASM_LOCK_PAUSED_WATCHDOG_MS` (issue #775). Mirrors
 * `pauseDeadline`/`resumeDeadline` in `miden-client-proxy.ts` in that the close
 * of the bracket re-arms the FULL normal ceiling from scratch, with no
 * elapsed-time accounting. For the two legitimately unbounded waits inside a
 * hold: a keystore sign round-trip (blocks on user authentication) and a local
 * prove (the fallback when delegated proving is down — capping it at the normal
 * ceiling would leave nothing to fall back to).
 *
 * "Relaxed", not "stopped": these waits are also where a trap is most likely,
 * and on the realms where the listener cannot see one (the SDK method worker
 * swallows it; JavaScriptCore may deliver it as a rejection) a stopped clock
 * left the wedge unrecoverable — the pre-#775 failure mode, reached through the
 * fix's own escape hatch. See `WASM_LOCK_PAUSED_WATCHDOG_MS` for the bound.
 *
 * Depth-counted so brackets nest, and holder-scoped: the holder is captured at
 * entry so the close can never touch a different holder. Pausing only silences
 * the watchdog — a realm trap still evicts a paused holder immediately.
 *
 * The CALLER MUST OWN THE LOCK, and should pass its `hold` to prove it. Without
 * one this pauses whoever happens to hold the mutex, which is wrong in the case
 * that matters: an evicted corpse reaching a sign callback or a local prove
 * would silence the watchdog of the innocent holder that recovery just promoted
 * — removing the backstop from the one flow still guarding the client. With a
 * stale hold the bracket degrades to a plain call.
 */
export async function withWasmLockWatchdogPaused<T>(
  operation: () => Promise<T>,
  hold?: WasmLockHold | null
): Promise<T> {
  const holder = currentHolder;
  if (!holder || holder.killed || !holdIsCurrent(hold)) {
    return operation();
  }
  holder.pauseCount++;
  // Only the OUTERMOST bracket swaps the ceiling; a nested one must not restart
  // the relaxed timer, or a flow that opens brackets in a loop would keep
  // pushing the bound out and get the old stop-the-clock behaviour back.
  if (holder.pauseCount === 1) {
    endUnpausedSegment(holder);
    armWatchdogFor(holder);
  }
  try {
    return await operation();
  } finally {
    if (!holder.killed) {
      holder.pauseCount--;
      if (holder.pauseCount === 0 && holder === currentHolder) {
        startUnpausedSegment(holder);
        armWatchdogFor(holder);
      }
    }
  }
}

/**
 * Temporarily release the WASM client mutex while running `operation`, then
 * reacquire it before resolving. Caller MUST currently hold the lock.
 *
 * Use this when a lock-holding flow does long, genuinely-non-WASM-client
 * work — for example, awaiting an offscreen-document prover. Without
 * yielding, sync (which contends on this same mutex) gets blocked for the
 * full prove duration and surfaces a "can't reach node" toast on its
 * timeout. With the yield, sync runs while the prove is happening in the
 * other context, which is fine because the offscreen doc has its own WASM
 * instance and isn't touching the SW's client.
 *
 * Safety: the operation must NOT touch the WASM client (any wasm-bindgen
 * call, MidenClient method, etc.). It's only safe to use for I/O-bound
 * waits on workloads that don't share state with the SW's WASM instance.
 */
export async function yieldWasmClientLock<T>(operation: () => Promise<T>, hold?: WasmLockHold | null): Promise<T> {
  // While yielded this flow does not hold the lock, so it must not be watched
  // (the offscreen prove it waits on is legitimately unbounded) and must not
  // be the realm-error eviction target — another holder may take the lock in
  // the meantime and gets its own watchdog (issue #775).
  const holder = currentHolder;
  if (!holder || !holdIsCurrent(hold)) {
    // Either the mutex is free, or `hold` proves this flow is no longer its
    // owner — an evicted holder's abandoned operation still running, whose lock
    // now belongs to somebody else. Releasing in either case would pop a waiter
    // into a concurrent WASM call (with a live holder still running, exactly the
    // "recursive use of an object" crash the mutex prevents), and the reacquire
    // would leak a permanently-held lock — the wedge #775 fixes. Run the
    // operation without touching the mutex.
    //
    // Callers that pass no `hold` can only be checked against the free case,
    // which is why the identity argument exists.
    return operation();
  }
  if (holder.watchdogTimer) {
    clearTimeout(holder.watchdogTimer);
    holder.watchdogTimer = null;
  }
  // Not running while yielded, so this time is not charged against the ceiling.
  endUnpausedSegment(holder);
  currentHolder = null;
  yieldedHolderCount++;
  wasmClientMutex.release();
  try {
    return await operation();
  } finally {
    await wasmClientMutex.acquire();
    yieldedHolderCount--;
    /* c8 ignore else -- a suspended holder is never the eviction target today */
    if (!holder.killed) {
      currentHolder = holder;
      // Back on the clock — at the relaxed ceiling if the resumed flow is still
      // inside a pause bracket (a yield nested in a pause), the normal one
      // otherwise, minus what this hold has already spent running.
      if (holder.pauseCount === 0) startUnpausedSegment(holder);
      armWatchdogFor(holder);
    } else {
      // Defensive: a holder cannot currently be killed while suspended, but if
      // that ever becomes possible this flow must not resume as owner — hand
      // the slot straight back instead of leaking a held lock.
      /* c8 ignore next 2 -- see above */
      wasmClientMutex.release();
    }
  }
}

/**
 * Queue a low-priority operation to run when the WASM client is idle.
 * Use this for background tasks like metadata prefetching that shouldn't
 * block or delay critical operations.
 *
 * Operations are fire-and-forget (errors are logged, not thrown).
 */
export function runWhenClientIdle(operation: () => Promise<void>): void {
  wasmClientMutex.queueIdleTask(operation);
}

/**
 * Singleton manager for MidenClientInterface.
 * Ensures a bounded number of client instances (and underlying web workers) exist at a time.
 */
class MidenClientSingleton {
  private instance: MidenClientInterface | null = null;
  private initializingPromise: Promise<MidenClientInterface> | null = null;

  private instanceWithOptions: MidenClientInterface | null = null;
  private initializingPromiseWithOptions: Promise<MidenClientInterface> | null = null;

  /**
   * Bumped by every dispose, PER SLOT. A creation that was already in flight
   * captures its own slot's value at its start and refuses to install its
   * client if it no longer matches — otherwise it would write a client built
   * before the dispose into the slot the dispose just cleared, handing later
   * callers exactly the stale instance the dispose existed to get rid of (issue
   * #775: recovery disposes from a timer / error listener, so a
   * `getMidenClient()` is likely in flight).
   *
   * Two counters, not one, because the slots have unrelated lifetimes:
   * `getInstanceWithOptions` disposes its own slot on EVERY call (options must
   * be re-applied), which is routine rather than a recovery. Sharing one counter
   * let that routine refresh invalidate an unrelated in-flight no-options
   * create, which then freed a perfectly healthy client, handed the terminated
   * instance to its caller anyway, and left its memoized promise uncleared.
   */
  private generation = 0;
  private generationWithOptions = 0;

  /**
   * Get or create the singleton MidenClientInterface instance.
   * This instance does not specify any options and is never disposed.
   * On mobile, if instanceWithOptions already exists, return that to avoid
   * creating multiple clients (which causes OOM from multiple WASM worker instances).
   */
  async getInstance(): Promise<MidenClientInterface> {
    // On mobile, reuse any existing client to avoid OOM from multiple worker instances
    /* c8 ignore next 3 -- singleton reuse path, requires prior getInstanceWithOptions call */
    if (this.instanceWithOptions) {
      return this.instanceWithOptions;
    }

    /* c8 ignore next 3 -- singleton cache hit, requires WASM client creation */
    if (this.instance) {
      return this.instance;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    const startedAt = this.generation;
    const creating: Promise<MidenClientInterface> = (async () => {
      try {
        const client = await MidenClientInterface.create();
        // Lost a race with a dispose: this client predates it, so it must not
        // land in the slot. Free it rather than leaking its WASM instance, and
        // still hand it back to THIS caller, whose await began before the
        // dispose — it fails on its next call, which is the same outcome the
        // dispose gave every other in-flight user of that client.
        if (startedAt !== this.generation) {
          this.freeGuarded(client);
          return client;
        }
        this.instance = client;
        return client;
      } finally {
        // Always clear the memoized init promise so a transient startup failure
        // (e.g. the node is unreachable at first client construction) self-heals
        // on the NEXT getInstance() call, instead of poisoning the singleton with
        // a permanently-rejected promise until a full reload / SW restart. Before
        // this, a startup blip left every caller getting the same rejection
        // forever (resilience gap 7).
        //
        // Guarded on generation: a dispose that landed mid-creation already
        // cleared the slot, and a later caller may have installed ITS OWN
        // creation there — which this must not clear, or a third caller would
        // start yet another concurrent create.
        if (startedAt === this.generation) this.initializingPromise = null;
      }
    })();
    this.initializingPromise = creating;

    return creating;
  }

  /**
   * Get or create the singleton MidenClientInterface instance with specified options.
   * If it already exists, this instance will always be disposed and recreated to ensure option correctness.
   */
  async getInstanceWithOptions(options: MidenClientCreateOptions): Promise<MidenClientInterface> {
    if (this.instanceWithOptions) {
      this.disposeInstanceWithOptions();
    }

    /* c8 ignore next 3 -- concurrent init dedup, requires WASM client creation */
    if (this.initializingPromiseWithOptions) {
      return this.initializingPromiseWithOptions;
    }

    const startedAt = this.generationWithOptions;
    const creating: Promise<MidenClientInterface> = (async () => {
      try {
        const client = await MidenClientInterface.create(options);
        // See getInstance: a client built before a dispose must not be
        // installed afterwards. This slot matters more, because it is the first
        // await of every signed (guardian) write.
        if (startedAt !== this.generationWithOptions) {
          this.freeGuarded(client);
          return client;
        }
        this.instanceWithOptions = client;
        return client;
      } finally {
        // Self-heal a transient startup failure instead of poisoning the
        // memoized promise (resilience gap 7 — see getInstance above), without
        // clearing a successor a mid-creation dispose let somebody else install.
        if (startedAt === this.generationWithOptions) this.initializingPromiseWithOptions = null;
      }
    })();
    this.initializingPromiseWithOptions = creating;

    return creating;
  }

  disposeInstanceWithOptions(): void {
    this.generationWithOptions++;
    // Cleared UNCONDITIONALLY, outside the instance guard. A with-options
    // creation that is still in flight leaves `instanceWithOptions` null, so the
    // guard below never runs — and the pending promise would then be returned
    // as-is by the next `getInstanceWithOptions()`, which is either a client
    // built against the pre-dispose state or, if that creation is the one that
    // trapped, a promise that never settles: every later signed write would
    // await it forever, and recovery could not clear it (issue #775).
    this.initializingPromiseWithOptions = null;
    if (this.instanceWithOptions) {
      this.freeGuarded(this.instanceWithOptions);
      this.instanceWithOptions = null;
    }
  }

  /**
   * `free()` on a trapped WASM module can itself throw (issue #775). The
   * instance is being discarded either way, so a throwing free must never
   * abort a dispose — that would leave the dead client in the slot and hand
   * it to the next `getMidenClient()` caller.
   */
  private freeGuarded(instance: MidenClientInterface): void {
    try {
      instance.free();
    } catch (err) {
      console.warn('[miden-client] free() threw during dispose (continuing):', err);
    }
  }

  /**
   * Free every live singleton (the no-options `instance` and the
   * `instanceWithOptions`), so the next `getInstance()`/`getInstanceWithOptions()`
   * call recreates the WASM client from scratch. Used when the effective
   * endpoints (RPC/prover/note-transport) change underneath a long-lived
   * singleton — see `resetMidenClient`.
   */
  disposeAllInstances(): void {
    this.generation++;
    if (this.instance) {
      this.freeGuarded(this.instance);
      this.instance = null;
    }
    // Null unconditionally, not just inside the `this.instance` guard above: if a
    // no-options `getInstance()` creation is in flight, `this.instance` is still null
    // here (the guard above never runs) but `initializingPromise` is a pending promise
    // that a subsequent `getInstance()` call would otherwise return as-is — repopulating
    // `this.instance` with a client built against the pre-reload override once that
    // stale creation resolves. Clearing the slot means any `getInstance()` call issued
    // after this reset starts its own fresh creation instead of rejoining the stale one.
    this.initializingPromise = null;
    this.disposeInstanceWithOptions();
  }

  /**
   * Clear every slot WITHOUT freeing the clients in them (issue #775).
   *
   * For the one recovery case where terminating would hit a flow that is still
   * legitimately using its client: a trap observed while a holder is suspended
   * inside `yieldWasmClientLock`. That flow is past the mutex and holds a direct
   * reference, so `free()` would fail it — possibly after its point of no
   * return. Detaching still gets the poisoned instance out of the way for every
   * FUTURE caller, which is the part that must not be skipped: nothing else in a
   * realm ever disposes the singleton, so leaving it installed hands the dead
   * client to everyone from then on.
   *
   * The detached instance is collected with the realm; the suspended flow fails
   * on its own next call against the aborted module, exactly as it would have.
   */
  detachAllInstances(): void {
    this.generation++;
    this.generationWithOptions++;
    this.instance = null;
    this.initializingPromise = null;
    this.instanceWithOptions = null;
    this.initializingPromiseWithOptions = null;
  }
}

const midenClientSingleton = new MidenClientSingleton();

// Install the trap listener as soon as any code in this realm touches the
// client module — a trap can fire during an un-locked bypass read (the balance
// poll) before the first `withWasmClientLock` call ever happens.
ensureRealmErrorListener();

/**
 * Convenience function to get the shared MidenClientInterface instance.
 * Use this in your components and modules instead of calling MidenClientInterface.create().
 */
export async function getMidenClient(options?: MidenClientCreateOptions): Promise<MidenClientInterface> {
  if (options) {
    const client = await midenClientSingleton.getInstanceWithOptions(options);
    return client;
  }
  const client = await midenClientSingleton.getInstance();
  return client;
}

/**
 * Dispose every live MidenClientInterface singleton so the next `getMidenClient()`
 * call rebuilds one from scratch against the current effective endpoints
 * (`lib/miden-chain/effective-endpoints`). Use this after the endpoint
 * override changes underneath an already-created client (e.g. the SW's
 * `RELOAD_ENDPOINT_OVERRIDES_REQUEST` handler) — the client bakes in
 * rpcUrl/proverUrl/noteTransportUrl at `MidenClient.create()` time and never
 * re-reads them. Runs inside `withWasmClientLock` so it can't dispose a
 * client mid-operation.
 */
export async function resetMidenClient(): Promise<void> {
  await withWasmClientLock(async () => {
    midenClientSingleton.disposeAllInstances();
  });
}
