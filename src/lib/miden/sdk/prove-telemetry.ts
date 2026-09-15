// `offscreen-realm`, NOT `offscreen-prover` (which re-exports this): the prover
// module is the chrome.offscreen lifecycle surface that several suites replace with
// a partial `jest.mock` factory, and importing from there would resolve this to
// `undefined` in those registries — where the call throws into `recordProveTelemetry`'s
// best-effort catch and silently records NOTHING. See `offscreen-realm.ts`.
import { OFFSCREEN_PROVE_MARKER, SW_TARGET, type OffscreenProveMarkerEvent } from 'lib/miden/back/offscreen-codec';
import { isInOffscreenDocument } from 'lib/miden/back/offscreen-realm';
import { isMobile } from 'lib/platform';

/**
 * Always-on, lightweight prove-timing telemetry (#466).
 *
 * `recordProveTiming` (miden-client-interface.ts) is E2E-only string logging.
 * This records STRUCTURED per-prove metrics in a small bounded ring (+ a
 * best-effort `chrome.storage.local` copy so a service-worker restart doesn't
 * lose it) so we can see WHY proving occasionally exceeds 20s: which path ran
 * (delegate / local / native), how long it took, and — the prime suspect —
 * whether the delegated remote prover (which has no client-side timeout) stalled
 * and fell back to local, doubling the wall time. A slow prove is also logged so
 * it shows up in ordinary logs without querying the ring.
 *
 * MULTI-REALM (issue #260). The ring is module-scoped, i.e. PER REALM, while the
 * storage copy is ONE shared key, so a whole-ring write erases everything under
 * that key the writing realm's own ring does not contain. Which realm proves is
 * a routing decision: flag-on (`MIDEN_USE_OFFSCREEN_CLIENT`, the service worker's
 * default) the four recording methods are dispatched whole-op into the offscreen
 * document and record THERE, while flag-off — or on a browser with no
 * `chrome.offscreen` — the same methods run inline in the service worker and
 * record there. The key outlives both the realm and the routing (it survives an
 * extension update), so a blind write throws away the history across every such
 * change, and would erase the other realm's samples outright if any prove is ever
 * added back on the service-worker side. `persist()` MERGES instead (read → union
 * → newest `RING_CAPACITY`) and each entry carries the realm that recorded it, so
 * the record is additive whichever realm is writing. See `writeMergedRing` for
 * the race behaviour.
 *
 * Telemetry must never affect proving: everything here is wrapped/best-effort.
 */

export const SLOW_PROVE_THRESHOLD_MS = 20_000;
const RING_CAPACITY = 50;
const STORAGE_KEY = 'miden_prove_telemetry';

/**
 * Which JS realm recorded an entry.
 *
 *   - `offscreen` — the extension's offscreen document, where flag-on
 *     (`MIDEN_USE_OFFSCREEN_CLIENT`) every non-guardian write's prove runs on the
 *     pooled multi-threaded WASM.
 *   - `inline` — every other realm: the service worker, and the app process on
 *     mobile/desktop (which have no offscreen document at all). `platform` already
 *     separates those two.
 */
export type ProveTelemetryRealm = 'offscreen' | 'inline';

export interface ProveTelemetryEntry {
  /** epoch ms when the prove completed */
  ts: number;
  /** which prover pathway actually produced the proof */
  path: 'delegate' | 'local' | 'native-mobile';
  /** total wall time the user waited for proving (ms, incl. a fallback) */
  durationMs: number;
  /** true when a delegated remote prove failed and we re-proved locally */
  fellBack: boolean;
  /** how long the remote attempt took before it failed (only when fellBack) */
  remoteDurationMs?: number;
  platform: 'mobile' | 'desktop';
  /** MT-WASM needs this; false on a non-isolated context forces slow ST WASM */
  crossOriginIsolated: boolean;
  /** durationMs exceeded SLOW_PROVE_THRESHOLD_MS — the #466 symptom */
  slow: boolean;
  /** the prove ultimately failed (e.g. remote stalled AND the local re-prove threw) */
  failed?: boolean;
  /**
   * Which realm recorded this — the whole point of the merged ring, since the
   * question "did this prove run offscreen?" is what explains its duration.
   * Always set by {@link recordProveTelemetry}; optional only because the shared
   * storage key survives an extension update, so a ring persisted by a build from
   * before this field existed can still be read back and merged.
   */
  realm?: ProveTelemetryRealm;
}

