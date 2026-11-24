import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';

import '../../../src/i18n';
import '../../../src/main.css';
import { ArcadeGcPurchaseDrawer } from '../../../src/app/templates/arcade/ArcadeGcPurchaseDrawer';

if (new URLSearchParams(location.search).has('dark')) document.documentElement.classList.add('dark');

const sale = {
  saleNoteId: 'synthetic-sale',
  sellerAccountId: 'synthetic-seller',
  payFaucetId: 'synthetic-usdcx',
  gcFaucetId: 'synthetic-gc',
  offeredAmount: 1_000_000_000n,
  requestedAmount: 1_000_000n,
  fillFloor: 1_000_000n
};

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <React.Suspense fallback={null}>
      <ArcadeGcPurchaseDrawer
        open
        onOpenChange={() => undefined}
        sale={sale}
        payBalance={2_000_000n}
        submitting={false}
        error={null}
        onConfirm={() => {
          throw new Error('This visual fixture cannot send a transaction');
        }}
      />
    </React.Suspense>
  </MotionConfig>
);
