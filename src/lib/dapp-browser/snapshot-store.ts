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

import { InAppBrowser } from '@capgo/inappbrowser';

const snapshots = new Map<string, string>();
const listeners = new Set<() => void>();

/** Take a snapshot via the patched plugin method and store it. */
export async function captureSnapshot(sessionId: string, scale = 0.5, quality = 0.7): Promise<string | null> {
  try {
    // The native method was added by patches/@capgo+inappbrowser+8.0.6.patch.
    // It's not in the upstream .d.ts, so we cast to call it.
    const result = await (
      InAppBrowser as unknown as {
        snapshot: (opts: { scale: number; quality: number }) => Promise<{ data: string }>;
      }
    ).snapshot({ scale, quality });
    if (result?.data) {
      snapshots.set(sessionId, result.data);
      notify();
      return result.data;
    }
    return null;
  } catch (err) {
    console.warn('[snapshot-store] capture failed:', err);
    return null;
  }
}

export function getSnapshot(sessionId: string): string | undefined {
  return snapshots.get(sessionId);
}

export function clearSnapshot(sessionId: string): void {
  if (snapshots.delete(sessionId)) {
    notify();
  }
}

export function clearAllSnapshots(): void {
  if (snapshots.size > 0) {
    snapshots.clear();
    notify();
  }
}

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
