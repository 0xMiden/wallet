import { useCallback, useEffect, useRef } from 'react';

import { goBack, HistoryAction, navigate, useLocation } from 'lib/woozie';

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
 * Fires at most once per location: `history.go(-1)` resolves on a later task, so
 * the screen stays mounted and interactive after the first call and a double tap
 * queued two traversals, overshooting the intended parent. The latch clears when
 * the location actually changes, which is also what makes it safe on a screen the
 * user navigates back INTO.
 */
export const useBackWithFallback = (fallbackPath = '/') => {
  const { historyPosition, pathname } = useLocation();
  const leaving = useRef(false);

  useEffect(() => {
    leaving.current = false;
  }, [pathname, historyPosition]);

  return useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    if (historyPosition > 0) {
      goBack();
    } else {
      // Replace, not push: going "back" must not leave an entry that sends the
      // user forward into the screen they just left. Both existing back owners
      // (PageLayout's toolbar handler and MobileBackBridge) replace here.
      navigate(fallbackPath, HistoryAction.Replace);
    }
  }, [historyPosition, fallbackPath]);
};