const ring: ProveTelemetryEntry[] = [];

/**
 * E2E-only breadcrumb trail of the `[prove-timing]` markers (#718).
 *
 * {@link recordProveTelemetry} above records a prove once it SETTLES, which is
 * exactly the wrong shape for diagnosing a write that never returns: the hang
 * leaves no entry at all. These markers are the complement — each one is written
 * as it happens, so the LAST marker names the call the realm is still inside.
 *
 * Per-realm key, unlike the merged telemetry ring. Nothing here needs the
 * cross-realm union (each realm's trail is read separately and is only meaningful
 * in its own order), and avoiding the read-merge-write cycle means a marker is a
 * single `set` dispatched synchronously on the spot — before the caller enters
 * the blocking WASM call the marker is announcing. A queued write would sit in a
 * microtask that a synchronous call never yields to, losing precisely the marker
 * that matters.
 */
const MARKER_CAPACITY = 200;
const markers: string[] = [];

/** Storage key holding one realm's marker trail. */
export function proveMarkerStorageKey(realm: ProveTelemetryRealm): string {
  return `miden_prove_markers_${realm}`;
}

/**
 * Append one `[prove-timing]` marker to this realm's trail.
 *
 * Called only from the E2E-gated `recordProveTiming`, so this is inert in
 * production builds. Never throws — instrumentation must not be able to fail a
 * prove.
 */
export function recordProveMarker(line: string): void {
  try {
    const ts = Date.now();
    markers.push(`${ts}|${line}`);
    while (markers.length > MARKER_CAPACITY) markers.shift();

    // The offscreen document has no `chrome.storage` of its own — the profile of a
    // failed run shows only SW-written keys — so it REPORTS to the single writer
    // exactly as connectivity does (#260), and the SW appends to the key below.
    if (isInOffscreenDocument()) {
      const event: OffscreenProveMarkerEvent = { target: SW_TARGET, type: OFFSCREEN_PROVE_MARKER, ts, line };
      // Two-layer swallow, matching `postConnectivityEvent`: the inner one absorbs a
      // rejection (no SW receiver), the outer a synchronous throw (torn-down port).
      // Both matter because this sits on the prove path, where a throw would be read
      // as a prove failure.
      void Promise.resolve(chrome.runtime.sendMessage(event)).catch(() => {});
      return;
    }

    const storage = telemetryStorage();
    if (!storage?.set) return;
    // `Promise.resolve` normalises the callback-style `set` some runtimes still
    // return `undefined` from, so the rejection handler always attaches.
    void Promise.resolve(storage.set({ [proveMarkerStorageKey('inline')]: [...markers] })).catch(() => {});
  } catch {
    // best-effort — see the class doc.
  }
}

/** Test-only: this realm's marker trail. */
export function __getProveMarkersForTest(): string[] {
  return [...markers];
}

/** Test-only: clear the marker trail. */
export function __resetProveMarkersForTest(): void {
  markers.length = 0;
}

export interface ProveSample {
  path: ProveTelemetryEntry['path'];
  durationMs: number;
  fellBack: boolean;
  remoteDurationMs?: number;
  failed?: boolean;
}

/**
 * Record one prove's timing. Never throws and never affects the prove — the
 * whole body is wrapped, since it runs on the hot proving path (a stray throw
 * here would otherwise be misread by `proveWithFallback`'s try/catch as a prove
 * failure). Returns the stored entry, or undefined if recording was skipped.
 */
