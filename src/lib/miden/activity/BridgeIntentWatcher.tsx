import { useEffect } from 'react';

const POLL_INTERVAL_MS = 8_000;

const LEADER_LOCK = 'bridge-intent-watcher';

export interface BridgeWatcherLockManager {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: object | null) => Promise<void>
  ): Promise<void>;
}

/** The part of `document` the watcher reads: whether its root is on screen, and when that changes. */
export interface BridgeWatcherDocument {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

const getNavigatorLocks = (): BridgeWatcherLockManager | undefined =>
  typeof navigator === 'undefined' ? undefined : navigator.locks;

/**
 * Poll every pending bridge row from the app root, for as long as the wallet is
 * unlocked. Covers both directions and both providers:
 * - EVM→Miden (`bridged-receive`): Epoch intent status and AggLayer deposit
 *   readiness, through `reconcileBridgedReceives`.
 * - Miden→EVM (`bridged-send`): Epoch fill status and AggLayer claimability,
 *   through `reconcileBridgedSends`.
 *
 * Before this watcher the polling lived on the Home, Explore and Activity pages,
 * so a bridge started from the deposit screen was not tracked until the user
 * opened one of them. Each direction has its own in-flight guard: a pass must
 * not overlap itself (`reconcileBridgedReceives` can wait on an EVM receipt, and
 * an overlapping tick would poll the same rows twice), but a slow pass in one
 * direction must not skip the other direction's ticks.
 *
 * The extension mounts a root per open window (popup, full page, side panel, dApp
 * confirmation), and the rows are shared by all of them, so one visible root
 * polls for the origin: it holds `bridge-intent-watcher` while it stays visible.
 * A root gives the lease up when it is hidden or unmounted, and only once its
 * in-flight passes settle, so two roots never reconcile the same rows at once. A
 * hidden root never keeps the lease: it skips its ticks, and every visible root
 * would wait behind it. Web Locks are released when a page dies; without them
 * the realm polls on its own.
 *
 * Both reconcilers are imported lazily: the provider mounts this watcher, and
 * a static import from here back through the transaction pipeline to the
 * provider is a cycle.
 *
 * Returns the function that stops polling.
 */
export function startBridgeIntentPolling({
  getLocks = getNavigatorLocks,
  doc = typeof document === 'undefined' ? undefined : document
}: {
  getLocks?: () => BridgeWatcherLockManager | undefined;
  doc?: BridgeWatcherDocument;
} = {}): () => void {
  let disposed = false;
  const passes = new Set<Promise<void>>();
  const isHidden = () => doc?.hidden === true;

  const guarded = (label: string, poll: () => Promise<void>) => {
    let running = false;
    return () => {
      if (disposed || running || isHidden()) return;
      running = true;
      const pass: Promise<void> = poll()
        .catch(error => console.warn(`[bridge-intent-watcher] ${label} failed`, error))
        .finally(() => {
          running = false;
          passes.delete(pass);
        });
      passes.add(pass);
    };
  };
  const pollReceives = guarded('receives', async () => {
    const { reconcileBridgedReceives } = await import('./bridge-receive');
    if (!disposed) await reconcileBridgedReceives();
  });
  const pollSends = guarded('sends', async () => {
    const { reconcileBridgedSends } = await import('lib/wallet-prompts');
    if (!disposed) await reconcileBridgedSends();
  });
  const startTicking = () => {
    const tick = () => {
      pollReceives();
      pollSends();
    };
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  };

  const locks = getLocks();
  if (!locks) {
    const stopTicking = startTicking();
    return () => {
      disposed = true;
      stopTicking();
    };
  }

  let lease: { abort: AbortController; release: () => void } | undefined;

  const lead = () => {
    if (disposed || lease || isHidden()) return;
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const current = { abort: new AbortController(), release };
    lease = current;
    locks
      .request(LEADER_LOCK, { signal: current.abort.signal }, async () => {
        if (lease !== current) return;
        const stopTicking = startTicking();
        await released;
        stopTicking();
        await Promise.all(passes);
      })
      .catch(error => {
        if (lease === current) lease = undefined;
        if (!current.abort.signal.aborted) console.warn('[bridge-intent-watcher] leadership request failed', error);
      });
  };
  const resign = () => {
    const current = lease;
    if (!current) return;
    lease = undefined;
    current.abort.abort();
    current.release();
  };
  const onVisibilityChange = () => (isHidden() ? resign() : lead());

  doc?.addEventListener('visibilitychange', onVisibilityChange);
  lead();
  return () => {
    disposed = true;
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
    resign();
  };
}

export function BridgeIntentWatcher(): null {
  useEffect(() => startBridgeIntentPolling(), []);

  return null;
}
