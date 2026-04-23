import { useEffect } from 'react';

import { InAppBrowser } from '@miden/dapp-browser';
import { isMobile } from 'lib/platform';

/**
 * While `open` is true on mobile, morph the native navbar pill off-screen
 * (and mark `body[data-drawer-open]` so any dApp peek bubbles morph out via
 * main.css). Reverses on close / unmount.
 *
 * Exists because the navbar lives in a separate native `UIWindow` stacked
 * above the WKWebView, so web-layer modals cannot cover it — it always
 * renders on top. Every modal on mobile has to call this to stay beneath
 * the overlay. No-op on desktop / extension.
 *
 * A single open/close reference counter keeps concurrent modals honest —
 * if a second modal opens before the first closes, the navbar stays out
 * until both are gone.
 */
let openCount = 0;

async function applyOutside() {
  document.body.setAttribute('data-drawer-open', '');
  try {
    await InAppBrowser.morphNavbarOut();
  } catch {
    // Best-effort — the plugin may not be present in this build target.
  }
}

async function applyInside() {
  document.body.removeAttribute('data-drawer-open');
  try {
    await InAppBrowser.morphNavbarIn();
  } catch {
    // Best-effort — see applyOutside.
  }
}

export function useHideNavbarWhileOpen(open: boolean): void {
  useEffect(() => {
    if (!isMobile() || !open) return;

    openCount += 1;
    if (openCount === 1) {
      void applyOutside();
    }

    return () => {
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        void applyInside();
      }
    };
  }, [open]);
}
