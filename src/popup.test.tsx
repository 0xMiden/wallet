/**
 * src/popup.tsx — the extension "Popup" window entry point.
 *
 * The module has no exports; everything happens as import-time side effects:
 *   1. a `Buffer` polyfill on `globalThis` (`globalThis.Buffer || Buffer`),
 *   2. `initTheme()`,
 *   3. `createRoot(#root).render(<App env={{ windowType: WindowType.Popup }} />)`,
 *   4. a popup-context guard:
 *        `if (!popups.includes(window) || !isPopupModeEnabled()) { openInFullPage(); window.close(); }`
 *
 * The whole testable surface is therefore reached by importing the module with
 * a real `#root` present (so the real `createRoot` mounts the tree) while
 * controlling the two guard inputs — `browser.extension.getViews(...)` and
 * `isPopupModeEnabled()` — to walk every branch of the `||`.
 *
 * We keep the REAL `react-dom/client` so the render executes real JSX, and
 * replace only the heavy leaf deps (App, app/env, popup-mode, theme, css,
 * lock-up checks, webextension-polyfill).
 *
 * Because the guard runs at import time, each scenario re-imports the module in
 * an isolated module registry (`jest.isolateModules`) after configuring the
 * mocks — mirroring the isolated-re-eval technique in options.test.tsx.
 */

import React from 'react';

