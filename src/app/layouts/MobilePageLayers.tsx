import React, { createContext, FC, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AnimatePresence, usePresence, useReducedMotion } from 'framer-motion';

import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { PropsWithChildren } from 'lib/props-with-children';
import { LocationProvider, LocationState } from 'lib/woozie/location';

const RetainPageContext = createContext(false);
const SlideCompleteContext = createContext<(() => void) | undefined>(undefined);

export const usePageSlideComplete = () => useContext(SlideCompleteContext);

interface PageLayerProps extends PropsWithChildren {
  location: LocationState;
  onSlideComplete?: () => void;
}

const PageLayer: FC<PageLayerProps> = ({ location, onSlideComplete, children }) => {
  const [present, remove] = usePresence();
  const retain = useContext(RetainPageContext);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', !present);
  }, [present]);

  // Wait for the incoming slide, not an animation of the unchanged background.
  useEffect(() => {
    if (!present && !retain) remove?.();
  }, [present, retain, remove]);

  return (
    <div
      ref={ref}
      className="absolute inset-0"
      data-page-layer={location.pathname}
      aria-hidden={!present || undefined}
      style={{ zIndex: present ? 2 : 1, pointerEvents: present ? 'auto' : 'none' }}
    >
      <SlideCompleteContext.Provider value={onSlideComplete}>
        <LocationProvider snapshot={location}>{children}</LocationProvider>
      </SlideCompleteContext.Provider>
    </div>
  );
};

interface MobilePageLayersProps extends PageLayerProps {
  pageKey: string;
  slide: boolean;
}

const MobilePageLayers: FC<MobilePageLayersProps> = ({ pageKey, slide, location, children }) => {
  const reduce = useReducedMotion();
  const [entry, setEntry] = useState({ key: pageKey, complete: true });
  if (entry.key !== pageKey) setEntry({ key: pageKey, complete: false });
  const retain = slide && !entry.complete && !reduce && !isReturningFromWebview();
  const completeSlide = () => {
    // An interrupted slide cannot release the background of a newer page.
    setEntry(current => (current.key === pageKey ? { ...current, complete: true } : current));
  };

  return (
    <div className="relative isolate h-full w-full overflow-x-clip">
      <RetainPageContext.Provider value={retain}>
        <AnimatePresence initial={false}>
          <PageLayer key={pageKey} location={location} onSlideComplete={completeSlide}>
            {children}
          </PageLayer>
        </AnimatePresence>
      </RetainPageContext.Provider>
    </div>
  );
};

export default MobilePageLayers;
