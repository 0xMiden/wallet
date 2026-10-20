import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { MidenClient } from '@miden-sdk/miden-sdk/lazy';

import '../../../src/i18n';
import '../../../src/main.css';
import AwaitFonts from '../../../src/app/a11y/AwaitFonts';
import FullScreenPage from '../../../src/app/layouts/FullScreenPage';
import { AppEnvProvider, WindowType } from '../../../src/app/env';
import { Provider, useLocation } from '../../../src/lib/woozie';
import { ReviewTransaction } from '../../../src/screens/send-flow/ReviewTransaction';
import './rpc';

function App() {
  const { pathname } = useLocation();
  if (pathname !== '/send/review') throw new Error(`Unexpected fixture route: ${pathname}`);
  return <ReviewTransaction />;
}

await MidenClient.ready();
window.__MINIMUM_SDK_READY__ = true;
createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <Provider>
      <AppEnvProvider windowType={WindowType.FullPage}>
        <React.Suspense fallback={null}>
          <AwaitFonts name="Inter" weights={[400, 500, 600]} className="antialiased font-inter">
            <AwaitFonts name="Nunito" weights={[700, 800]}>
              <FullScreenPage>
                <App />
              </FullScreenPage>
            </AwaitFonts>
          </AwaitFonts>
        </React.Suspense>
      </AppEnvProvider>
    </Provider>
  </MotionConfig>
);
