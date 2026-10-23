import { useEffect, useState } from 'react';

import { useBridgeConfigSnapshot } from './use-feature-availability';
import { selectMainnetLaunchAt } from './values';

// Check the clock each second while launch is pending. A clock change does not reset a running timer.
const MAX_TIMER_MS = 1_000;

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
      // Launch has passed, but the saved time can still be before launch. Read the clock again.
      if (now < launchAt) setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [launchAt, now]);

  return launchAt !== null && now >= launchAt;
}
