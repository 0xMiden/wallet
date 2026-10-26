import { useEffect, useRef } from 'react';

import { App } from '@capacitor/app';

import { resolveRootView } from 'app/root-view';
import { isMobile } from 'lib/platform';
import { beginFlow, FlowHandle } from 'lib/telemetry';

/**
 * A real iOS resume delivers Capacitor's `appStateChange` AND the DOM's
 * `visibilitychange` almost together, so the two are coalesced inside this
 * window to keep one resume from reporting two `return` flows.
 */
const FOREGROUND_COALESCE_MS = 500;

/** The slice of the router context the two lifecycle flows are derived from. */
export interface AppLifecycleContext {
  ready: boolean;
  locked: boolean;
  hydrated: boolean;
}

/**
 * Report the two app-lifecycle telemetry flows.
 *
 * `open` — one flow per mount of the app shell, completed once the app leaves
 * its boot view. It has to live here rather than in `app/App`: readiness comes
 * from `useMidenContext`, and `App` is the component that MOUNTS
 * `MidenProvider`, so a hook in its body would sit above the context it needs.
 * Beginning an `open` that can never be completed would make every launch look
 * like an abandonment, which is the failure mode the started/ended pairing
 * exists to detect.
 *
 * `return` — mobile only, and semantically so rather than as a compromise: on
 * the extension a reopened popup is a fresh mount, i.e. already an `open`.
 * `isMobile()` gates both listeners, and `platform` rides on every event, so
 * the receiving side can tell the two apart. Gated on a wallet already
 * existing, because there is nothing to return TO during onboarding.
 *
 * Deliberately NOT folded into `useForegroundRefresh`: that hook's job is
 * syncing, and mixing telemetry into it would rot both.
 */
export function useAppLifecycleTelemetry(ctx: AppLifecycleContext): void {
  const view = resolveRootView(ctx);

  // Read by the foreground listeners, which are registered once and would
  // otherwise close over the view from the render that installed them.
  const viewRef = useRef(view);
  viewRef.current = view;

  const openRef = useRef<FlowHandle | null>(null);
  const returnRef = useRef<FlowHandle | null>(null);

  // `open` begins once per mount. An unmount while still booting is a launch
  // the user walked away from, so cancel rather than leak an unmatched start.
  useEffect(() => {
    openRef.current = beginFlow('open');
    return () => {
      openRef.current?.cancel();
      openRef.current = null;
    };
  }, []);

  // Leaving the boot view — onto the wallet, the lock screen or onboarding —
  // is what "the app opened" means. Clearing the ref makes this fire once.
  useEffect(() => {
    if (view === 'loading') return;
    const handle = openRef.current;
    if (!handle) return;
    openRef.current = null;
    handle.complete();
  }, [view]);

  /**
   * `return` measures foreground → wallet usable again, so it completes when
   * the app reaches its usable view. Foregrounding onto a wallet that
   * auto-locked therefore keeps the flow open across the unlock, which is the
   * case worth measuring; foregrounding onto an already-usable wallet
   * completes immediately, for a near-zero duration that truthfully says the
   * user came straight back in.
   */
  useEffect(() => {
    if (view !== 'app') return;
    const handle = returnRef.current;
    if (!handle) return;
    returnRef.current = null;
    handle.complete();
  }, [view]);

  useEffect(() => {
    if (!isMobile()) return undefined;

    let lastForegroundAt = 0;
    const onForeground = () => {
      const now = Date.now();
      if (now - lastForegroundAt < FOREGROUND_COALESCE_MS) return;
      lastForegroundAt = now;

      // Only an existing wallet can be returned to: `welcome` means there is
      // none, and `loading` means we have not heard from the backend yet.
      const current = viewRef.current;
      if (current !== 'unlock' && current !== 'app') return;
      // A resume that arrives while the previous return is still waiting on the
      // lock screen belongs to that flow, not a new one.
      if (returnRef.current) return;

      const handle = beginFlow('return');
      if (current === 'app') {
        handle.complete();
        return;
      }
      returnRef.current = handle;
    };

    let removeAppListener: (() => void) | undefined;
    let cancelled = false;
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onForeground();
    })
      .then(handle => {
        if (cancelled) {
          void handle.remove();
        } else {
          removeAppListener = () => void handle.remove();
        }
      })
      .catch(() => {
        // The native listener could not be registered (plugin unavailable in a
        // web/test context); the visibilitychange path still covers resume.
      });

    const onVisibility = () => {
      if (document.visibilityState === 'visible') onForeground();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      removeAppListener?.();
      document.removeEventListener('visibilitychange', onVisibility);
      returnRef.current?.cancel();
      returnRef.current = null;
    };
  }, []);
}
