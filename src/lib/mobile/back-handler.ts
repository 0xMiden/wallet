import { App } from '@capacitor/app';

import { isAndroid, isMobile } from 'lib/platform';

/**
 * Mobile back button handler system.
 *
 * Handles hardware back button and swipe-back gestures on both Android and iOS.
 * Overlay handlers run before page handlers, so a page that re-registers while an
 * overlay is open cannot take the press from it. They are for UI rendered outside the
 * routed page's React tree (app-level dialogs and gates, provider modals, the router's
 * banner sheet) and for a sheet or popover that closes itself through its own back
 * handler (it returns false while closed): it uses `useCloseOnBack`. A sheet its host
 * closes stays in the page tier, closed by that page's own handler.
 * Within each tier the last registered runs first.
 * If a handler returns true, it consumed the event and no other handlers are called.
 * If no handler consumes the event: Android minimizes app, iOS does nothing.
 */

type BackHandler = () => boolean | void;

export interface BackHandlerOptions {
  /**
   * Runs before every page handler: for UI outside the routed page's tree, or a sheet or popover that
   * closes itself through its own handler (returning false while closed; `useCloseOnBack` does this).
   */
  overlay?: boolean;
}

const handlers: BackHandler[] = [];
const overlayHandlers: BackHandler[] = [];
let initialized = false;

/**
 * Initialize the mobile back button listener.
 * Call once at app start (in mobile-app.tsx).
 */
export async function initMobileBackHandler(): Promise<void> {
  if (!isMobile() || initialized) {
    return;
  }

  initialized = true;

  await App.addListener('backButton', () => {
    // Overlays first, then pages; most recently registered first within each tier.
    for (const tier of [overlayHandlers, handlers]) {
      for (let i = tier.length - 1; i >= 0; i--) {
        const handler = tier[i];
        /* c8 ignore next -- defensive guard for sparse array, mobile-only */ if (!handler) continue;
        const result = handler();
        if (result === true) {
          // Handler consumed the event
          return;
        }
      }
    }

    // No handler consumed the event
    if (isAndroid()) {
      // On Android, minimize the app (go to home screen)
      App.minimizeApp();
    }
    // On iOS, do nothing (swipe gesture already handled by system if we get here)
  });
}

/**
 * Register a back handler. Returns a function to unregister.
 *
 * @param handler - Function that returns true if it handled the back press
 * @param options - `{ overlay: true }` for UI rendered outside the routed page's tree, or for a
 *   sheet or popover that closes itself (returning false while closed; use `useCloseOnBack`)
 * @returns Unregister function
 *
 * @example
 * ```typescript
 * // A sheet this page renders and closes; UI outside the page tree would pass
 * // { overlay: true }, and a sheet that closes itself uses useCloseOnBack instead.
 * useEffect(() => {
 *   const unregister = registerMobileBackHandler(() => {
 *     if (sheetOpen) {
 *       closeSheet();
 *       return true; // Consumed
 *     }
 *     return false; // Pass to next handler
 *   });
 *   return unregister;
 * }, [sheetOpen]);
 * ```
 */
export function registerMobileBackHandler(handler: BackHandler, options: BackHandlerOptions = {}): () => void {
  const tier = options.overlay ? overlayHandlers : handlers;
  tier.push(handler);

  return () => {
    const index = tier.indexOf(handler);
    if (index !== -1) {
      tier.splice(index, 1);
    }
  };
}
