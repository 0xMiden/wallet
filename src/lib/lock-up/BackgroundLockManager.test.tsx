import React from 'react';

import { act, render } from '@testing-library/react';

import { BACKGROUND_LOCK_HEARTBEAT_MS, backgroundLockPending } from './background-lock';
import { BackgroundLockManager } from './BackgroundLockManager';
import { backgroundLockDelay } from './index';

const mockPlatform = { mobile: true, desktop: false };
jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.mobile,
  isDesktop: () => mockPlatform.desktop
}));

const mockAppCallbacks = new Map<string, () => void>();
const mockAppRemove = jest.fn();
const mockAddListener = jest.fn((event: string, cb: () => void) => {
  mockAppCallbacks.set(event, cb);
  return Promise.resolve({ remove: mockAppRemove });
});
jest.mock('@capacitor/app', () => ({
  App: { addListener: (event: string, cb: () => void) => mockAddListener(event, cb) }
}));

const mockRequestLock = jest.fn<Promise<void>, []>();
jest.mock('./lock-request', () => ({ requestLock: () => mockRequestLock() }));

const MINUTE = 60_000;
const START = new Date('2026-01-01T00:00:00Z').getTime();

const advance = (ms: number) => {
  jest.setSystemTime(Date.now() + ms);
};
const fire = (event: string) => act(() => mockAppCallbacks.get(event)?.());
const setVisibility = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const mount = async () => {
  const view = render(<BackgroundLockManager />);
  await act(async () => {});
  return view;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(START);
  mockPlatform.mobile = true;
  mockPlatform.desktop = false;
  mockAppCallbacks.clear();
  mockAddListener.mockReset().mockImplementation((event: string, cb: () => void) => {
    mockAppCallbacks.set(event, cb);
    return Promise.resolve({ remove: mockAppRemove });
  });
  mockAppRemove.mockClear();
  mockRequestLock.mockReset().mockResolvedValue(undefined);
  backgroundLockPending.set(false);
  backgroundLockDelay.set('10');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('BackgroundLockManager', () => {
  it('locks on resume after ten minutes in the background by default', async () => {
    await mount();
    fire('pause');
    advance(10 * MINUTE);
    fire('resume');
    expect(mockRequestLock).toHaveBeenCalledTimes(1);
  });

  it('does not lock on resume after nine minutes', async () => {
    await mount();
    fire('pause');
    advance(9 * MINUTE);
    fire('resume');
    expect(mockRequestLock).not.toHaveBeenCalled();
    expect(backgroundLockPending.get()).toBe(false);
  });

  it('uses the stored delay', async () => {
    backgroundLockDelay.set('1');
    await mount();
    fire('pause');
    advance(61_000);
    fire('resume');
    expect(mockRequestLock).toHaveBeenCalledTimes(1);
  });

  it('does not listen to appStateChange or visibilitychange on mobile, so an in-app sheet or a Face ID prompt never counts', async () => {
    await mount();
    expect(mockAddListener.mock.calls.map(([event]) => event).sort()).toEqual(['pause', 'resume']);
    setVisibility('hidden');
    advance(15 * MINUTE);
    setVisibility('visible');
    expect(mockRequestLock).not.toHaveBeenCalled();
  });

  it('locks after a freeze with no pause delivered', async () => {
    await mount();
    advance(11 * MINUTE);
    act(() => {
      jest.advanceTimersByTime(BACKGROUND_LOCK_HEARTBEAT_MS);
    });
    expect(mockRequestLock).toHaveBeenCalledTimes(1);
  });

  it('locks once when resume and a heartbeat both see the expiry', async () => {
    mockRequestLock.mockReturnValue(new Promise(() => {}));
    await mount();
    fire('pause');
    advance(11 * MINUTE);
    fire('resume');
    act(() => {
      jest.advanceTimersByTime(BACKGROUND_LOCK_HEARTBEAT_MS);
    });
    expect(mockRequestLock).toHaveBeenCalledTimes(1);
  });

  it('raises the cover before the lock request settles, and keeps it while retrying a failed request', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let reject: (e: Error) => void = () => {};
    mockRequestLock.mockImplementationOnce(
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        })
    );
    await mount();
    fire('pause');
    advance(10 * MINUTE);
    fire('resume');
    expect(backgroundLockPending.get()).toBe(true);
    expect(mockRequestLock).toHaveBeenCalledTimes(1);

    await act(async () => {
      reject(new Error('busy'));
    });
    expect(warn).toHaveBeenCalledWith('[background-lock] lock request failed:', expect.any(Error));
    expect(backgroundLockPending.get()).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(BACKGROUND_LOCK_HEARTBEAT_MS);
    });
    expect(mockRequestLock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('removes each handle when it resolves after the manager unmounted', async () => {
    const resolvers: Array<(handle: { remove: jest.Mock }) => void> = [];
    mockAddListener.mockImplementation((event: string, cb: () => void) => {
      mockAppCallbacks.set(event, cb);
      return new Promise(resolve => resolvers.push(resolve));
    });
    const view = render(<BackgroundLockManager />);
    view.unmount();
    const removes = [jest.fn(), jest.fn()];
    await act(async () => {
      resolvers.forEach((resolve, i) => resolve({ remove: removes[i] }));
    });
    expect(resolvers).toHaveLength(2);
    removes.forEach(remove => expect(remove).toHaveBeenCalledTimes(1));
  });

  it('warns when a lifecycle listener cannot register', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockAddListener.mockImplementation(() => Promise.reject(new Error('no plugin')));
    await mount();
    expect(warn).toHaveBeenCalledWith('[background-lock] listener registration failed:', expect.any(Error));
    warn.mockRestore();
  });

  it('on desktop, locks when the window was hidden for the delay', async () => {
    mockPlatform.mobile = false;
    mockPlatform.desktop = true;
    await mount();
    expect(mockAddListener).not.toHaveBeenCalled();
    setVisibility('hidden');
    advance(10 * MINUTE);
    setVisibility('visible');
    expect(mockRequestLock).toHaveBeenCalledTimes(1);
  });

  it('does nothing on the extension', async () => {
    mockPlatform.mobile = false;
    await mount();
    expect(mockAddListener).not.toHaveBeenCalled();
    advance(30 * MINUTE);
    act(() => {
      jest.advanceTimersByTime(BACKGROUND_LOCK_HEARTBEAT_MS);
    });
    expect(mockRequestLock).not.toHaveBeenCalled();
  });

  it('drops the cover and its listeners on unmount', async () => {
    const view = await mount();
    fire('pause');
    advance(10 * MINUTE);
    fire('resume');
    expect(backgroundLockPending.get()).toBe(true);
    view.unmount();
    expect(backgroundLockPending.get()).toBe(false);
    expect(mockAppRemove).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
