/**
 * Platform detection utilities for cross-platform code sharing
 * between browser extension, mobile app, and desktop app.
 *
 * IMPORTANT: This file is imported by service worker code (background.js).
 * Service workers don't have `window`, so we must check for it before
 * doing anything that requires window, Capacitor, or Tauri.
 */

export type PlatformType = 'extension' | 'mobile' | 'desktop' | 'web';

// Lazy-load Capacitor to avoid issues in service workers
let _capacitor: typeof import('@capacitor/core').Capacitor | null = null;
let _capacitorChecked = false;

function getCapacitor(): typeof import('@capacitor/core').Capacitor | null {
  if (!_capacitorChecked) {
    _capacitorChecked = true;
    try {
      // Only import Capacitor if window exists (not in service worker)
      if (typeof window !== 'undefined') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _capacitor = require('@capacitor/core').Capacitor;
      }
    } catch {
      _capacitor = null;
    }
  }
  return _capacitor;
}

/**
 * Detects if running in a Capacitor native app (iOS/Android)
 */
export function isCapacitor(): boolean {
  const capacitor = getCapacitor();
  return capacitor?.isNativePlatform() ?? false;
}

/**
 * Detects if running in a browser extension context
 */
export function isExtension(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  // Check for Firefox (browser.runtime.id) or Chrome (chrome.runtime.id)
  const browserRuntime = g.browser?.runtime?.id;
  const chromeRuntime = g.chrome?.runtime?.id;
  return !!(browserRuntime || chromeRuntime);
}

/**
 * Detects if running on iOS
 */
export function isIOS(): boolean {
  const capacitor = getCapacitor();
  return capacitor?.getPlatform() === 'ios';
}

/**
 * Detects if running on Android
 */
export function isAndroid(): boolean {
  const capacitor = getCapacitor();
  return capacitor?.getPlatform() === 'android';
}

/**
 * Detects if running on mobile (iOS or Android)
 */
export function isMobile(): boolean {
  return isCapacitor();
}

/**
 * Detects if running in a Tauri desktop app
 */
export function isTauri(): boolean {
  /* c8 ignore start */ if (typeof window === 'undefined') return false; /* c8 ignore stop */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
}

/**
 * Detects if running as a desktop app (Tauri)
 */
export function isDesktop(): boolean {
  return isTauri();
}

/**
 * Gets the current platform type
 */
export function getPlatform(): PlatformType {
  if (isCapacitor()) {
    return 'mobile';
  }
  if (isTauri()) {
    return 'desktop';
  }
  if (isExtension()) {
    return 'extension';
  }
  return 'web';
}

/**
 * Platform object for convenient access to all detection functions
 */
export const platform = {
  isCapacitor,
  isExtension,
  isIOS,
  isAndroid,
  isMobile,
  isTauri,
  isDesktop,
  getPlatform
};

export default platform;
