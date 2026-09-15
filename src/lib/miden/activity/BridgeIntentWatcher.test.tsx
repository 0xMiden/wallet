import React from 'react';

import { act, render } from '@testing-library/react';

import { BridgeIntentWatcher, BridgeWatcherDocument, startBridgeIntentPolling } from './BridgeIntentWatcher';

const mockReconcileReceives = jest.fn();
const mockReconcileSends = jest.fn();

jest.mock('./bridge-receive', () => ({
  reconcileBridgedReceives: (...args: unknown[]) => mockReconcileReceives(...args)
}));
jest.mock('lib/wallet-prompts', () => ({
  reconcileBridgedSends: (...args: unknown[]) => mockReconcileSends(...args)
}));

const tick = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

const settle = async () => {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};

const advance = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  await settle();
};

type LockMode = 'exclusive' | 'shared';

/**
 * Web Locks for every realm of one origin. Per lock name, requests are granted in order: an exclusive request waits
 * for every holder, a shared one only for an exclusive holder. A waiting request can be aborted, unless
 * `ignoreAbort` stands in for a grant that raced the abort.
 */
function createLockManager({ ignoreAbort = false } = {}) {
  const held = new Map<string, { mode: LockMode; count: number }>();
  const queue: Array<{ name: string; mode: LockMode; grant: () => void }> = [];
  const grantable = (name: string, mode: LockMode) => {
    const holder = held.get(name);
    return !holder || (holder.mode === 'shared' && mode === 'shared');
  };
  const release = (name: string) => {
    const holder = held.get(name);
    if (!holder || holder.count === 1) held.delete(name);
    else held.set(name, { mode: holder.mode, count: holder.count - 1 });
  };
  const pump = () => {
    for (const entry of [...queue]) {
      const index = queue.indexOf(entry);
      const blockedAhead = queue.slice(0, index).some(other => other.name === entry.name);
      if (blockedAhead || !grantable(entry.name, entry.mode)) continue;
      queue.splice(index, 1);
      entry.grant();
    }
  };
  return {
    waiting: () => queue.length,
    request(
      name: string,
      options: { mode?: LockMode; signal?: AbortSignal },
      callback: (lock: object | null) => Promise<void>
    ) {
      const mode = options.mode ?? 'exclusive';
      return new Promise<void>((resolve, reject) => {
        const entry = {
          name,
          mode,
          grant: () => {
            const holder = held.get(name);
            held.set(name, { mode, count: (holder?.count ?? 0) + 1 });
            callback({})
              .then(resolve, reject)
              .finally(() => {
                release(name);
                pump();
              });
          }
        };
        if (!queue.some(other => other.name === name) && grantable(name, mode)) {
          entry.grant();
          return;
        }
        queue.push(entry);
        options.signal?.addEventListener('abort', () => {
          const index = queue.indexOf(entry);
          if (ignoreAbort || index < 0) return;
          queue.splice(index, 1);
          reject(new DOMException('The request was aborted.', 'AbortError'));
          pump();
        });
      });
    }
  };
}

/** Every realm of an origin shares one lock manager, so the fake stands in for `navigator.locks`. */
function installLocks<T>(locks: T): T {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  return locks;
}

function createRoot(hidden = false): BridgeWatcherDocument & { setHidden(value: boolean): void } {
  const listeners = new Set<() => void>();
  const root = {
    hidden,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.delete(listener);
    },
    setHidden(value: boolean) {
      root.hidden = value;
      listeners.forEach(listener => listener());
    }
  };
  return root;
}

describe('BridgeIntentWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockReconcileReceives.mockResolvedValue(undefined);
    mockReconcileSends.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('reconciles both directions on mount and again on every interval', async () => {
    render(<BridgeIntentWatcher />);
    await act(async () => {});
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);

    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);

    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(3);
    expect(mockReconcileSends).toHaveBeenCalledTimes(3);
  });

  it('skips receives while their pass is in flight and keeps polling sends on every tick', async () => {
    let release: () => void = () => {};
    mockReconcileReceives.mockImplementation(() => new Promise<void>(resolve => (release = resolve)));

    render(<BridgeIntentWatcher />);
    await act(async () => {});
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);

    await tick(8_000);
    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    expect(mockReconcileSends).toHaveBeenCalledTimes(3);

    await act(async () => {
      release();
    });
    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
  });

  it('skips sends while their pass is in flight and keeps polling receives on every tick', async () => {
    let release: () => void = () => {};
    mockReconcileSends.mockImplementation(() => new Promise<void>(resolve => (release = resolve)));

    render(<BridgeIntentWatcher />);
    await act(async () => {});
    await tick(8_000);
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);

    await act(async () => {
      release();
    });
    await tick(8_000);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);
  });

  it('still polls sends when receives reject, and keeps polling afterwards', async () => {
    mockReconcileReceives.mockRejectedValueOnce(new Error('rpc down'));

    render(<BridgeIntentWatcher />);
    await act(async () => {});

    expect(console.warn).toHaveBeenCalledWith('[bridge-intent-watcher] receives failed', expect.any(Error));
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);

    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);
  });

  it('warns and keeps polling when sends reject', async () => {
    mockReconcileSends.mockRejectedValueOnce(new Error('allocator down'));

    render(<BridgeIntentWatcher />);
    await act(async () => {});

    expect(console.warn).toHaveBeenCalledWith('[bridge-intent-watcher] sends failed', expect.any(Error));

    await tick(8_000);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the document is hidden', async () => {
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    render(<BridgeIntentWatcher />);
    await tick(8_000);
    expect(mockReconcileReceives).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    await tick(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
  });

  it('stops polling once unmounted', async () => {
    const { unmount } = render(<BridgeIntentWatcher />);
    await act(async () => {});
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

    unmount();
    await tick(8_000);

    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
  });

  it('lets one mounted root poll when the page has Web Locks', async () => {
    installLocks(createLockManager());
    try {
      render(
        <>
          <BridgeIntentWatcher />
          <BridgeIntentWatcher />
        </>
      );
      await act(settle);
      expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

      await tick(8_000);
      await act(settle);
      expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });
});

