import { useCallback, useEffect, useRef } from 'react';

import { createLocationState, goBack, HistoryAction, listen, navigate } from 'lib/woozie';

/**
 * Back handler for a screen that draws its own header instead of relying on
 * PageLayout's toolbar.
 *
 * `goBack()` is `history.go(-1)`, which does nothing when the screen was opened
 * cold — a deep link, a reload, or a Replace navigation — leaving the chevron
 * inert with no other way off the screen. PageLayout's toolbar has always
 * guarded that with a fallback destination (`PageLayout.tsx`, `registerBackHandler`),
 * so screens that opt out of the toolbar need the same guard.
 *
 * Reads LIVE history at call time, never `useLocation()`: MobilePageLayers gives each
 * page layer a frozen location snapshot, so a page kept mounted under or over another
 * one (and a slide page re-entered while it is still sliding out, which brings back
 * the same instance) reads a stale position and never sees the location change.
 *
 * Fires at most once per location: `history.go(-1)` resolves on a later task, so
 * the screen stays mounted and interactive after the first call and a double tap
 * queued two traversals, overshooting the intended parent. The latch holds the URL
 * it left from and clears on any history event that moves the live URL off it, so
 * a screen the user leaves and comes back INTO goes back again.
 */
export const useBackWithFallback = (fallbackPath = '/') => {
  const leavingFrom = useRef<string | null>(null);

  useEffect(
    () =>
      listen(() => {
        if (createLocationState().href !== leavingFrom.current) leavingFrom.current = null;
      }),
    []
  );

  return useCallback(() => {
    const { href = '', historyPosition } = createLocationState();
    if (leavingFrom.current === href) return;
    leavingFrom.current = href;
    if (historyPosition > 0) {
      goBack();
    } else {
      // Replace, not push: going "back" must not leave an entry that sends the
      // user forward into the screen they just left. Both existing back owners
      // (PageLayout's toolbar handler and MobileBackBridge) replace here.
      navigate(fallbackPath, HistoryAction.Replace);
    }
  }, [fallbackPath]);
};
