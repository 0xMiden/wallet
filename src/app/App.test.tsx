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

import { act, render, waitFor } from '@testing-library/react';

import { type AppEnvironment, WindowType } from 'app/env';
import type { StorageHealth } from 'lib/miden/storage-health';
import { initFeatureEligibility } from 'lib/remote-config/runtime';
import { isTelemetryEnabled } from 'lib/settings/helpers';
import { type WalletAccount, WalletStatus } from 'lib/shared/types';
import { clearLegacyAnalyticsStorage } from 'lib/telemetry';
import { initCrashReporting } from 'lib/telemetry/crash';
import { recordRelaySurface } from 'lib/telemetry/relay-diagnostics';
import { WalletType } from 'screens/onboarding/types';

// NOTE: App is required lazily (not statically imported) because App.tsx calls
// `isExtension()` at module scope, and the mock control fns below must be
// initialized before that runs. See `beforeAll`.
let App: React.ComponentType<{ env: AppEnvironment }>;

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
// Telemetry startup: legacy-identifier cleanup and crash reporting are independent
// of the usage-data choice. Mock clients to assert the startup wiring.
// ---------------------------------------------------------------------------
jest.mock('lib/telemetry', () => ({
  clearLegacyAnalyticsStorage: jest.fn()
}));

jest.mock('lib/telemetry/crash', () => ({
  initCrashReporting: jest.fn()
}));

jest.mock('lib/telemetry/relay-diagnostics', () => ({
  recordRelaySurface: jest.fn()
}));

// Test the App startup call. The AppKit provider has a separate config subscription.
jest.mock('lib/walletconnect/appkit', () => ({
  AppKitProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/remote-config/runtime', () => ({
  initFeatureEligibility: jest.fn(async () => ({
    state: 'ready',
    network: 'testnet',
    version: 1,
    allowed: { wallet: true, earn: true, swap: true }
  })),
  subscribeBridgeConfig: () => () => undefined,
  getBridgeConfigSnapshot: () => ({ network: 'testnet', config: null })
}));

const mockLoadEndpointOverrides = jest.fn<Promise<void>, []>(async () => undefined);
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  loadEndpointOverrides: () => mockLoadEndpointOverrides(),
  getEffectiveNetworkName: () => 'testnet'
}));

// `getThemeSetting` is here only because the (unmocked) AppKit provider reads it
// at module scope; mocking this module wholesale would otherwise break it.
jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual<typeof import('lib/settings/helpers')>('lib/settings/helpers'),
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
// MotionConfig surfaces its reducedMotion setting so the root wiring is assertable.
jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  MotionConfig: ({ children, reducedMotion }: { children?: React.ReactNode; reducedMotion?: string }) => (
    <div data-testid="motion-config" data-reduced-motion={reducedMotion}>
      {children}
    </div>
  )
}));

jest.mock('app/ErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

jest.mock('lib/ui/dialog', () => ({
  DialogsProvider: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="dialogs-provider">{children}</div>
  )
}));

jest.mock('app/env', () => ({
  AppEnvProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  WindowType: jest.requireActual<typeof import('app/env')>('app/env').WindowType
}));

jest.mock('lib/woozie', () => ({
  Provider: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}));

const createHealthyAvailability = (): StorageHealth => ({ status: 'healthy', epoch: 0 });
const healthyAvailability = createHealthyAvailability();
const retainedAccount: WalletAccount = {
  publicKey: 'retained-account',
  name: 'Retained account',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0,
  authScheme: 'ecdsa'
};
let mockMiden = {
  ready: true,
  locked: false,
  hydrated: true,
  storageAvailability: healthyAvailability,
  state: {
    status: WalletStatus.Ready,
    accounts: [retainedAccount],
    currentAccount: retainedAccount,
    networks: [],
    settings: null,
    ownMnemonic: false,
    storageAvailability: healthyAvailability
  }
};
jest.mock('lib/miden/front', () => ({
  MidenProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useMidenContext: () => mockMiden
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
  ),
  useHideForegroundDappWhileOpen: jest.fn()
}));

jest.mock('app/providers/UpdateNotificationProvider', () => ({
  UpdateNotificationProvider: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="update-notification-provider">{children}</div>
  )
}));

