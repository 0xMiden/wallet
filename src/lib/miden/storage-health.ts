import { putToStorage } from 'lib/miden/front/storage';
import { monotonicNowMs } from 'lib/miden/sync-backoff';

/** chrome.storage mirror of the stall flag; the popup banner reads it, the service worker is its only writer. */
export const STORAGE_STALL_KEY = 'miden-storage-stall';

/** How long the probe database may take to open before storage counts as not answering. A healthy open takes milliseconds. */
export const STORAGE_PROBE_DEADLINE_MS = 5_000;

/** While stalled, calls fail fast and re-probe at most this often, reusing the one pending open, so a stall adds no work. */
export const STORAGE_RECHECK_INTERVAL_MS = 10_000;

const PROBE_DB_NAME = 'miden-storage-probe';

/**
 * The browser's IndexedDB backend does not answer (#2148). Not a node or network fault, so it must reach neither the
 * connectivity banner nor the sync circuit breaker, and restarting the offscreen document cannot cure it: the new
 * client opens the same stuck database.
 */
export class StorageStalledError extends Error {
  constructor() {
    super('Browser storage is not answering; the browser must be restarted');
    this.name = 'StorageStalledError';
  }
}

export function isStorageStalledError(err: unknown): err is StorageStalledError {
  return err instanceof StorageStalledError || (err as { name?: unknown } | null)?.name === 'StorageStalledError';
}

// One open at a time: while the backend is silent the request never settles, and a fresh one per recheck would leave
// an unbounded pile of pending requests. It closes its connection when a late open finally succeeds.
let pendingOpen: Promise<void> | null = null;

// Any answer proves the backend alive, including an error or a blocked open; only silence is a stall.
function openProbeDb(): Promise<void> {
  if (pendingOpen) return pendingOpen;
  const open = new Promise<void>(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(PROBE_DB_NAME, 1);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
  pendingOpen = open;
  void open.then(() => {
    if (pendingOpen === open) pendingOpen = null;
  });
  return open;
}

/** Opens a tiny dedicated database under a short deadline, separate from every sync and network timeout. */
export async function probeStorage(deadlineMs: number = STORAGE_PROBE_DEADLINE_MS): Promise<'ok' | 'stalled'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<'stalled'>(resolve => {
    timer = setTimeout(() => resolve('stalled'), deadlineMs);
  });
  try {
    return await Promise.race([openProbeDb().then(() => 'ok' as const), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

let stalled = false;
let mirrored: boolean | null = null;
let mirrorWriting = false;
let lastProbeAtMs: number | null = null;
let probing: Promise<boolean> | null = null;
let startupProbe: Promise<boolean> | null = null;

export function isStorageStalled(): boolean {
  return stalled;
}

// `mirrored` records only a write that landed, so a failed one (a clear of a persisted true above all) is retried by
// the next call instead of leaving the banner up after recovery.
function syncMirror(): void {
  if (mirrorWriting || mirrored === stalled) return;
  const next = stalled;
  mirrorWriting = true;
  let write: Promise<unknown>;
  try {
    write = Promise.resolve(putToStorage(STORAGE_STALL_KEY, next));
  } catch (err) {
    write = Promise.reject(err);
  }
  write
    .then(() => {
      mirrored = next;
    })
    .catch(err => console.warn('[storage-health] mirror failed:', err))
    .finally(() => {
      mirrorWriting = false;
      // Only a flag that moved during the write; a failed write waits for the next call.
      if (next !== stalled) syncMirror();
    });
}

function setStalled(next: boolean): void {
  stalled = next;
  syncMirror();
}

/**
 * Starts the probe at service worker start, before anything touches Dexie, so a stall at wake still writes the mirror.
 * Every gate waits for it, and it replaces a flag a previous worker left behind.
 */
export function beginStartupProbe(): void {
  startupProbe ??= checkStorage();
}

/** Probes now (one probe at a time), updates the flag and resolves true while storage is stalled. */
export function checkStorage(): Promise<boolean> {
  if (probing) return probing;
  probing = probeStorage()
    .then(result => {
      lastProbeAtMs = monotonicNowMs();
      setStalled(result === 'stalled');
      return stalled;
    })
    .finally(() => {
      probing = null;
    });
  return probing;
}

/**
 * Gate for work that needs storage. Free while healthy; while stalled it answers from the flag and re-probes at most
 * once per {@link STORAGE_RECHECK_INTERVAL_MS}, which is also how a recovered browser clears the flag.
 */
export async function isStorageStalledNow(): Promise<boolean> {
  if (startupProbe) await startupProbe;
  if (!stalled) {
    if (mirrored !== null) syncMirror();
    return false;
  }
  if (lastProbeAtMs !== null && monotonicNowMs() - lastProbeAtMs < STORAGE_RECHECK_INTERVAL_MS) return true;
  return checkStorage();
}

/** Test-only: restore the module to its initial state. */
export function resetStorageHealthForTests(): void {
  stalled = false;
  mirrored = null;
  mirrorWriting = false;
  lastProbeAtMs = null;
  probing = null;
  startupProbe = null;
  pendingOpen = null;
}
