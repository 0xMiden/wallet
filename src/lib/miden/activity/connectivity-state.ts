/**
 * Connectivity state machine.
 *
 * Tracks the wallet's reachability to the things it depends on, by independent
 * category. Replaces the old single `connectivity-issues` boolean flag — that
 * flag was misnamed (it only ever fired for *prover* failures), persisted in
 * chrome.storage with no auto-clear (a single transient 502 pinned the banner
 * forever), and was not wired on mobile at all.
 *
 * Categories are NOT mutually exclusive — multiple may be active at once
 * (e.g. node down + prover down). Each has independent set/clear rules:
 *
 *   network  - User is offline / DNS / fetch fails to anything (we couldn't
 *              even reach the open internet).
 *   node     - Miden node RPC is unreachable while the rest of the network
 *              is fine. Surfaced from sync errors.
 *   prover   - Remote prover service down. Surfaced by withProverFallback.
 *              Auto-clears on the next successful prover call.
 *   resolving - Transient pseudo-state: a recovery probe / retry is in flight.
 *               Auto-clears with timeout or when a hard category resolves.
 *
 * Persistence model (split by platform):
 *
 *   - Extension: state lives in the service worker's memory AND mirrors to
 *     chrome.storage.local at key `miden-connectivity-state`. The popup reads
 *     via the same `useStorage` mechanism that drives the rest of the
 *     SW->popup state channel. Mirroring to chrome.storage is the ONLY way
 *     the popup learns about an SW-side categorization without an explicit
 *     intercom round-trip.
 *
 *   - Mobile/desktop: there is no SW. The state machine lives in the React
 *     app's process and is accessed via the same hook. The mirror still
 *     writes to the storage adapter (which on mobile/desktop is an
 *     in-memory or Capacitor Preferences shim — see lib/platform/storage-adapter),
 *     so the same `useStorage` consumer works uniformly across platforms.
 *
 * SINGLE WRITER (issue #260). `current` is module-scoped, i.e. PER REALM, and
 * `notify()` writes the WHOLE snapshot to one shared storage key. On the
 * extension that key has producers in BOTH realms:
 *
 *   - service worker — `node`/`network` from sync-manager's failure/success
 *     paths, AND `prover` from the guardian requeue branch of
 *     `safeGenerateTransactionsLoop` (`transaction/index.ts`), since the SW owns
 *     the transaction loop;
 *   - offscreen document — `prover` around every write it executes
 *     (`proveWithFallback` in `sdk/miden-client-interface.ts`).
 *
 * Neither realm has ever seen the other's issues, so a whole-snapshot write from
 * either replaces the entire picture and e.g. an offscreen prover SUCCESS
 * silently clears a real "node unreachable" banner. The fix is
 * {@link setConnectivityReporter}: a realm that does not own the snapshot
 * reports its marks/clears to the realm that does, instead of writing the key
 * itself. See that function for the delivery/drop-safety contract, and
 * {@link applyConnectivityReport} for how the owning realm takes a report.
 *
 * DURABILITY. `current` is per-realm memory that an MV3 service-worker eviction
 * resets, while the storage MIRROR survives — and on the extension the popup
 * PREFERS the mirror (`use-connectivity-state` reads
 * `storageSnapshot ?? memorySnapshot`). After a wake the two therefore disagree,
 * and the "already clear" short-circuit in {@link clearConnectivityIssue} swallows
 * the very clear that would repair a stale mirrored issue, latching a recovered
 * banner with no in-app way back.
 *
 * The service worker closes that gap by HYDRATING `current` from the mirror at
 * `start()` ({@link hydrateConnectivityState}, called from `lib/miden/back/main.ts`)
 * — not by blanking the mirror. Hydration is not the old persistence trap these
 * category rules were written against: that design never auto-cleared at all, so a
 * single transient 502 pinned the banner forever. Here every category has a live
 * clear path, and hydration is precisely what RE-ARMS it — a successful sync clears
 * network/node/resolving and a successful prove clears `prover`, and both now
 * TRANSITION (because `current` agrees with the mirror) instead of short-circuiting.
 * Blanking the mirror at start() would instead have made a genuine outage's banner
 * vanish on every wake, and it could only come back after three more consecutive
 * sync failures (sync-manager's MAX_CONSECUTIVE_SYNC_FAILURES, each up to its 30s
 * watchdog and gated behind the circuit-breaker backoff) or, for `prover`, not until
 * the user's next prove attempt — which may never come.
 */

