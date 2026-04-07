/**
 * App-level provider that owns the embedded dApp browser webview lifecycle.
 *
 * Mounted by `<TabLayout>` so it sits ABOVE the route switcher in the
 * React tree. PR-3 §3.4a calls this out as load-bearing: in PR-1 the
 * webview was owned by `<DappActive>` inside the `/browser` route, which
 * meant navigating away from `/browser` unmounted the webview. PR-3
 * needs the webview to survive tab navigation so a parked dApp's bubble
 * stays interactive from any tab.
 *
 * Responsibilities owned by this provider:
 *  - The active dApp `<DappSession>` (in PR-3 we still cap at one
 *    session — PR-4 promotes this to a list)
 *  - The `useDappWebView` hook lifecycle (open / track rect / close)
 *  - The current "mode" — `'launcher' | 'active' | 'parked'`
 *  - The slot rect computed by `<NativeWebViewSlot>` (consumed by the
 *    lifecycle hook to drive `updateDimensions`)
 *  - Park / restore orchestration: capture snapshot, move webview off-
 *    screen via `updateDimensions(-2000, ...)`, animate bubble to corner
 *  - The `<DappBubbleHost>` portal (rendered as a sibling of children)
 *  - The `<DappConfirmationModal>` portal (also rendered as a sibling
 *    so it survives tab navigation per PR-6's "confirmation flow for
 *    parked dApps")
 *
 * Consumers (`BrowserScreen`, `DappActive`, `DappBubble`) read state via
 * the `useDappBrowser()` hook and call methods on the returned context.
 */

