import {
  __resetStartupReconnectForTest,
  boundStartupReconnect,
  effectiveAppKitStatus,
  STARTUP_RECONNECT_BOUND_MS,
  type StartupReconnectDeps,
  startupReconnectTimedOut,
  subscribeStartupReconnect
} from './startup-reconnect';

type Harness = {
  deps: StartupReconnectDeps;
  status: (next: string) => void;
  modal: (open: boolean) => void;
  forgetSession: jest.Mock;
  disconnect: jest.Mock;
};

function harness(
  stored: 'connected' | 'disconnected' | undefined,
  overrides: Partial<StartupReconnectDeps> = {}
): Harness {
  const statusListeners = new Set<(status: string) => void>();
  const modalListeners = new Set<(open: boolean) => void>();
  const forgetSession = jest.fn();
  const disconnect = jest.fn(async () => {});
  return {
    deps: {
      storedStatus: () => stored,
      subscribeStatus: listener => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      subscribeModalOpen: listener => {
        modalListeners.add(listener);
        return () => modalListeners.delete(listener);
      },
      forgetSession,
      disconnect,
      ...overrides
    },
    status: next => statusListeners.forEach(listener => listener(next)),
    modal: open => modalListeners.forEach(listener => listener(open)),
    forgetSession,
    disconnect
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetStartupReconnectForTest();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('boundStartupReconnect', () => {
  it('does nothing on a page with no stored session', () => {
    const fresh = harness(undefined);
    boundStartupReconnect(fresh.deps);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(fresh.forgetSession).not.toHaveBeenCalled();
    expect(fresh.disconnect).not.toHaveBeenCalled();
    expect(startupReconnectTimedOut()).toBe(false);

    const ended = harness('disconnected');
    boundStartupReconnect(ended.deps);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(ended.forgetSession).not.toHaveBeenCalled();
  });

  it('forgets the session and asks for a disconnect once a stored session is still restoring at the bound', () => {
    const h = harness('connected');
    const listener = jest.fn();
    subscribeStartupReconnect(listener);
    boundStartupReconnect(h.deps);

    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS - 1);
    expect(startupReconnectTimedOut()).toBe(false);
    expect(h.forgetSession).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(startupReconnectTimedOut()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(h.forgetSession).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(effectiveAppKitStatus('connecting')).toBe('disconnected');
    expect(effectiveAppKitStatus('connected')).toBe('connected');
  });

  it('keeps a restore that settled before the bound', () => {
    for (const settled of ['connected', 'disconnected']) {
      __resetStartupReconnectForTest();
      const h = harness('connected');
      boundStartupReconnect(h.deps);
      h.status(settled);
      jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
      expect(h.forgetSession).not.toHaveBeenCalled();
      expect(h.disconnect).not.toHaveBeenCalled();
      expect(startupReconnectTimedOut()).toBe(false);
    }
  });

  it('stands down when the user opens the connect modal before the bound', () => {
    const h = harness('connected');
    boundStartupReconnect(h.deps);
    h.modal(true);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.forgetSession).not.toHaveBeenCalled();
    expect(startupReconnectTimedOut()).toBe(false);
    expect(effectiveAppKitStatus('connecting')).toBe('connecting');
  });

  it('re-arms when the connect modal closes without a settled status, and opening it ends the override', () => {
    const h = harness('connected');
    boundStartupReconnect(h.deps);
    h.modal(true);
    h.modal(false);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS);
    expect(h.forgetSession).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(startupReconnectTimedOut()).toBe(true);
    expect(effectiveAppKitStatus('connecting')).toBe('disconnected');

    // The disconnect never settles; the user opens the modal to pair afresh.
    h.modal(true);
    expect(startupReconnectTimedOut()).toBe(false);
    expect(effectiveAppKitStatus('connecting')).toBe('connecting');
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.disconnect).toHaveBeenCalledTimes(1);

    h.modal(false);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS);
    expect(startupReconnectTimedOut()).toBe(true);
    expect(h.forgetSession).toHaveBeenCalledTimes(2);
    expect(h.disconnect).toHaveBeenCalledTimes(2);
  });

  it('keeps a running clock on its original deadline through a close it did not open', () => {
    const h = harness('connected');
    boundStartupReconnect(h.deps);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS - 1);
    h.modal(false);
    jest.advanceTimersByTime(1);
    expect(h.forgetSession).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.forgetSession).toHaveBeenCalledTimes(1);

    h.modal(false);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it('leaves the restore alone once the status has left connecting', () => {
    const h = harness('connected');
    boundStartupReconnect(h.deps);
    h.modal(true);
    h.status('connected');
    h.modal(false);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.forgetSession).not.toHaveBeenCalled();
    expect(startupReconnectTimedOut()).toBe(false);

    h.status('connecting');
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.forgetSession).not.toHaveBeenCalled();
    expect(effectiveAppKitStatus('connecting')).toBe('connecting');

    // The user's own attempt, opened and closed while still connecting, is never bounded.
    h.modal(true);
    h.modal(false);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.forgetSession).not.toHaveBeenCalled();
  });

  it('does not let a caller shorten the startup bound', () => {
    const h = harness('connected');
    Object.assign(h.deps, { boundMs: 50 });
    boundStartupReconnect(h.deps);
    jest.advanceTimersByTime(50);
    expect(h.forgetSession).not.toHaveBeenCalled();
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS - 50);
    expect(h.forgetSession).toHaveBeenCalledTimes(1);
  });

  it('lifts the override once the status moves on, so a later connect shows its own progress', () => {
    const h = harness('connected');
    const listener = jest.fn();
    subscribeStartupReconnect(listener);
    boundStartupReconnect(h.deps);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS);
    expect(startupReconnectTimedOut()).toBe(true);

    h.status('disconnected');
    expect(startupReconnectTimedOut()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(effectiveAppKitStatus('connecting')).toBe('connecting');
  });

  it('survives a forget that throws and a disconnect that rejects, and warns once for each', async () => {
    const h = harness('connected', {
      forgetSession: () => {
        throw new Error('storage gone');
      },
      disconnect: async () => {
        throw new Error('provider stuck');
      }
    });
    boundStartupReconnect(h.deps);
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS);
    await Promise.resolve();
    expect(startupReconnectTimedOut()).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('stops watching when told to', () => {
    const h = harness('connected');
    const stop = boundStartupReconnect(h.deps);
    stop();
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS * 2);
    expect(h.forgetSession).not.toHaveBeenCalled();
    expect(startupReconnectTimedOut()).toBe(false);
  });
});
