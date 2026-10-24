// The native morph's frame-rate link starts with its command, too late for an idle panel to reach 120 Hz by the
// first frame (#1817), so a control that can start one asks for the full rate when a finger lands on it.

import { InAppBrowser } from '@miden/dapp-browser';
import { isMobile } from 'lib/platform';

/** How long a touch-down request holds the full frame rate when no morph takes it over. */
export const MORPH_PREPARE_MS = 600;

/**
 * Asks native for the full frame rate now. The morph it then runs takes the request over; without one the request
 * lapses after MORPH_PREPARE_MS. Never rejects: a plugin without the method (an older build) changes nothing.
 */
export function prepareMorph(): Promise<void> {
  if (!isMobile()) return Promise.resolve();
  return InAppBrowser.prepareMorph({ durationMs: MORPH_PREPARE_MS }).catch(() => undefined);
}
