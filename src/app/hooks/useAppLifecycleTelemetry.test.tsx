import { act, renderHook } from '@testing-library/react';

import { useAppLifecycleTelemetry } from './useAppLifecycleTelemetry';

// ---------------------------------------------------------------------------
// The hook owns the two app-lifecycle flows:
//   `open`   — one per mount of the app shell, completed once the app leaves
//              its boot ('loading') view.
//   `return` — mobile only, one per foreground of an app that already has a
//              wallet, completed when that wallet is usable again.
//
// `resolveRootView` is deliberately NOT mocked: the ctx → view mapping is the
// production one, so these tests pin real behaviour rather than a stub's.
// ---------------------------------------------------------------------------

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock };
const mockFlowHandles: Array<{ flow: string; handle: TelemetryHandle }> = [];
const mockBeginFlow = jest.fn((flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn() };
  mockFlowHandles.push({ flow, handle });
  return handle;
});
jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => mockBeginFlow(flow),
  classifyError: () => 'unknown'
}));

const mockIsMobile = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

// Capture the Capacitor appStateChange listener the hook registers.
let appStateCb: ((state: { isActive: boolean }) => void) | undefined;
const mockRemoveListener = jest.fn();
const mockAddListener = jest.fn((_event: string, cb: (state: { isActive: boolean }) => void) => {
  appStateCb = cb;
  return Promise.resolve({ remove: mockRemoveListener });
});
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: (event: string, cb: (state: { isActive: boolean }) => void) => mockAddListener(event, cb)
  }
}));

const flowsBegun = () => mockFlowHandles.map(entry => entry.flow);

// Throwing accessor (rather than a `!`) so a missing flow names what was begun.
function handleFor(flow: string): TelemetryHandle {
  const entry = mockFlowHandles.find(candidate => candidate.flow === flow);
  if (!entry)
    throw new Error(`no telemetry flow was begun for '${flow}' (begun: ${flowsBegun().join(', ') || 'none'})`);
  return entry.handle;
}

// The four ctx shapes resolveRootView maps to its four views.
const LOADING = { locked: false, ready: false, hydrated: false };
const WELCOME = { locked: false, ready: false, hydrated: true };
const UNLOCK = { locked: true, ready: true, hydrated: true };
const APP = { locked: false, ready: true, hydrated: true };

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

// Let the App.addListener promise settle so the remove handle is registered.
async function flushListenerRegistration() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFlowHandles.length = 0;
  appStateCb = undefined;
  mockIsMobile.mockReturnValue(true);
  mockAddListener.mockImplementation((_event: string, cb: (state: { isActive: boolean }) => void) => {
    appStateCb = cb;
    return Promise.resolve({ remove: mockRemoveListener });
  });
  setVisibility('visible');
});

describe('useAppLifecycleTelemetry — the `open` flow', () => {
  it('begins an open flow on mount', () => {
    renderHook(() => useAppLifecycleTelemetry(LOADING));

    expect(mockBeginFlow.mock.calls.length).toBeGreaterThan(0);
    expect(flowsBegun()).toContain('open');
  });

  it('leaves the open flow unsettled while the app is still booting', () => {
    renderHook(() => useAppLifecycleTelemetry(LOADING));

    const handle = handleFor('open');
    expect(handle.complete).not.toHaveBeenCalled();
    expect(handle.cancel).not.toHaveBeenCalled();
  });

  it('completes the open flow once the app leaves the loading view', () => {
    const { rerender } = renderHook(ctx => useAppLifecycleTelemetry(ctx), { initialProps: LOADING });
    expect(handleFor('open').complete).not.toHaveBeenCalled();

    rerender(APP);

    expect(handleFor('open').complete).toHaveBeenCalledTimes(1);
  });

  it('completes the open flow when the app boots straight into the unlock view', () => {
    renderHook(() => useAppLifecycleTelemetry(UNLOCK));

    expect(handleFor('open').complete).toHaveBeenCalledTimes(1);
  });

  it('completes the open flow when the app boots into onboarding', () => {
    renderHook(() => useAppLifecycleTelemetry(WELCOME));

    expect(handleFor('open').complete).toHaveBeenCalledTimes(1);
  });

  it('completes the open flow exactly once across later view changes', () => {
    const { rerender } = renderHook(ctx => useAppLifecycleTelemetry(ctx), { initialProps: LOADING });
    rerender(UNLOCK);
    rerender(APP);
    rerender(WELCOME);

    expect(handleFor('open').complete).toHaveBeenCalledTimes(1);
  });

  it('begins only one open flow per mount, however often it re-renders', () => {
    const { rerender } = renderHook(ctx => useAppLifecycleTelemetry(ctx), { initialProps: LOADING });
    rerender(LOADING);
    rerender(LOADING);
    rerender(APP);

    expect(flowsBegun().filter(flow => flow === 'open')).toEqual(['open']);
  });

  it('cancels an open flow that never finished booting when the shell unmounts', () => {
    const { unmount } = renderHook(() => useAppLifecycleTelemetry(LOADING));
    const handle = handleFor('open');

    unmount();

    expect(handle.cancel).toHaveBeenCalledTimes(1);
    expect(handle.complete).not.toHaveBeenCalled();
  });

  it('leaves a completed open flow untouched on unmount', () => {
    const { unmount } = renderHook(() => useAppLifecycleTelemetry(APP));
    const handle = handleFor('open');
    expect(handle.complete).toHaveBeenCalledTimes(1);

    unmount();

    expect(handle.cancel).not.toHaveBeenCalled();
  });

  it('begins the open flow off mobile too', () => {
    mockIsMobile.mockReturnValue(false);
    renderHook(() => useAppLifecycleTelemetry(APP));

    expect(flowsBegun()).toContain('open');
    expect(handleFor('open').complete).toHaveBeenCalledTimes(1);
  });
});

