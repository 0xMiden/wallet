import React from 'react';

import { act, render } from '@testing-library/react';

import {
  BridgeIntentWatcher,
  BridgeWatcherDocument,
  BridgeWatcherLockManager,
  startBridgeIntentPolling
} from './BridgeIntentWatcher';

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

/**
 * One exclusive lock shared by every realm of an origin, granted in request order. A waiting request can be
 * aborted, unless `ignoreAbort` stands in for a grant that raced the abort.
 */
function createLockManager({ ignoreAbort = false } = {}): BridgeWatcherLockManager & { waiting(): number } {
  let held = false;
  const queue: Array<() => void> = [];
  const grantNext = () => queue.shift()?.();
  return {
    waiting: () => queue.length,
    request(_name, options, callback) {
      return new Promise<void>((resolve, reject) => {
        const grant = () => {
          held = true;
          callback({})
            .then(resolve, reject)
            .finally(() => {
              held = false;
              grantNext();
            });
        };
        if (!held) {
          grant();
          return;
        }
        queue.push(grant);
        options.signal?.addEventListener('abort', () => {
          const index = queue.indexOf(grant);
          if (ignoreAbort || index < 0) return;
          queue.splice(index, 1);
          reject(new DOMException('The request was aborted.', 'AbortError'));
        });
      });
    }
  };
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
    Object.defineProperty(navigator, 'locks', { value: createLockManager(), configurable: true });
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
  });

  it('polls from the leading root only, and hands over when it stops', async () => {
    const locks = createLockManager();
    const stopFirst = startBridgeIntentPolling({ getLocks: () => locks, doc: createRoot() });
    const stopSecond = startBridgeIntentPolling({ getLocks: () => locks, doc: createRoot() });
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
    const locks = createLockManager();
    const leader = createRoot();
    const stopLeader = startBridgeIntentPolling({ getLocks: () => locks, doc: leader });
    const stopVisible = startBridgeIntentPolling({ getLocks: () => locks, doc: createRoot() });
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

  it('hands over only once the outgoing leader has finished its pass', async () => {
    const locks = createLockManager();
    let finishPass: () => void = () => {};
    mockReconcileReceives.mockImplementationOnce(() => new Promise<void>(resolve => (finishPass = resolve)));
    const leader = createRoot();
    const stopLeader = startBridgeIntentPolling({ getLocks: () => locks, doc: leader });
    const stopNext = startBridgeIntentPolling({ getLocks: () => locks, doc: createRoot() });
    await settle();

    leader.setHidden(true);
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);

    finishPass();
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);
    stopLeader();
    stopNext();
  });

  it('withdraws the waiting request of a root that is hidden, and asks again once it is visible', async () => {
    const locks = createLockManager();
    const waiting = createRoot();
    const stopLeader = startBridgeIntentPolling({ getLocks: () => locks, doc: createRoot() });
    const stopWaiting = startBridgeIntentPolling({ getLocks: () => locks, doc: waiting });
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
    const locks = createLockManager({ ignoreAbort: true });
    const waiting = createRoot();
    const stopLeader = startBridgeIntentPolling({ getLocks: () => locks, doc: createRoot() });
    const stopWaiting = startBridgeIntentPolling({ getLocks: () => locks, doc: waiting });
    await settle();

    waiting.setHidden(true);
    waiting.setHidden(false);
    stopLeader();
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(2);

    await advance(8_000);
    expect(mockReconcileReceives).toHaveBeenCalledTimes(3);
    stopWaiting();
  });

  it('asks for the lease only once its root is visible', async () => {
    const locks = createLockManager();
    const root = createRoot(true);
    const stop = startBridgeIntentPolling({ getLocks: () => locks, doc: root });
    await advance(8_000);
    expect(mockReconcileReceives).not.toHaveBeenCalled();

    root.setHidden(false);
    await settle();
    expect(mockReconcileReceives).toHaveBeenCalledTimes(1);
    stop();
  });
});
