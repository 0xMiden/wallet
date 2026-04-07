/**
 * Persistent snapshot store for parked dApps.
 *
 * PR-6: snapshots captured at park-time are written to
 * `Directory.Cache` as base64 JPEG data URLs, one file per sessionId.
 * On app restart we read them back into the in-memory
 * `snapshot-store.ts` map so bubbles render their frozen preview
 * immediately, before any native webview has been instantiated.
 *
 * Why the cache directory: iOS/Android can evict cache files under
 * memory pressure, but they're NOT backed up to iCloud/Google Drive.
 * The threat model (per plan §cross-cutting concern 12) doesn't warrant
 * encryption — a snapshot showing a wallet balance the user already
 * sees on-screen isn't sensitive enough to justify the key-management
 * complexity.
 *
 * Size: snapshots are ~20–150 KB each at scale 0.5, quality 0.7. With
 * MAX_PARKED_DAPPS = 3 that's well under a megabyte total; not worth
 * fancy indexing.
 */

import { Directory, Filesystem } from '@capacitor/filesystem';

const SNAPSHOT_DIR = 'miden-dapp-snapshots';

function pathFor(sessionId: string): string {
  // Sanitize the id — dapp-* ids only contain [A-Za-z0-9-], so this is
  // defense in depth against callers that might pass something
  // unexpected.
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${SNAPSHOT_DIR}/${safeId}.txt`;
}

async function ensureDir(): Promise<void> {
  try {
    await Filesystem.mkdir({
      path: SNAPSHOT_DIR,
      directory: Directory.Cache,
      recursive: true
    });
  } catch {
    // Already exists — safe to ignore. The subsequent read/write will
    // surface any real permission error.
  }
}

/** Write a base64 data URL snapshot to disk for a given session. */
export async function writeSnapshotToDisk(sessionId: string, dataUrl: string): Promise<void> {
  try {
    await ensureDir();
    await Filesystem.writeFile({
      path: pathFor(sessionId),
      data: dataUrl,
      directory: Directory.Cache
    });
  } catch (error) {
    console.warn('[snapshot-persistence] write failed for', sessionId, error);
  }
}

/** Read a previously-written snapshot back from disk. Returns null if missing. */
export async function readSnapshotFromDisk(sessionId: string): Promise<string | null> {
  try {
    const result = await Filesystem.readFile({
      path: pathFor(sessionId),
      directory: Directory.Cache
    });
    const data = result.data;
    if (typeof data === 'string') return data;
    // `readFile` can return a Blob on the web platform — the web
    // platform doesn't persist anything here so this branch is defensive
    // and falls back to null.
    return null;
  } catch {
    // Missing file, permission denied, or cache was evicted. Treat all
    // as "not present" and let the caller fall back to a favicon tile.
    return null;
  }
}

/** Remove a snapshot file. */
export async function removeSnapshotFromDisk(sessionId: string): Promise<void> {
  try {
    await Filesystem.deleteFile({
      path: pathFor(sessionId),
      directory: Directory.Cache
    });
  } catch {
    // Missing file is fine.
  }
}

/** Remove every persisted snapshot. Called on wallet reset. */
export async function clearAllSnapshotsFromDisk(): Promise<void> {
  try {
    await Filesystem.rmdir({
      path: SNAPSHOT_DIR,
      directory: Directory.Cache,
      recursive: true
    });
  } catch {
    // Nothing to clean up.
  }
}
