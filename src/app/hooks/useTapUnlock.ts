import React, { useRef } from 'react';

import { hapticLight, hapticMedium } from 'lib/mobile/haptics';

/** The number of taps that open a hidden developer entry. */
export const UNLOCK_TAPS = 7;

/** A tap later than this after the one before starts the count again. */
export const UNLOCK_TAP_WINDOW_MS = 2_000;

/**
 * The hidden developer gesture: seven taps, each within two seconds of the one before, call
 * `onUnlock`. The Welcome logo and the Settings version line share it. Taps four to six give a light
 * haptic and the seventh a medium one; nothing on screen changes.
 */
export function useTapUnlock(onUnlock: () => void): (event: React.MouseEvent) => void {
  const tapCount = useRef(0);
  const lastTap = useRef(0);

  return (event: React.MouseEvent) => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const now = event.timeStamp;
    tapCount.current = now - lastTap.current > UNLOCK_TAP_WINDOW_MS ? 1 : tapCount.current + 1;
    lastTap.current = now;
    if (tapCount.current >= 4 && tapCount.current < UNLOCK_TAPS) hapticLight();
    if (tapCount.current < UNLOCK_TAPS) return;
    tapCount.current = 0;
    hapticMedium();
    onUnlock();
  };
}