import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';

export type ConnectivityCategory = 'network' | 'node' | 'prover' | 'resolving';

export interface CategoryState {
  active: boolean;
  /** ms epoch when this category most-recently transitioned to active. */
  since: number | null;
}

export type ConnectivityStateSnapshot = Record<ConnectivityCategory, CategoryState>;

export const CONNECTIVITY_STATE_KEY = 'miden-connectivity-state';

const ALL_CATEGORIES: ConnectivityCategory[] = ['network', 'node', 'prover', 'resolving'];

/**
 * The categories {@link clearReachabilityIssues} clears in one shot — everything
 * a successful sync proves healthy. `prover` is deliberately absent: it is a
 * separate service with separate health.
 */
const REACHABILITY_CATEGORIES = ['network', 'node', 'resolving'] as const;

const DEFAULT_CATEGORY_STATE: CategoryState = { active: false, since: null };

function emptySnapshot(): ConnectivityStateSnapshot {
  return {
    network: { ...DEFAULT_CATEGORY_STATE },
    node: { ...DEFAULT_CATEGORY_STATE },
    prover: { ...DEFAULT_CATEGORY_STATE },
    resolving: { ...DEFAULT_CATEGORY_STATE }
  };
}

let current: ConnectivityStateSnapshot = emptySnapshot();
const listeners = new Set<(snapshot: ConnectivityStateSnapshot) => void>();

/**
 * Categories THIS realm has observed for itself since module init (or the last
 * {@link resetConnectivityState}). Recorded even when the mutator short-circuits,
 * because "already clear" is still an observation.
 *
 * Exists only for {@link hydrateConnectivityState}, which reads storage
 * asynchronously: a mark or clear can land while that read is in flight, and a
 * fresh observation must always beat a mirrored one from before the restart.
 */
const observed = new Set<ConnectivityCategory>();

/**
 * Forwards ONE category's latest known state to the realm that owns the
 * snapshot. `active` is the value this realm just observed, not a delta.
 */
export type ConnectivityReporter = (category: ConnectivityCategory, active: boolean) => void;

/**
 * Installed only in a realm that does NOT own the snapshot (today: the
 * extension's offscreen document — see `src/offscreen/main.ts`). Null everywhere
 * else, which is the unchanged local-state-plus-storage-mirror behaviour.
 */
let reporter: ConnectivityReporter | null = null;

/**
 * Make THIS realm a reporter instead of a writer.
 *
 * With a reporter installed, `markConnectivityIssue` / `clearConnectivityIssue` /
 * `clearReachabilityIssues` stop touching this realm's `current` and stop
 * mirroring to storage; they forward the observation to the owning realm, which
 * applies it to the one authoritative snapshot. That is what stops the offscreen
 * realm's prover result from overwriting the service worker's node/network
 * categorization (and vice versa) — see the SINGLE WRITER note in the header.
 *
 * The forward is expected to be FIRE-AND-FORGET across a realm boundary, so it
 * carries no delivery or ordering guarantee, and this module is built so that
 * dropping one costs at most a stale banner:
 *
 *   - EVERY call forwards. A reporting realm keeps no local state and therefore
 *     does no "already active / already clear" de-duplication — that dedupe is
 *     what would turn a single dropped report into a permanently wrong banner
 *     (a lost clear followed by locally-suppressed repeats would latch the
 *     category active forever). Because it re-sends rather than sending deltas,
 *     the next report of the same kind corrects whatever was lost or reordered.
 *     For the offscreen realm's only producer, `proveWithFallback`, "the same
 *     kind" is precise: it clears `prover` after every prove that succeeds on its
 *     first attempt, and marks `prover` after every DELEGATED prove that fails
 *     with a transport-shaped error — and sends nothing when a non-delegated prove
 *     throws, when a delegated failure is not transport-shaped, or on the local
 *     re-prove that rescues a delegated failure. So a dropped clear costs staleness
 *     until the next first-attempt success (`prover` has no periodic probe —
 *     {@link clearReachabilityIssues} deliberately excludes it) and a dropped mark
 *     until the next delegated network failure.
 *   - The RECEIVING half of that contract is {@link applyConnectivityReport}: a
 *     re-send only repairs anything if the owning realm writes it through. Do not
 *     apply reports via the de-duplicating mutators below — see that function.
 *   - Nothing downstream makes a correctness decision on it. The snapshot's only
 *     consumer is the connectivity banner (`use-connectivity-state`), so a stale
 *     category is a cosmetic error for one prove, never a funds-path one.
 *
 * Pass `null` to restore the local-writer behaviour (tests).
 */