import { act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Stable jest.fn identities captured once; behaviour reconfigured per test.
// `mock`-prefixed so the swc jest transform allows referencing them from the
// hoisted `jest.mock` factories (same convention as options.test.tsx).
// ---------------------------------------------------------------------------
const mockInitTheme = jest.fn();
const mockOpenInFullPage = jest.fn();
const mockIsPopupModeEnabled = jest.fn();
const mockGetViews = jest.fn();
const mockAppRender = jest.fn();

// A distinctive sentinel for WindowType.Popup so the assertion that App is
// rendered with the popup env is meaningful.
const POPUP_WINDOW_TYPE = 'popup-window-type';

// Side-effect-only / leaf imports: no-op them so no CSS parsing or lock-up
// checks run.
jest.mock('./main.css', () => ({}));
jest.mock('lib/lock-up/run-checks', () => ({}));

// App is mocked to a trivial component that records the props it was rendered
// with, so we can assert the popup env is threaded through.
jest.mock('app/App', () => ({
  __esModule: true,
  default: (props: any) => {
    mockAppRender(props);
    return <div data-testid="popup-app" />;
  }
}));

jest.mock('app/env', () => ({
  __esModule: true,
  WindowType: { Popup: 'popup-window-type', FullPage: 'fullpage-window-type', SidePanel: 'sidepanel-window-type' },
  openInFullPage: (...args: unknown[]) => mockOpenInFullPage(...args)
}));

jest.mock('lib/popup-mode', () => ({
  isPopupModeEnabled: (...args: unknown[]) => mockIsPopupModeEnabled(...args)
}));

jest.mock('lib/settings/theme', () => ({
  initTheme: (...args: unknown[]) => mockInitTheme(...args)
}));

// webextension-polyfill: control `browser.extension.getViews` per test. (There
// is an auto-applied manual mock under __mocks__ whose getViews returns [];
// this factory overrides it so we can drive the guard's first operand.)
jest.mock('webextension-polyfill', () => ({
  __esModule: true,
  default: {
    extension: {
      getViews: (...args: unknown[]) => mockGetViews(...args)
    }
  }
}));

/**
 * Ensure a fresh `#root` element exists, then import `popup.tsx` in an isolated
 * module registry so its import-time side effects re-run against the currently
 * configured mocks. Wrapped in `act` so the real `createRoot(...).render(...)`
 * flushes synchronously.
 */
async function loadPopup() {
  const existing = document.getElementById('root');
  if (existing) existing.remove();
  const rootEl = document.createElement('div');
  rootEl.id = 'root';
  document.body.appendChild(rootEl);

  await act(async () => {
    jest.isolateModules(() => {
      require('./popup');
    });
  });

  // popup.tsx requires a fresh `react-dom/client` inside the isolated registry,
  // whose concurrent render commits on a scheduler macrotask that the
  // statically-imported `act` (bound to a different react-dom instance) can't
  // flush. Yield to the macrotask queue so the real render commits and the
  // mocked <App> executes before we assert on it.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

let closeSpy: jest.SpyInstance;

beforeEach(() => {
  mockInitTheme.mockReset();
  mockOpenInFullPage.mockReset();
  mockIsPopupModeEnabled.mockReset();
  mockGetViews.mockReset();
  mockAppRender.mockReset();
  // jsdom's window.close is a no-op that logs "Not implemented"; spy to both
  // silence it and assert on it.
  closeSpy = jest.spyOn(window, 'close').mockImplementation(() => undefined);
});

afterEach(() => {
  closeSpy.mockRestore();
});

describe('src/popup.tsx', () => {
  it('initialises the theme and mounts <App> (popup env) into #root', async () => {
    // Stay in popup context so the guard does NOT fire and tear things down.
    mockGetViews.mockReturnValue([window]);
    mockIsPopupModeEnabled.mockReturnValue(true);

    await loadPopup();

    expect(mockInitTheme).toHaveBeenCalledTimes(1);
    // Real createRoot rendered the mocked App into #root.
    expect(document.querySelector('[data-testid="popup-app"]')).not.toBeNull();
    expect(mockAppRender).toHaveBeenCalledTimes(1);
    expect(mockAppRender).toHaveBeenCalledWith(
      expect.objectContaining({ env: { windowType: POPUP_WINDOW_TYPE } })
    );
    // getViews consulted with the popup filter.
    expect(mockGetViews).toHaveBeenCalledWith({ type: 'popup' });
  });

  it('does nothing when in a real popup view AND popup mode is enabled', async () => {
    // Guard: !includes(false) || !enabled(false) => false — no redirect.
    mockGetViews.mockReturnValue([window]);
    mockIsPopupModeEnabled.mockReturnValue(true);

    await loadPopup();

    expect(mockIsPopupModeEnabled).toHaveBeenCalledTimes(1);
    expect(mockOpenInFullPage).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('opens full page and closes when this window is NOT a popup view', async () => {
    // First operand true: !popups.includes(window) === true (short-circuits ||),
    // so isPopupModeEnabled is never consulted.
    mockGetViews.mockReturnValue([]);
    mockIsPopupModeEnabled.mockReturnValue(true);

    await loadPopup();

    expect(mockOpenInFullPage).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Short-circuited: second operand not evaluated.
    expect(mockIsPopupModeEnabled).not.toHaveBeenCalled();
  });

  it('opens full page and closes when popup mode is disabled', async () => {
    // First operand false (window is a popup view), second operand true
    // (!isPopupModeEnabled()) => redirect.
    mockGetViews.mockReturnValue([window]);
    mockIsPopupModeEnabled.mockReturnValue(false);

    await loadPopup();

    expect(mockIsPopupModeEnabled).toHaveBeenCalledTimes(1);
    expect(mockOpenInFullPage).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('installs the Buffer polyfill when globalThis.Buffer is absent', async () => {
    // Exercise the right-hand side of `globalThis.Buffer || Buffer` by
    // re-evaluating the module with Buffer unset. Keep the guard inert.
    mockGetViews.mockReturnValue([window]);
    mockIsPopupModeEnabled.mockReturnValue(true);

    const saved = (globalThis as unknown as { Buffer?: unknown }).Buffer;
    try {
      delete (globalThis as unknown as { Buffer?: unknown }).Buffer;
      await loadPopup();
      expect((globalThis as unknown as { Buffer?: unknown }).Buffer).toBeDefined();
    } finally {
      (globalThis as unknown as { Buffer?: unknown }).Buffer = saved;
    }
  });
});