describe('startBridgeIntentPolling - one polling root per origin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockReconcileReceives.mockResolvedValue(undefined);
    mockReconcileSends.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('polls from the leading root only, and hands over when it stops', async () => {
    installLocks(createLockManager());
    const stopFirst = startBridgeIntentPolling({ doc: createRoot() });
    const stopSecond = startBridgeIntentPolling({ doc: createRoot() });
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);

    await advance(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);

    stopFirst();
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(3);

    await advance(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(4);
    stopSecond();
  });

  it('gives the lease up when its root is hidden, so a visible root polls', async () => {
    installLocks(createLockManager());
    const leader = createRoot();
    const stopLeader = startBridgeIntentPolling({ doc: leader });
    const stopVisible = startBridgeIntentPolling({ doc: createRoot() });
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

    leader.setHidden(true);
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);

    await advance(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(3);
    stopLeader();
    stopVisible();
  });

  it('hands over at once while the outgoing leader still has a pass running', async () => {
    installLocks(createLockManager());
    mockReconcileReceives.mockImplementationOnce(() => new Promise<void>(() => {}));
    const leader = createRoot();
    const stopLeader = startBridgeIntentPolling({ doc: leader });
    const stopNext = startBridgeIntentPolling({ doc: createRoot() });
    await settle();
    expect(mockReconcileSends).toHaveBeenCalledTimes(1);

    leader.setHidden(true);
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    expect(mockReconcileSends).toHaveBeenCalledTimes(2);
    stopLeader();
    stopNext();
  });

  it('withdraws the waiting request of a root that is hidden, and asks again once it is visible', async () => {
    const locks = installLocks(createLockManager());
    const waiting = createRoot();
    const stopLeader = startBridgeIntentPolling({ doc: createRoot() });
    const stopWaiting = startBridgeIntentPolling({ doc: waiting });
    await settle();
    expect(locks.waiting()).toBe(1);

    waiting.setHidden(true);
    await settle();
    expect(locks.waiting()).toBe(0);

    stopLeader();
    await advance(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

    waiting.setHidden(false);
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    stopWaiting();
  });

  it('ignores a grant for a request its root withdrew before it was shown again', async () => {
    installLocks(createLockManager({ ignoreAbort: true }));
    const waiting = createRoot();
    const stopLeader = startBridgeIntentPolling({ doc: createRoot() });
    const stopWaiting = startBridgeIntentPolling({ doc: waiting });
    const stopQueued = startBridgeIntentPolling({ doc: createRoot() });
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

    // The withdrawn request stays queued ahead of the third root's; the renewed one queues behind it.
    waiting.setHidden(true);
    waiting.setHidden(false);
    stopLeader();
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);

    await advance(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(3);
    stopWaiting();
    stopQueued();
  });

  it('resumes a direction once its own unfinished pass settles when a root leads again', async () => {
    installLocks(createLockManager());
    let finishOldPass: () => void = () => {};
    mockReconcileReceives.mockImplementationOnce(() => new Promise<void>(resolve => (finishOldPass = resolve)));
    const returning = createRoot();
    const stopReturning = startBridgeIntentPolling({ doc: returning });
    await settle();
    const stopOther = startBridgeIntentPolling({ doc: createRoot() });
    await settle();

    returning.setHidden(true);
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);

    returning.setHidden(false);
    await settle();
    stopOther();
    await settle();
    expect(mockReconcileSends).toHaveBeenCalledTimes(3);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);

    finishOldPass();
    await settle();
    await advance(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(3);
    stopReturning();
  });

  it('asks for the lease only once its root is visible', async () => {
    installLocks(createLockManager());
    const root = createRoot(true);
    const stop = startBridgeIntentPolling({ doc: root });
    await advance(8_000);
    expect(mockReconcileReceives).not.toHaveBeenCalled();

    root.setHidden(false);
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    stop();
  });
});
