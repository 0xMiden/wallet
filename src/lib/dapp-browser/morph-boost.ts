// The native morph's frame-rate link starts with its command, too late for an idle panel to reach 120 Hz by the
// first frame (#1817), so a control that can start one asks for the full rate when a finger lands on it.

import { InAppBrowser } from '@miden/dapp-browser';
import { isMobile } from 'lib/platform';

/** How long a touch-down request holds the full frame rate when no morph takes it over. */
export const MORPH_PREPARE_MS = 600;

/**
 * Asks native for the full frame rate now. The morph it then runs takes the request over; without one the request
 * lapses after MORPH_PREPARE_MS. With the id of a parked dApp, native also shows that dApp's window unseen, so the
 * restore morph's first frame is not the unhide. Never rejects: a plugin without the method (an older build) changes nothing.
 */
export function prepareMorph(id?: string): Promise<void> {
  if (!isMobile()) return Promise.resolve();
  return InAppBrowser.prepareMorph(id ? { durationMs: MORPH_PREPARE_MS, id } : { durationMs: MORPH_PREPARE_MS }).catch(
    () => undefined
  );
}
