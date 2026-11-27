// Renders the production dApp confirm window (src/app/ConfirmPage.tsx) for the request named by ?id=.
import React from 'react';

import { MotionConfig } from 'framer-motion';
import { createRoot } from 'react-dom/client';

import '../../../src/i18n';
import '../../../src/main.css';
import AwaitFonts from '../../../src/app/a11y/AwaitFonts';
import ConfirmPage from '../../../src/app/ConfirmPage';

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <React.Suspense fallback={null}>
      <AwaitFonts name="Inter" weights={[400, 500, 600]} className="antialiased font-inter">
        <AwaitFonts name="Nunito" weights={[700, 800]}>
          <ConfirmPage />
        </AwaitFonts>
      </AwaitFonts>
    </React.Suspense>
  </MotionConfig>
);
