import React, { createContext, FC, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AnimatePresence, motion, TargetAndTransition, usePresence, useReducedMotion } from 'framer-motion';

import { useMotion } from 'lib/animation';
import { pageSlideDim, pageSlideEntrance, pageSlideParallax } from 'lib/animation/page-appearance';
import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { PropsWithChildren } from 'lib/props-with-children';
import { LocationProvider, LocationState } from 'lib/woozie/location';

// True while the current page is a slide page. A layer that leaves while
// this is true stays mounted underneath it, like a navigation stack, so a
// pop reveals the same instance with its scroll and state intact.
const RetainPageContext = createContext(false);

// How a layer moves while another layer slides over or off it.
// - `still`: no motion. The layer shows or is removed at once.
// - `cover`: a page slides in above this layer. It moves left and dims.
// - `uncover`: this slide page pops. It slides out to the right.
// - `reveal`: a slide page pops above this layer. It comes back from the left.
type LayerMotion = 'still' | 'cover' | 'uncover' | 'reveal';

interface PageLayerProps extends PropsWithChildren {
  location: LocationState;
  slide: boolean;
  revealed: boolean;
  animated: boolean;
}

const coveredTarget: TargetAndTransition = { x: pageSlideParallax };
const restTarget: TargetAndTransition = { x: 0 };
const uncoverTarget: TargetAndTransition = { x: '100%' };

const PageLayer: FC<PageLayerProps> = ({ location, slide, revealed, animated, children }) => {
  const [present, remove] = usePresence();
  const retain = useContext(RetainPageContext);
  const ref = useRef<HTMLDivElement>(null);
  const transition = useMotion(pageSlideEntrance);

  let layerMotion: LayerMotion = 'still';
  switch (true) {
    case present && revealed && animated:
      layerMotion = 'reveal';
      break;
    case !present && retain:
      layerMotion = 'cover';
      break;
    case !present && slide && animated:
      layerMotion = 'uncover';
      break;
  }

  useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', !present);
  }, [present]);

  // A covered layer stays until the slide page above it goes. An uncovering
  // layer waits for its own slide out. Any other absent layer goes at once.
  useEffect(() => {
    if (!present && layerMotion === 'still') remove?.();
  }, [present, layerMotion, remove]);

  let initial: false | TargetAndTransition = false;
  let animate: TargetAndTransition = restTarget;
  let dim = 0;
  let zIndex = present ? 2 : 1;
  switch (layerMotion) {
    case 'reveal':
      initial = coveredTarget;
      dim = 0;
      break;
    case 'cover':
      animate = coveredTarget;
      dim = pageSlideDim;
      break;
    case 'uncover':
      animate = uncoverTarget;
      zIndex = 3;
      break;
  }

  return (
    <motion.div
      ref={ref}
      className="absolute inset-0"
      data-page-layer={location.pathname}
      aria-hidden={!present || undefined}
      style={{ zIndex, pointerEvents: present ? 'auto' : 'none' }}
      initial={initial}
      animate={animate}
      transition={transition}
      onAnimationComplete={() => {
        if (!present && layerMotion === 'uncover') remove?.();
      }}
    >
      <LocationProvider snapshot={location}>{children}</LocationProvider>
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-pure-black pointer-events-none"
        initial={layerMotion === 'reveal' ? { opacity: pageSlideDim } : { opacity: 0 }}
        animate={{ opacity: dim }}
        transition={transition}
      />
    </motion.div>
  );
};

interface MobilePageLayersProps extends PropsWithChildren {
  location: LocationState;
  pageKey: string;
  slide: boolean;
}

interface PageEntry {
  key: string;
  slide: boolean;
  // The page before this one was a slide page and this one is not.
  // The slide page pops, so this page comes back from under it.
  revealed: boolean;
}

const MobilePageLayers: FC<MobilePageLayersProps> = ({ pageKey, slide, location, children }) => {
  const reduce = useReducedMotion();
  const animated = !reduce && !isReturningFromWebview();
  const [entry, setEntry] = useState<PageEntry>({ key: pageKey, slide, revealed: false });
  if (entry.key !== pageKey) {
    setEntry({ key: pageKey, slide, revealed: entry.slide && !slide });
  }
  const retain = slide && animated;

  return (
    <div className="relative isolate h-full w-full overflow-x-clip">
      <RetainPageContext.Provider value={retain}>
        <AnimatePresence initial={false}>
          <PageLayer
            key={pageKey}
            location={location}
            slide={slide}
            revealed={entry.key === pageKey && entry.revealed}
            animated={animated}
          >
            {children}
          </PageLayer>
        </AnimatePresence>
      </RetainPageContext.Provider>
    </div>
  );
};

export default MobilePageLayers;
