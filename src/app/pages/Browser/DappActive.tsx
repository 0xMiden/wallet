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

import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InAppBrowser } from '@miden/dapp-browser';
import { useTranslation } from 'react-i18next';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { createDappSession } from 'lib/dapp-browser';
import { getSnapshot } from 'lib/dapp-browser/snapshot-store';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isMobile } from 'lib/platform';

import { CapsuleBar } from './CapsuleBar';
import { DappActionsSheet } from './DappActionsSheet';
import { NativeWebViewSlot } from './NativeWebViewSlot';
import { ProgressBar } from './ProgressBar';

export const DappActive: FC = () => {
  const { session, isLoading, close, open, park, setSlotRect, openSwitcher, sessionStates } = useDappBrowser();
  const { t } = useTranslation();
  const slotRef = useRef<HTMLDivElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);

  // PR-6: read this session's full state so we can surface error and
  // cold-load overlays.
  const sessionState = useMemo(
    () => (session ? sessionStates.find(s => s.session.id === session.id) : undefined),
    [session, sessionStates]
  );
  const error = sessionState?.error ?? null;
  const cachedSnapshot = session ? getSnapshot(session.id) : undefined;

  // Hardware back from `<DappActive>`: park (not close) so the session
  // stays alive as a bubble. The user can drag-down or tap ✕ for a hard
  // close. The confirmation modal registers its own back handler that
  // takes precedence (LIFO) when shown.
  useMobileBackHandler(() => {
    void park();
    return true;
  }, [park]);

  // The capsule's "Reload" overflow action calls the plugin reload directly.
  // PR-6: id-aware so we reload the correct instance when multiple dApps
  // are open in parallel.
  const handleReload = useCallback(() => {
    if (!session) return;
    InAppBrowser.reload({ id: session.id }).catch(err => console.warn('[DappActive] reload failed:', err));
  }, [session]);

  // "Reopen" action from the WeChat-style actions sheet — a HARD restart
  // (distinct from soft Reload above). Closes the current session so the
  // native UIWindow + WebView tear down, then opens a brand-new session
  // at the same URL. Useful when a dApp is stuck in a broken state
  // that a simple reload can't fix.
  const handleReopen = useCallback(() => {
    if (!session) return;
    const url = session.url;
    void close(session.id).then(() => {
      open(createDappSession(url));
    });
  }, [session, close, open]);

  // When the actions sheet opens:
  //   1. Morph out the floating navbar + park bubbles (same CSS/Swift
  //      pattern Settings uses — see Settings.tsx for the rationale).
  //   2. HIDE the dApp WKWebView via `setVisible(false)`. This is the
  //      same trick the card switcher uses: the dApp lives in a
  //      UIWindow above the Capacitor host window, so any React-rendered
  //      drawer sheet that tries to slide up from the bottom gets buried
  //      behind the webview. Hiding the webview clears the occluding
  //      layer and lets the sheet sit on top. The webview's JS context,
  //      scroll position, and in-flight requests all survive the
  //      hide/show cycle.
  //
  // IMPORTANT: this effect is a NO-OP while the sheet is closed — it only
  // runs side effects on "open" and reverses them via the cleanup. An
  // earlier revision also ran the reverse branch on close, which meant
  // DappActive's first mount (actionsOpen=false) would call
  // `morphNavbarIn()` + `setVisible(true)` even when neither were needed.
  // That race with the provider's own restore flow (which also calls
  // `setVisible(true)` + `setRect()` on bubble-tap) caused restored dApps
  // to briefly appear and then get re-parked on the first click.
  useEffect(() => {
    if (!isMobile() || !session || !actionsOpen) return;
    const sessionId = session.id;
    document.body.setAttribute('data-drawer-open', '');
    InAppBrowser.morphNavbarOut().catch(() => {});
    InAppBrowser.setVisible({ id: sessionId, visible: false }).catch(() => {});
    return () => {
      document.body.removeAttribute('data-drawer-open');
      InAppBrowser.morphNavbarIn().catch(() => {});
      InAppBrowser.setVisible({ id: sessionId, visible: true }).catch(() => {});
    };
  }, [actionsOpen, session]);

  // Drive the provider's slotRect via a ResizeObserver on the slot div.
  //
  // CAREFUL: TabLayout runs a `mobile-page-enter` slide-in animation
  // (translateX 8% → 0 over 150ms) on the contentRef wrapper that
  // contains DappActive. getBoundingClientRect returns transformed
  // coordinates, so any measurement taken DURING the slide-in lands
  // ~32pt to the right of the real position. ResizeObserver only
  // re-fires on size changes, not transform changes, so a stale,
  // mid-animation rect would otherwise get locked into the slot state
  // and the WKWebView would render shifted right by ~32pt. We schedule
  // re-measures at 0/200/400ms after mount to make sure at least one
  // lands after the animation has settled.
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
    const t1 = window.setTimeout(update, 200);
    const t2 = window.setTimeout(update, 400);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
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
        // PR-5: card switcher access from the capsule.
        onOpenSwitcher={openSwitcher}
        tabsCount={sessionStates.length}
        onOpenActions={() => setActionsOpen(true)}
      />

      <DappActionsSheet session={session} open={actionsOpen} onOpenChange={setActionsOpen} onReopen={handleReopen} />

      {/* Spacer matching the capsule height (24 drag + 56 content + 1 hairline).
          No safe-area-inset-top here — public/mobile.html applies it
          on the body, which already pushes contentRef below the notch,
          and CapsuleBar dropped its own paddingTop for the same reason.
          Re-adding it would leave a ~50pt empty band between the
          status bar and the drag handle. */}
      <div style={{ height: '81px' }} className="shrink-0" />
      <ProgressBar loading={isLoading} />

      {/* The slot's bounding rect drives `updateDimensions`. Uses
          flex-1 so it naturally fills the space between the capsule
          and the footer spacer below — no `calc(100vh - ...)` math
          (which was off by ~77pt due to nested safe-area padding
          and caused the native webview to overlap the footer, eating
          HOME/ACTIVITY/BROWSER taps).

          PR-6: while isLoading is true (either a first open or a cold-
          bubble restore), we overlay the cached snapshot behind the
          native webview. Keyed to isLoading so it fades out once the
          real content loads underneath. */}
      <div className="relative flex-1 min-h-0">
        <NativeWebViewSlot ref={slotRef} style={{ position: 'absolute', inset: 0 }} />
        {isLoading && cachedSnapshot && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `url(${cachedSnapshot})`,
              backgroundSize: 'cover',
              backgroundPosition: 'top center',
              opacity: isLoading ? 1 : 0,
              transition: 'opacity 0.3s ease-out'
            }}
            aria-hidden="true"
          />
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-pure-white px-6 text-center">
            <div className="mb-2 text-lg font-semibold text-grey-900">
              {t('dappLoadFailed') ?? "Can't load this dApp"}
            </div>
            <div className="mb-6 text-sm text-grey-600">
              {t('dappLoadFailedHint') ?? 'Check your connection and try again.'}
            </div>
            <button
              type="button"
              onClick={handleReload}
              className="rounded-full bg-orange-500 px-6 py-3 text-sm font-semibold text-pure-white"
            >
              {t('retry') ?? 'Retry'}
            </button>
          </div>
        )}
      </div>

      {/* No footer spacer — the slot (flex-1 above) deliberately
          extends to the bottom of contentRef so the WKWebView visually
          covers the area behind the wallet's floating bottom navbar.
          The dApp UIWindow uses MidenDappPassthroughWindow with a
          bottomPassthrough strip (set in DappBrowserProvider as
          NAVBAR_PASSTHROUGH) that returns nil from hitTest for taps
          in the navbar region, so the navbar stays clickable while
          dApp content can scroll behind it like a native iOS app. */}
    </div>
  );
};
