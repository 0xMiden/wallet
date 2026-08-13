import { useEffect } from 'react';

import { App } from '@capacitor/app';

import { isMobile } from 'lib/platform';

import { requestNotesRefresh } from './note-refresh';
import { requestImmediateSync } from './useSyncTrigger';

/**
 * On mobile, force an immediate sync + note revalidation whenever the app
 * returns to the foreground.
 *
 * iOS WKWebView freezes the WebView's timers while the app is backgrounded, so
 * `useSyncTrigger`'s poll and the claimable-notes SWR are both suspended; on
 * resume they only tick again after their own intervals elapse — so a note that
 * arrived while backgrounded appears "too late" (#462). There was previously NO
 * foreground/resume kick anywhere (`requestImmediateSync` existed but was wired
 * only to the connectivity-banner retry). This bridges that gap: on foreground
 * we (1) kick a sync so a just-arrived note is imported now, and (2) ask the
 * claimable-notes hooks to revalidate now so an already-imported note surfaces
 * without waiting out the SWR interval.
 *
 * Listens to BOTH Capacitor `appStateChange` (the native resume signal) and DOM
 * `visibilitychange` (fires in the extension/desktop and as a belt-and-suspenders
 * on mobile). No-op off mobile — the extension has its own service-worker sync.
 */
export function useForegroundRefresh(): void {
  useEffect(() => {
    if (!isMobile()) return;

    const onForeground = () => {
      requestImmediateSync();
      requestNotesRefresh();
    };

    let removeAppListener: (() => void) | undefined;
    let cancelled = false;
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onForeground();
    }).then(handle => {
      if (cancelled) {
        void handle.remove();
      } else {
        removeAppListener = () => void handle.remove();
      }
    });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') onForeground();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      removeAppListener?.();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
