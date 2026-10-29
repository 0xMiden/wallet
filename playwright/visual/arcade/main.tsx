import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import '../../../src/i18n';
import '../../../src/main.css';
import { FeaturedCard } from '../../../src/app/pages/Browser/DappLauncher/FeaturedCard';
import type { ExploreItem } from '../../../src/lib/dapp-browser/explore-catalog';

const item: ExploreItem = {
  id: 'faucet', name: 'Faucet', tagline: 'A synthetic two-line headline for a featured application',
  url: 'https://faucet.example/', category: 'tools', brandColor: '#0EA5E9', isExchange: false
};

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <React.Suspense fallback={null}>
      <div style={{ width: 260 }}><FeaturedCard item={item} onOpen={() => undefined} /></div>
    </React.Suspense>
  </MotionConfig>
);
