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

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

const SNAPSHOT_DIR = 'miden-dapp-snapshots';
export const SNAPSHOT_MAX_BYTES = 524_288;
export const SNAPSHOT_MAX_FILES = 8;
export const SNAPSHOTS_MAX_BYTES = 4_194_304;
const encoder = new TextEncoder();

async function reserveSnapshot(path: string, bytes: number): Promise<void> {
  const listing = await Filesystem.readdir({ path: SNAPSHOT_DIR, directory: Directory.Cache });
  const files = listing.files
    .filter(file => file.type === 'file' && /^[a-zA-Z0-9._-]+\.txt$/.test(file.name))
    .map(file => ({ ...file, path: `${SNAPSHOT_DIR}/${file.name}` }))
    .filter(file => file.path !== path)
    .sort((left, right) => (left.mtime || 0) - (right.mtime || 0) || left.name.localeCompare(right.name));
  let count = files.length;
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (count <= SNAPSHOT_MAX_FILES && total + bytes <= SNAPSHOTS_MAX_BYTES && file.size <= SNAPSHOT_MAX_BYTES)
      continue;
    await Filesystem.deleteFile({ path: file.path, directory: Directory.Cache });
    count--;
    total -= file.size;
  }
  if (count >= SNAPSHOT_MAX_FILES || total + bytes > SNAPSHOTS_MAX_BYTES) throw new Error('Preview cache unavailable');
}
let persistence = Promise.resolve();

// Directory-wide ordering also makes clear-all wait for outstanding mkdir/write operations.
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = persistence.then(operation);
  persistence = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

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

/** Write a base64 data URL snapshot to disk for a given session.
 *
 * We store the whole `data:image/jpeg;base64,…` string as UTF-8 text
 * so the read side can hand it straight back to the bubble as
 * `background: url(…)`. Without `Encoding.UTF8` Capacitor treats the
 * `data` argument as a base64-encoded string and tries to decode it
 * into binary — but the dataURL prefix contains `:`, `/`, and `,`
 * which aren't valid base64 characters, so the write silently stores
 * garbage and every rehydrated bubble comes back as an empty white
 * circle.
 */
export function writeSnapshotToDisk(sessionId: string, dataUrl: string): Promise<void> {
  return serialize(() => writeSnapshot(sessionId, dataUrl));
}

async function writeSnapshot(sessionId: string, dataUrl: string): Promise<void> {
  const bytes = encoder.encode(dataUrl).byteLength;
  if (bytes > SNAPSHOT_MAX_BYTES) return;
  try {
    await ensureDir();
    const path = pathFor(sessionId);
    await reserveSnapshot(path, bytes);
    await Filesystem.writeFile({
      path,
      data: dataUrl,
      directory: Directory.Cache,
      encoding: Encoding.UTF8
    });
  } catch (error) {
    console.warn('[snapshot-persistence] write failed for', sessionId, error);
  }
}

/** Read a previously-written snapshot back from disk. Returns null if missing. */
export function readSnapshotFromDisk(sessionId: string): Promise<string | null> {
  return serialize(() => readSnapshot(sessionId));
}

async function readSnapshot(sessionId: string): Promise<string | null> {
  try {
    const stat = await Filesystem.stat({ path: pathFor(sessionId), directory: Directory.Cache });
    if (stat.type !== 'file' || !Number.isFinite(stat.size) || stat.size < 0 || stat.size > SNAPSHOT_MAX_BYTES) {
      await removeSnapshot(sessionId);
      return null;
    }
    const result = await Filesystem.readFile({
      path: pathFor(sessionId),
      directory: Directory.Cache,
      encoding: Encoding.UTF8
    });
    const data = result.data;
    if (typeof data !== 'string') {
      // `readFile` can return a Blob on the web platform — the web
      // platform doesn't persist anything here so this branch is
      // defensive and falls back to null.
      return null;
    }
    // Guard against legacy files written before this module specified
    // `Encoding.UTF8`: those bytes are unrelated to a dataURL and would
    // feed the bubble an invalid `background: url(…)`, leaving it as a
    // featureless white circle until the next fresh park cycle.
    if (!data.startsWith('data:') || encoder.encode(data).byteLength > SNAPSHOT_MAX_BYTES) {
      // Try to delete the stale file so we stop re-reading it every
      // rehydrate; best-effort, not fatal if it fails.
      await removeSnapshot(sessionId);
      return null;
    }
    return data;
  } catch {
    // Missing file, permission denied, or cache was evicted. Treat all
    // as "not present" and let the caller fall back to a favicon tile.
    return null;
  }
}

/** Remove a snapshot file. */
export function removeSnapshotFromDisk(sessionId: string): Promise<void> {
  return serialize(() => removeSnapshot(sessionId));
}

async function removeSnapshot(sessionId: string): Promise<void> {
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
export function clearAllSnapshotsFromDisk(): Promise<void> {
  return serialize(clearSnapshots);
}

async function clearSnapshots(): Promise<void> {
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
