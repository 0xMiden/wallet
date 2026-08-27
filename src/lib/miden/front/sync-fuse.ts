import {
  FUSED_SYNC_PROBE_INTERVAL_MS,
  MAX_CONSECUTIVE_WATCHDOG_EVICTIONS,
  monotonicNowMs
} from 'lib/miden/sync-backoff';

/**
 * The automatic WASM probes this realm runs on a timer, each identified by the same
 * string it passes as its hold `label` so a fuse entry and an eviction record name the
 * same thing.
 *
 * Every one of them is a hold that (a) runs unattended on a cadence, (b) rebuilds the
 * client when the slot is empty — which after any eviction it is — and so (c) can park
 * on the node that just refused to answer, poisoning and leaking a client per lap. They
 * are exactly the population the fuse exists to throttle.
 *
 * The guardian key carries the ACCOUNT, because `syncGuardianAccounts` loops over every
 * guardian account and each talks to its own guardian endpoint. Keying them together was
 * the same defeat-by-ordering this ledger was split up to fix, one level down: a healthy
 * sibling's success wiped the parked account's evidence within the same lap, so the
 * threshold was unreachable and a guardian wallet parked and leaked a client every two
 * minutes forever. Guardian is the wallet's DEFAULT account type, so that path is the
 * likeliest one in the product, not a corner.
 */
export type SyncFuseKey = 'idle-sync' | 'claimable-notes' | 'balances' | 'note-import' | `guardian-sync:${string}`;

/**
 * The fuse key for one guardian account's sync probe.
 *
 * Carries the ENDPOINT as well as the account, on the same principle as
 * {@link clearSyncFuseForEndpointChange}: every conclusion in this ledger is about one
 * node, and repointing an account at a different guardian makes the old conclusion
 * meaningless. Folding it into the key invalidates that evidence by construction — there
 * is no clear-on-change hook to remember, and no way for a lit fuse to keep a
 * freshly-repointed account quiet for the next half hour.
 */
export const guardianSyncFuseKey = (accountPublicKey: string, guardianEndpoint: string): SyncFuseKey =>
  `guardian-sync:${accountPublicKey}@${guardianEndpoint}`;

interface FuseEntry {
  evictions: number;
  fusedUntilMs: number | null;
}

/**
 * The sync fuse (#777): per-probe evidence that this realm's WASM client is PARKED, and
 * the standing deadline that evidence buys.
 *
 * Module-scoped, and in a module of its own rather than inside `useSyncTrigger`, because
 * what it records belongs to the REALM's client — the dead in-flight call lives in the
 * SDK's module-level map — and four different timers drive a hold against that one
 * client. The hook's loop is merely the loudest.
 *
 * KEYED PER PROBE, which is the correction that makes the shared ledger actually work.
 * A single counter looked right and was defeated by ordering: `useSyncTrigger` clears
 * the ledger on every healthy chain sync and only THEN fires guardian sync, so against a
 * healthy node with a parked guardian the count oscillated 0 → 1 → 0 forever and the
 * threshold was unreachable. The wallet kept paying a two-minute app-wide park and a
 * leaked client every lap, indefinitely — the precise outcome sharing the ledger was
 * supposed to end. Evidence is therefore withdrawn only by a success on the SAME probe:
 * one probe reaching the node says nothing about another probe's parked call, and both
 * facts have to be able to coexist.
 *
 * "Probe" means the narrowest thing that can park INDEPENDENTLY, which is why the
 * guardian key carries the account: two guardian accounts have two endpoints, and one
 * answering says nothing about the other. Getting that granularity wrong in either
 * direction has the same cost — too coarse and a healthy sibling erases the parked one's
 * evidence every lap (the bug above), too fine and no key ever accumulates enough.
 *
 * The state survives remounts on purpose. The hook's effect is rebuilt on every `status`
 * transition, so an idle auto-lock followed by an unlock used to throw the evidence away
 * and hand a provably parked realm back the 3s cadence, plus four more two-minute
 * evictions to re-earn a conclusion it had already reached. The breaker's state stays
 * effect-scoped, and that asymmetry is the point: a remount there legitimately means the
 * user came back and a node outage may well be over, whereas a remount tells you nothing
 * at all about a call parked in a module the remount did not touch.
 *
 * A standing deadline rather than a flag plus the breaker's window, because the two must
 * not share one field: while fused, any single non-watchdog failure re-entered the
 * breaker's arm and overwrote the fused deadline with a window at most a fifth as long,
 * so one offline blip mid-fuse cost the user the whole cadence. Kept separate, each
 * consumer waits for the later of the two.
 */
const ledger = new Map<SyncFuseKey, FuseEntry>();

const entryFor = (key: SyncFuseKey): FuseEntry => {
  const existing = ledger.get(key);
  if (existing) return existing;
  const fresh: FuseEntry = { evictions: 0, fusedUntilMs: null };
  ledger.set(key, fresh);
  return fresh;
};

/** This probe's fused deadline, or null when its fuse has not blown. */
export function syncFuseUntilMs(key: SyncFuseKey): number | null {
  return ledger.get(key)?.fusedUntilMs ?? null;
}

/**
 * True while this probe is fused and its current window has not run out.
 *
 * The gate for a probe that has no scheduler of its own to stretch — an SWR poll, or the
 * guardian sync the idle loop fires and forgets. Without it a lit fuse bought nothing:
 * the fired-and-forgotten guardian sync started a fresh two-minute park on the very next
 * tick after the eviction, and the SWR polls kept doing so every five seconds.
 */
