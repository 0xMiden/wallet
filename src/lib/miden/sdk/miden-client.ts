// This import must stay ABOVE the `./miden-client-interface` one: that import
// forms a cycle (via `speculation-manager`), and the poison bindings this
// module's own body reads — the three ceilings in `armWatchdogFor`, the error
// class in `recoverFromWedgedHolder` — must already be initialized when the
// cycle re-enters this module. See `wasm-client-poison.ts`.
import {
  WASM_LOCK_MIN_WATCHDOG_MS,
  WASM_LOCK_PAUSED_WATCHDOG_MS,
  WASM_LOCK_WATCHDOG_MS,
  WasmClientPoisonedError,
  bumpWasmClientGeneration
} from './wasm-client-poison';
// eslint-disable-next-line import/order -- must load AFTER wasm-client-poison (TDZ safety, see above)
import { MidenClientInterface, MidenClientCreateOptions } from './miden-client-interface';

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
  /**
   * This hold's operation, attached by the lock wrapper right after it starts.
   *
   * An eviction cannot free the client, because the abandoned operation is still
   * holding it (see `replaceClientSingletons`) — but it does not have to leak it
   * forever either. When this promise settles, that operation has stopped touching
   * the client, so the poisoned instance can finally be reclaimed. Without it,
   * every eviction leaked a whole WASM client, and the #777 path evicts on a
   * two-minute ceiling for as long as a node stays parked.
   */
  running: Promise<unknown> | null;
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
  /**
   * Same ledger for PAUSED wall-clock: total time this hold has spent inside
   * pause brackets, and when the current paused segment began. Without it each
   * bracket re-armed a fresh relaxed ceiling, so SEQUENTIAL brackets (sign,
   * then prove, then sign again…) bought unbounded unwatched time — the exact
   * loophole `unpausedElapsedMs` closes for the normal ceiling.
   */
  pausedElapsedMs: number;
  pausedSegmentStartedAt: number | null;
  /**
   * Whether this hold has already been granted the once-per-hold finishing
   * slice (`WASM_LOCK_MIN_WATCHDOG_MS`) it gets when a bracket closes on an
   * already-exhausted budget. One grant is mercy; granting it at every close
   * would restore exactly the unbounded loop `unpausedElapsedMs` prevents.
   */
  graceUsed: boolean;
  /**
   * The same one-shot mercy for the RELAXED ceiling. It has to exist separately
   * because the two ledgers are separate: `graceUsed` credits
   * `unpausedElapsedMs`, so it does nothing for a hold whose paused budget is the
   * exhausted one. A hold that spent 29 of its 30 relaxed minutes answering a
   * sign prompt would otherwise get 60 seconds for the prove that follows — and
   * at exactly 30, a ceiling of literally zero, evicting it on the next
   * macrotask. That eviction lands past `'syncing'`, where the pipeline records
   * `markMayHaveSubmitted` permanently, so the cost of a slow user behind a slow
   * prover is a send that can never be retried.
   */
  pausedGraceUsed: boolean;
  /**
   * The normal (unpaused) watchdog ceiling for THIS hold. Defaults to
   * `WASM_LOCK_WATCHDOG_MS`; a caller whose operation has a tighter known
   * bound (the sync holds, issue #777) passes a smaller one via
   * `withWasmClientLock`'s options so a wedge is recovered on the operation's
   * own budget instead of the 5-minute last resort. Holder-scoped so it
   * survives pause brackets and yields, and never leaks to the next hold.
   *
   * Always within `[WASM_LOCK_MIN_WATCHDOG_MS, WASM_LOCK_WATCHDOG_MS]`, so the
   * rest of the watchdog arithmetic can treat it as a sane finite budget.
   * `beginHold` is the only writer and clamps its argument through
   * `resolveNormalCeilingMs`, which is what makes that an invariant rather than
   * a convention every call site has to remember.
   */
  normalCeilingMs: number;
  /**
   * Who took this hold, for the eviction record. The watchdog fires rarely, in the
   * field, on a device whose console nobody can read live — and by now a dozen
   * sites take a bounded hold on this one mutex. Without a name, every eviction
   * log described the SAME mechanism and none of them said which flow parked:
   * `runningMs` and `normalCeilingMs` cannot separate an idle sync from a
   * guardian round-trip or a claimable-notes read, all of which now ask for the
   * same two-minute ceiling (#777). Optional, so an unlabelled hold still logs.
   */
  label: string | null;
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
 * Treat the value as opaque; only reference equality is meaningful. Exported
 * `Readonly` to make that the type's problem rather than a convention: a caller
 * that could flip `killed` or `pauseCount` would be editing the lock's own
 * bookkeeping from outside. The module's internals keep working on plain
 * `LockHolder`.
 */
export type WasmLockHold = Readonly<LockHolder>;

let currentHolder: LockHolder | null = null;

