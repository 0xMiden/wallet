import { useCallback } from 'react';

import { createLocationState, goBack, HistoryAction, navigate } from 'lib/woozie';

import { useOncePerLocation } from './useOncePerLocation';

/**
 * Back handler for a screen that draws its own header instead of relying on
 * PageLayout's toolbar.
 *
 * `goBack()` is `history.go(-1)`, which does nothing when the screen was opened
 * cold - a deep link, a reload, or a Replace navigation - leaving the back button
 * inert with no other way off the screen. PageLayout's toolbar has always
 * guarded that with a fallback destination (`PageLayout.tsx`, `registerBackHandler`),
 * so screens that opt out of the toolbar need the same guard.
 *
 * Reads LIVE history at call time, never `useLocation()`: MobilePageLayers gives each
 * page layer a frozen location snapshot, so a page kept mounted under or over another
 * one (a page a pop reveals is the same instance) reads a stale position and never
 * sees the location change.
 *
 * Fires at most once per location (`useOncePerLocation`): `history.go(-1)` resolves on
 * a later task, so the screen stays mounted and interactive after the first call and a
 * double tap queued two traversals, overshooting the intended parent. The latch clears
 * when live history moves, so a screen the user leaves and comes back INTO goes back again.
 */
export const useBackWithFallback = (fallbackPath = '/') => {
  const claim = useOncePerLocation();

  return useCallback(() => {
    if (!claim()) return;
    if (createLocationState().historyPosition > 0) {
      goBack();
    } else {
      // Replace, not push: going "back" must not leave an entry that sends the
      // user forward into the screen they just left. Both existing back owners
      // (PageLayout's toolbar handler and MobileBackBridge) replace here.
      navigate(fallbackPath, HistoryAction.Replace);
    }
  }, [claim, fallbackPath]);
};
