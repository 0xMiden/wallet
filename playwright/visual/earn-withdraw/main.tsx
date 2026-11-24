import React from 'react';
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import '../../../src/i18n';
import '../../../src/main.css';
import EarnWithdrawAmount from '../../../src/screens/earn-flow/EarnWithdrawAmount';
import EarnWithdrawReview from '../../../src/screens/earn-flow/EarnWithdrawReview';
import EarnWithdrawStatus from '../../../src/screens/earn-flow/EarnWithdrawStatus';
import EarnPositionDetail from '../../../src/screens/earn-flow/EarnPositionDetail';
import AwaitFonts from '../../../src/app/a11y/AwaitFonts';
import FullScreenPage from '../../../src/app/layouts/FullScreenPage';
import { MotionConfig } from 'framer-motion';
function App() {
  const path = useSyncExternalStore(
    fn => {
      window.addEventListener('popstate', fn);
      return () => window.removeEventListener('popstate', fn);
    },
    () => location.pathname + location.search
  );
  return path.includes('/withdraw-status/') ? (
    <EarnWithdrawStatus key={path} txId="fixture-withdrawal" />
  ) : path.includes('/review') ? (
    <EarnWithdrawReview positionId="position-1" />
  ) : path.includes('/withdraw') ? (
    <EarnWithdrawAmount positionId="position-1" />
  ) : (
    <EarnPositionDetail positionId="position-1" />
  );
}
createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="user">
    <React.Suspense fallback={null}>
      <AwaitFonts name="Inter" weights={[400, 500, 600]} className="antialiased font-inter">
        <AwaitFonts name="Nunito" weights={[700, 800]}>
          <FullScreenPage>
            <App />
          </FullScreenPage>
        </AwaitFonts>
      </AwaitFonts>
    </React.Suspense>
  </MotionConfig>
);
