import { useEffect } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { isMobile } from 'lib/platform';

import { type BackHandlerOptions, registerMobileBackHandler } from './back-handler';

/**
 * React hook to register a mobile back button handler.
 *
 * The handler is automatically registered on mount and unregistered on unmount.
 * Handlers are called in reverse order (most recently registered first), and
 * overlay handlers before page handlers. A retained page that is off screen registers none.
 *
 * @param handler - Function that returns true if it handled the back press
 * @param deps - Dependency array (like useEffect)
 * @param options - `{ overlay: true }` for UI rendered outside the routed page's tree, or for a
 *   sheet component that closes itself through its own handler; read at registration
 *
 * @example
 * ```typescript
 * useMobileBackHandler(() => {
 *   if (cardStack.length > 1) {
 *     goBack();
 *     return true; // Consumed
 *   }
 *   return false; // Pass to next handler
 * }, [cardStack.length, goBack]);
 * ```
 */
export function useMobileBackHandler(
  handler: () => boolean | void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps: any[],
  options?: BackHandlerOptions
): void {
  const overlay = options?.overlay === true;
  // A retained page that is off screen (a hidden tab, a page under a slide page) registers nothing, so the page
  // on screen always gets the press; a page coming back on screen registers again, on top.
  const onScreen = usePageActive();
  useEffect(() => {
    if (!isMobile() || !onScreen) {
      return;
    }

    const unregister = registerMobileBackHandler(handler, { overlay });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, onScreen]);
}
