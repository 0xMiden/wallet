import React from 'react';

import { MotionConfig } from 'framer-motion';
import { createRoot } from 'react-dom/client';

import { TOKEN_DETAIL_FIXTURE_ID } from './fixture';
import TokenDetail from '../../../src/app/pages/TokenDetail';

import '../../../src/i18n';
import '../../../src/main.css';

const params = new URLSearchParams(window.location.search);
if (params.has('dark')) document.documentElement.classList.add('dark');

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <TokenDetail tokenId={TOKEN_DETAIL_FIXTURE_ID} />
  </MotionConfig>
);
