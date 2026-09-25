import React, { FC, useState } from 'react';

import { motion, TargetAndTransition, useIsPresent, useReducedMotion } from 'framer-motion';

import { usePreset } from 'lib/animation';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';

export interface FullScreenPageProps extends PropsWithChildren {
  /** How the page arrives. Defaults to `defaultPageEntrance()`. */
  entrance?: 'fade' | 'slide';
}

/**
 * On mobile every page slides in (and out on back) unless it opts into a fade. Elsewhere a page
 * keeps the fade unless it asks for a slide: in the extension a slide page whose entrance never
 * ran to completion sat at translateX(100%), wholly off screen, where a fade that never ran still
 * leaves the page in place (guardian-lifecycle-e2e on #929).
 */
export const defaultPageEntrance = (): 'fade' | 'slide' => (isMobile() ? 'slide' : 'fade');

const FullScreenPage: FC<FullScreenPageProps> = ({ children, entrance = defaultPageEntrance() }) => {
  const present = useIsPresent();
  const reduce = useReducedMotion();
  const appear = !reduce && !isReturningFromWebview();
  const slide = appear && entrance === 'slide';
  const [entered, setEntered] = useState(false);
  // Keep the previous tab's navbar visible under the incoming page, and give
  // it back the moment this page starts to slide out.
  useHideNavbarWhileOpen(present && (!slide || entered));
  // A slide page is the incoming page of the `page` preset; the page beneath moves with it in
  // `MobilePageLayers`. Any other page fades in on `fade`.
  const page = usePreset('page');
  const fade = usePreset('fade');
  const motionPreset = slide ? page : fade;
  let initial: false | TargetAndTransition = false;
  switch (true) {
    case slide:
      initial = { ...page.initial, opacity: 1 };
      break;
    case appear:
      initial = fade.initial ?? false;
      break;
  }

  return (
    <motion.div
      className="flex flex-col h-full w-full bg-app-bg"
      initial={initial}
      animate={slide ? { ...page.animate, opacity: 1 } : fade.animate}
      transition={motionPreset.transition}
      onAnimationComplete={() => setEntered(true)}
    >
      {children}
    </motion.div>
  );
};

export default FullScreenPage;
