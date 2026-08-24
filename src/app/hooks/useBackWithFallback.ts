import { useCallback } from 'react';

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
 */
export const useBackWithFallback = (fallbackPath = '/') => {
  const { historyPosition } = useLocation();

  return useCallback(() => {
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
