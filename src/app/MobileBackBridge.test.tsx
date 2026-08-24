/**
 * @jest-environment jsdom
 */
import React from 'react';

import { render } from '@testing-library/react';

import { goBack, navigate, HistoryAction } from 'lib/woozie';

import { MobileBackBridge } from './MobileBackBridge';

// ---------------------------------------------------------------------------
// Mutable mock state. The mocked `lib/woozie.useLocation` reads from this so a
// test can drive any pathname / historyPosition without rendering the real
// router + history stack. (`mock*` prefix lets the jest hoister let the factory
// close over it.)
// ---------------------------------------------------------------------------
const mockLocation = { pathname: '/', historyPosition: 0 };

// The bridge's whole behaviour lives inside the callback it hands to
// `useMobileBackHandler`. We stub the hook to capture that callback (and its
// dep array) at render time so each test can invoke it directly and assert the
// return value + navigation side effects — this is what exercises every branch
// of the source without needing the native Capacitor back-button plumbing.
const mockBack: {
  handler: (() => boolean | void) | null;
  deps: unknown[] | null;
} = { handler: null, deps: null };

// `lib/woozie` pulls in the full location/history/analytics stack. Stub the
// three symbols the bridge uses: `navigate` + `goBack` (spies) and
// `useLocation` (reads the shared mutable state). `HistoryAction` must be a
// real object because the source references `HistoryAction.Replace` as a value.
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  HistoryAction: { Push: 'push', Replace: 'replace' },
  useLocation: () => ({
    pathname: mockLocation.pathname,
    historyPosition: mockLocation.historyPosition
  })
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void, deps: unknown[]) => {
    mockBack.handler = handler;
    mockBack.deps = deps;
  }
}));

const navigateMock = navigate as jest.Mock;
const goBackMock = goBack as jest.Mock;

/**
 * Render the bridge at a given route so the fresh callback closes over the
 * matching inHome / isSettingsSubpage / isTabPage values, then hand back the
 * captured back handler for the test to invoke.
 */
const renderAt = (pathname: string, historyPosition = 0) => {
  mockLocation.pathname = pathname;
  mockLocation.historyPosition = historyPosition;
  const utils = render(<MobileBackBridge />);
  return { ...utils, handler: mockBack.handler! };
};

describe('MobileBackBridge', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    goBackMock.mockClear();
    mockBack.handler = null;
    mockBack.deps = null;
  });

  it('renders nothing (returns null)', () => {
    const { container } = renderAt('/');

    expect(container.firstChild).toBeNull();
  });

  it('registers a back handler with the location-derived dependency array', () => {
    renderAt('/settings/security', 3);

    expect(typeof mockBack.handler).toBe('function');
    // [pathname, historyPosition, inHome, isSettingsSubpage, isTabPage].
    // '/settings/security' is both a settings subpage AND a tab page (it
    // startsWith '/settings/'), so isTabPage is true too — the subpage branch
    // just wins first inside the handler.
    expect(mockBack.deps).toEqual(['/settings/security', 3, false, true, true]);
  });

  it('on a settings subpage with history: pops one level, like the header chevron', () => {
    // The settings screens are routes now and they nest — Keys pushes Reveal
    // private key, Authorized dApps pushes Connected dApps. Jumping to
    // '/settings' from here skipped the page the chevron goes back to.
    const { handler } = renderAt('/settings/reveal-private-key', 5);

    const result = handler();

    expect(result).toBe(true);
    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('on a cold-opened settings subpage: replaces to /settings and consumes the event', () => {
    const { handler } = renderAt('/settings/security', 0);

    const result = handler();

    expect(result).toBe(true);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/settings', HistoryAction.Replace);
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('on a tab page matched exactly (/history): replaces to home and consumes', () => {
    const { handler } = renderAt('/history', 4);

    const result = handler();

    expect(result).toBe(true);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/', HistoryAction.Replace);
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('on a nested tab page (/browser/dapp via startsWith): replaces to home and consumes', () => {
    const { handler } = renderAt('/browser/dapp', 0);

    const result = handler();

    expect(result).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith('/', HistoryAction.Replace);
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('treats the bare /settings tab as a tab page (not a settings subpage)', () => {
    const { handler } = renderAt('/settings', 0);

    // /settings does NOT start with '/settings/', so it falls through to the
    // tab-page branch and goes home rather than replacing to itself.
    const result = handler();

    expect(result).toBe(true);
    expect(navigateMock).toHaveBeenCalledWith('/', HistoryAction.Replace);
  });

  it('on a non-tab page with history: goes back and consumes', () => {
    const { handler } = renderAt('/send', 2);

    const result = handler();

    expect(result).toBe(true);
    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('on a non-tab, non-home page with no history: replaces to home and consumes', () => {
    const { handler } = renderAt('/send', 0);

    const result = handler();

    expect(result).toBe(true);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/', HistoryAction.Replace);
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('on home with no history: returns false so the system handles it', () => {
    const { handler } = renderAt('/', 0);

    const result = handler();

    expect(result).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(goBackMock).not.toHaveBeenCalled();
  });
});
