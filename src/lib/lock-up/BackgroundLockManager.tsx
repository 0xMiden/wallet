import { FC, useEffect } from 'react';

import { App } from '@capacitor/app';

import { isDesktop, isMobile } from 'lib/platform';

import { BACKGROUND_LOCK_HEARTBEAT_MS, backgroundLockPending, createBackgroundLockClock } from './background-lock';
import { backgroundLockDelay, backgroundLockDelayMs } from './index';
import { requestLock } from './lock-request';

/**
 * Locks the mobile and desktop apps after the chosen time in the background. Renders nothing; it only runs the clock.
 */
export const BackgroundLockManager: FC = () => {
  useEffect(() => {
    const mobile = isMobile();
    if (!mobile && !isDesktop()) return undefined;

    const clock = createBackgroundLockClock(() => backgroundLockDelayMs(backgroundLockDelay.get()), Date.now());
    let unmounted = false;

    // The lock request waits on the WASM client lock, which a running sync holds, so the cover goes up first. A failed
    // request keeps it up and the next heartbeat retries: a wallet that could not lock must not look usable.
    let inFlight = false;
    const sendLock = () => {
      if (inFlight) return;
      inFlight = true;
      requestLock()
        .catch(err => console.warn('[background-lock] lock request failed:', err))
        .finally(() => {
          inFlight = false;
        });
    };
    const lockNow = () => {
      if (backgroundLockPending.get()) return;
      backgroundLockPending.set(true);
      sendLock();
    };

    const onHidden = () => clock.hidden(Date.now());
    const onVisible = () => {
      if (clock.visible(Date.now())) lockNow();
    };
    const heartbeat = setInterval(() => {
      if (backgroundLockPending.get()) sendLock();
      else if (clock.tick(Date.now())) lockNow();
    }, BACKGROUND_LOCK_HEARTBEAT_MS);

    const removers: Array<() => void> = [];
    if (mobile) {
      // Only pause and resume: `appStateChange` also fires for a Face ID prompt or Control Center, and the in-app dApp
      // browser leaves the document visible, none of which is time in the background.
      const listen = (event: 'pause' | 'resume', handler: () => void) =>
        App.addListener(event, handler)
          .then(handle => {
            if (unmounted) void handle.remove();
            else removers.push(() => void handle.remove());
          })
          .catch(err => {
            // The heartbeat still locks after a long absence, but a pause or resume that never registers leaves the
            // clock blind to short ones, so it is worth knowing.
            console.warn('[background-lock] listener registration failed:', err);
          });
      void listen('pause', onHidden);
      void listen('resume', onVisible);
    } else {
      const onVisibility = () => (document.visibilityState === 'hidden' ? onHidden() : onVisible());
      document.addEventListener('visibilitychange', onVisibility);
      removers.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }

    return () => {
      unmounted = true;
      clearInterval(heartbeat);
      removers.forEach(remove => remove());
      backgroundLockPending.set(false);
    };
  }, []);

  return null;
};
