import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';

import '../../../src/i18n';
import '../../../src/main.css';
import AwaitFonts from '../../../src/app/a11y/AwaitFonts';
import FullScreenPage from '../../../src/app/layouts/FullScreenPage';
import { StorageRecoveryPage } from '../../../src/app/StorageRecoveryPage';

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <React.Suspense fallback={null}>
      <AwaitFonts name="Inter" weights={[400, 500, 600]} className="antialiased font-inter">
        <AwaitFonts name="Nunito" weights={[700, 800]}>
          <FullScreenPage><StorageRecoveryPage onBack={() => undefined} /></FullScreenPage>
        </AwaitFonts>
      </AwaitFonts>
    </React.Suspense>
  </MotionConfig>
);