export function setConnectivityReporter(fn: ConnectivityReporter | null): void {
  reporter = fn;
}

/**
 * Invoke the installed reporter, swallowing anything it throws. Mirrors the
 * try/catch `notify()` puts around subscribers, and for a sharper reason: these
 * mutators run on the prove path (`proveWithFallback` marks/clears `prover`
 * around every prove), where a throw would be misread as a prove failure.
 */
function report(fn: ConnectivityReporter, category: ConnectivityCategory, active: boolean): void {
  try {
    fn(category, active);
  } catch (err) {
    console.warn('[connectivity-state] reporter threw:', err);
  }
}

function snapshot(): ConnectivityStateSnapshot {
  // Defensive copy so callers (subscribers, persistence layer) cannot mutate
  // module state by accident.
  return {
    network: { ...current.network },
    node: { ...current.node },
    prover: { ...current.prover },
    resolving: { ...current.resolving }
  };
}

function notify(): void {
  const snap = snapshot();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch (err) {
      console.warn('[connectivity-state] subscriber threw:', err);
    }
  }
  // A REPORTING realm must never write the shared key, by ANY path. Gating the
  // mirror HERE rather than in each mutator is what makes that true for every present
  // and future one, by construction rather than by remembering to add a branch. The
  // one mutator that has no reporter branch today is {@link resetConnectivityState}
  // (a local reset has nothing meaningful to forward) — test-only now, but without
  // this gate it would blind-write an all-clear snapshot over the owning realm's live
  // categories: exactly the whole-snapshot clobber the split exists to eliminate.
  // Subscribers above still fire, because they are this realm's own consumers.
  if (reporter) return;
  // Mirror to storage so cross-context consumers (popup reading SW state) see
  // the change. We deliberately fire-and-forget — listeners get the snapshot
  // synchronously above, and the storage write is best-effort UI plumbing.
  void putToStorage(CONNECTIVITY_STATE_KEY, snap).catch(err => {
    console.warn('[connectivity-state] storage mirror failed:', err);
  });
}

/** Read the current snapshot. Cheap; no I/O.
 *
 * Reads THIS realm's copy, which neither the mark/clear mutators nor
 * {@link applyConnectivityReport} write in a reporting realm, so it stays empty — the
 * authoritative snapshot lives in the realm that owns it (see
 * {@link setConnectivityReporter}). No consumer reads it from a reporting realm: the
 * only reader is the banner hook, which runs in the React app. */
export function getConnectivityState(): ConnectivityStateSnapshot {
  return snapshot();
}

/** Subscribe to state changes. Returns an unsubscribe fn. Same realm caveat as
 * {@link getConnectivityState}: in a reporting realm the mark/clear mutators
 * forward instead of transitioning local state, so the ordinary traffic that drives
 * this in an owning realm produces no notification there. */