describe('useAppLifecycleTelemetry — the `return` flow', () => {
  it('begins and completes a return flow when a ready wallet is re-foregrounded', async () => {
    renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    act(() => {
      appStateCb?.({ isActive: true });
    });

    expect(flowsBegun()).toContain('return');
    // Already usable, so the return is over the moment it started.
    expect(handleFor('return').complete).toHaveBeenCalledTimes(1);
  });

  it('holds the return flow open until a locked wallet becomes usable again', async () => {
    const { rerender } = renderHook(ctx => useAppLifecycleTelemetry(ctx), { initialProps: UNLOCK });
    await flushListenerRegistration();

    act(() => {
      appStateCb?.({ isActive: true });
    });
    const handle = handleFor('return');
    // Foregrounded onto the lock screen — the wallet is not usable yet.
    expect(handle.complete).not.toHaveBeenCalled();

    rerender(APP);

    expect(handle.complete).toHaveBeenCalledTimes(1);
  });

  it('also treats a DOM visibilitychange as a foreground', async () => {
    renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    act(() => {
      setVisibility('visible');
    });

    expect(flowsBegun()).toContain('return');
  });

  it('ignores a visibilitychange to hidden', async () => {
    renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    act(() => {
      setVisibility('hidden');
    });

    expect(flowsBegun()).not.toContain('return');
  });

  it('ignores a background transition', async () => {
    renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    act(() => {
      appStateCb?.({ isActive: false });
    });

    expect(flowsBegun()).not.toContain('return');
  });

  it('coalesces the appStateChange + visibilitychange that one real resume delivers', async () => {
    renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    act(() => {
      appStateCb?.({ isActive: true });
      setVisibility('visible');
    });

    expect(flowsBegun().filter(flow => flow === 'return')).toEqual(['return']);
  });

  it('does not report a return when there is no wallet to come back to', async () => {
    renderHook(() => useAppLifecycleTelemetry(WELCOME));
    await flushListenerRegistration();

    act(() => {
      appStateCb?.({ isActive: true });
    });

    expect(flowsBegun()).not.toContain('return');
  });

  it('does not report a return while the app has not yet hydrated', async () => {
    renderHook(() => useAppLifecycleTelemetry(LOADING));
    await flushListenerRegistration();

    act(() => {
      appStateCb?.({ isActive: true });
    });

    expect(flowsBegun()).not.toContain('return');
  });

  it('never reports a return off mobile, where a reopen is a fresh open instead', async () => {
    mockIsMobile.mockReturnValue(false);
    renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    act(() => {
      setVisibility('visible');
    });

    expect(mockAddListener).not.toHaveBeenCalled();
    expect(flowsBegun()).not.toContain('return');
  });

  it('does not open a second return flow while the first is still waiting on the lock screen', async () => {
    // Step the clock past the coalescing window so the second resume is a
    // genuinely distinct foreground rather than the same one being de-duped.
    let now = Date.parse('2026-06-01T00:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      renderHook(() => useAppLifecycleTelemetry(UNLOCK));
      await flushListenerRegistration();

      act(() => {
        appStateCb?.({ isActive: true });
      });
      now += 10_000;
      act(() => {
        appStateCb?.({ isActive: true });
      });

      expect(flowsBegun().filter(flow => flow === 'return')).toEqual(['return']);
      expect(handleFor('return').complete).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('cancels a return flow still waiting on the lock screen when the shell unmounts', async () => {
    const { unmount } = renderHook(() => useAppLifecycleTelemetry(UNLOCK));
    await flushListenerRegistration();

    act(() => {
      appStateCb?.({ isActive: true });
    });
    const handle = handleFor('return');

    unmount();

    expect(handle.cancel).toHaveBeenCalledTimes(1);
  });

  it('removes both foreground listeners on unmount', async () => {
    const removeSpy = jest.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    unmount();

    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('removes the native listener even when it registers after unmount', async () => {
    const { unmount } = renderHook(() => useAppLifecycleTelemetry(APP));
    unmount();
    await flushListenerRegistration();

    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  });

  it('survives a native listener registration failure and still reports on visibilitychange', async () => {
    mockAddListener.mockImplementation(() => Promise.reject(new Error('plugin unavailable')));
    renderHook(() => useAppLifecycleTelemetry(APP));
    await flushListenerRegistration();

    act(() => {
      setVisibility('visible');
    });

    expect(flowsBegun()).toContain('return');
  });
});
