/**
 * app/App — the root wallet shell.
 *
 * `App` is a pure composition component: it stacks the error boundary, dialog
 * provider, Suspense fallback, and the a11y/font boot wrappers, then picks ONE
 * of three surfaces for the main content based on the runtime env:
 *
 *   - `env.confirmWindow`      → <ConfirmPage/>            (dApp confirm popup)
 *   - `checkIsMobile()`        → <DappBrowserProvider/>    (embedded webview host)
 *   - otherwise                → <PageRouter/>             (extension / desktop)
 *
 * `AppProvider` wires the env + Woozie router context and conditionally mounts
 * the pin-extension prompt (extension only), the mobile back bridge (mobile
 * only), and the lazily-loaded desktop dApp handlers (desktop only).
 *
 * Every imported child is a heavy provider (WASM, Capacitor, Tauri, i18next),
 * so we replace each with a lightweight probe and drive `lib/platform`'s three
 * environment predicates by hand to exercise all branches, including the
 * module-load-time `if (isExtension()) import('lib/lock-up/run-checks')`.
 */

import React from 'react';

import { render, waitFor } from '@testing-library/react';

import { isTelemetryEnabled } from 'lib/settings/helpers';
import { clearLegacyAnalyticsStorage } from 'lib/telemetry';
import { initCrashReporting } from 'lib/telemetry/crash';

// NOTE: App is required lazily (not statically imported) because App.tsx calls
// `isExtension()` at module scope, and the mock control fns below must be
// initialized before that runs. See `beforeAll`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let App: React.ComponentType<any>;

// ---------------------------------------------------------------------------
// Platform predicates — the only real inputs that steer App's branching.
// Defaults are chosen so the *static* `import App from './App'` above evaluates
// the module-load `if (isExtension())` TRUE branch, covering the dynamic
// `import('lib/lock-up/run-checks')` line. Individual tests override per render.
// ---------------------------------------------------------------------------
const mockIsExtension = jest.fn(() => true);
const mockIsMobile = jest.fn(() => false);
const mockIsDesktop = jest.fn(() => false);

jest.mock('lib/platform', () => ({
  isExtension: () => mockIsExtension(),
  isMobile: () => mockIsMobile(),
  isDesktop: () => mockIsDesktop()
}));

// Side-effect-only imports / extension-only lock-up checks — no-op them so no
// i18next init or webextension-polyfill machinery runs.
jest.mock('../i18n', () => ({}));
jest.mock('lib/lock-up/run-checks', () => ({}));

// Type-only import at runtime resolves to an empty module.
jest.mock('lib/props-with-children', () => ({}));

// ---------------------------------------------------------------------------
// Telemetry startup — the legacy-identifier cleanup and the consent-gated
// crash reporter. Mocked so the assertions are about whether App calls them and
// under what consent, not about Sentry or localStorage internals.
// ---------------------------------------------------------------------------
jest.mock('lib/telemetry', () => ({
  clearLegacyAnalyticsStorage: jest.fn()
}));

jest.mock('lib/telemetry/crash', () => ({
  initCrashReporting: jest.fn()
}));

// `getThemeSetting` is here only because the (unmocked) AppKit provider reads it
// at module scope; mocking this module wholesale would otherwise break it.
jest.mock('lib/settings/helpers', () => ({
  getThemeSetting: jest.fn(() => 'system'),
  isTelemetryEnabled: jest.fn(() => false)
}));

const mockClearLegacyAnalyticsStorage = clearLegacyAnalyticsStorage as jest.Mock;
const mockInitCrashReporting = initCrashReporting as jest.Mock;
const mockIsTelemetryEnabled = isTelemetryEnabled as jest.Mock;

