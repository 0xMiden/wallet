import { useEffect, useState } from 'react';

import { nowSec } from 'lib/epoch/bridge-in-lock';

/** The clock in unix seconds, refreshed each second while `running` is true. */
export function useNowSec(running: boolean): number {
  const [now, setNow] = useState(nowSec);
  useEffect(() => {
    if (!running) return undefined;
    setNow(nowSec());
    const timer = setInterval(() => setNow(nowSec()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