export function recordProveTelemetry(sample: ProveSample): ProveTelemetryEntry | undefined {
  try {
    const entry: ProveTelemetryEntry = {
      ts: Date.now(),
      path: sample.path,
      durationMs: Math.round(sample.durationMs),
      fellBack: sample.fellBack,
      ...(sample.remoteDurationMs !== undefined ? { remoteDurationMs: Math.round(sample.remoteDurationMs) } : {}),
      ...(sample.failed ? { failed: true } : {}),
      platform: isMobile() ? 'mobile' : 'desktop',
      crossOriginIsolated:
        typeof globalThis !== 'undefined' && !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
      slow: sample.durationMs > SLOW_PROVE_THRESHOLD_MS,
      realm: isInOffscreenDocument() ? 'offscreen' : 'inline'
    };

    ring.push(entry);
    while (ring.length > RING_CAPACITY) ring.shift();

    if (entry.slow) {
      console.warn(
        `[prove-telemetry] slow prove ${entry.durationMs}ms path=${entry.path} fellBack=${entry.fellBack}` +
          (entry.remoteDurationMs !== undefined ? ` remoteMs=${entry.remoteDurationMs}` : '') +
          (entry.failed ? ' FAILED' : '') +
          ` (>${SLOW_PROVE_THRESHOLD_MS}ms — #466)`
      );
    }

    void persist();
    return entry;
  } catch {
    // Telemetry must NEVER break or slow a prove.
    return undefined;
  }
}

/** A snapshot of the in-memory ring (newest last). */
export function getProveTelemetry(): ProveTelemetryEntry[] {
  return [...ring];
}

/** Test-only: clear the ring. */
export function __resetProveTelemetryForTest(): void {
  ring.length = 0;
}

/** Test-only: resolve once every `persist()` queued so far has finished writing. */
export function __flushProveTelemetryForTest(): Promise<void> {
  return persistQueue;
}

/** The slice of `chrome.storage.local` this module uses. Both members are optional
 * because this module runs in non-extension realms too (mobile/desktop, jsdom),
 * where `chrome` is absent entirely and persistence is simply skipped. */
type TelemetryStorageArea = {
  get?: (keys: string) => Promise<Record<string, unknown>>;
  set?: (items: Record<string, unknown>) => Promise<void>;
};

function telemetryStorage(): TelemetryStorageArea | undefined {
  return (globalThis as { chrome?: { storage?: { local?: TelemetryStorageArea } } }).chrome?.storage?.local;
}

/**
 * Runtime shape check for one entry read back from storage.
 *
 * Needed because the stored value is untyped input as far as the compiler is
 * concerned — it may have been written by an older build, hand-edited, or simply
 * be something else under this key — and a malformed entry that survived into the
 * merged ring would be written straight back out again, corrupting the record
 * permanently rather than for one read.
 */
function isProveTelemetryEntry(value: unknown): value is ProveTelemetryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<Record<keyof ProveTelemetryEntry, unknown>>;
  return (
    typeof e.ts === 'number' &&
    (e.path === 'delegate' || e.path === 'local' || e.path === 'native-mobile') &&
    typeof e.durationMs === 'number' &&
    typeof e.fellBack === 'boolean' &&
    (e.remoteDurationMs === undefined || typeof e.remoteDurationMs === 'number') &&
    (e.platform === 'mobile' || e.platform === 'desktop') &&
    typeof e.crossOriginIsolated === 'boolean' &&
    typeof e.slow === 'boolean' &&
    (e.failed === undefined || typeof e.failed === 'boolean') &&
    // Absent on a ring persisted before the field existed — see the field's doc.
    (e.realm === undefined || e.realm === 'offscreen' || e.realm === 'inline')
  );
}

