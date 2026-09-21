import { useSyncExternalStore } from 'react';

import { ACTIVITY_READ_MAX_IDS, ACTIVITY_READ_STORAGE_KEY } from './constants';

/**
 * Which activity the user has already looked at, per device.
 *
 * The same shape as `activity-view.ts`: plain text in `localStorage` under its own key, read
 * through a `useSyncExternalStore` hook so every mounted Activity surface — the tab icon, the
 * grouped rows, the feed — re-renders the moment something is marked read. Deliberately NOT part
 * of the vault-backed `WalletSettings`: "have I read this" is a fact about this installation, not
 * about the account, and it must never sync.
 *
 * ## What "read" means
 *
 * Two pieces of state, and an id is read if EITHER says so:
 *
 * - `seenBefore` — a high-water mark in unix seconds. Everything that happened at or before it is
 *   read. On first run it is set to now, which is what stops an existing wallet's whole history
 *   from arriving as a wall of dots.
 * - `ids` — the individual things read since. Only ids NEWER than the mark need to be here, so
 *   the set is pruned against the mark on every write.
 *
 * ## Why it cannot grow without bound
 *
 * A set of read ids grows with every tap, so it needs a ceiling, and the only honest way to
 * collapse individual facts is to turn the oldest of them back into the mark. Past
 * `ACTIVITY_READ_MAX_IDS`, `seenBefore` is advanced to the OLDEST remaining read id's timestamp
 * and everything at or below it is dropped — which says "you have read something older than this,
 * so take everything older as read". That is an inference, not a record, and it is the same one
 * an inbox's "mark everything below as read" makes. What it can cost is a dot on an item older
 * than a hundred things the user has already opened; what it buys is a stored value of a few kB
 * that cannot creep.
 */

export interface ActivityReadState {
  /** Unix seconds. Everything at or before this is read. */
  seenBefore: number;
  /** Ids read individually since the mark, with the timestamp each was read AT. */
  ids: Readonly<Record<string, number>>;
}

interface StoredShape {
  seenBefore: unknown;
  ids: unknown;
}

type Listener = () => void;
const listeners = new Set<Listener>();

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The live value. Cached because `useSyncExternalStore` compares the snapshot by identity and
 * would loop forever on a getter that parses fresh JSON into a new object every call.
 */
let cached: ActivityReadState | undefined;

function parse(raw: string | null): ActivityReadState | undefined {
  if (!raw) return undefined;
  try {
    const parsed: StoredShape = JSON.parse(raw);
    if (typeof parsed?.seenBefore !== 'number' || !Number.isFinite(parsed.seenBefore)) return undefined;
    const ids: Record<string, number> = {};
    if (parsed.ids && typeof parsed.ids === 'object') {
      for (const [id, at] of Object.entries(parsed.ids as Record<string, unknown>)) {
        if (typeof at === 'number' && Number.isFinite(at)) ids[id] = at;
      }
    }
    return { seenBefore: parsed.seenBefore, ids };
  } catch {
    return undefined;
  }
}

function persist(state: ActivityReadState) {
  cached = state;
  try {
    localStorage.setItem(ACTIVITY_READ_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

/**
 * The read state, seeding it on first run.
 *
 * Seeding WRITES, and it has to: if the seed stayed in memory, a reload before the first tap
 * would seed again at a later `now` and silently mark as read everything that arrived in between
 * — which is the one failure this whole mechanism cannot have.
 */
export function getActivityReadState(): ActivityReadState {
  if (cached) return cached;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(ACTIVITY_READ_STORAGE_KEY);
  } catch {}
  const parsed = parse(stored);
  if (parsed) {
    cached = parsed;
    return parsed;
  }
  const seeded: ActivityReadState = { seenBefore: nowSeconds(), ids: {} };
  persist(seeded);
  return seeded;
}

/** Whether one activity has been read. `timestamp` is the same unix-seconds stamp its row shows. */
export function isActivityRead(state: ActivityReadState, id: string, timestamp: number): boolean {
  // A row whose timestamp is unusable (`NaN`, `-Infinity`) has no place on the timeline and
  // cannot be compared against the mark; only an explicit read counts for it.
  if (Number.isFinite(timestamp) && timestamp <= state.seenBefore) return true;
  return id in state.ids;
}

/** Marks one activity read. `timestamp` is its own, not the current time. */
export function markActivityRead(id: string, timestamp: number): void {
  const current = getActivityReadState();
  if (isActivityRead(current, id, timestamp)) return;
  // Only entries strictly ABOVE the mark survive compaction, so a row with no usable timestamp
  // (an incoming transfer that never carried a `receivedAt`) is recorded just past it rather than
  // at a `now` the mark may already have reached — otherwise the read would be dropped on write.
  const at = Number.isFinite(timestamp) ? timestamp : Math.max(nowSeconds(), current.seenBefore + 1);
  persist(compact({ seenBefore: current.seenBefore, ids: { ...current.ids, [id]: at } }));
  listeners.forEach(listener => listener());
}

/**
 * Drops ids the mark already covers, then — while there are still too many — advances the mark
 * over the oldest of them. See the module comment for why that is a sound trade.
 */
function compact(state: ActivityReadState): ActivityReadState {
  let seenBefore = state.seenBefore;
  // Oldest first, so the set is trimmed from the front and the mark walks up with it.
  const entries = Object.entries(state.ids)
    .filter(([, at]) => at > seenBefore)
    .sort((a, b) => a[1] - b[1]);
  while (entries.length > ACTIVITY_READ_MAX_IDS) {
    seenBefore = entries.shift()![1];
    // Anything sharing that second is under the mark now too, so it no longer needs its own row.
    while (entries.length > 0 && entries[0]![1] <= seenBefore) entries.shift();
  }
  return { seenBefore, ids: Object.fromEntries(entries) };
}

/** Test seam: forgets the stored state and the in-memory cache. */
export function resetActivityReadState(): void {
  cached = undefined;
  try {
    localStorage.removeItem(ACTIVITY_READ_STORAGE_KEY);
  } catch {}
  listeners.forEach(listener => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read state — re-renders every Activity surface when something is marked read. */
export function useActivityReadState(): ActivityReadState {
  return useSyncExternalStore(subscribe, getActivityReadState);
}