export function subscribeConnectivityState(fn: (snapshot: ConnectivityStateSnapshot) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Mark a category as active. No-op if it was already active (avoids
 * resetting `since` on every retry storm).
 *
 * In a reporting realm the observation is forwarded UNCONDITIONALLY and the
 * "already active" short-circuit does not run — the owning realm applies it and
 * keeps the `since` stamp stable there. See {@link setConnectivityReporter}.
 */
export function markConnectivityIssue(category: ConnectivityCategory): void {
  if (reporter) {
    report(reporter, category, true);
    return;
  }
  observed.add(category);
  const existing = current[category];
  if (existing.active) return;
  current = { ...current, [category]: { active: true, since: Date.now() } };
  notify();
}

/** Clear a single category. No-op if already clear (forwarded unconditionally
 * in a reporting realm, exactly as {@link markConnectivityIssue} is). */
export function clearConnectivityIssue(category: ConnectivityCategory): void {
  if (reporter) {
    report(reporter, category, false);
    return;
  }
  observed.add(category);
  const existing = current[category];
  if (!existing.active) return;
  current = { ...current, [category]: { active: false, since: null } };
  notify();
}

/**
 * Convenience: clear `network`, `node`, AND `resolving` in one shot. Called
 * from sync-success paths where a successful sync proves the user can reach
 * the node (which by extension proves the network is fine, and any in-flight
 * recovery is now resolved).
 *
 * Does NOT touch `prover` — the prover is a separate service with separate
 * health, and a sync success says nothing about prover availability.
 */
export function clearReachabilityIssues(): void {
  if (reporter) {
    // One report per category, same as three individual clears — the owning
    // realm is the only place the three-at-once shape needs to exist.
    for (const cat of REACHABILITY_CATEGORIES) report(reporter, cat, false);
    return;
  }
  let changed = false;
  const next = { ...current };
  for (const cat of REACHABILITY_CATEGORIES) {
    observed.add(cat);
    if (next[cat].active) {
      next[cat] = { active: false, since: null };
      changed = true;
    }
  }
  if (changed) {
    current = next;
    notify();
  }
}

/**
 * Apply ONE category's state as REPORTED by another realm (see
 * {@link setConnectivityReporter}). The owning realm's entry point for the
 * cross-realm channel; `lib/miden/back/main.ts`'s reverse-IPC listener is the only
 * caller today.
 *
 * Unlike {@link markConnectivityIssue} / {@link clearConnectivityIssue} this NEVER
 * short-circuits on "already active / already clear": it always writes the category
 * and always notifies, so every report re-mirrors the snapshot to the shared key.
 *
 * That unconditional write is what makes the reporter's drop-safety contract real
 * rather than aspirational. The reporting realm re-sends its current value on every
 * prove, but `current` here is per-realm memory an MV3 service-worker eviction
 * resets, while the mirror the banner actually reads is durable.
 * {@link hydrateConnectivityState} normally reconciles the two at `start()`, but that
 * read is asynchronous and best-effort — a report arriving before it lands (or after
 * it failed, or written by a build that predates it) still meets a `current` that
 * disagrees with the mirror. A de-duplicating apply would then see "already clear",
 * skip `notify()`, and latch the stale mirrored value with no in-app recovery (the
 * banner's Retry runs a sync, whose success path deliberately does not touch
 * `prover`). Writing through costs one extra storage write per prove, which is
 * seconds apart.
 *
 * NOTE — one behaviour this reaches that the pre-split code could not: `prover` has
 * an SW-side producer too (the guardian requeue in `transaction/index.ts`), and the
 * offscreen realm reports `prover: false` after EVERY prove it completes, including a
 * purely local one. So a routine non-guardian send now clears a `prover` banner the
 * guardian requeue raised while that requeue is still waiting on the remote prover.
 * That is `clearConnectivityIssue`'s own stated semantics ("a successful prover call,
 * whether local or remote, means the pathway is healthy") and it is what already
 * happened flag-OFF, where both producers shared one realm — but on the flag-on
 * extension it is new, because before the split the offscreen realm's clear
 * short-circuited against its own empty `current` and never reached the SW at all.
 *
 * `since` survives a repeated `active: true` so the banner's dismissal key — which
 * IS the activation timestamp (`use-connectivity-state`) — stays stable for as long
 * as the issue does.
 *
 * No-op in a reporting realm, like {@link hydrateConnectivityState} and for the same
 * reason: only the realm that owns the snapshot has anywhere to put a report.
 */
export function applyConnectivityReport(category: ConnectivityCategory, active: boolean): void {
  // A realm that does not own the snapshot has no report to apply: it would write a
  // `current` that nothing in that realm reads, contradicting the "a reporting realm
  // keeps no local state" invariant the rest of this module relies on. Unreachable
  // today (the only caller is the SW's reverse-IPC listener), but this is the same
  // by-construction guard `notify()` puts on the storage half, for the state half.
  if (reporter) return;
  observed.add(category);
  const existing = current[category];
  const next: CategoryState = active
    ? { active: true, since: existing.active ? existing.since : Date.now() }
    : { active: false, since: null };
  current = { ...current, [category]: next };
  notify();
}

/**
 * Runtime shape check for one category read back from the mirror. The stored value
 * is untyped input as far as the compiler is concerned — an older build, a
 * hand-edited profile, or something else entirely under this key — and hydrating a
 * malformed entry would put a value the banner has to render into `current` and then
 * write it straight back out.
 */
function isCategoryState(value: unknown): value is CategoryState {
  if (typeof value !== 'object' || value === null) return false;
  if (!('active' in value) || !('since' in value)) return false;
  const { active, since } = value;
  return typeof active === 'boolean' && (since === null || typeof since === 'number');
}

/** Every category must be present and well-formed — a partial snapshot would leave
 * `current` half-hydrated. Spelled out per category rather than looped, matching
 * {@link emptySnapshot} / {@link snapshot}, so the compiler still checks the set. */
function isConnectivitySnapshot(value: unknown): value is ConnectivityStateSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  if (!('network' in value) || !('node' in value) || !('prover' in value) || !('resolving' in value)) return false;
  return (
    isCategoryState(value.network) &&
    isCategoryState(value.node) &&
    isCategoryState(value.prover) &&
    isCategoryState(value.resolving)
  );
}

