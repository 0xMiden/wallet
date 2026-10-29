/* eslint-disable import/first */

const _g = globalThis as any;
_g.__intSyncTest = {
  intercomMock: {
    request: jest.fn(),
    subscribe: jest.fn(() => () => {})
  },
  walletState: {},
  hasExtensionRuntime: true
};

jest.mock('lib/store', () => {
  const useWalletStore = (selector: (state: unknown) => unknown) =>
    selector((globalThis as any).__intSyncTest.walletState);
  useWalletStore.getState = () => (globalThis as any).__intSyncTest.walletState;
  return { getIntercom: () => (globalThis as any).__intSyncTest.intercomMock, useWalletStore };
});

jest.mock('lib/store/utils/updateBalancesFromSyncData', () => ({
  updateBalancesFromSyncData: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => true),
  // False on an extension page an extension reload or update orphaned.
  hasExtensionRuntime: () => (globalThis as any).__intSyncTest.hasExtensionRuntime
}));

import { act, renderHook } from '@testing-library/react';

import { WalletMessageType, WalletStatus } from 'lib/shared/types';

import { fetchStateFromBackend, retryFetchState, useIntercomSync } from './useIntercomSync';

const intercom = _g.__intSyncTest.intercomMock;

const readyResponse = {
  type: WalletMessageType.GetStateResponse,
  state: { status: 'Ready', accounts: [] }
};

const idleState = {
  status: WalletStatus.Idle,
  accounts: [],
  currentAccount: null,
  networks: [],
  settings: null,
  ownMnemonic: null
};

const pendingResponse = {
  type: WalletMessageType.GetStateResponse,
  state: { ...idleState, backendInitialized: false }
};

beforeEach(() => {
  intercom.request.mockReset();
  intercom.subscribe.mockReset().mockReturnValue(() => {});
});

describe('fetchStateFromBackend', () => {
  it('returns the state field of a successful response', async () => {
    intercom.request.mockResolvedValueOnce(readyResponse);
    const state = await fetchStateFromBackend();
    expect(state).toEqual({ status: 'Ready', accounts: [] });
  });

  it('rejects the uninitialized backend sentinel', async () => {
    intercom.request.mockResolvedValueOnce(pendingResponse);
    await expect(fetchStateFromBackend()).rejects.toThrow('Backend initialization pending');
  });

  it.each([true, undefined])('accepts genuine Idle with initialization marker %s', async backendInitialized => {
    intercom.request.mockResolvedValueOnce({
      type: WalletMessageType.GetStateResponse,
      state: { ...idleState, ...(backendInitialized === undefined ? {} : { backendInitialized }) }
    });

    await expect(fetchStateFromBackend()).resolves.toMatchObject(idleState);
  });

  it('throws when the response type is wrong', async () => {
    intercom.request.mockResolvedValue({ type: 'WrongType' });
    await expect(fetchStateFromBackend()).rejects.toThrow('Invalid response type');
  });

  it('is a single attempt — the caller owns any retry loop', async () => {
    intercom.request.mockResolvedValueOnce({ type: 'WrongType' });
    await expect(fetchStateFromBackend()).rejects.toThrow('Invalid response type');
    expect(intercom.request).toHaveBeenCalledTimes(1);
  });
});

