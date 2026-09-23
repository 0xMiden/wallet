import React, { createContext, FC, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { AnimatePresence, motion, TargetAndTransition, usePresence, useReducedMotion } from 'framer-motion';

import { PageActiveContext, PageOnScreenContext } from 'app/layouts/page-active';
import { pageSlideDim, pageSlideParallax, usePreset } from 'lib/animation';
import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { PropsWithChildren } from 'lib/props-with-children';
import { HistoryAction } from 'lib/woozie/history';
import { LocationProvider, LocationState } from 'lib/woozie/location';

interface LayerStack {
  // True while the current page is a slide page. A layer that leaves while
  // this is true stays mounted underneath it, like a navigation stack, so a
  // pop reveals the same instance with its scroll and state intact.
  retain: boolean;
  // The key of the page a return left. A slide page slides out, and no page a
  // return left stays covered under the page it went back to.
  poppedKey: string | null;
  // Keys of every mounted layer, present or retained.
  mounted: Set<string>;
}

const LayerStackContext = createContext<LayerStack>({ retain: false, poppedKey: null, mounted: new Set() });

// How a layer moves while another layer slides over or off it.
// - `still`: no motion. The layer shows or is removed at once.
// - `cover`: a page slides in above this layer. It moves left and dims.
// - `uncover`: a return leaves this slide page. It slides out to the right.
// - `reveal`: a return leaves the slide page above this layer. It comes back from the left.
type LayerMotion = 'still' | 'cover' | 'uncover' | 'reveal';

interface PageLayerProps extends PropsWithChildren {
  layerKey: string;
  location: LocationState;
  slide: boolean;
  revealed: boolean;
  animated: boolean;
}

// The page beneath a slide page. The slide page itself moves on the `page` preset.
const coveredTarget: TargetAndTransition = { x: pageSlideParallax };

const PageLayer: FC<PageLayerProps> = ({ layerKey, location, slide, revealed, animated, children }) => {
  const [present, remove] = usePresence();
  const { retain, poppedKey, mounted } = useContext(LayerStackContext);
  const ref = useRef<HTMLDivElement>(null);
  const page = usePreset('page');
  // A layer that started to slide out keeps sliding out. It is off screen,
  // and a later push must not pull it back under the new page.
  const uncovering = useRef(false);
  if (present) uncovering.current = false;

  let layerMotion: LayerMotion = 'still';
  switch (true) {
    case present && revealed && animated:
      layerMotion = 'reveal';
      break;
    case !present && slide && animated && (uncovering.current || layerKey === poppedKey):
      layerMotion = 'uncover';
      break;
    case !present && retain && layerKey !== poppedKey:
      layerMotion = 'cover';
      break;
  }
  if (layerMotion === 'uncover') uncovering.current = true;
  // Set while a slide page covers this layer; cleared once its way back has finished. A slide page
  // returned to from another slide page is `still`, yet it animates back from the covered offset too.
  const covered = useRef(false);
  if (layerMotion === 'cover') covered.current = true;

  // Fully on screen: off the moment a push starts covering this layer, and after a pop only once
  // its own way back has finished (a covered layer, or a fresh one mounted in `reveal`), since the
  // page above is still sliding off until then. Set during render, so the commit that changes
  // `present` never paints a stale value.
  const settled = present && !(animated && (covered.current || layerMotion === 'reveal'));
  const [onScreen, setOnScreen] = useState(settled);
  const [onScreenFor, setOnScreenFor] = useState(present);
  if (onScreenFor !== present) {
    setOnScreenFor(present);
    setOnScreen(settled);
  }

  useLayoutEffect(() => {
    mounted.add(layerKey);
    return () => {
      mounted.delete(layerKey);
    };
  }, [mounted, layerKey]);

  useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', !present);
  }, [present]);

  // A covered layer stays until the slide page above it goes. An uncovering
  // layer waits for its own slide out. Any other absent layer goes at once.
  useEffect(() => {
    if (!present && layerMotion === 'still') remove?.();
  }, [present, layerMotion, remove]);

  let initial: false | TargetAndTransition = false;
  let animate = page.animate;
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
      animate = page.exit;
      zIndex = 3;
      break;
  }

  return (
    <motion.div
      ref={ref}
      className="relative col-start-1 row-start-1 min-h-0 min-w-0"
      data-page-layer={location.pathname}
      aria-hidden={!present || undefined}
      style={{ zIndex, pointerEvents: present ? 'auto' : 'none' }}
      initial={initial}
      animate={animate}
      transition={page.transition}
      onAnimationComplete={() => {
        if (!present && layerMotion === 'uncover') remove?.();
        if (present && !onScreen) {
          covered.current = false;
          setOnScreen(true);
        }
      }}
    >
      <LocationProvider snapshot={location}>
        <PageActiveContext.Provider value={present}>
          <PageOnScreenContext.Provider value={onScreen}>{children}</PageOnScreenContext.Provider>
        </PageActiveContext.Provider>
      </LocationProvider>
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-pure-black pointer-events-none"
        initial={layerMotion === 'reveal' ? { opacity: pageSlideDim } : { opacity: 0 }}
        animate={{ opacity: dim }}
        transition={page.transition}
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
  // A return left a slide page for this page, which is not one, so this page
  // comes back from under it.
  revealed: boolean;
  // The page a return left for this one.
  poppedKey: string | null;
}

const MobilePageLayers: FC<MobilePageLayersProps> = ({ pageKey, slide, location, children }) => {
  const reduce = useReducedMotion();
  const animated = !reduce && !isReturningFromWebview();
  const mounted = useRef(new Set<string>()).current;
  const [entry, setEntry] = useState<PageEntry>({ key: pageKey, slide, revealed: false, poppedKey: null });
  if (entry.key !== pageKey) {
    // A return goes back down the stack: the router popped, or the page is still mounted beneath (a close
    // that navigates to it). Only a return plays the Back animation; a push from a slide page to a plain
    // page releases the stack without it.
    const returning = location.trigger === HistoryAction.Pop || mounted.has(pageKey);
    setEntry({
      key: pageKey,
      slide,
      revealed: returning && entry.slide && !slide,
      poppedKey: returning ? entry.key : null
    });
  }
  const retain = slide && animated;
  const stack = useMemo<LayerStack>(
    () => ({ retain, poppedKey: entry.poppedKey, mounted }),
    [retain, entry.poppedKey, mounted]
  );

  return (
    <div className="relative isolate grid h-full w-full overflow-x-clip">
      <LayerStackContext.Provider value={stack}>
        <AnimatePresence initial={false}>
          <PageLayer
            key={pageKey}
            layerKey={pageKey}
            location={location}
            slide={slide}
            revealed={entry.key === pageKey && entry.revealed}
            animated={animated}
          >
            {children}
          </PageLayer>
        </AnimatePresence>
      </LayerStackContext.Provider>
    </div>
  );
};

export default MobilePageLayers;
