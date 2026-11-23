import React from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';

import '../../../src/i18n';
import '../../../src/main.css';
import TokenDetail from '../../../src/app/pages/TokenDetail';
import { TOKEN_DETAIL_FIXTURE_ID } from './fixture';

const params = new URLSearchParams(location.search);
if (params.has('dark')) document.documentElement.classList.add('dark');

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <TokenDetail tokenId={TOKEN_DETAIL_FIXTURE_ID} />
  </MotionConfig>
);
