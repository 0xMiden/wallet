/* eslint-disable import/first */
/**
 * Tests for `useNativeNavbarAction` — the hook that hoists a page's
 * primary action button into the native navbar overlay's compact
 * mode. Key guarantees:
 *
 *  - On mobile, setNavbarAction fires with the requested label/enabled.
 *  - On non-mobile, the hook is a no-op (never touches the plugin).
 *  - A successor page's mount doesn't get clobbered by the predecessor
 *    page's unmount (multi-page handoff guard via the ownerId ref).
 *  - Passing null while owning clears the action.
 */

// Using the `mock*` prefix opts out of jest's reference-check rule
// for jest.mock factories. The arrow-function wrappers below are
// intentional: they capture the variable lazily, so by the time
// jest calls through the factory (on import of the mocked module)
// the consts have been initialized. A direct `mock*` reference in
// the factory would hit the temporal dead zone.
const mockSetNavbarAction: jest.Mock = jest.fn();
const mockClearNavbarAction: jest.Mock = jest.fn();
const mockAddListener: jest.Mock = jest.fn(() => Promise.resolve({ remove: jest.fn() }));

jest.mock('@miden/dapp-browser', () => ({
  InAppBrowser: {
    setNavbarAction: (...args: unknown[]) => mockSetNavbarAction(...args),
    clearNavbarAction: (...args: unknown[]) => mockClearNavbarAction(...args),
    addListener: (...args: unknown[]) => mockAddListener(...args)
  }
}));

const mockIsMobile: jest.Mock = jest.fn();
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

import { act, renderHook } from '@testing-library/react';

// Import under test AFTER mocks.
import { useNativeNavbarAction } from './use-native-navbar-action';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMobile.mockReturnValue(true);
});

describe('mobile path', () => {
  it('installs the native action on mount', () => {
    renderHook(() => useNativeNavbarAction({ label: 'Continue', enabled: true, onTap: () => undefined }));
    expect(mockSetNavbarAction).toHaveBeenCalledWith({ label: 'Continue', enabled: true });
  });

  it('defaults enabled to true when not specified', () => {
    renderHook(() => useNativeNavbarAction({ label: 'Go', onTap: () => undefined }));
    expect(mockSetNavbarAction).toHaveBeenCalledWith({ label: 'Go', enabled: true });
  });

  it('clears the action on unmount', () => {
    const { unmount } = renderHook(() => useNativeNavbarAction({ label: 'Continue', onTap: () => undefined }));
    unmount();
    expect(mockClearNavbarAction).toHaveBeenCalled();
  });

  it('updates the native action when label changes', () => {
    const { rerender } = renderHook(
      ({ label }: { label: string }) => useNativeNavbarAction({ label, onTap: () => undefined }),
      {
        initialProps: { label: 'First' }
      }
    );
    expect(mockSetNavbarAction).toHaveBeenLastCalledWith({ label: 'First', enabled: true });

    rerender({ label: 'Second' });
    expect(mockSetNavbarAction).toHaveBeenLastCalledWith({ label: 'Second', enabled: true });
  });

  it('updates the native action when enabled toggles', () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useNativeNavbarAction({ label: 'Continue', enabled, onTap: () => undefined }),
      { initialProps: { enabled: true } }
    );
    expect(mockSetNavbarAction).toHaveBeenLastCalledWith({ label: 'Continue', enabled: true });
    rerender({ enabled: false });
    expect(mockSetNavbarAction).toHaveBeenLastCalledWith({ label: 'Continue', enabled: false });
  });

  it('clears the action when the caller passes null while owning the slot', () => {
    const { rerender } = renderHook(
      ({ action }: { action: { label: string; onTap: () => void } | null }) => useNativeNavbarAction(action),
      {
        initialProps: {
          action: { label: 'Continue', onTap: () => undefined } as { label: string; onTap: () => void } | null
        }
      }
    );
    expect(mockSetNavbarAction).toHaveBeenCalled();
    mockClearNavbarAction.mockClear();

    rerender({ action: null });
    expect(mockClearNavbarAction).toHaveBeenCalled();
  });
});

describe('non-mobile path', () => {
  it('is a no-op when isMobile() returns false', () => {
    mockIsMobile.mockReturnValue(false);
    renderHook(() => useNativeNavbarAction({ label: 'Continue', onTap: () => undefined }));
    expect(mockSetNavbarAction).not.toHaveBeenCalled();
    expect(mockClearNavbarAction).not.toHaveBeenCalled();
  });
});

describe('multi-page handoff guard', () => {
  it('predecessor unmount does NOT clear the successor\u2019s installed action', async () => {
    // Page A mounts with an action.
    const pageA = renderHook(() => useNativeNavbarAction({ label: 'PageA-Continue', onTap: () => undefined }));
    expect(mockSetNavbarAction).toHaveBeenLastCalledWith({ label: 'PageA-Continue', enabled: true });

    // Page B mounts while A is still mounted — becomes the new owner.
    const pageB = renderHook(() => useNativeNavbarAction({ label: 'PageB-Next', onTap: () => undefined }));
    expect(mockSetNavbarAction).toHaveBeenLastCalledWith({ label: 'PageB-Next', enabled: true });

    mockClearNavbarAction.mockClear();

    // A unmounts. Since B now owns the slot, A's cleanup must be a no-op.
    act(() => {
      pageA.unmount();
    });
    expect(mockClearNavbarAction).not.toHaveBeenCalled();

    // B unmounts. It still owns the slot, so clear fires.
    act(() => {
      pageB.unmount();
    });
    expect(mockClearNavbarAction).toHaveBeenCalled();
  });
});
