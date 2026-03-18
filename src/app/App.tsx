import React, { ComponentProps, FC, Suspense } from 'react';

// Lock-up checks are extension-only - skip on mobile

import AwaitFonts from 'app/a11y/AwaitFonts';
import AwaitI18N from 'app/a11y/AwaitI18N';
import BootAnimation from 'app/a11y/BootAnimation';
import DisableOutlinesForClick from 'app/a11y/DisableOutlinesForClick';
import RootSuspenseFallback from 'app/a11y/RootSuspenseFallback';
import { AppEnvProvider } from 'app/env';
import ErrorBoundary from 'app/ErrorBoundary';
import Dialogs from 'app/layouts/Dialogs';
import { MobileBackBridge } from 'app/MobileBackBridge';
import PageRouter from 'app/PageRouter';
import { ExtensionMessageListener } from 'components/ConnectivityIssueBanner';
import { MidenProvider } from 'lib/miden/front';
import { isDesktop as checkIsDesktop, isExtension, isMobile as checkIsMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';
import { DialogsProvider } from 'lib/ui/dialog';
import * as Woozie from 'lib/woozie';
import '../i18n';

import ConfirmPage from './ConfirmPage';
// Lock-up checks are extension-only (uses webextension-polyfill)
if (isExtension()) {
  import('lib/lock-up/run-checks');
}

interface AppProps extends Partial<PropsWithChildren> {
  env: ComponentProps<typeof AppEnvProvider>;
}

const App: FC<AppProps> = ({ env }) => {
  return (
    <ErrorBoundary whileMessage="booting a wallet" className="min-h-screen" windowType={env.windowType}>
      <DialogsProvider>
        <Suspense fallback={<RootSuspenseFallback />}>
          <AppProvider env={env}>
            <Dialogs />

            <DisableOutlinesForClick />

            <AwaitI18N />

            <AwaitFonts name="Geist" weights={[300, 400, 500, 600]} className="antialiased font-geist">
              <BootAnimation>{env.confirmWindow ? <ConfirmPage /> : <PageRouter />}</BootAnimation>
            </AwaitFonts>
          </AppProvider>
        </Suspense>
      </DialogsProvider>
    </ErrorBoundary>
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
        {checkIsMobile() && <MobileBackBridge />}
        {checkIsDesktop() && (
          <Suspense fallback={null}>
            <DesktopDappHandler />
            <DesktopDappConfirmationModal />
          </Suspense>
        )}
        <MidenProvider>{children}</MidenProvider>
      </Woozie.Provider>
    </AppEnvProvider>
  );
};
