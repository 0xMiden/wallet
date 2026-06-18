import { App } from '@capacitor/app';

import { isAndroid, isMobile } from 'lib/platform';

/**
 * Mobile back button handler system.
 *
 * Handles hardware back button and swipe-back gestures on both Android and iOS.
 * Handlers are called in reverse order (last registered = first called).
 * If a handler returns true, it consumed the event and no other handlers are called.
 * If no handler consumes the event: Android minimizes app, iOS does nothing.
 */

type BackHandler = () => boolean | void;

const handlers: BackHandler[] = [];
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
    // Call handlers in reverse order (most recently registered first)
    for (let i = handlers.length - 1; i >= 0; i--) {
      const handler = handlers[i];
      /* c8 ignore next -- defensive guard for sparse array, mobile-only */ if (!handler) continue;
      const result = handler();
      if (result === true) {
        // Handler consumed the event
        return;
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
 * @returns Unregister function
 *
 * @example
 * ```typescript
 * useEffect(() => {
 *   const unregister = registerMobileBackHandler(() => {
 *     if (modalOpen) {
 *       closeModal();
 *       return true; // Consumed
 *     }
 *     return false; // Pass to next handler
 *   });
 *   return unregister;
 * }, [modalOpen]);
 * ```
 */
export function registerMobileBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);

  return () => {
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  };
}