/**
 * Identity of one recorded prove, for de-duplication across a read-merge-write
 * cycle: this realm's own entries are read back from storage on every persist and
 * must collapse onto themselves rather than accumulate.
 *
 * `ts` alone would be enough to collide two realms' distinct proves on the same
 * millisecond, so the key also carries the recording realm and the fields that
 * describe the prove. Within one realm the WASM mutex serializes proving, and a
 * prove takes seconds, so a same-millisecond duplicate of all of these is a
 * repeat of the SAME entry — which is exactly what should collapse.
 */
function entryKey(e: ProveTelemetryEntry): string {
  return [e.ts, e.realm ?? '?', e.path, e.durationMs, e.fellBack ? 1 : 0, e.failed ? 1 : 0].join('|');
}

/** Union of the stored entries and this realm's ring: de-duplicated, ordered
 * oldest-first, and truncated to the newest {@link RING_CAPACITY}.
 *
 * The sort is load-bearing, not cosmetic: `slice` keeps the TAIL, which is the
 * newest {@link RING_CAPACITY} only once the union is in timestamp order. The
 * concatenation is not — the stored entries can be newer than this realm's ring
 * (the service worker records one guardian-requeue prove while the offscreen realm
 * has a full ring of fresher samples under the key), in which case an unsorted
 * truncation would evict the newest foreign entries and keep the stale local ones. */
function mergeEntries(stored: ProveTelemetryEntry[], local: ProveTelemetryEntry[]): ProveTelemetryEntry[] {
  const byKey = new Map<string, ProveTelemetryEntry>();
  for (const entry of [...stored, ...local]) byKey.set(entryKey(entry), entry);
  return [...byKey.values()].sort((a, b) => a.ts - b.ts).slice(-RING_CAPACITY);
}

/**
 * Serializes this realm's persists so a burst can't have two read-merge-write
 * cycles interleave and drop each other's additions. Only ever holds a resolved
 * or resolving promise: `persist` chains through `.catch(() => {})`, and
 * `writeMergedRing` swallows its own errors anyway.
 */
let persistQueue: Promise<void> = Promise.resolve();

/**
 * Merge this realm's ring into the shared storage key.
 *
 * CROSS-REALM RACE: two realms can read-merge-write concurrently, and the later
 * `set` then wins with a snapshot that predates the other's addition. Nothing
 * short of a lock we don't have could prevent that, and it is bounded and
 * self-healing rather than lossy: the loser's entries are still in ITS ring, so
 * its next persist re-adds them (the dedupe makes the re-add idempotent). Only an
 * entry evicted from its own realm's ring — i.e. RING_CAPACITY proves later —
 * before ever winning a write is lost for good. Compare the previous behaviour,
 * where every persist unconditionally dropped everything under the key that this
 * realm's ring did not already hold.
 */
async function writeMergedRing(): Promise<void> {
  try {
    const storage = telemetryStorage();
    if (!storage?.set) return;
    // The READ has its own catch, deliberately: a storage area without `get`, or one
    // whose `get` rejects (`chrome.storage.local` rejects with "Extension context
    // invalidated." once the extension has been updated or reloaded under a realm
    // that is still running, and can fail on an IO error), degrades to writing just
    // this realm's ring — exactly the pre-merge behaviour. Sharing the outer catch
    // would skip the `set` as well, leaving the ring memory-only for as long as the
    // reads keep failing: strictly worse than the unconditional write this replaced,
    // and worst on a realm that may not survive to retry.
    let stored: ProveTelemetryEntry[] = [];
    if (storage.get) {
      try {
        const raw = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY];
        if (Array.isArray(raw)) stored = raw.filter(isProveTelemetryEntry);
      } catch {
        // A failed read degrades to a ring-only write, never to no write at all.
      }
    }
    await storage.set({ [STORAGE_KEY]: mergeEntries(stored, ring) });
  } catch {
    // best-effort — telemetry must never break or slow a prove.
  }
}

function persist(): Promise<void> {
  const next = persistQueue.then(writeMergedRing);
  persistQueue = next.catch(() => {});
  return next;
}
