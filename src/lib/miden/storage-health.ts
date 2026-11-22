import { putToStorage } from 'lib/miden/front/storage';
import { monotonicNowMs } from 'lib/miden/sync-backoff';

/** chrome.storage mirror of the stall flag; the popup banner reads it, the service worker is its only writer. */
export const STORAGE_STALL_KEY = 'miden-storage-stall';

/** How long the probe database may take to open before storage counts as not answering. A healthy open takes milliseconds. */
export const STORAGE_PROBE_DEADLINE_MS = 5_000;

/** While stalled, calls fail fast and re-probe at most this often, so a stall costs no work and no memory. */
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

// Any answer proves the backend alive, including an error or a blocked open; only silence is a stall.
function openProbeDb(): Promise<void> {
  return new Promise(resolve => {
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
let lastProbeAtMs: number | null = null;
let probing: Promise<boolean> | null = null;

export function isStorageStalled(): boolean {
  return stalled;
}

function setStalled(next: boolean): void {
  stalled = next;
  // The first result always writes, so a flag mirrored by a previous service worker cannot outlive its stall.
  if (mirrored === next) return;
  mirrored = next;
  void putToStorage(STORAGE_STALL_KEY, next).catch(err => console.warn('[storage-health] mirror failed:', err));
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
  if (!stalled) return false;
  if (lastProbeAtMs !== null && monotonicNowMs() - lastProbeAtMs < STORAGE_RECHECK_INTERVAL_MS) return true;
  return checkStorage();
}

/** Test-only: restore the module to its initial state. */
export function resetStorageHealthForTests(): void {
  stalled = false;
  mirrored = null;
  lastProbeAtMs = null;
  probing = null;
}