/**
 * Seed `current` from the durable storage mirror. Called once per service-worker
 * start (`lib/miden/back/main.ts`); best-effort and never throws.
 *
 * `current` is per-realm memory that an MV3 eviction resets, but the mirror survives
 * and the popup renders it in preference (`use-connectivity-state`). Left
 * unreconciled the two disagree, and the "already clear" short-circuit in
 * {@link clearConnectivityIssue} / {@link clearReachabilityIssues} then swallows the
 * clear that would repair the mirror — the banner keeps showing an issue that has
 * already recovered. Hydrating makes those clears transition again, so the ordinary
 * recovery paths do the repairing. See the DURABILITY note in the header for why
 * this is the right direction, versus blanking the mirror.
 *
 * A category THIS realm has already observed always wins: the read is asynchronous,
 * so a mark or clear can land while it is in flight, and a fresh observation must
 * never be overwritten by a pre-restart mirrored one. When that happens the mirror is
 * rewritten from `current` instead — the observation may well have short-circuited
 * ("already clear") and so never mirrored itself, which is the same latch this whole
 * function exists to prevent, just inside a one-microtask window.
 *
 * No-op in a reporting realm — it does not own the snapshot and never writes the key
 * it would be reading (see {@link setConnectivityReporter}).
 */
export async function hydrateConnectivityState(): Promise<void> {
  if (reporter) return;
  try {
    const stored = await fetchFromStorage<unknown>(CONNECTIVITY_STATE_KEY);
    if (!isConnectivitySnapshot(stored)) return;
    // `changed`: the mirror taught us something. `mirrorIsStale`: we know better than
    // the mirror for a category observed while the read was in flight, so it needs
    // rewriting from `current`.
    let changed = false;
    let mirrorIsStale = false;
    const next = { ...current };
    for (const cat of ALL_CATEGORIES) {
      const mirrored = stored[cat];
      if (next[cat].active === mirrored.active && next[cat].since === mirrored.since) continue;
      if (observed.has(cat)) {
        mirrorIsStale = true;
        continue;
      }
      next[cat] = { active: mirrored.active, since: mirrored.since };
      changed = true;
    }
    if (changed) current = next;
    // One notify path for both cases: it publishes to this realm's subscribers (on
    // mobile/desktop the banner subscribes in-process) and re-mirrors. Costs at most
    // one storage write per service-worker start, and none when the two already agree.
    if (changed || mirrorIsStale) notify();
  } catch (err) {
    // A banner that starts empty is strictly better than a failed start().
    console.warn('[connectivity-state] hydrate failed:', err);
  }
}

/**
 * Reset everything to the empty snapshot and notify. Test-only — no production
 * caller. (The service worker reconciles with {@link hydrateConnectivityState} at
 * `start()` instead; blanking the mirror there would make a genuine outage's banner
 * disappear on every MV3 wake.)
 *
 * Deliberately LOCAL-ONLY, with no reporter forward: a reporting realm has no
 * meaningful state to reset, since the mark/clear mutators never write its `current`
 * in the first place — forwarding four clears from it would instead reach across and wipe
 * ANOTHER realm's snapshot, which is the opposite of what a local reset means. In
 * such a realm `notify()` also skips the storage mirror, so this cannot reach the
 * shared key by that path either.
 */
export function resetConnectivityState(): void {
  // Always replace the snapshot reference so subscribers see a fresh object,
  // and trigger a notify so consumers re-render even from a clean baseline
  // (matters in tests that subscribe before any state change).
  current = emptySnapshot();
  observed.clear();
  notify();
}

// Surface the category list for consumers (UI iteration order, tests).
export const CONNECTIVITY_CATEGORIES = ALL_CATEGORIES;
