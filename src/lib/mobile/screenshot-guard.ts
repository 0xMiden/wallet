import { useEffect, useState } from 'react';

import { registerPlugin } from '@capacitor/core';

import { isMobile } from 'lib/platform';

interface ScreenshotGuardPlugin {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

const ScreenshotGuard = registerPlugin<ScreenshotGuardPlugin>('ScreenshotGuard');

// One native switch serves every holder, so it is counted: an onboarding step that finishes its exit
// after the next one mounted must not turn protection off under the step still on screen.
let holders = 0;
let sharedEnable: Promise<boolean> | null = null;

function acquireGuard(): Promise<boolean> {
  holders += 1;
  if (sharedEnable === null) {
    const enabling: Promise<boolean> = ScreenshotGuard.enable().then(
      () => true,
      err => {
        console.warn('[screenshot-guard] enable failed:', err);
        // A failure is not kept as the shared answer, so the next holder retries the native enable;
        // a newer enable started after a release must not be cleared by this older one.
        if (sharedEnable === enabling) sharedEnable = null;
        return false;
      }
    );
    sharedEnable = enabling;
  }
  return sharedEnable;
}

function releaseGuard(): void {
  holders -= 1;
  if (holders > 0) return;
  sharedEnable = null;
  ScreenshotGuard.disable().catch(err => console.warn('[screenshot-guard] disable failed:', err));
}

/** Test-only: forget every holder and the shared enable. */
export function __resetScreenshotGuardForTest(): void {
  holders = 0;
  sharedEnable = null;
}

/**
 * Blocks screenshots / screen recordings of the current screen while `active`.
 * iOS excludes the window from captures via the secure-text-field layer trick;
 * Android sets FLAG_SECURE on the activity window.
 *
 * Every active holder shares one native switch: the first to mount enables it,
 * later ones reuse that enable, and only the last to unmount disables it.
 *
 * Returns whether it is safe to render the guarded content: `false` from the
 * first render where guarding is needed until the shared native enable has
 * succeeded, so callers can withhold sensitive content from the unprotected
 * frames (an in-progress screen recording would otherwise capture them). Stays
 * `false` if activation fails. Always `true` on web/desktop, where there is
 * nothing to guard.
 */
export function useScreenshotGuard(active = true): boolean {
  const needsGuard = active && isMobile();
  const [guardEnabled, setGuardEnabled] = useState(false);

  useEffect(() => {
    if (!needsGuard) return;
    let cancelled = false;
    acquireGuard().then(enabled => {
      if (!cancelled && enabled) setGuardEnabled(true);
    });
    return () => {
      cancelled = true;
      setGuardEnabled(false);
      releaseGuard();
    };
  }, [needsGuard]);

  return needsGuard ? guardEnabled : true;
}
