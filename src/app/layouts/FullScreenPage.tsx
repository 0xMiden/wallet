import React, { FC, useState } from 'react';

import { motion, TargetAndTransition, useIsPresent, useReducedMotion } from 'framer-motion';

import { useMotion } from 'lib/animation';
import { pageAppearance, pageSlideEntrance } from 'lib/animation/page-appearance';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';

import { usePageSlideComplete } from './MobilePageLayers';

export interface FullScreenPageProps extends PropsWithChildren {
  entrance?: 'fade' | 'slide';
}

const FullScreenPage: FC<FullScreenPageProps> = ({ children, entrance = 'fade' }) => {
  const present = useIsPresent();
  const reduce = useReducedMotion();
  const appear = isMobile() && !reduce && !isReturningFromWebview();
  const slide = appear && entrance === 'slide';
  const [entered, setEntered] = useState(false);
  const completeSlide = usePageSlideComplete();
  // Keep the previous tab's navbar visible under the incoming page.
  useHideNavbarWhileOpen(present && (!slide || entered));
  const transition = useMotion(slide ? pageSlideEntrance : pageAppearance);
  let initial: false | TargetAndTransition = false;
  switch (true) {
    case slide:
      initial = { x: '100%', opacity: 1 };
      break;
    case appear:
      initial = { opacity: 0 };
      break;
  }

  return (
    <motion.div
      className="flex flex-col h-full w-full bg-app-bg"
      initial={initial}
      animate={slide ? { x: 0, opacity: 1 } : { opacity: 1 }}
      transition={transition}
      onAnimationComplete={() => {
        setEntered(true);
        completeSlide?.();
      }}
    >
      {children}
    </motion.div>
  );
};

export default FullScreenPage;
