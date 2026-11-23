import { useEffect, useState } from 'react';

import { nowSec } from 'lib/epoch/bridge-in-lock';

/**
 * The clock in unix seconds, refreshed each second while `running` is true. The value is also refreshed one time when
 * `running` changes, so a clock that stops does not keep a time from before it stopped.
 */
export function useNowSec(running: boolean): number {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    setNow(nowSec());
    if (!running) return undefined;
    const timer = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
