import React, { createContext, FC, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { AnimatePresence, motion, TargetAndTransition, usePresence, useReducedMotion } from 'framer-motion';

import { PageActiveContext, PageOnScreenContext } from 'app/layouts/page-active';
import { pageSlideDim, pageSlideParallax, reducedMotionTransition, usePreset } from 'lib/animation';
import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { PropsWithChildren } from 'lib/props-with-children';
import { HistoryAction } from 'lib/woozie/history';
import { LocationProvider, LocationState } from 'lib/woozie/location';

interface LayerStack {
  // True while the current page is a slide page (and motion is not reduced). A layer that leaves while
  // this is true stays mounted underneath it, like a navigation stack, so a pop reveals the same
  // instance with its scroll and state intact. It never reads the webview-return hint, which is
  // short-lived: a re-render inside that window must not drop the covered pages.
  retain: boolean;
  // False under reduced motion or just after a webview closed. Read live, so a leaving layer, whose
  // own props are frozen, moves instantly too.
  animated: boolean;
  // The layer key of the page a return left. A slide page slides out, and no
  // page a return left stays covered under the page it went back to.
  poppedKey: string | null;
  // Keys of every mounted layer, present or retained.
  mounted: Set<string>;
  // The page on screen. An earlier layer of the same page that is still leaving goes at once, so the
  // page is never in the DOM twice.
  pageKey: string;
}

const LayerStackContext = createContext<LayerStack>({
  retain: false,
  animated: true,
  poppedKey: null,
  mounted: new Set(),
  pageKey: ''
});

// How a layer moves while another layer slides over or off it.
// - `still`: no motion. The layer shows or is removed at once.
// - `cover`: a page slides in above this layer. It moves left and dims.
// - `uncover`: a return leaves this slide page. It slides out to the right.
// - `reveal`: a return leaves the slide page above this layer. It comes back from the left.
type LayerMotion = 'still' | 'cover' | 'uncover' | 'reveal';

interface PageLayerProps extends PropsWithChildren {
  pageKey: string;
  layerKey: string;
  location: LocationState;
  slide: boolean;
  revealed: boolean;
  animated: boolean;
}

// The page beneath a slide page. The slide page itself moves on the `page` preset.
const coveredTarget: TargetAndTransition = { x: pageSlideParallax };

const PageLayer: FC<PageLayerProps> = ({ pageKey, layerKey, location, slide, revealed, animated, children }) => {
  const [present, remove] = usePresence();
  const {
    retain,
    animated: stackAnimated,
    poppedKey,
    mounted,
    pageKey: currentPageKey
  } = useContext(LayerStackContext);
  const ref = useRef<HTMLDivElement>(null);
  const page = usePreset('page');
  // A layer that started to slide out keeps sliding out. It is off screen,
  // and a later push must not pull it back under the new page.
  const uncovering = useRef(false);
  if (present) uncovering.current = false;
  // Set while a slide page covers this layer; cleared once its way back has finished. A slide page
  // returned to from another slide page is `still`, yet it animates back from the covered offset too.
  const covered = useRef(false);
  // AnimatePresence unmounts leaving layers together, once every one is done, and a covered layer is
  // not done until the slide page above it goes. A layer that has called remove() renders nothing
  // until then, even if a later navigation would make it `cover`: its page content unmounts and it
  // leaves `mounted`. A push can still bring it back while it is held, so it comes back reset.
  const [gone, setGone] = useState(false);
  if (present && gone) {
    covered.current = false;
    setGone(false);
  }
  // An earlier layer of the page on screen renders nothing, so the page is never in the DOM twice.
  const superseded = !present && pageKey === currentPageKey;

  let layerMotion: LayerMotion = 'still';
  switch (true) {
    case superseded:
      break;
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
    if (gone) return;
    mounted.add(layerKey);
    return () => {
      mounted.delete(layerKey);
    };
  }, [mounted, layerKey, gone]);

  useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', !present);
  }, [present]);

  // A covered layer stays until the slide page above it goes. An uncovering
  // layer waits for its own slide out. Any other absent layer goes at once.
  useEffect(() => {
    if (present || layerMotion !== 'still') return;
    setGone(true);
    remove?.();
  }, [present, layerMotion, remove]);

  if (gone || superseded) return null;

  const transition = stackAnimated ? page.transition : reducedMotionTransition;
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
      transition={transition}
      onAnimationComplete={() => {
        if (!present && layerMotion === 'uncover') {
          setGone(true);
          remove?.();
        }
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
  // A return left a slide page for this page, which is not one, so this page
  // comes back from under it.
  revealed: boolean;
  // The layer a return left for this one.
  poppedKey: string | null;
  // How many times each page's layer has been retired. Each retire gives the page a new layer key, so a
  // push never revives a retired generation (a page a return left, including one still sliding out, or
  // one a push superseded). A layer that went without being retired (a covered page a release dropped)
  // can still come back through a push while AnimatePresence holds it, and it comes back reset.
  // Whether a navigation is a return is the stack's job.
  pops: Record<string, number>;
  // The pages a push may still return to, from the bottom layer to the page on screen. A page that
  // leaves it keeps its layer, so a router Pop still reveals it; only a push to it opens a new one.
  stack: string[];
}

const layerKeyOf = (pageKey: string, pops: Record<string, number>) => `${pageKey}#${pops[pageKey] ?? 0}`;
const retire = (pops: Record<string, number>, pageKey: string) => ({ ...pops, [pageKey]: (pops[pageKey] ?? 0) + 1 });

const MobilePageLayers: FC<MobilePageLayersProps> = ({ pageKey, slide, location, children }) => {
  const reduce = useReducedMotion();
  const animated = !reduce && !isReturningFromWebview();
  const mounted = useRef(new Set<string>()).current;
  const [entry, setEntry] = useState<PageEntry>({
    key: pageKey,
    slide,
    revealed: false,
    poppedKey: null,
    pops: {},
    stack: [pageKey]
  });
  if (entry.key !== pageKey) {
    // A return goes back down the stack: the router popped, or the page is in the stack beneath with its
    // layer still mounted (a close that navigates to it). Only a return plays the Back animation; a push
    // from a slide page to a plain page releases the stack without it.
    const live = mounted.has(layerKeyOf(pageKey, entry.pops));
    const below = entry.stack.slice(0, -1).lastIndexOf(pageKey);
    const returning = location.trigger === HistoryAction.Pop || (live && below >= 0);
    let stack: string[];
    if (returning) stack = below >= 0 ? entry.stack.slice(0, below + 1) : [...entry.stack.slice(0, -1), pageKey];
    else if (!slide) stack = [pageKey];
    else stack = [...(location.trigger === HistoryAction.Replace ? entry.stack.slice(0, -1) : entry.stack), pageKey];
    setEntry({
      key: pageKey,
      slide,
      revealed: returning && entry.slide && !slide,
      poppedKey: returning ? layerKeyOf(entry.key, entry.pops) : null,
      // A push to a page outside the stack whose old layer is still mounted opens a new layer.
      pops: returning ? retire(entry.pops, entry.key) : live ? retire(entry.pops, pageKey) : entry.pops,
      stack
    });
  }
  const layerKey = layerKeyOf(pageKey, entry.pops);
  const retain = slide && !reduce;
  const stack = useMemo<LayerStack>(
    () => ({ retain, animated, poppedKey: entry.poppedKey, mounted, pageKey }),
    [retain, animated, entry.poppedKey, mounted, pageKey]
  );

  return (
    <div className="relative isolate grid h-full w-full overflow-x-clip">
      <LayerStackContext.Provider value={stack}>
        <AnimatePresence initial={false}>
          <PageLayer
            key={layerKey}
            pageKey={pageKey}
            layerKey={layerKey}
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
