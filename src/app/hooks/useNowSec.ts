import { useEffect, useState } from 'react';

import { nowSec } from 'lib/epoch/bridge-in-lock';

/**
 * The clock in unix seconds, refreshed each second while `running` is true. The value is also refreshed one time when
 * `running` changes and clamped to at least `nowSec()` on render, so a stopped clock never serves a stale timestamp.
 */
export function useNowSec(running: boolean): number {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    setNow(nowSec());
    if (!running) return undefined;
    const timer = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return Math.max(now, nowSec());
}
