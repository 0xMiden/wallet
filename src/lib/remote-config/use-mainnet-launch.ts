import { useEffect, useState } from 'react';

import { useBridgeConfigSnapshot } from './use-feature-availability';
import { selectMainnetLaunchAt } from './values';

// The longest wait one timer takes: a browser clamps a longer `setTimeout` delay to a value that fires at
// once, so a far-off moment is reached through a chain of waits.
const MAX_TIMER_MS = 0x7fffffff;

/**
 * Whether mainnet has launched for the effective network: the document's countdown is on and its moment
 * has passed. Re-renders at the moment itself, so a Welcome or recovery left open across it changes mode
 * without a reload, and on every document change that moves the moment.
 */
export function useMainnetLaunched(): boolean {
  const snapshot = useBridgeConfigSnapshot();
  const launchAt = selectMainnetLaunchAt(snapshot);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (launchAt === null) return;
    const remaining = launchAt - Date.now();
    if (remaining <= 0) {
      // The moment passed while this render's `now` was still ahead of it: read the clock again.
      if (now < launchAt) setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [launchAt, now]);

  return launchAt !== null && now >= launchAt;
}
