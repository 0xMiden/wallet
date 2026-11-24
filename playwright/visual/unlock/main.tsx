import React from 'react';

import { MotionConfig } from 'framer-motion';
import { createRoot } from 'react-dom/client';

import '../../../src/i18n';
import '../../../src/main.css';
import Unlock from '../../../src/app/pages/Unlock';

createRoot(document.getElementById('root')!).render(
  <MotionConfig reducedMotion="always">
    <Unlock />
  </MotionConfig>
);