import React, {
  type FC,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import { AnimatePresence } from 'framer-motion';

import { DappBubbleHost } from 'app/pages/Browser/DappBubbleHost';
import { DappConfirmationModal } from 'app/pages/Browser/DappConfirmationModal';
import { useDappBrowserWebView } from 'app/pages/Browser/useDappBrowserWebView';
import { type DappSession, useDappConfirmation } from 'lib/dapp-browser';
import { captureSnapshot, clearSnapshot } from 'lib/dapp-browser/snapshot-store';
import { type WebViewRect } from 'lib/dapp-browser/webview-rect';
import { isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';
import { useWalletStore } from 'lib/store';

/**
 * Where the foreground webview should be drawn:
 *  - 'launcher' — no session, the launcher is showing
 *  - 'active'   — webview is on screen, occupying the slot rect
 *  - 'parked'   — session alive but webview moved offscreen; bubble visible
 */
export type DappMode = 'launcher' | 'active' | 'parked';

interface DappBrowserContextValue {
  /** The currently held session, or null when on the launcher. */
  session: DappSession | null;
  mode: DappMode;
  /** True between openWebView and the first browserPageLoaded event. */
  isLoading: boolean;
  /** Open a brand-new dApp session. Closes any prior session first. */
  open: (session: DappSession) => void;
  /** Close the current dApp session entirely. */
  close: () => Promise<void>;
  /** Park the active session — snapshot, hide webview, show bubble. */
  park: () => Promise<void>;
  /** Restore a parked session back to active. */
  restore: () => Promise<void>;
  /** Set the slot rect — `<NativeWebViewSlot>` calls this on every layout. */
  setSlotRect: (rect: WebViewRect | null) => void;
  /** The most recent slot rect, used by minimize-animation hooks. */
  slotRect: WebViewRect | null;
}

const DappBrowserContext = createContext<DappBrowserContextValue | null>(null);

export function useDappBrowser(): DappBrowserContextValue {
  const ctx = useContext(DappBrowserContext);
  if (!ctx) {
    throw new Error('useDappBrowser must be used inside <DappBrowserProvider>');
  }
  return ctx;
}

/**
 * The provider — mounted at the TabLayout level (above the route switcher).
 */
export const DappBrowserProvider: FC<PropsWithChildren> = ({ children }) => {
  const [session, setSession] = useState<DappSession | null>(null);
  const [mode, setMode] = useState<DappMode>('launcher');
  const [slotRect, setSlotRect] = useState<WebViewRect | null>(null);
  const setActiveDappSession = useWalletStore(s => s.setActiveDappSession);

  // Track the rect we're driving the webview to. Park moves it offscreen;
  // restore moves it back to the slot rect.
  const targetRectRef = useRef<WebViewRect | null>(null);

  // The lifecycle hook lives here in the provider so opening a dApp here
  // doesn't depend on `<DappActive>` being mounted. The hook resolves
  // `targetRect` lazily so the same instance is reused across mode changes.
  const {
    isLoading,
    open: openWebView,
    close: closeWebView
  } = useDappBrowserWebView({
    session,
    targetRect: mode === 'parked' ? offscreenRect() : slotRect,
    onPageLoaded: title => {
      setSession(prev => (prev && title ? { ...prev, title, status: 'active' } : prev));
    },
    onClose: () => {
      // Native plugin closed itself (e.g. user backed out). Treat as full close.
      hardClose();
    }
  });

  const hardClose = useCallback(() => {
    if (session) clearSnapshot(session.id);
    setSession(null);
    setMode('launcher');
    setSlotRect(null);
    targetRectRef.current = null;
    setActiveDappSession(null);
  }, [session, setActiveDappSession]);

  // open() is the entry point. It tears down any prior session, sets the
  // new session into state, then the effect below picks up the change and
  // calls openWebView() once a slot rect arrives.
  const open = useCallback(
    (next: DappSession) => {
      // Close any prior session first
      void closeWebView();
      if (session) clearSnapshot(session.id);
      setSession(next);
      setMode('active');
      setActiveDappSession(next.id);
    },
    [closeWebView, session, setActiveDappSession]
  );

  const close = useCallback(async () => {
    await closeWebView();
    hardClose();
  }, [closeWebView, hardClose]);

  // Park: capture snapshot, then HARD CLOSE the native webview. The session
  // metadata stays in state so the bubble can show, and restore() reopens
  // the webview at the slot rect when the user taps the bubble.
  //
  // Why hard close instead of moving offscreen: the @capgo/inappbrowser
  // plugin's positioned-modal swap (PassThroughView container) makes
  // subsequent updateDimensions calls move the wrong frame, so an
  // "offscreen rect" approach doesn't actually hide the webview. Closing
  // and reopening is a heavier path but reliable. PR-4's vendored fork
  // adds proper setVisible support so the JS context survives across park.
  const park = useCallback(async () => {
    if (!session || mode !== 'active') return;
    // Snapshot first so the bubble has a frozen preview to render.
    await captureSnapshot(session.id, 0.5, 0.7);
    await closeWebView();
    setMode('parked');
    setSlotRect(null);
  }, [session, mode, closeWebView]);

  // Restore: flip mode back to 'active'. DappActive remounts on the next
  // render, the slot rect is reported, and the lifecycle hook reopens.
  const restore = useCallback(async () => {
    if (!session || mode !== 'parked') return;
    setMode('active');
  }, [session, mode]);

  const contextValue = useMemo<DappBrowserContextValue>(
    () => ({
      session,
      mode,
      isLoading,
      open,
      close,
      park,
      restore,
      setSlotRect,
      slotRect
    }),
    [session, mode, isLoading, open, close, park, restore, slotRect]
  );

  // Mirror provider state into the existing Zustand activeDappSessionId
  // boolean for backwards compat with native-notifications.
  useEffect(() => {
    setActiveDappSession(session?.id ?? null);
  }, [session, setActiveDappSession]);

  // Open the webview ONLY when there's a session, mode is 'active', and the
  // DappActive slot has reported a rect. Parked mode doesn't reopen — park
  // hard-closes the webview and the bubble is the only visual; restore flips
  // mode to 'active' which triggers DappActive to remount and the slot rect
  // to be reported, after which this effect fires.
  useEffect(() => {
    if (!session || mode !== 'active' || !slotRect) return;
    void openWebView();
    // openWebView is a stable ref from the hook; intentionally not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, mode, slotRect != null]);

  // The confirmation modal is rendered here so it survives tab navigation.
  const { request, resolve } = useDappConfirmation();

  // Read account info for the modal — kept here to avoid prop-drilling
  const currentAccount = useWalletStore(s => s.currentAccount);
  const accounts = useWalletStore(s => s.accounts);
  const accountId = useMemo(() => {
    if (currentAccount?.publicKey) return currentAccount.publicKey;
    if (accounts && accounts.length > 0) return accounts[0].publicKey;
    return null;
  }, [currentAccount, accounts]);
  const shortAccountId = useMemo(() => {
    if (!accountId) return null;
    return `${accountId.slice(0, 10)}...${accountId.slice(-8)}`;
  }, [accountId]);

  return (
    <DappBrowserContext.Provider value={contextValue}>
      {children}

      {/* Bubble portal — visible when a dApp is parked. Sits above tab content. */}
      {isMobile() && <DappBubbleHost />}

      {/* Confirmation modal — visible whenever the store has a pending request,
          regardless of which tab the user is on. */}
      <AnimatePresence>
        {request && (
          <DappConfirmationModal request={request} accountId={shortAccountId} onResolve={result => resolve(result)} />
        )}
      </AnimatePresence>
    </DappBrowserContext.Provider>
  );
};

/**
 * Coordinates we move the webview to when parked. Negative values move
 * the native frame offscreen so it stays alive but invisible. The plugin
 * accepts negative coordinates without clamping — verified during PR-1
 * part 2 review of `@capgo+inappbrowser` source.
 */
function offscreenRect(): WebViewRect {
  return { x: -10000, y: -10000, width: 1, height: 1 };
}

// Re-export RefObject so consumers can pass refs through context.
export type { RefObject };
