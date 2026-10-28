import React, { ComponentProps, FC, Suspense, useEffect } from 'react';

import { MotionConfig } from 'framer-motion';

// Lock-up checks are extension-only - skip on mobile

import AwaitFonts from 'app/a11y/AwaitFonts';
import AwaitI18N from 'app/a11y/AwaitI18N';
import BootAnimation from 'app/a11y/BootAnimation';
import DisableOutlinesForClick from 'app/a11y/DisableOutlinesForClick';
import RootSuspenseFallback from 'app/a11y/RootSuspenseFallback';
import { AppEnvProvider, WindowType } from 'app/env';
import ErrorBoundary from 'app/ErrorBoundary';
import { ExternalPageFailedNotice } from 'app/ExternalPageFailedNotice';
import Dialogs from 'app/layouts/Dialogs';
import { MobileBackBridge } from 'app/MobileBackBridge';
import PageRouter from 'app/PageRouter';
import { DappBrowserProvider } from 'app/providers/DappBrowserProvider';
import { GuardianRecoveryProvider } from 'app/providers/GuardianRecoveryProvider';
import { UpdateNotificationProvider } from 'app/providers/UpdateNotificationProvider';
import { BreadConnectPrompt } from 'app/templates/BreadConnectPrompt';
import { HotKeyRotatedOutGate } from 'app/templates/HotKeyRotatedOutGate';
import { HotKeyRotationGate } from 'app/templates/HotKeyRotationGate';
import { OpenLinkPrompt } from 'app/templates/OpenLinkPrompt';
import { PinExtensionPrompt } from 'app/templates/PinExtensionPrompt';
import { ScreenKeyPublisher } from 'app/templates/ScreenKeyPublisher';
import { SeedBackupGate } from 'app/templates/SeedBackupGate';
import { ExtensionMessageListener } from 'components/ConnectivityIssueBanner';
import { MidenProvider, request, useMidenContext } from 'lib/miden/front';
import { isDesktop as checkIsDesktop, isExtension, isMobile as checkIsMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';
import { WalletMessageType } from 'lib/shared/types';
import { clearLegacyAnalyticsStorage } from 'lib/telemetry';
// Deep import: the barrel deliberately does not re-export `crash`, so that
// `@sentry/browser` stays out of the many chunks that only want `beginFlow`.
import { initCrashReporting } from 'lib/telemetry/crash';
import { recordRelaySurface, type RelaySurface } from 'lib/telemetry/relay-diagnostics';
import { setOperationTransport } from 'lib/telemetry/report-operation';
import { DialogsProvider } from 'lib/ui/dialog';
import { AppKitProvider } from 'lib/walletconnect/appkit';
import * as Woozie from 'lib/woozie';
import '../i18n';

import ConfirmPage from './ConfirmPage';
import { RuntimeSupportGate } from './RuntimeSupportGate';
import { StorageRecoveryPage } from './StorageRecoveryPage';
import { WalletAccessGate } from './WalletAccessGate';
// Lock-up checks are extension-only (uses webextension-polyfill)
if (isExtension()) {
  import('lib/lock-up/run-checks');
}

interface AppProps extends Partial<PropsWithChildren> {
  env: ComponentProps<typeof AppEnvProvider>;
}

// Mobile and desktop render the full page too; the report's platform and build target tell them apart.
const RELAY_SURFACE: Record<WindowType, RelaySurface> = {
  [WindowType.Popup]: 'popup',
  [WindowType.FullPage]: 'fullpage',
  [WindowType.SidePanel]: 'sidepanel'
};

const App: FC<AppProps> = ({ env }) => {
  useEffect(() => {
    recordRelaySurface(env.confirmWindow ? 'confirm' : RELAY_SURFACE[env.windowType]);
  }, [env.windowType, env.confirmWindow]);

  useEffect(() => {
    // Unconditional: the dormant `localStorage['analytics']` identifier from the
    // removed analytics scaffold is data held with no basis, so it goes whether
    // or not the user ever consents to anything.
    clearLegacyAnalyticsStorage();
    // How an operation reported from a page reaches the wire. Installed rather
    // than imported by the reporter, which also runs inside the service worker
    // and must not pull this message client into the worker's bundle. Ungated:
    // the transport only carries an event to the worker, which applies the same
    // consent check every other event passes through.
    setOperationTransport(event => request({ type: WalletMessageType.ReportTelemetryEventRequest, event }).then());
    // Crash reports are independent of usage sharing. Capture and transport
    // still check the browser's data-collection permission before sending.
    initCrashReporting();
  }, []);

  return (
    // Every framer animation in the app follows the OS reduced-motion setting: transforms and
    // layout animations become instant. The `lib/animation` helpers cover the rest.
    <MotionConfig reducedMotion="user">
      <ErrorBoundary whileMessage="booting a wallet" className="min-h-screen" windowType={env.windowType}>
        <DialogsProvider>
          <Suspense fallback={<RootSuspenseFallback />}>
            <AwaitI18N />
            <RuntimeSupportGate>
              <WalletAccessGate>
                <AppProvider env={env}>
                  <DisableOutlinesForClick />

                  <AwaitFonts name="Inter" weights={[300, 400, 500, 600]} className="antialiased font-inter">
                    <BootAnimation>
                      {/* Vaul's shouldScaleBackground scales the element carrying
                      data-vaul-drawer-wrapper while a bottom sheet is open
                      (transform + transient border-radius/overflow, all managed
                      by vaul). Must wrap the whole app surface. */}
                      <div data-vaul-drawer-wrapper="" className="h-full bg-app-bg">
                        <StorageAvailabilityBoundary confirmWindow={env.confirmWindow === true}>
                          <SeedBackupGate>
                            <Dialogs />
                            {isExtension() && <PinExtensionPrompt />}
                            {checkIsDesktop() && (
                              <Suspense fallback={null}>
                                <DesktopDappConfirmationModal />
                              </Suspense>
                            )}
                            {env.confirmWindow ? (
                              <ConfirmPage />
                            ) : checkIsMobile() ? (
                              // The DappBrowserProvider owns the embedded dApp webview lifecycle
                              // and the bubble host. It must live ABOVE PageRouter so it survives
                              // tab navigation - a parked dApp's bubble stays interactive even
                              // when the user moves to a different tab.
                              <DappBrowserProvider>
                                <UpdateNotificationProvider>
                                  <HotKeyRotationGate />
                                  <HotKeyRotatedOutGate />
                                  <GuardianRecoveryProvider />
                                  <OpenLinkPrompt />
                                  <BreadConnectPrompt />
                                  <PageRouter />
                                </UpdateNotificationProvider>
                              </DappBrowserProvider>
                            ) : (
                              <UpdateNotificationProvider>
                                <HotKeyRotationGate />
                                <HotKeyRotatedOutGate />
                                <GuardianRecoveryProvider />
                                <PageRouter />
                              </UpdateNotificationProvider>
                            )}
                          </SeedBackupGate>
                        </StorageAvailabilityBoundary>
                      </div>
                    </BootAnimation>
                  </AwaitFonts>
                </AppProvider>
              </WalletAccessGate>
            </RuntimeSupportGate>
          </Suspense>
        </DialogsProvider>
      </ErrorBoundary>
    </MotionConfig>
  );
};

export default App;

// Lazy load desktop components to avoid loading Tauri APIs on non-desktop platforms
const DesktopDappHandler = React.lazy(() => import('lib/desktop/DesktopDappHandler'));
const DesktopDappConfirmationModal = React.lazy(() =>
  import('lib/desktop/DesktopDappConfirmationModal').then(m => ({ default: m.DesktopDappConfirmationModal }))
);

const AppProvider: FC<AppProps> = ({ children, env }) => {
  console.log('[AppProvider] Rendering, isMobile:', checkIsMobile(), 'isDesktop:', checkIsDesktop());
  return (
    <AppEnvProvider {...env}>
      <Woozie.Provider>
        <ExtensionMessageListener />
        <ScreenKeyPublisher />
        {checkIsMobile() && <MobileBackBridge />}
        {checkIsMobile() && <ExternalPageFailedNotice />}
        {checkIsDesktop() && (
          <Suspense fallback={null}>
            <DesktopDappHandler />
          </Suspense>
        )}
        <AppKitProvider>
          <MidenProvider>{children}</MidenProvider>
        </AppKitProvider>
      </Woozie.Provider>
    </AppEnvProvider>
  );
};

const StorageAvailabilityBoundary: FC<PropsWithChildren & { confirmWindow: boolean }> = ({
  children,
  confirmWindow
}) => {
  const { storageAvailability } = useMidenContext();
  if (storageAvailability?.status !== 'pending') return <>{children}</>;
  if (storageAvailability?.status !== 'unavailable') return <RootSuspenseFallback />;
  return confirmWindow ? <StorageRecoveryPage /> : <PageRouter />;
};
