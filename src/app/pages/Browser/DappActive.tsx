/**
 * Visual shell shown when a dApp session is foregrounded on /browser.
 *
 * After PR-3's `<DappBrowserProvider>` hoist, this component is purely
 * VISUAL — it doesn't own the webview lifecycle anymore. It just:
 *  - Renders the `<CapsuleBar>` (drag handle + favicon + title + ✕)
 *  - Renders the `<NativeWebViewSlot>` whose rect drives the provider's
 *    `setSlotRect` callback
 *  - Reads the active session and isLoading state from `useDappBrowser()`
 *
 * The actual `InAppBrowser.openWebView` lives in the provider, so
 * navigating to a different tab unmounts `<DappActive>` without closing
 * the webview — the bubble takes over.
 */

import React, { type FC, useCallback, useEffect, useRef } from 'react';

import { InAppBrowser } from '@capgo/inappbrowser';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';

import { CapsuleBar } from './CapsuleBar';
import { NativeWebViewSlot } from './NativeWebViewSlot';
import { ProgressBar } from './ProgressBar';

export const DappActive: FC = () => {
  const { session, isLoading, close, park, setSlotRect } = useDappBrowser();
  const slotRef = useRef<HTMLDivElement>(null);

  // Hardware back from `<DappActive>`: park (not close) so the session
  // stays alive as a bubble. The user can drag-down or tap ✕ for a hard
  // close. The confirmation modal registers its own back handler that
  // takes precedence (LIFO) when shown.
  useMobileBackHandler(() => {
    void park();
    return true;
  }, [park]);

  // The capsule's "Reload" overflow action calls the plugin reload directly.
  const handleReload = useCallback(() => {
    InAppBrowser.reload().catch(err => console.warn('[DappActive] reload failed:', err));
  }, []);

  // Drive the provider's slotRect via a ResizeObserver on the slot div.
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSlotRect({
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [setSlotRect]);

  // Clear slot rect on unmount so the provider knows the visual surface
  // is gone (e.g. user navigated to another tab while parked).
  useEffect(
    () => () => {
      setSlotRect(null);
    },
    [setSlotRect]
  );

  if (!session) return null;

  return (
    <div className="flex h-full flex-col">
      <CapsuleBar
        session={session}
        onClose={() => void close()}
        onReload={handleReload}
        onMinimize={() => void park()}
      />

      {/* Spacer matching the capsule height (24 drag + 56 content + 1 hairline) */}
      <div style={{ height: 'calc(env(safe-area-inset-top) + 81px)' }} className="shrink-0" />
      <ProgressBar loading={isLoading} />

      {/* The slot's bounding rect drives `updateDimensions`. We carve out
          space at the bottom matching the floating tabbar (88px content +
          safe-area-inset-bottom) so the native webview rect doesn't overlap
          the React tabbar — otherwise the dApp's PassThroughView captures
          touches in the tabbar region. */}
      <NativeWebViewSlot
        ref={slotRef}
        style={{
          flex: 'none',
          height: 'calc(100vh - env(safe-area-inset-top) - 81px - env(safe-area-inset-bottom) - 88px)'
        }}
      />
    </div>
  );
};