describe('retryFetchState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries until fetchStateFromBackend resolves, then returns state', async () => {
    intercom.request
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(readyResponse);

    const promise = retryFetchState(() => false);
    // Advance past two backoff windows (250ms + 500ms) to unblock retries.
    await jest.advanceTimersByTimeAsync(1_000);

    expect(await promise).toEqual({ status: 'Ready', accounts: [] });
    expect(intercom.request).toHaveBeenCalledTimes(3);
  });

  it('returns null when cancelled between attempts', async () => {
    let cancelled = false;
    intercom.request.mockRejectedValue(new Error('boom'));

    const promise = retryFetchState(() => cancelled);
    // Let the first failure land, then cancel during the backoff wait.
    await jest.advanceTimersByTimeAsync(0);
    cancelled = true;
    await jest.advanceTimersByTimeAsync(5_000);

    expect(await promise).toBeNull();
  });

  it('warns exactly once after 20 failed attempts', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    intercom.request.mockRejectedValue(new Error('boom'));
    let cancelled = false;

    const promise = retryFetchState(() => cancelled);
    // Run >20 attempts: backoff saturates at 3s, so 20 rounds ≈ plenty of slack.
    await jest.advanceTimersByTimeAsync(120_000);
    cancelled = true;
    await jest.advanceTimersByTimeAsync(5_000);
    await promise;

    const wedgedWarns = warn.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('backend unresponsive after 20 attempts')
    );
    expect(wedgedWarns).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('useIntercomSync balance poll on a page an extension reload or update orphaned', () => {
  let get: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    intercom.request.mockResolvedValue(readyResponse);
    _g.__intSyncTest.walletState = {
      currentAccount: { publicKey: 'A' },
      syncFromBackend: jest.fn(),
      setSyncStatus: jest.fn()
    };
    _g.__intSyncTest.hasExtensionRuntime = true;
    get = jest.fn((_key: string, cb: (result: unknown) => void) => cb({}));
    _g.chrome = { storage: { local: { get } } };
  });

  afterEach(() => {
    jest.useRealTimers();
    delete _g.chrome;
    _g.__intSyncTest.walletState = {};
    _g.__intSyncTest.hasExtensionRuntime = true;
  });

  it('stops reading extension storage once the runtime is gone', async () => {
    renderHook(() => useIntercomSync());
    const reads = get.mock.calls.length;
    expect(reads).toBeGreaterThan(0);

    _g.__intSyncTest.hasExtensionRuntime = false;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(9_000);
    });
    expect(get).toHaveBeenCalledTimes(reads);
  });

  it('does not apply an older initial response after a newer broadcast refetch', async () => {
    let finishInitial!: (value: unknown) => void;
    let listener!: (message: unknown) => void;
    intercom.request
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishInitial = resolve;
          })
      )
      .mockResolvedValueOnce({ ...readyResponse, state: { status: 'Ready', accounts: [], revision: 'new' } });
    intercom.subscribe.mockImplementation((callback: (message: unknown) => void) => {
      listener = callback;
      return () => {};
    });
    const sync = _g.__intSyncTest.walletState.syncFromBackend;
    renderHook(() => useIntercomSync());
    await act(async () => {
      listener({ type: WalletMessageType.StateUpdated });
    });
    await act(async () => {
      finishInitial({ ...readyResponse, state: { status: 'Ready', accounts: [], revision: 'old' } });
    });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ revision: 'new' }));
  });

  it('skips the one-shot balance rehydrate when the runtime is gone by the time the state arrives', async () => {
    intercom.request.mockResolvedValue({
      ...readyResponse,
      state: { ...readyResponse.state, currentAccount: { publicKey: 'A' } }
    });
    _g.__intSyncTest.hasExtensionRuntime = false;
    get.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });

    renderHook(() => useIntercomSync());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_500);
    });

    expect(get).not.toHaveBeenCalled();
  });

  it('never reads extension storage when it mounts after the runtime is gone', () => {
    _g.__intSyncTest.hasExtensionRuntime = false;
    get.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });

    expect(() => renderHook(() => useIntercomSync())).not.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('useIntercomSync backend initialization', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    _g.__intSyncTest.walletState = {
      currentAccount: null,
      hydrated: false,
      syncFromBackend: jest.fn(() => {
        _g.__intSyncTest.walletState.hydrated = true;
      }),
      setSyncStatus: jest.fn()
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    _g.__intSyncTest.walletState = {};
  });

  it('keeps hydration pending across retries until real onboarding state arrives', async () => {
    intercom.request.mockResolvedValue(pendingResponse);
    const { unmount } = renderHook(() => useIntercomSync());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(_g.__intSyncTest.walletState.hydrated).toBe(false);
    expect(_g.__intSyncTest.walletState.syncFromBackend).not.toHaveBeenCalled();
    expect(intercom.request.mock.calls.length).toBeGreaterThan(1);

    intercom.request.mockResolvedValue({
      type: WalletMessageType.GetStateResponse,
      state: { ...idleState, backendInitialized: true }
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(_g.__intSyncTest.walletState.hydrated).toBe(true);
    expect(_g.__intSyncTest.walletState.syncFromBackend).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('cannot hydrate from a pending retry after unmount', async () => {
    intercom.request.mockResolvedValue(pendingResponse);
    const { unmount } = renderHook(() => useIntercomSync());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    unmount();
    intercom.request.mockResolvedValue(readyResponse);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    expect(_g.__intSyncTest.walletState.hydrated).toBe(false);
    expect(_g.__intSyncTest.walletState.syncFromBackend).not.toHaveBeenCalled();
  });
});

describe('useIntercomSync initial response ordering', () => {
  afterEach(() => {
    _g.__intSyncTest.walletState = {};
  });

  it('does not overwrite a newer lock notification with an older initial response', async () => {
    let completeInitial!: (value: unknown) => void;
    let notify!: (message: { type: WalletMessageType }) => void;
    const sync = jest.fn();
    _g.__intSyncTest.walletState = { currentAccount: null, syncFromBackend: sync, setSyncStatus: jest.fn() };
    intercom.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          completeInitial = resolve;
        })
    );
    const locked = { ...idleState, status: WalletStatus.Locked, backendInitialized: true };
    intercom.request.mockResolvedValueOnce({ type: WalletMessageType.GetStateResponse, state: locked });
    intercom.subscribe.mockImplementation((callback: typeof notify) => {
      notify = callback;
      return () => {};
    });
    const { unmount } = renderHook(() => useIntercomSync());
    await act(async () => {
      notify({ type: WalletMessageType.StateUpdated });
    });
    expect(sync).toHaveBeenLastCalledWith(locked);
    await act(async () => {
      completeInitial({
        type: WalletMessageType.GetStateResponse,
        state: { ...idleState, status: WalletStatus.Ready, backendInitialized: true }
      });
    });
    expect(sync).toHaveBeenLastCalledWith(locked);
    unmount();
  });
});