export function isSyncFused(key: SyncFuseKey): boolean {
  const until = syncFuseUntilMs(key);
  return until !== null && until - monotonicNowMs() > 0;
}

/**
 * A hold taken by this probe was evicted by the watchdog.
 *
 * The one failure that proves the realm's call is unrecoverable rather than merely
 * failing: the node accepted the request and never answered, and the SDK will hand the
 * same dead promise to every later probe, so replacing the client cannot reach it.
 */
export function noteSyncWatchdogEviction(key: SyncFuseKey): void {
  const entry = entryFor(key);
  entry.evictions++;
  if (entry.evictions < MAX_CONSECUTIVE_WATCHDOG_EVICTIONS) return;
  if (entry.fusedUntilMs === null) {
    console.warn(
      `[sync-fuse] ${entry.evictions} consecutive watchdog evictions of '${key}' — the realm's call is ` +
        'parked and replacing the client cannot reach it; dropping automatic probes to one per ' +
        `${Math.round(FUSED_SYNC_PROBE_INTERVAL_MS / 60_000)} min until one succeeds (#777)`
    );
  }
  // Re-armed after EVERY qualifying failure while the evidence stands, not only after
  // the eviction that lit the fuse. "One probe per 30 min until one succeeds" is the
  // contract, and a probe that fails some other way has not succeeded — arming only on
  // the eviction let the deadline expire and the consumer fall back to its much shorter
  // ordinary interval.
  //
  // A DEADLINE rather than a per-run delay, for the same reason the breaker keeps one: a
  // tick the guards skip must serve out the wait, not restart it. As a per-run delay,
  // every skipped tick re-armed the full cadence, so a user who opened the send flow
  // while fused pushed their next probe out by another half hour each time.
  entry.fusedUntilMs = monotonicNowMs() + FUSED_SYNC_PROBE_INTERVAL_MS;
}

/**
 * This probe failed for some reason OTHER than a watchdog eviction.
 *
 * Withdraws the evidence, but only before the fuse blows. Once lit, a non-eviction
 * failure is no proof the parked call recovered — only a SUCCESS is that — and zeroing
 * here meant one offline blip mid-fuse bought four fresh evictions, eight more minutes of
 * parked WASM, to re-reach a conclusion nothing had contradicted. While fused it instead
 * re-arms the deadline, for the "until one succeeds" reason above.
 */
export function noteNonEvictionSyncFailure(key: SyncFuseKey): void {
  const entry = entryFor(key);
  if (entry.fusedUntilMs === null) {
    entry.evictions = 0;
    return;
  }
  entry.fusedUntilMs = monotonicNowMs() + FUSED_SYNC_PROBE_INTERVAL_MS;
}

/**
 * This probe went through. The only thing that clears its fuse: it proves the call is
 * not parked after all, which is the one observation the fuse is waiting for.
 */
export function noteSyncSuccess(key: SyncFuseKey): void {
  const entry = ledger.get(key);
  if (!entry) return;
  entry.evictions = 0;
  entry.fusedUntilMs = null;
}

/**
 * A user gesture buys this probe ONE immediate attempt through a lit fuse
 * (#788 follow-up: the dead-letter drain's Retry). The deadline is cleared so
 * the next automatic pass runs now, but the EVIDENCE stands: if the granted
 * probe parks again, the very next eviction re-lights the fuse rather than
 * starting a fresh evidence budget — a gesture is one probe, never a licence
 * to walk the realm back onto the fast cadence against a still-parked call.
 * Same philosophy as the idle loop's Retry exemption in #788.
 *
 * The deadline is EXPIRED rather than cleared, and the difference is the whole
 * contract. `null` is also how this ledger spells "not fused", and
 * `noteNonEvictionSyncFailure` reads exactly that field to decide whether to
 * withdraw the evidence — so nulling it here meant a granted probe that then
 * failed for any ordinary reason (a storage write, a client build) zeroed the
 * eviction count and disarmed the fuse outright, buying
 * `MAX_CONSECUTIVE_WATCHDOG_EVICTIONS` fresh two-minute parks to re-reach a
 * conclusion nothing had contradicted. An already-expired deadline reads as
 * unfused to `isSyncFused` — which is the one probe the gesture buys — while
 * every writer still sees a lit fuse and re-arms it.
 */
export function grantManualSyncProbe(key: SyncFuseKey): void {
  const entry = ledger.get(key);
  if (!entry) return;
  entry.fusedUntilMs = monotonicNowMs();
}

/**
 * Every probe's evidence is void — the realm now talks to a different node.
 *
 * The fuse's claim is about one node's parked call, so an endpoint change invalidates it
 * outright. Without this, repointing a wallet at a working node left it silent for up to
 * another half hour on evidence earned against the node it no longer uses, and the fuse
 * deliberately does not depend on a UI affordance to recover.
 */
export function clearSyncFuseForEndpointChange(): void {
  if (ledger.size === 0) return;
  ledger.clear();
  console.warn('[sync-fuse] endpoint changed — discarding every fuse conclusion earned against the old node');
}

/** Test-only: the module-scoped state above would otherwise leak between tests. */
export function __resetSyncFuseStateForTests(): void {
  ledger.clear();
}
