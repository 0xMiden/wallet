import { useLayoutEffect } from 'react';

import { setRoutePart } from 'lib/e2e/screen-key';
import { createLocationState, listen } from 'lib/woozie';

/**
 * E2E-only. Feeds the Woozie route into the screen-key signal so E2E
 * harnesses can screenshot on every screen change.
 * Gated on MIDEN_E2E_TEST so it tree-shakes out of production.
 */
export function ScreenKeyPublisher(): null {
  useLayoutEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    const publish = (): void => {
      const loc = createLocationState();
      setRoutePart(loc.pathname + (loc.search || ''));
    };
    publish();
    return listen(publish);
  }, []);
  return null;
}