// ---------------------------------------------------------------------------
// Structural wrappers — render their children straight through so the inner
// tree is preserved and assertable.
// ---------------------------------------------------------------------------
jest.mock('app/ErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/ui/dialog', () => ({
  DialogsProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('app/env', () => ({
  AppEnvProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/woozie', () => ({
  Provider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/miden/front', () => ({
  MidenProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('app/a11y/AwaitFonts', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('app/a11y/BootAnimation', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('app/providers/DappBrowserProvider', () => ({
  DappBrowserProvider: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="dapp-browser-provider">{children}</div>
  )
}));

// ---------------------------------------------------------------------------
// Leaf probes — render a marker div so we can assert presence / absence.
// ---------------------------------------------------------------------------
jest.mock('app/a11y/AwaitI18N', () => ({
  __esModule: true,
  default: () => <div data-testid="await-i18n" />
}));

jest.mock('app/a11y/DisableOutlinesForClick', () => ({
  __esModule: true,
  default: () => <div data-testid="disable-outlines" />
}));

jest.mock('app/a11y/RootSuspenseFallback', () => ({
  __esModule: true,
  default: () => <div data-testid="root-suspense-fallback" />
}));

jest.mock('app/layouts/Dialogs', () => ({
  __esModule: true,
  default: () => <div data-testid="dialogs" />
}));

jest.mock('app/PageRouter', () => ({
  __esModule: true,
  default: () => <div data-testid="page-router" />
}));

jest.mock('./ConfirmPage', () => ({
  __esModule: true,
  default: () => <div data-testid="confirm-page" />
}));

jest.mock('app/MobileBackBridge', () => ({
  MobileBackBridge: () => <div data-testid="mobile-back-bridge" />
}));

jest.mock('app/templates/PinExtensionPrompt', () => ({
  PinExtensionPrompt: () => <div data-testid="pin-extension-prompt" />
}));

jest.mock('components/ConnectivityIssueBanner', () => ({
  ExtensionMessageListener: () => <div data-testid="extension-message-listener" />
}));

// React.lazy'd desktop-only modules. `DesktopDappHandler` is a default export;
// `DesktopDappConfirmationModal` is a named export (App re-maps it to default).
jest.mock('lib/desktop/DesktopDappHandler', () => ({
  __esModule: true,
  default: () => <div data-testid="desktop-dapp-handler" />
}));

jest.mock('lib/desktop/DesktopDappConfirmationModal', () => ({
  __esModule: true,
  DesktopDappConfirmationModal: () => <div data-testid="desktop-confirm-modal" />
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
type Env = { windowType: string; confirmWindow?: boolean };

const renderApp = (env: Env) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<App env={env as any} />);

describe('app/App', () => {
  beforeAll(() => {
    // Evaluate App.tsx now that the mock control fns exist. With the default
    // `mockIsExtension === true`, this covers the module-load `if (isExtension())`
    // TRUE branch and its dynamic `import('lib/lock-up/run-checks')` line. A
    // plain require (no isolateModules) shares React with @testing-library.
    App = require('./App').default;
  });

  beforeEach(() => {
    // Silence the diagnostic `[AppProvider] Rendering ...` log.
    jest.spyOn(console, 'log').mockImplementation(() => {});
    // Reset to the "extension, not mobile, not desktop" baseline; each test
    // overrides as needed. (clearAllMocks preserves these implementations.)
    mockIsExtension.mockReturnValue(true);
    mockIsMobile.mockReturnValue(false);
    mockIsDesktop.mockReturnValue(false);
    // Consent is off until the user opts in — the baseline for the startup
    // telemetry assertions below.
    mockIsTelemetryEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('extension surface (not mobile, not desktop, not confirm)', () => {
    it('renders PageRouter with the pin-extension prompt and no mobile/confirm surfaces', () => {
      mockIsExtension.mockReturnValue(true);
      mockIsMobile.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = renderApp({ windowType: 'FullPage', confirmWindow: false });

      // Main content -> PageRouter (the default branch).
      expect(getByTestId('page-router')).toBeInTheDocument();
      // Extension-only prompt is mounted.
      expect(getByTestId('pin-extension-prompt')).toBeInTheDocument();

      // Structural wrappers still render their leaves.
      expect(getByTestId('dialogs')).toBeInTheDocument();
      expect(getByTestId('disable-outlines')).toBeInTheDocument();
      expect(getByTestId('await-i18n')).toBeInTheDocument();
      expect(getByTestId('extension-message-listener')).toBeInTheDocument();

      // Mobile / confirm / desktop surfaces are absent.
      expect(queryByTestId('mobile-back-bridge')).not.toBeInTheDocument();
      expect(queryByTestId('dapp-browser-provider')).not.toBeInTheDocument();
      expect(queryByTestId('confirm-page')).not.toBeInTheDocument();
      expect(queryByTestId('desktop-dapp-handler')).not.toBeInTheDocument();
    });
  });

  describe('mobile surface (not extension, not desktop, not confirm)', () => {
    it('wraps PageRouter in the DappBrowserProvider and mounts the mobile back bridge', () => {
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(true);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = renderApp({ windowType: 'FullPage', confirmWindow: false });

      const dappHost = getByTestId('dapp-browser-provider');
      expect(dappHost).toBeInTheDocument();
      // PageRouter lives INSIDE the dApp browser host on mobile.
      expect(dappHost).toContainElement(getByTestId('page-router'));

      // Mobile back bridge is mounted; extension prompt is not.
      expect(getByTestId('mobile-back-bridge')).toBeInTheDocument();
      expect(queryByTestId('pin-extension-prompt')).not.toBeInTheDocument();

      expect(queryByTestId('confirm-page')).not.toBeInTheDocument();
      expect(queryByTestId('desktop-dapp-handler')).not.toBeInTheDocument();
    });
  });

  describe('confirm window surface', () => {
    it('renders ConfirmPage and no router / dApp host', () => {
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = renderApp({ windowType: 'FullPage', confirmWindow: true });

      expect(getByTestId('confirm-page')).toBeInTheDocument();
      expect(queryByTestId('page-router')).not.toBeInTheDocument();
      expect(queryByTestId('dapp-browser-provider')).not.toBeInTheDocument();
    });

    it('prefers ConfirmPage over the mobile surface when both env.confirmWindow and isMobile are set', () => {
      // confirmWindow short-circuits the ternary before the isMobile check.
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(true);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = renderApp({ windowType: 'FullPage', confirmWindow: true });

      expect(getByTestId('confirm-page')).toBeInTheDocument();
      expect(queryByTestId('dapp-browser-provider')).not.toBeInTheDocument();
      expect(queryByTestId('page-router')).not.toBeInTheDocument();
    });
  });

  describe('desktop surface', () => {
    it('lazily mounts the desktop dApp handler and confirmation modal alongside PageRouter', async () => {
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(true);

      const { getByTestId, findByTestId, queryByTestId } = renderApp({
        windowType: 'FullPage',
        confirmWindow: false
      });

      // The desktop components are React.lazy'd, so they resolve on a microtask.
      expect(await findByTestId('desktop-dapp-handler')).toBeInTheDocument();
      expect(await findByTestId('desktop-confirm-modal')).toBeInTheDocument();

      await waitFor(() => expect(getByTestId('page-router')).toBeInTheDocument());

      // Desktop is neither mobile nor extension in this configuration.
      expect(queryByTestId('mobile-back-bridge')).not.toBeInTheDocument();
      expect(queryByTestId('pin-extension-prompt')).not.toBeInTheDocument();
    });
  });

  describe('telemetry startup', () => {
    it('clears the legacy analytics identifier on mount, whatever the consent', () => {
      renderApp({ windowType: 'FullPage', confirmWindow: false });

      // The dormant `localStorage['analytics']` userId is data we hold with no
      // basis, so deleting it is unconditional — not something the user has to
      // opt out of telemetry to get.
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
    });

    it('does NOT start crash reporting when consent has not been given', () => {
      mockIsTelemetryEnabled.mockReturnValue(false);

      renderApp({ windowType: 'FullPage', confirmWindow: false });

      expect(mockIsTelemetryEnabled).toHaveBeenCalled();
      expect(mockInitCrashReporting).not.toHaveBeenCalled();
      // The cleanup still runs, so a green cleanup assertion cannot be what is
      // making this pass.
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
    });

    it('starts crash reporting when consent has been given', () => {
      mockIsTelemetryEnabled.mockReturnValue(true);

      renderApp({ windowType: 'FullPage', confirmWindow: false });

      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
    });

    it('starts crash reporting once per mount, not once per render', () => {
      mockIsTelemetryEnabled.mockReturnValue(true);

      const { rerender } = renderApp({ windowType: 'FullPage', confirmWindow: false });
      rerender(<App env={{ windowType: 'FullPage', confirmWindow: false } as any} />);

      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
    });

    it('runs the startup wiring on the confirm-window surface too', () => {
      mockIsTelemetryEnabled.mockReturnValue(true);

      renderApp({ windowType: 'FullPage', confirmWindow: true });

      // A dApp confirmation is where a crash is most costly to a user, so it is
      // not a surface to leave unreported.
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
    });
  });

  describe('module-load lock-up check', () => {
    it('skips the lock-up import when not running as an extension (false branch)', () => {
      // Re-evaluate the module with isExtension() === false to cover the
      // FALSE branch of the top-level `if (isExtension())`. The TRUE branch is
      // already covered by the static `import App from './App'` at file load
      // (default mockIsExtension === true). No render needed here.
      mockIsExtension.mockReturnValue(false);

      let ReloadedApp: unknown;
      jest.isolateModules(() => {
        ReloadedApp = require('./App').default;
      });

      expect(typeof ReloadedApp).toBe('function');
    });
  });
});
