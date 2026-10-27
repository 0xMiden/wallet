/**
 * In-memory snapshot store for parked dApps.
 *
 * PR-3 takes a snapshot via the patched `@capgo/inappbrowser` plugin's
 * `snapshot` plugin method (added in PR-1 part 2's `patches/`) right
 * before parking a session. The data URL gets stored here keyed by
 * sessionId so the bubble (and PR-5's card switcher) can render the
 * frozen preview.
 *
 * The store is intentionally in-memory only — PR-6 adds the disk
 * persistence layer for cold-bubble restore after app restart.
 */

import { InAppBrowser } from '@miden/dapp-browser';

const SNAPSHOT_MAX_BYTES = 524_288;
const SNAPSHOT_MAX_ENTRIES = 8;
const SNAPSHOTS_MAX_BYTES = 4_194_304;
const snapshots = new Map<string, string>();
const encoder = new TextEncoder();

function retainSnapshot(sessionId: string, dataUrl: string): boolean {
  if (encoder.encode(dataUrl).byteLength > SNAPSHOT_MAX_BYTES) return false;
  snapshots.delete(sessionId);
  snapshots.set(sessionId, dataUrl);
  const retainedBytes = () => encoder.encode(JSON.stringify(Object.fromEntries(snapshots))).byteLength;
  while (snapshots.size > SNAPSHOT_MAX_ENTRIES || retainedBytes() > SNAPSHOTS_MAX_BYTES) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  return snapshots.has(sessionId);
}
const pendingCaptures = new Map<string, Set<symbol>>();
const listeners = new Set<() => void>();

/** Take a snapshot via the patched plugin method and store it.
 *
 * PR-6: the native `snapshot` call is now id-aware (PR-4 chunk 4), so
 * this forwards the sessionId as the native instance id. Without this
 * fix the call would always target the legacy "default" slot, which
 * would either return an empty snapshot or the wrong dApp's image
 * when multiple instances are open.
 */
export async function captureSnapshot(sessionId: string, scale = 0.5, quality = 0.7): Promise<string | null> {
  const captures = pendingCaptures.get(sessionId) ?? new Set<symbol>();
  const token = Symbol();
  captures.add(token);
  pendingCaptures.set(sessionId, captures);
  try {
    const result = await InAppBrowser.snapshot({ id: sessionId, scale, quality });
    if (!captures.has(token)) return null;
    if (result?.data && retainSnapshot(sessionId, result.data)) {
      notify();
      return result.data;
    }
    return null;
  } catch (err) {
    console.warn('[snapshot-store] capture failed:', err);
    return null;
  } finally {
    captures.delete(token);
    if (captures.size === 0 && pendingCaptures.get(sessionId) === captures) pendingCaptures.delete(sessionId);
  }
}

export function getSnapshot(sessionId: string): string | undefined {
  return snapshots.get(sessionId);
}

export function clearSnapshot(sessionId: string): void {
  // Invalidate captures already awaiting native output, including an otherwise empty cache.
  pendingCaptures.get(sessionId)?.clear();
  pendingCaptures.delete(sessionId);
  if (snapshots.delete(sessionId)) {
    notify();
  }
}

export function clearAllSnapshots(): void {
  pendingCaptures.forEach(captures => captures.clear());
  pendingCaptures.clear();
  if (snapshots.size > 0) {
    snapshots.clear();
    notify();
  }
}

/**
 * PR-6 cold-bubble rehydration: insert a snapshot into the in-memory
 * store without going through the native plugin. Used by the provider
 * to populate bubble previews from disk at app launch.
 */
export const snapshotStoreInternals = {
  setRaw(sessionId: string, dataUrl: string): void {
    if (retainSnapshot(sessionId, dataUrl)) notify();
  }
};

/** React-friendly subscription. */
export function subscribeSnapshots(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  listeners.forEach(l => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}
