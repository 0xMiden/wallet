import { useCallback, useEffect, useRef } from 'react';

import { createLocationState, listen } from 'lib/woozie';

// The history position is part of it because two adjacent entries can share a URL (a
// Replace onto the URL of the entry below): a pop between them changes only the position.
const liveLocationKey = () => {
  const { href = '', historyPosition } = createLocationState();
  return `${historyPosition} ${href}`;
};

/**
 * A latch for a screen's exit: `claim()` is true the first time it is called at a
 * location and false after that, until live history moves to another location.
 *
 * Reads LIVE history, never `useLocation()`: MobilePageLayers gives each page layer a
 * frozen location snapshot, and a page re-entered while its layer is still sliding out
 * comes back as the same instance, so a latch keyed on the snapshot never re-arms and
 * the page is dead on its second visit. A history event that leaves the location where
 * it was (a same-URL replace) keeps the latch set.
 */
export const useOncePerLocation = () => {
  const claimedAt = useRef<string | null>(null);

  useEffect(
    () =>
      listen(() => {
        if (liveLocationKey() !== claimedAt.current) claimedAt.current = null;
      }),
    []
  );

  return useCallback(() => {
    const here = liveLocationKey();
    if (claimedAt.current === here) return false;
    claimedAt.current = here;
    return true;
  }, []);
};
