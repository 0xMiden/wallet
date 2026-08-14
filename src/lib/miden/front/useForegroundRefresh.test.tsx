import { renderHook } from '@testing-library/react';

import { useForegroundRefresh } from './useForegroundRefresh';

const mockIsMobile = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

// Capture the appStateChange callback the hook registers.
let appStateCb: ((s: { isActive: boolean }) => void) | undefined;
const removeHandle = jest.fn();
jest.mock('@capacitor/app', () => ({
  App: {
    addListener: jest.fn((_event: string, cb: (s: { isActive: boolean }) => void) => {
      appStateCb = cb;
      return Promise.resolve({ remove: removeHandle });
    })
  }
}));

const mockRequestImmediateSync = jest.fn();
jest.mock('./useSyncTrigger', () => ({
  requestImmediateSync: () => mockRequestImmediateSync()
}));

const mockRequestNotesRefresh = jest.fn();
jest.mock('./note-refresh', () => ({
  requestNotesRefresh: () => mockRequestNotesRefresh()
}));

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useForegroundRefresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appStateCb = undefined;
    mockIsMobile.mockReturnValue(true);
  });

  it('kicks an immediate sync + note refresh when the app returns to the foreground (appStateChange)', async () => {
    renderHook(() => useForegroundRefresh());
    // let the App.addListener promise resolve
    await Promise.resolve();

    expect(appStateCb).toBeDefined();
    appStateCb!({ isActive: true });

    expect(mockRequestImmediateSync).toHaveBeenCalledTimes(1);
    expect(mockRequestNotesRefresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a background transition (isActive false)', async () => {
    renderHook(() => useForegroundRefresh());
    await Promise.resolve();

    appStateCb!({ isActive: false });

    expect(mockRequestImmediateSync).not.toHaveBeenCalled();
    expect(mockRequestNotesRefresh).not.toHaveBeenCalled();
  });

  it('also refreshes on a DOM visibilitychange -> visible', () => {
    renderHook(() => useForegroundRefresh());

    setVisibility('hidden');
    expect(mockRequestImmediateSync).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(mockRequestImmediateSync).toHaveBeenCalledTimes(1);
    expect(mockRequestNotesRefresh).toHaveBeenCalledTimes(1);
  });

  it('is a no-op off mobile (no listeners, no refresh)', () => {
    mockIsMobile.mockReturnValue(false);
    renderHook(() => useForegroundRefresh());

    setVisibility('visible');
    expect(mockRequestImmediateSync).not.toHaveBeenCalled();
    expect(mockRequestNotesRefresh).not.toHaveBeenCalled();
  });

  it('coalesces the appStateChange + visibilitychange that both fire on one resume', async () => {
    renderHook(() => useForegroundRefresh());
    await Promise.resolve();

    // A real iOS resume delivers both nearly together — only one refresh should run.
    appStateCb!({ isActive: true });
    setVisibility('visible');

    expect(mockRequestImmediateSync).toHaveBeenCalledTimes(1);
    expect(mockRequestNotesRefresh).toHaveBeenCalledTimes(1);
  });

  it('removes the native listener even if the component unmounts before it registers', async () => {
    const { unmount } = renderHook(() => useForegroundRefresh());
    // Unmount BEFORE the App.addListener promise resolves.
    unmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(removeHandle).toHaveBeenCalledTimes(1);
  });
});