jest.mock('app/providers/GuardianRecoveryProvider', () => ({
  GuardianRecoveryProvider: () => <div data-testid="guardian-recovery-provider" />
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

jest.mock('app/ExternalPageFailedNotice', () => ({
  ExternalPageFailedNotice: () => <div data-testid="external-page-failed-notice" />
}));

jest.mock('app/templates/PinExtensionPrompt', () => ({
  PinExtensionPrompt: () => <div data-testid="pin-extension-prompt" />
}));

// The gate reads useAppEnv and Woozie.useLocation, which the env and router mocks above do not provide.
jest.mock('app/templates/HotKeyRotationGate', () => ({
  HotKeyRotationGate: () => <div data-testid="hot-key-rotation-gate" />
}));
jest.mock('app/templates/HotKeyRotatedOutGate', () => ({
  HotKeyRotatedOutGate: () => <div data-testid="hot-key-rotated-out-gate" />
}));

jest.mock('app/templates/OpenLinkPrompt', () => ({
  OpenLinkPrompt: () => <div data-testid="open-link-prompt" />
}));

jest.mock('app/templates/BreadConnectPrompt', () => ({
  BreadConnectPrompt: () => <div data-testid="bread-connect-prompt" />
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

let mockBackupRequired = false;
jest.mock('app/templates/SeedBackupGate', () => ({
  SeedBackupGate: ({ children }: { children: React.ReactNode }) => {
    if (mockBackupRequired) return <div data-testid="required-backup" />;
    return <>{children}</>;
  }
}));

jest.mock('lib/desktop/DesktopDappConfirmationModal', () => ({
  __esModule: true,
  DesktopDappConfirmationModal: () => <div data-testid="desktop-confirm-modal" />
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
type Env = AppEnvironment;

const renderApp = async (env: Env) => {
  const view = render(<App env={env} />);
  await act(async () => undefined);
  return view;
};

describe('app/App', () => {
  beforeAll(() => {
    // Evaluate App.tsx now that the mock control fns exist. With the default
    // `mockIsExtension === true`, this covers the module-load `if (isExtension())`
    // TRUE branch and its dynamic `import('lib/lock-up/run-checks')` line. A
    // plain require (no isolateModules) shares React with @testing-library.
    App = require('./App').default;
  });

  beforeEach(() => {
    mockBackupRequired = false;
    mockMiden = {
      ...mockMiden,
      storageAvailability: healthyAvailability,
      state: { ...mockMiden.state, storageAvailability: healthyAvailability }
    };
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
    mockLoadEndpointOverrides.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each(['extension', 'mobile', 'desktop', 'confirmation'])(
    'blocks %s controls during required backup',
    async surface => {
      mockBackupRequired = true;
      mockIsExtension.mockReturnValue(surface === 'extension' || surface === 'confirmation');
      mockIsMobile.mockReturnValue(surface === 'mobile');
      mockIsDesktop.mockReturnValue(surface === 'desktop');
      const view = await renderApp({ windowType: WindowType.FullPage, confirmWindow: surface === 'confirmation' });
      expect(view.getByTestId('required-backup')).toBeInTheDocument();
      if (surface === 'desktop') await view.findByTestId('desktop-dapp-handler');
      for (const id of [
        'page-router',
        'confirm-page',
        'desktop-confirm-modal',
        'dapp-browser-provider',
        'pin-extension-prompt',
        'dialogs',
        'open-link-prompt',
        'bread-connect-prompt'
      ]) {
        expect(view.queryByTestId(id)).not.toBeInTheDocument();
      }
    }
  );

  it('Task5 availability followon unavailable mobile mounts no signing or request prompts', async () => {
    mockIsExtension.mockReturnValue(false);
    mockIsMobile.mockReturnValue(true);
    mockIsDesktop.mockReturnValue(false);
    const storageAvailability: StorageHealth = {
      status: 'unavailable',
      epoch: 9,
      reason: 'continuity',
      backend: 'sdk',
      operation: 'open',
      time: 1000
    };
    mockMiden = { ...mockMiden, storageAvailability, state: { ...mockMiden.state, storageAvailability } };
    const view = await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });
    expect(view.queryByTestId('hot-key-rotation-gate')).not.toBeInTheDocument();
    expect(view.queryByTestId('hot-key-rotated-out-gate')).not.toBeInTheDocument();
    expect(view.queryByTestId('guardian-recovery-provider')).not.toBeInTheDocument();
    expect(view.queryByTestId('open-link-prompt')).not.toBeInTheDocument();
    expect(view.queryByTestId('bread-connect-prompt')).not.toBeInTheDocument();
    expect(view.queryByTestId('desktop-confirm-modal')).not.toBeInTheDocument();
    expect(view.queryByTestId('page-router')).toBeInTheDocument();
  });

  it('Task5 availability unavailable confirm window mounts no confirmation', async () => {
    const storageAvailability: StorageHealth = {
      status: 'unavailable',
      epoch: 7,
      reason: 'continuity',
      backend: 'sdk',
      operation: 'open',
      time: 1234
    };
    mockMiden = {
      ...mockMiden,
      storageAvailability,
      state: { ...mockMiden.state, storageAvailability }
    };

    const view = await renderApp({ windowType: WindowType.Popup, confirmWindow: true });

    expect(view.queryByTestId('confirm-page')).not.toBeInTheDocument();
    expect(view.queryByTestId('page-router')).not.toBeInTheDocument();
  });

  describe('extension surface (not mobile, not desktop, not confirm)', () => {
    it('renders PageRouter with the pin-extension prompt and no mobile/confirm surfaces', async () => {
      mockIsExtension.mockReturnValue(true);
      mockIsMobile.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });

      // Main content -> PageRouter (the default branch).
      expect(getByTestId('page-router')).toBeInTheDocument();
      expect(getByTestId('update-notification-provider')).toContainElement(getByTestId('page-router'));
      // Extension-only prompt is mounted.
      expect(getByTestId('pin-extension-prompt')).toBeInTheDocument();

      // Structural wrappers still render their leaves.
      expect(getByTestId('dialogs')).toBeInTheDocument();
      expect(getByTestId('disable-outlines')).toBeInTheDocument();
      expect(getByTestId('await-i18n')).toBeInTheDocument();
      expect(getByTestId('extension-message-listener')).toBeInTheDocument();

      // Mobile / confirm / desktop surfaces are absent.
      expect(queryByTestId('mobile-back-bridge')).not.toBeInTheDocument();
      expect(queryByTestId('external-page-failed-notice')).not.toBeInTheDocument();
      expect(queryByTestId('dapp-browser-provider')).not.toBeInTheDocument();
      expect(queryByTestId('open-link-prompt')).not.toBeInTheDocument();
      expect(queryByTestId('confirm-page')).not.toBeInTheDocument();
      expect(queryByTestId('desktop-dapp-handler')).not.toBeInTheDocument();
    });
  });

  describe('motion config', () => {
    it.each([
      ['extension', { windowType: WindowType.FullPage, confirmWindow: false }, 'page-router'],
      ['confirm window', { windowType: WindowType.Popup, confirmWindow: true }, 'confirm-page']
    ])('follows the OS reduced-motion setting around the whole %s tree', async (_label, env, leaf) => {
      const { getByTestId } = await renderApp(env);

      const config = getByTestId('motion-config');
      expect(config).toHaveAttribute('data-reduced-motion', 'user');
      expect(config).toContainElement(getByTestId(leaf));
      expect(config).toContainElement(getByTestId('dialogs'));
    });
  });

  describe('mobile surface (not extension, not desktop, not confirm)', () => {
    it('wraps PageRouter in the DappBrowserProvider and mounts the mobile back bridge and page-failure notice', async () => {
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(true);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });

      const dappHost = getByTestId('dapp-browser-provider');
      expect(dappHost).toBeInTheDocument();
      // PageRouter lives INSIDE the dApp browser host on mobile.
      expect(dappHost).toContainElement(getByTestId('page-router'));
      expect(dappHost).toContainElement(getByTestId('update-notification-provider'));
      // Opening a link's page needs the dApp browser.
      expect(dappHost).toContainElement(getByTestId('open-link-prompt'));

      // Mobile back bridge is mounted; extension prompt is not.
      expect(getByTestId('mobile-back-bridge')).toBeInTheDocument();
      // The notice shows an alert, so it has to sit under the dialog store.
      expect(getByTestId('dialogs-provider')).toContainElement(getByTestId('external-page-failed-notice'));
      expect(queryByTestId('pin-extension-prompt')).not.toBeInTheDocument();

      expect(queryByTestId('confirm-page')).not.toBeInTheDocument();
      expect(queryByTestId('desktop-dapp-handler')).not.toBeInTheDocument();
    });
  });

  describe('confirm window surface', () => {
    it('renders ConfirmPage and no router / dApp host', async () => {
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = await renderApp({ windowType: WindowType.FullPage, confirmWindow: true });

      expect(getByTestId('confirm-page')).toBeInTheDocument();
      expect(queryByTestId('page-router')).not.toBeInTheDocument();
      expect(queryByTestId('update-notification-provider')).not.toBeInTheDocument();
      expect(queryByTestId('dapp-browser-provider')).not.toBeInTheDocument();
    });

    it('prefers ConfirmPage over the mobile surface when both env.confirmWindow and isMobile are set', async () => {
      // confirmWindow short-circuits the ternary before the isMobile check.
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(true);
      mockIsDesktop.mockReturnValue(false);

      const { getByTestId, queryByTestId } = await renderApp({ windowType: WindowType.FullPage, confirmWindow: true });

      expect(getByTestId('confirm-page')).toBeInTheDocument();
      expect(queryByTestId('dapp-browser-provider')).not.toBeInTheDocument();
      expect(queryByTestId('page-router')).not.toBeInTheDocument();
      expect(queryByTestId('update-notification-provider')).not.toBeInTheDocument();
    });
  });

  describe('desktop surface', () => {
    it('lazily mounts the desktop dApp handler and confirmation modal alongside PageRouter', async () => {
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(false);
      mockIsDesktop.mockReturnValue(true);

      const { getByTestId, findByTestId, queryByTestId } = await renderApp({
        windowType: WindowType.FullPage,
        confirmWindow: false
      });

      // The desktop components are React.lazy'd, so they resolve on a microtask.
      expect(await findByTestId('desktop-dapp-handler')).toBeInTheDocument();
      expect(await findByTestId('desktop-confirm-modal')).toBeInTheDocument();

      await waitFor(() => expect(getByTestId('page-router')).toBeInTheDocument());
      expect(getByTestId('update-notification-provider')).toContainElement(getByTestId('page-router'));

      // Desktop is neither mobile nor extension in this configuration.
      expect(queryByTestId('mobile-back-bridge')).not.toBeInTheDocument();
      expect(queryByTestId('external-page-failed-notice')).not.toBeInTheDocument();
      expect(queryByTestId('pin-extension-prompt')).not.toBeInTheDocument();
    });
  });

  describe('telemetry startup', () => {
    it('clears the legacy analytics identifier on mount, whatever the consent', async () => {
      await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });

      // The dormant `localStorage['analytics']` userId is data we hold with no
      // basis, so deleting it is unconditional — not something the user has to
      // opt out of telemetry to get.
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
    });

    it('starts crash reporting when usage sharing is disabled', async () => {
      mockIsTelemetryEnabled.mockReturnValue(false);

      await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });

      expect(mockIsTelemetryEnabled).not.toHaveBeenCalled();
      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
    });

    it('starts crash reporting when usage sharing is enabled', async () => {
      mockIsTelemetryEnabled.mockReturnValue(true);

      await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });

      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
    });

    it('starts crash reporting once per mount, not once per render', async () => {
      mockIsTelemetryEnabled.mockReturnValue(false);

      const { rerender } = await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });
      rerender(<App env={{ windowType: WindowType.FullPage, confirmWindow: false }} />);

      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
    });

    it('starts crash reporting on the confirm-window surface with usage sharing disabled', async () => {
      mockIsTelemetryEnabled.mockReturnValue(false);

      await renderApp({ windowType: WindowType.FullPage, confirmWindow: true });

      // A dApp confirmation is where a crash is most costly to a user, so it is
      // not a surface to leave unreported.
      expect(mockClearLegacyAnalyticsStorage).toHaveBeenCalledTimes(1);
      expect(mockInitCrashReporting).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['popup', { windowType: WindowType.Popup }],
      ['fullpage', { windowType: WindowType.FullPage }],
      ['sidepanel', { windowType: WindowType.SidePanel }],
      ['confirm', { windowType: WindowType.Popup, confirmWindow: true }]
    ])('records the window as %s for relay failure reports', async (surface, env) => {
      await renderApp(env);

      expect(jest.mocked(recordRelaySurface)).toHaveBeenCalledWith(surface);
    });
  });

  describe('startup eligibility', () => {
    it('initializes eligibility once per mount, whatever screen opens first', async () => {
      const { rerender } = await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });
      rerender(<App env={{ windowType: WindowType.FullPage, confirmWindow: false }} />);

      expect(jest.mocked(initFeatureEligibility)).toHaveBeenCalledTimes(1);
    });

    it('loads it on the mobile and confirm-window surfaces too', async () => {
      mockIsExtension.mockReturnValue(false);
      mockIsMobile.mockReturnValue(true);
      const { unmount } = await renderApp({ windowType: WindowType.FullPage, confirmWindow: false });
      unmount();

      await renderApp({ windowType: WindowType.Popup, confirmWindow: true });

      expect(jest.mocked(initFeatureEligibility)).toHaveBeenCalledTimes(2);
    });
  });

  describe('module-load lock-up check', () => {
    it('skips the lock-up import when not running as an extension (false branch)', async () => {
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

jest.mock('./StorageRecoveryPage', () => ({
  StorageRecoveryPage: () => <div data-testid="storage-recovery-page" />
}));
