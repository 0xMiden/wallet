import { useEffect, useState } from 'react';

import { registerPlugin } from '@capacitor/core';

import { isMobile } from 'lib/platform';

interface ScreenshotGuardPlugin {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

const ScreenshotGuard = registerPlugin<ScreenshotGuardPlugin>('ScreenshotGuard');

/**
 * Blocks screenshots / screen recordings of the current screen while `active`.
 * iOS excludes the window from captures via the secure-text-field layer trick;
 * Android sets FLAG_SECURE on the activity window.
 *
 * Returns whether it is safe to render the guarded content: `false` from the
 * first render where guarding is needed until the native call has succeeded,
 * so callers can withhold sensitive content from the unprotected frames (an
 * in-progress screen recording would otherwise capture them). Stays `false`
 * if activation fails. Always `true` on web/desktop, where there is nothing
 * to guard.
 */
export function useScreenshotGuard(active = true): boolean {
  const needsGuard = active && isMobile();
  const [guardEnabled, setGuardEnabled] = useState(false);

  useEffect(() => {
    if (!needsGuard) return;
    let cancelled = false;
    ScreenshotGuard.enable()
      .then(() => {
        if (!cancelled) setGuardEnabled(true);
      })
      .catch(err => console.warn('[screenshot-guard] enable failed:', err));
    return () => {
      cancelled = true;
      setGuardEnabled(false);
      ScreenshotGuard.disable().catch(err => console.warn('[screenshot-guard] disable failed:', err));
    };
  }, [needsGuard]);

  return needsGuard ? guardEnabled : true;
}