/**
 * The hold that currently owns the mutex, or `null` when it is free.
 *
 * Two legitimate uses, and the difference between them is the whole point:
 *
 * - To LEARN this flow's own hold, call it at the very START of a locked
 *   operation's body. No `await` has elapsed since the hold was created, so the
 *   value provably IS this flow's. Capturing it any later is meaningless — by
 *   then an eviction may have handed the slot to somebody else, which is the
 *   ambiguity {@link WasmLockHold} exists to resolve.
 * - To ASK whether this flow still owns the mutex, compare it against a hold
 *   captured earlier, at any time. That is the reverse question and it is
 *   exactly what an abandoned-but-still-running flow needs, since a stale
 *   identity is the only thing distinguishing it from a healthy owner.
 */
export function getCurrentWasmLockHold(): WasmLockHold | null {
  return currentHolder;
}

/**
 * The post-await ownership re-check the CLAUDE.md hold contract mandates, as
 * one shared export (#788 follow-up): compare the hold captured at the start of
 * a locked body against the live owner, and refuse to continue if the mutex has
 * moved on. `where` names the transition for the forensic record — it travels
 * on the error's `cause`, never its message, which stays closed wallet-authored
 * text (see {@link WasmClientPoisonedError}).
 *
 * Call it between a parking await and the NEXT WASM call — including reads on
 * objects returned earlier (an `Account`'s `vault()` is a borrow of the client
 * it came from, not a stale snapshot). Throwing here is safe exactly where the
 * contract says to check: provably pre-submit transitions. Never guard
 * post-submit steps with it — completing beats aborting once a transaction may
 * have been broadcast.
 *
 * `hold` is NON-NULLABLE, unlike the permissive {@link holdIsCurrent} that backs
 * `yield`/`pause`. The two read `null` in opposite directions on purpose —
 * "nobody told me, so trust the lock" is right for relaxing a watchdog and
 * catastrophic for an abort check — and accepting `null` here made the wrong one
 * reachable by accident: `assertWasmHoldCurrent(getCurrentWasmLockHold(), …)`
 * typechecks and is tautologically true, so it fails OPEN in the one case the
 * guard exists for. Requiring the captured hold makes that a compile error, the
 * same reason `DispatchContext.hold` is non-nullable. The runtime null test
 * stays behind the type as a backstop: an untyped or `as`-cast caller must not
 * be able to reach the fails-open comparison when nothing holds the mutex.
 */
