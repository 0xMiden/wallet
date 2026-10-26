import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import '../../../src/i18n';
import '../../../src/main.css';
import { ArcadeLanding } from '../../../src/app/pages/Browser/DappLauncher/ArcadeLanding';
import type { ExploreView } from '../../../src/lib/dapp-browser/explore-catalog';

const params = new URLSearchParams(location.search);
if (params.has('dark')) document.documentElement.classList.add('dark');
const catalog: ExploreView = {
  items: [
    {
      id: 'synthetic-game',
      name: params.has('long') ? 'A longer synthetic Arcade game title' : 'Synthetic Arcade',
      tagline: params.has('long')
        ? 'A longer description that wraps across several lines while you review this synthetic game before opening it.'
        : 'A synthetic game for layout review.',
      url: 'https://game.example/',
      category: 'games',
      isExchange: false
    }
  ],
  sections: [{ id: 'games', title: 'Games', kind: 'list', itemIds: ['synthetic-game'] }]
};

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <React.Suspense fallback={null}>
      <ArcadeLanding catalog={catalog} pending={false} onOpen={() => undefined} />
    </React.Suspense>
  </MotionConfig>
);