export function assertWasmHoldCurrent(hold: WasmLockHold, where: string): void {
  if (hold != null && getCurrentWasmLockHold() === hold) return;
  throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}`));
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
  // A rejection reason is not always an `Error`: a trap that crosses a worker
  // boundary, or one JavaScriptCore surfaces itself, can arrive as a bare string
  // (the shape `onRealmRejection` passes with no `rawMessage`). Reading only
  // `Error.message` left that case with an empty string, so the whole predicate
  // was dead for it and the wedge waited out the 5-minute — or, mid-prove,
  // 30-minute — watchdog instead of being evicted in milliseconds.
  const message =
    typeof rawMessage === 'string' && rawMessage.length > 0
      ? rawMessage
      : typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : '';
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

/**
 * Holders currently suspended inside a `yieldWasmClientLock` window.
 *
 * A SET rather than a count, because these are exactly the parties that retain a
 * poisoned client besides the holder being evicted — and reclaiming the instance
 * needs their promises, not their number (see `reclaimWhenIdle`).
 */
const yieldedHolders = new Set<LockHolder>();

/**
 * Realm-local listeners run after recovery has replaced the client singletons
 * (issue #775).
 *
 * `midenClientSingleton` is not the only place a realm keeps a client: the
 * offscreen document builds its own via `MidenClientInterface.create()` and
 * caches it in a module-local, so `replaceClientSingletons()` reaches nothing there
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
  for (const listener of poisonedListeners) {
    try {
      listener();
    } catch (err) {
      console.warn('[miden-client] a poisoned-client listener threw (continuing):', err);
    }
  }
}

/**
 * Get the poisoned client out of the way for every future caller, choosing
 * between terminating it and merely marking it by whether anyone is still
 * legitimately using it (issue #775).
 *
 * `evictedHolderKeepsReference` is the caller stating that some flow it just
 * abandoned is still holding a direct client reference, so `free()` would pull
 * the module out from under it. EVERY eviction is such a caller: an evicted
 * operation is abandoned, not cancelled, and every write resolves its client
 * INSIDE the hold — so the evicted flow is past the mutex, holding a reference,
 * and by construction still inside a WASM call. `free()`ing there fails a
 * transaction that may already have submitted.
 *
 * Keying that decision on the suspended-holder count alone was wrong, and wrong in
 * the worst place: every yield call site in the app is an offscreen-prove path,
 * which only the extension has. On mobile and desktop the count is therefore
 * permanently zero, so every eviction took the `free()` branch — including a
 * mobile write, which has no transport deadline and no JS deadline, and for
 * which the watchdog is the ONLY bound. That is the one flow most likely to be
 * mid-submit when the ceiling expires.
 *
 * Only a trap with NO holder at all can safely terminate immediately: the module
 * is already aborted and nobody is using the instance.
 *
 * Marking is not the same as leaking, though it was at first. `reclaimAfter`
 * settles when every flow still holding that instance has finished with it, and
 * the poisoned instance is freed THEN. Without it every eviction leaked a whole
 * WASM client (a method worker and its instance off mobile), and the #777 path
 * evicts on a two-minute ceiling for as long as a node stays parked, so the leak
 * was unbounded in the realm's lifetime. What it cannot recover is an operation
 * that never settles at all — a fetch parked forever holds its client forever,
 * which is why the fuse bounds how often that can happen.
 *
 * `reclaimAfter` has to cover EVERY retainer, not just the evicted flow, or the
 * deferred free becomes a use-after-free. Poisoning detaches the instance so no
 * NEW caller can be handed it, but a holder already suspended inside a yield is
 * using that same instance and is not the operation being waited on — freeing on
 * the evicted flow's settle alone would pull the module out from under a sibling
 * that is still writing. `reclaimWhenIdle` builds the promise from all of them.
 */
function replaceClientSingletons(evictedHolderKeepsReference: boolean, reclaimAfter?: Promise<unknown> | null): void {
  if (evictedHolderKeepsReference || yieldedHolders.size > 0) {
    const poisoned = midenClientSingleton.poisonAllInstances();
    if (reclaimAfter && poisoned.length > 0) {
      void reclaimAfter.then(() => {
        console.warn('[miden-client] every flow holding the poisoned client has settled — reclaiming it');
        midenClientSingleton.freeDetachedInstances(poisoned);
      });
    }
  } else {
    midenClientSingleton.disposeAllInstances();
  }
  notifyWasmClientPoisoned();
}

/**
 * When every party still holding the about-to-be-poisoned client has finished
 * with it — or `null` when that moment is not observable, in which case the
 * instance stays marked rather than being freed under a live flow.
 *
 * The retainers are the flow being evicted plus every holder suspended mid-yield:
 * both resolved the instance inside their hold and hold a direct reference, and
 * poisoning only stops NEW callers from being handed it. A retainer whose
 * operation promise is not attached yet (a hold evicted in the few synchronous
 * statements before the lock wrapper attaches it) makes the whole set
 * unobservable, so the answer is `null` rather than a partial wait.
 *
 * `allSettled`, not `all`: these promises usually REJECT (an evicted holder is
 * rejected with `WasmClientPoisonedError`), and a rejection is just as good a
 * signal that the flow has stopped touching the client.
 */
function reclaimWhenIdle(retainers: Iterable<LockHolder>): Promise<unknown> | null {
  const running: Promise<unknown>[] = [];
  for (const retainer of retainers) {
    if (!retainer.running) return null;
    running.push(retainer.running);
  }
  return running.length > 0 ? Promise.allSettled(running) : null;
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
  } else if (yieldedHolders.size > 0) {
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
    console.error(
      '[miden-client] WASM trap while a holder is mid-yield — poisoning client singletons in place:',
      cause
    );
    lastRecoveryAt = monotonicNow();
    replaceClientSingletons(true, reclaimWhenIdle(yieldedHolders));
  } else {
    // No holder to evict, and nobody suspended — the ONLY case that can safely
    // terminate. The trap still aborted the module instance, so dispose and let
    // the next getMidenClient() construct a fresh client rather than handing out
    // the poisoned one.
    console.error('[miden-client] WASM trap with no lock holder — disposing client singletons:', cause);
    lastRecoveryAt = monotonicNow();
    replaceClientSingletons(false);
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
/**
 * The relaxed ceiling this hold has left, with the same once-per-hold finishing
 * slice the normal ceiling gets. Shared by the pause bracket and the yield,
 * which are the same budget seen from two places: a yield banks its wall-clock
 * into `pausedElapsedMs` on the way out, so a hold that alternates the two must
 * not find the second one arming at zero.
 */
function pausedCeilingFor(holder: LockHolder): number {
  const remaining = WASM_LOCK_PAUSED_WATCHDOG_MS - holder.pausedElapsedMs;
  // Strictly greater, which is a boundary hardening rather than a behaviour change:
  // at `remaining === MIN` both operators hand back the same `MIN`, but `>=` did it
  // WITHOUT consuming the grace, leaving the once-per-hold slice available to a
  // later sub-`MIN` transition that would then refund the ledger to `PAUSED - MIN`
  // all over again. Falling through spends the grace at the boundary instead.
  if (remaining > WASM_LOCK_MIN_WATCHDOG_MS) return remaining;
  if (!holder.pausedGraceUsed) {
    // Credited to the ledger, not just to this timer, for the reason spelled out
    // on `graceUsed` below: overriding only the timer leaves the ledger past the
    // ceiling, so the next transition re-arms at `max(negative, 0)`.
    holder.pausedGraceUsed = true;
    holder.pausedElapsedMs = WASM_LOCK_PAUSED_WATCHDOG_MS - WASM_LOCK_MIN_WATCHDOG_MS;
    return WASM_LOCK_MIN_WATCHDOG_MS;
  }
  return Math.max(remaining, 0);
}

function armWatchdogFor(holder: LockHolder): void {
  if (holder.watchdogTimer) clearTimeout(holder.watchdogTimer);
  let ceiling: number;
  if (holder.pauseCount > 0) {
    // The relaxed ceiling bounds the hold's TOTAL paused time, not the current
    // bracket: unpaused time already spent is not charged against it, but time
    // spent in earlier brackets is, or sequential brackets would each buy a
    // fresh 30 minutes and a bracket-looping flow would run forever unwatched.
    ceiling = pausedCeilingFor(holder);
  } else {
    // Charge only time this hold spent RUNNING, so the normal ceiling bounds the
    // hold rather than the segment since the last transition.
    const remaining = holder.normalCeilingMs - holder.unpausedElapsedMs;
    // `>=` here, NOT the `>` that `pausedCeilingFor` uses, and the asymmetry is
    // deliberate. On the paused ledger, `remaining === MIN` can only mean the budget
    // is nearly spent, because `WASM_LOCK_PAUSED_WATCHDOG_MS` is many times `MIN`.
    // Here it also describes a hold whose ENTIRE budget is `MIN` — the clamp floors
    // a requested ceiling at exactly that — so a fresh hold arrives at this line
    // with `remaining === MIN` and nothing spent. Falling through would burn its
    // once-per-hold grace at hold start and leave the first bracket close with only
    // the true remainder, evicting a healthy holder mid-sign.
    if (remaining >= WASM_LOCK_MIN_WATCHDOG_MS) {
      ceiling = remaining;
    } else if (!holder.graceUsed) {
      // Budget exhausted while a bracket was open: give the hold one slice to
      // finish in rather than evicting it the instant the bracket closes — the
      // wait it just came out of was the legitimately unbounded one. Once only,
      // so a flow looping over brackets cannot renew the grace forever.
      //
      // Credited to the LEDGER, not just to this timer. The slice has to survive
      // the hold's next transition, and the transition that follows it in
      // practice is a yield: `proveLocallyViaOffscreen` comes out of the sign
      // pause, runs the rest of execute, then yields around the offscreen prove.
      // Overriding only the timer left `unpausedElapsedMs` past the ceiling, so
      // the resume re-armed at `max(negative, 0)` — evicting the flow on the
      // next macrotask, which lands between `markSubmitting()` and the actual
      // submit. Writing the ledger back to "one slice left" makes the resume
      // re-arm on the unspent remainder of the grace instead.
      holder.graceUsed = true;
      holder.unpausedElapsedMs = holder.normalCeilingMs - WASM_LOCK_MIN_WATCHDOG_MS;
      ceiling = WASM_LOCK_MIN_WATCHDOG_MS;
    } else {
      ceiling = Math.max(remaining, 0);
    }
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

/**
 * Close the hold's current paused segment (the outermost bracket is closing, or
 * the hold is yielding the mutex mid-bracket), banking what it spent paused so
 * the relaxed ceiling bounds the hold's total paused time.
 */
function endPausedSegment(holder: LockHolder): void {
  if (holder.pausedSegmentStartedAt === null) return;
  holder.pausedElapsedMs += Math.max(monotonicNow() - holder.pausedSegmentStartedAt, 0);
  holder.pausedSegmentStartedAt = null;
}

/** Start a new paused segment (a bracket is open and the hold owns the mutex). */
function startPausedSegment(holder: LockHolder): void {
  if (holder.pausedSegmentStartedAt === null) holder.pausedSegmentStartedAt = monotonicNow();
}

/**
 * Open a hold. `requestedCeilingMs` is what the CALLER asked for, not a usable
 * ceiling: it is clamped here, by construction, so `normalCeilingMs` cannot be
 * out of range no matter which call site (or which future one) supplies it —
 * see {@link resolveNormalCeilingMs} for what an unchecked value breaks.
 */
function beginHold(requestedCeilingMs?: number, label?: string): LockHolder {
  let abort!: (err: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });
  const holder: LockHolder = {
    killed: false,
    running: null,
    pauseCount: 0,
    watchdogTimer: null,
    unpausedElapsedMs: 0,
    segmentStartedAt: monotonicNow(),
    pausedElapsedMs: 0,
    pausedSegmentStartedAt: null,
    graceUsed: false,
    pausedGraceUsed: false,
    normalCeilingMs: resolveNormalCeilingMs(requestedCeilingMs),
    label: label ?? null,
    abort,
    aborted
  };
  // A non-null holder here means the mutex admitted two owners at once — the
  // invariant this type documents is broken, and the WASM client is about to be
  // double-borrowed. Unobservable before, so say so loudly rather than
  // silently overwriting the evidence. Retire the displaced holder too: it is
  // about to be overwritten, and leaving it live would leave its watchdog armed
  // to fire against a stale identity while it still believes it owns the lock.
  if (currentHolder) {
    console.error('[miden-client] BUG: taking the WASM lock while another holder is still registered');
    // Marked `killed` so the displaced flow's own `endHold` does NOT release: a
    // second owner can only have been admitted through a release that already
    // happened spuriously, so letting the displaced holder release again would
    // wake yet another waiter into the still-running new owner — turning one
    // over-release into a cascade of concurrent WASM calls.
    const displaced = currentHolder;
    displaced.killed = true;
    if (displaced.watchdogTimer) clearTimeout(displaced.watchdogTimer);
    displaced.watchdogTimer = null;
    displaced.abort(new WasmClientPoisonedError('realm-error', new Error('displaced by a second lock holder')));
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
  // The forensic record for a mechanism that fires rarely, in the field, on a
  // device whose console nobody can read live (mobile especially). The error's
  // own message deliberately names no ceiling, because the ceiling that applied
  // depends on the pause accounting — so the live numbers have to be HERE or
  // they exist nowhere. `mode` says whether the client was terminated or only
  // marked, which decides whether some other flow kept a working reference.
  console.error('[miden-client] evicting wedged WASM lock holder:', {
    reason,
    hold: holder.label ?? 'unlabelled',
    runningMs: Math.round(
      holder.unpausedElapsedMs + (holder.segmentStartedAt === null ? 0 : monotonicNow() - holder.segmentStartedAt)
    ),
    pauseDepth: holder.pauseCount,
    graceUsed: holder.graceUsed,
    // Without this, a 2-minute sync-ceiling kill and a hold that had barely
    // started on the 5-minute backstop produce indistinguishable records —
    // `runningMs` alone cannot say which bound was in force (#777).
    normalCeilingMs: holder.normalCeilingMs,
    yieldedHolders: yieldedHolders.size,
    // Always in-place for an eviction — the evicted flow keeps its reference, and
    // the instance is reclaimed once that flow's own promise settles.
    mode: 'poison-in-place',
    error
  });
  holder.abort(error);
  // A trap aborts the WASM module instance — every later call against it
  // fails, so releasing the mutex alone would hand the next operation a dead
  // client. Replace it first (deliberately NOT via resetMidenClient(), which
  // takes this same lock and would deadlock), then release so the queue
  // drains onto a freshly constructed client. MARKING rather than freeing: the
  // holder being evicted is abandoned, not cancelled, and it resolved its client
  // inside the hold — so it is past the mutex, still holding that reference, and
  // by construction still inside a WASM call. Freeing under it fails a
  // transaction that may already have submitted — so the instance is freed later
  // instead, when that flow's own promise settles.
  // The evicted holder is the current mutex owner, so it is not itself yielded:
  // every member of `yieldedHolders` is a sibling still using the same instance.
  replaceClientSingletons(true, reclaimWhenIdle([holder, ...yieldedHolders]));
  wasmClientMutex.release();
}

/**
 * Options for {@link withWasmClientLock}.
 *
 * `watchdogMs` tightens THIS hold's normal watchdog ceiling below
 * `WASM_LOCK_WATCHDOG_MS` (issue #777) — for operations with a known bound (the
 * sync holds) where waiting out the 5-minute last resort leaves the wallet
 * lockless for far longer than the operation could legitimately run. Expiry is
 * the ordinary #775 eviction: the holder is rejected with
 * `WasmClientPoisonedError` and the client singletons are replaced, because the
 * abandoned operation is not cancelled and may still be borrowing the WASM
 * client — merely releasing the mutex would double-borrow it under the next
 * holder. The paused/yielded ceilings are NOT affected: a pause bracket still
 * relaxes to `WASM_LOCK_PAUSED_WATCHDOG_MS`.
 *
 * The value is CLAMPED, never trusted — see `resolveNormalCeilingMs`.
 */
export interface WasmClientLockOptions {
  watchdogMs?: number;
  /** Names this hold in the eviction record — see `LockHolder.label`. */
  label?: string;
}

/**
 * Resolve a caller's requested ceiling to a usable one: anything that is not a
 * positive finite number is treated as no request at all, and a real request is
 * clamped into `[WASM_LOCK_MIN_WATCHDOG_MS, WASM_LOCK_WATCHDOG_MS]`.
 *
 * The option only ever TIGHTENS the last-resort backstop, and this is what makes
 * that true rather than merely documented. Three ways an unchecked value broke
 * the #775 contract, all reachable the moment a ceiling is computed rather than
 * written as a literal:
 *   - Above the default it WIDENED the ceiling, so `withWasmClientLock` would
 *     hand out longer unwatched holds than the backstop allows. That is the
 *     pre-#775 wedge reached through the fix's own escape hatch, which is
 *     exactly what `WASM_LOCK_PAUSED_WATCHDOG_MS` refuses to do by design.
 *   - Below `WASM_LOCK_MIN_WATCHDOG_MS` it fell into `armWatchdogFor`'s
 *     one-shot grace branch on the FIRST arm. The hold still got a 30 s timer,
 *     so the mistake was invisible — but it had spent, before any pause bracket
 *     existed, the finishing slice a post-sign submit needs, and banked a
 *     `normalCeilingMs - 30_000` ledger that goes negative below the slice.
 *   - `NaN` survived into that ledger and reached `setTimeout(fn, NaN)` at the
 *     next transition, which fires on the next macrotask: an instant eviction
 *     of a holder that had done nothing wrong, plus a client replacement.
 *     `Infinity` coerces identically, so the value a caller would reach for to
 *     switch the watchdog OFF is the one that fires it immediately.
 *
 * Zero and negative fall back to the DEFAULT rather than clamping up to the
 * minimum: a non-positive ceiling cannot be a considered request to tighten, so
 * the safe reading of it is a bug in the caller, and honouring it as "evict as
 * soon as allowed" would tear down healthy holds at 30 s.
 *
 * One consequence of the lower bound worth stating: the once-per-hold finishing
 * grace credits `normalCeilingMs - WASM_LOCK_MIN_WATCHDOG_MS` back to the
 * ledger, so a hold clamped AT the minimum gets its whole budget back rather
 * than a slice, and its total unpaused bound is `ceiling +
 * WASM_LOCK_MIN_WATCHDOG_MS` — 60 s at the minimum, 150 s at the sync ceiling.
 * Still once per hold, so still bounded, just less tight than the name suggests.
 */
function resolveNormalCeilingMs(requestedMs: number | undefined): number {
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return WASM_LOCK_WATCHDOG_MS;
  }
  return Math.min(Math.max(requestedMs, WASM_LOCK_MIN_WATCHDOG_MS), WASM_LOCK_WATCHDOG_MS);
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
export async function withWasmClientLock<T>(
  operation: (hold: WasmLockHold) => Promise<T>,
  options?: WasmClientLockOptions
): Promise<T> {
  await wasmClientMutex.acquire();
  const holder = beginHold(options?.watchdogMs, options?.label);
  try {
    const running = operation(holder);
    holder.running = running;
    // The race ABANDONS `running` when recovery rejects `aborted`; if the corpse
    // later rejects with a trap-shaped error past the recovery cooldown, an
    // unhandled rejection would re-enter `onRealmRejection` and evict the
    // innocent successor. Park a no-op handler so the abandonment is silent.
    running.catch(() => {});
    return await Promise.race([running, holder.aborted]);
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
  operation: (hold: WasmLockHold) => Promise<T>,
  options?: WasmClientLockOptions
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!wasmClientMutex.tryAcquire()) return { ran: false };
  // Takes a ceiling like the blocking form. The caller that skips when the lock is
  // busy is the one that most needs one: the window it DOES win is the instant an
  // eviction released the mutex, when the client slot is empty and its own read has
  // to rebuild against the node that just parked (#777).
  const holder = beginHold(options?.watchdogMs, options?.label);
  try {
    const running = operation(holder);
    holder.running = running;
    // See withWasmClientLock: an abandoned corpse's late rejection must not
    // surface as an unhandled rejection and evict the successor.
    running.catch(() => {});
    return { ran: true, value: await Promise.race([running, holder.aborted]) };
  } finally {
    if (endHold(holder)) {
      wasmClientMutex.release();
    }
  }
}

/**
 * Run `operation` with the current lock holder's watchdog relaxed to
 * `WASM_LOCK_PAUSED_WATCHDOG_MS` (issue #775). For the two legitimately
 * unbounded waits inside a hold: a keystore sign round-trip (blocks on user
 * authentication) and a local prove (the fallback when delegated proving is
 * down — capping it at the normal ceiling would leave nothing to fall back to).
 *
 * UNLIKE `pauseDeadline`/`resumeDeadline` in `miden-client-proxy.ts`, the close
 * does NOT restart the full ceiling: it re-arms only this hold's unspent normal
 * budget (`LockHolder.unpausedElapsedMs`), plus one `WASM_LOCK_MIN_WATCHDOG_MS`
 * finishing slice if that budget already ran out. Restarting from scratch is
 * what let a flow opening and closing brackets in a loop run forever unwatched.
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
    startPausedSegment(holder);
    armWatchdogFor(holder);
  }
  try {
    return await operation();
  } finally {
    if (!holder.killed) {
      holder.pauseCount--;
      if (holder.pauseCount === 0 && holder === currentHolder) {
        endPausedSegment(holder);
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
  // Not RUNNING while yielded, so this time is charged against the normal ceiling
  // no more than a pause is. It is still banked (below, on the way out) against
  // the relaxed one: the ceiling is a bound on the HOLD, and letting each yield
  // start a fresh 30 minutes is the same "sequential brackets buy unlimited
  // unwatched time" loophole `pausedElapsedMs` exists to close for pauses.
  endUnpausedSegment(holder);
  endPausedSegment(holder);
  const yieldStartedAt = monotonicNow();
  currentHolder = null;
  yieldedHolders.add(holder);
  // The count must settle exactly once whether the yielded wait resolves or the
  // yield watchdog below gives up on it: a wait that never settles used to leave
  // the count elevated forever, permanently degrading every future recovery to
  // poison-in-place (and its holder wedged unwatched — the pre-#775 symptom
  // reached through the yield).
  let yieldCountSettled = false;
  const settleYieldCount = (): void => {
    if (yieldCountSettled) return;
    yieldCountSettled = true;
    yieldedHolders.delete(holder);
  };
  // A yielded wait is legitimately long (an offscreen prove) but must not be
  // UNWATCHED: the same relaxed ceiling a pause gets, minus paused time already
  // spent. On fire the holder is evicted like any other wedge.
  //
  // The client is POISONED IN PLACE rather than terminated, exactly as a trap
  // taken while a holder is mid-yield is (`recoverFromTrap`): the suspended flow
  // still holds its reference, so freeing it would pull the module out from under
  // a write that may already have submitted. But marking is not optional. Every
  // corpse-detecting guard keys off `isDisposed` — `yieldLockUnlessDisposed`,
  // `wrapSignWithWatchdogPause`, `Vault.spawn`'s re-resolve — and two of them can
  // pass no hold, so `holdIsCurrent` cannot answer for them and they fall back to
  // trusting whoever holds the mutex. Leaving the client unmarked here made this
  // the one eviction path whose corpse reads HEALTHY: on its next yield it would
  // release a SUCCESSOR's mutex, popping a waiter into a live WASM call, and its
  // sign would pause the successor's watchdog. That is the pre-#775 wedge reached
  // through the fix's own recovery path.
  const yieldCeilingMs = pausedCeilingFor(holder);
  const yieldWatchdog = setTimeout(() => {
    if (holder.killed) return;
    holder.killed = true;
    lastRecoveryAt = monotonicNow();
    const error = new WasmClientPoisonedError('watchdog', new Error('yielded WASM lock wait never settled'));
    // Marking, not freeing: this holder is suspended mid-yield and keeps using
    // the reference it already has. It is freed once every flow holding that
    // instance has settled — this one included, so it needs no special case
    // (it is still a member of `yieldedHolders` here; the set settles below).
    // `currentHolder` is whoever legitimately took the mutex while this flow
    // slept, and it resolved the SAME instance inside its own hold, so it
    // retains it exactly as a yielded sibling does. Omitting it was safe only
    // transitively (a yielded flow cannot settle while an owner holds the
    // lock), and that stops being true the moment the owner is itself evicted:
    // its abandoned callback keeps running while the mutex is already released.
    const retainers = currentHolder ? [currentHolder, ...yieldedHolders] : [...yieldedHolders];
    // Logged AFTER the census and as `retainers`, not as `yieldedHolders.size`: this
    // holder is still a member of that set here (it settles below), so the raw count
    // means something different than the identically-named field
    // `recoverFromWedgedHolder` logs, where the evicted holder is the mutex owner and
    // is NOT in the set. Reporting the census is unambiguous either way, and it is
    // the number that decides when the instance can be reclaimed.
    console.error('[miden-client] evicting holder wedged while yielded:', {
      hold: holder.label ?? 'unlabelled',
      // The OPEN yield included. Banked into `pausedElapsedMs` only when the yield
      // settles (in the `finally` below), so the bare field reports every yield but
      // the one that just expired — which on the common shape, a single yield that
      // never returns, is a flat `pausedMs: 0` beside a 30-minute eviction. The one
      // number the reader came for was the only one missing.
      pausedMs: Math.round(holder.pausedElapsedMs + Math.max(0, monotonicNow() - yieldStartedAt)),
      runningMs: Math.round(holder.unpausedElapsedMs),
      // The ceiling that actually fired. It is computed from the pause ledger, so
      // it is not derivable from the constants by a reader of the log.
      ceilingMs: yieldCeilingMs,
      pausedGraceUsed: holder.pausedGraceUsed,
      retainers: retainers.length,
      liveMutexOwner: currentHolder !== null,
      error
    });
    replaceClientSingletons(true, reclaimWhenIdle(retainers));
    settleYieldCount();
    holder.abort(error);
  }, yieldCeilingMs);
  wasmClientMutex.release();
  try {
    return await operation();
  } finally {
    clearTimeout(yieldWatchdog);
    holder.pausedElapsedMs += Math.max(0, monotonicNow() - yieldStartedAt);
    await wasmClientMutex.acquire();
    settleYieldCount();
    if (!holder.killed) {
      currentHolder = holder;
      // Back on the clock — at the relaxed ceiling if the resumed flow is still
      // inside a pause bracket (a yield nested in a pause), the normal one
      // otherwise, minus what this hold has already spent running.
      if (holder.pauseCount === 0) {
        startUnpausedSegment(holder);
      } else {
        startPausedSegment(holder);
      }
      armWatchdogFor(holder);
    } else {
      // Evicted while suspended (the yield watchdog above, or a future eviction
      // path): this flow must not resume as owner — hand the slot straight back
      // instead of leaking a held lock.
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
      this.detachOrFree(this.instanceWithOptions);
      this.instanceWithOptions = null;
    }
  }

  /**
   * Retire an instance this singleton is dropping: free it outright when nobody
   * else can still be holding it, otherwise mark it and free it once they are done.
   *
   * A holder suspended mid-yield resolved the instance INSIDE its hold and keeps a
   * direct reference, so terminating here would pull the client out from under a
   * flow that may already have submitted. Marking alone was the other half of the
   * bug: the reference was dropped with nothing waiting to reclaim it, so a whole
   * WASM client (and off mobile its method worker) leaked — and unlike a trap
   * recovery this runs on the ROUTINE options refresh, i.e. once per
   * `getMidenClient(options)` call that finds a populated slot.
   */
  private detachOrFree(instance: MidenClientInterface): void {
    if (yieldedHolders.size === 0) {
      this.freeGuarded(instance);
      return;
    }
    instance.markPoisoned();
    const reclaimAfter = reclaimWhenIdle(yieldedHolders);
    // Unobservable (a retainer with no operation promise attached yet) leaves the
    // instance marked rather than freed — the same fail-safe direction
    // `replaceClientSingletons` takes.
    if (!reclaimAfter) return;
    void reclaimAfter.then(() => {
      console.warn('[miden-client] every flow holding the detached client has settled — reclaiming it');
      this.freeDetachedInstances([instance]);
    });
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
   *
   * Bumps the cross-module client generation (issue #775): callers that cache
   * something DERIVED from a client — `guardian-manager`'s `MultisigService`
   * cache — must not keep serving an entry built on an instance that no longer
   * exists. That is as true of an endpoint-change reset as it is of a trap
   * recovery, so the bump lives here rather than in the poison notification.
   */
  disposeAllInstances(): void {
    bumpWasmClientGeneration();
    this.generation++;
    if (this.instance) {
      // Routed through the same retirement path as the with-options slot. An
      // endpoint change takes the mutex, which a holder suspended mid-yield does
      // NOT hold — so this reset could reach a straight `free()` while that flow
      // still had the instance in hand, the one path left violating the
      // never-free-under-a-retainer rule the poison paths were built around.
      this.detachOrFree(this.instance);
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
   * Clear every slot, MARKING the clients in them poisoned rather than freeing
   * them (issue #775).
   *
   * For the recovery cases where terminating would hit a flow that is still
   * legitimately using its client: a trap or an eviction while a holder is
   * suspended inside `yieldWasmClientLock` (a send waiting on the offscreen
   * prove, with the concurrent sync holding the mutex). That flow is past the
   * mutex and holds a direct reference, so `free()` would fail it — possibly
   * after its point of no return.
   *
   * Marking is not optional, and is why this is not called a detach. The
   * corpse-detecting guards — `yieldLockUnlessDisposed`,
   * `wrapSignWithWatchdogPause`, `proveWithFallback`'s local-prove pause, and
   * `Vault.spawn`'s re-resolve — all key off `isDisposed`. Dropping the
   * reference without marking hides the client from future callers while
   * leaving every flow that already holds it looking like a healthy owner, so
   * its next yield would release a SUCCESSOR's mutex.
   *
   * The instance itself is not terminated, so a `useWorker` client's method
   * worker lives until the realm goes away — the accepted cost of not failing a
   * flow that may already have submitted.
   */
  poisonAllInstances(): MidenClientInterface[] {
    bumpWasmClientGeneration();
    this.generation++;
    this.generationWithOptions++;
    const poisoned = [this.instance, this.instanceWithOptions].filter(
      (client): client is MidenClientInterface => client !== null
    );
    for (const client of poisoned) client.markPoisoned();
    this.instance = null;
    this.initializingPromise = null;
    this.instanceWithOptions = null;
    this.initializingPromiseWithOptions = null;
    return poisoned;
  }

  /**
   * Terminate instances that were poisoned earlier and are no longer installed.
   *
   * The deferred half of `poisonAllInstances`: marking keeps a flow that may
   * already have submitted alive, and this is what stops that being a permanent
   * leak once the flow has finished. Deliberately takes explicit instances rather
   * than reading the slots — by the time this runs, a successor client is installed
   * and must not be touched.
   */
  freeDetachedInstances(instances: MidenClientInterface[]): void {
    for (const instance of instances) this.freeGuarded(instance);
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
