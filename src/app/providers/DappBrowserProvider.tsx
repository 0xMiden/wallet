/**
 * App-level provider that owns the embedded dApp browser webview lifecycles.
 *
 * Mounted by `<TabLayout>` so it sits ABOVE the route switcher in the
 * React tree. This lets a parked dApp's bubble stay interactive from any
 * tab — navigating to /home doesn't unmount the provider, which doesn't
 * unmount the bubble portal.
 *
 * PR-4 chunk 7 — multi-instance migration:
 *  - PR-3 held a single `DappSession` at a time and re-opened the native
 *    WKWebView on every park/restore cycle. PR-4's vendored
 *    `@miden/dapp-browser` fork adds a registry of parallel WKWebView
 *    instances (iOS: UIWindow per instance; Android: Dialog per
 *    instance), so the provider can now keep N dApps alive in parallel
 *    with their JS context preserved across park/restore (state survives
 *    because we only toggle the native window's visibility — the WKWebView
 *    itself is never torn down).
 *  - `session` / `mode` are kept as derived backwards-compat fields so
 *    existing consumers (`BrowserScreen`, `DappActive`) don't need to
 *    know about the multi-session model yet; they read the foregrounded
 *    session via the singular fields. `<DappBubbleHost>` reads the full
 *    `parkedSessions` array to render one bubble per parked dApp.
 *  - The `useDappBrowserWebView` hook is gone — its responsibilities
 *    (listener wiring, bridge injection, lifecycle) moved into the
 *    provider so multi-session bookkeeping can be centralized.
 *
 * Responsibilities owned by this provider:
 *  - The map of live dApp sessions keyed by session id
 *  - The foreground session id (which session occupies the slot rect) —
 *    null when no session is foregrounded (launcher visible)
 *  - Opening, parking, restoring, closing individual sessions
 *  - Listening to plugin events (messageFromWebview, browserPageLoaded,
 *    urlChangeEvent, closeEvent, pageLoadError) and routing them to the
 *    matching session by `event.id`
 *  - The `<DappBubbleHost>` portal (rendered as a sibling of children)
 *  - The `<DappConfirmationModal>` portal (also rendered as a sibling
 *    so it survives tab navigation)
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

import { DappWebViewInstance, InAppBrowser, ToolBarType, dappWebViewManager } from '@miden/dapp-browser';
import { AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { DappBubbleHost } from 'app/pages/Browser/DappBubbleHost';
import { DappConfirmationModal } from 'app/pages/Browser/DappConfirmationModal';
import { DappSwitcher } from 'app/pages/Browser/DappSwitcher';
import {
  INJECTION_SCRIPT,
  type DappSession,
  type PersistedSession,
  type WebViewMessage,
  fromPersisted,
  handleWebViewMessage,
  loadPersistedSessions,
  readSnapshotFromDisk,
  removePersistedSession,
  removeSnapshotFromDisk,
  toPersisted,
  upsertPersistedSession,
  useDappConfirmation,
  writeSnapshotToDisk
} from 'lib/dapp-browser';
// PR-6 cold-bubble rehydration uses `snapshotStoreInternals.setRaw` to
// hand a disk-loaded snapshot to the in-memory store without going
// through the native plugin.
import { dappConfirmationStore } from 'lib/dapp-browser/confirmation-store';
import { captureSnapshot, clearSnapshot, snapshotStoreInternals } from 'lib/dapp-browser/snapshot-store';
import { type WebViewRect } from 'lib/dapp-browser/webview-rect';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';
import { useWalletStore } from 'lib/store';
import { navigate, useLocation } from 'lib/woozie';

/**
 * Where the foreground webview should be drawn:
 *  - 'launcher' — no foregrounded session, the launcher is showing
 *  - 'active'   — a session is foregrounded and occupying the slot rect
 *  - 'parked'   — legacy single-session mode; no longer emitted as a
 *                 distinct provider-level mode in PR-4 (each session has
 *                 its own status). Preserved in the type for any lingering
 *                 callers still switching on it.
 */
export type DappMode = 'launcher' | 'active' | 'parked';

/**
 * Provider-internal lifecycle status for a single session. Distinct from
 * `DappSessionStatus` in `lib/dapp-browser/dapp-session.ts`, which tracks
 * the public session model. We use a smaller set here keyed off the
 * native instance lifecycle.
 */
export type DappInstanceStatus = 'loading' | 'active' | 'parked' | 'closing';

export interface DappSessionState {
  session: DappSession;
  /** The native-side multi-instance handle. Null briefly while opening. */
  instance: DappWebViewInstance | null;
  status: DappInstanceStatus;
  /** Live origin — updated by urlChangeEvent so cross-origin nav is tracked. */
  origin: string;
  /** True between openWebView and the first browserPageLoaded event. */
  isLoading: boolean;
  /**
   * PR-6: "cold" means this session was rehydrated from persistence at
   * app launch but no native WKWebView exists for it yet. The bubble
   * renders from the cached disk snapshot, and the first restore tap
   * lazy-instantiates the webview via `openInternal` — saving memory
   * for dApps the user hasn't touched since the last app session.
   */
  isCold: boolean;
  /**
   * PR-6: non-null when the last page load for this session failed
   * (e.g. offline, DNS, TLS). `<DappActive>` renders an error overlay
   * with a retry action when this is set. Cleared on successful load
   * or explicit reload.
   */
  error: string | null;
}

interface DappBrowserContextValue {
  /** The foregrounded session, or null if the launcher is showing. */
  session: DappSession | null;
  /** Convenience — 'active' if a session is foregrounded, 'launcher' otherwise. */
  mode: DappMode;
  /** True if the foreground session is still loading its first page. */
  isLoading: boolean;
  /** All sessions currently in the parked state (bubble should show for each). */
  parkedSessions: DappSessionState[];
  /** Every live session (foreground + parked), keyed by id. */
  sessionStates: DappSessionState[];
  /** Open a brand-new dApp session; parks the current foreground if any. */
  open: (session: DappSession) => void;
  /** Close a session entirely. Defaults to the foreground session. */
  close: (sessionId?: string) => Promise<void>;
  /** Park a session — snapshot, hide native window, show bubble. */
  park: (sessionId?: string) => Promise<void>;
  /** Restore a parked session to the foreground. */
  restore: (sessionId: string) => Promise<void>;
  /**
   * PR-5: card switcher state. The switcher is a fullscreen modal that
   * lets the user browse and manage every open dApp at once. It's
   * mounted by the provider so it survives tab navigation.
   */
  switcherOpen: boolean;
  openSwitcher: () => void;
  closeSwitcher: () => void;
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
 * Send a JSON response back to the injected bridge in a specific instance.
 * Mirrors the PR-3 helper in `useDappBrowserWebView`; the retry loop protects
 * against the rare case where executeScript races the injection of
 * `window.__midenWalletResponse`.
 */
async function sendResponseToInstance(instance: DappWebViewInstance, response: unknown, retries = 3): Promise<void> {
  const code = `window.__midenWalletResponse(${JSON.stringify(JSON.stringify(response))});`;
  // Small delay before the first attempt to give the bridge time to settle
  // after an awaited user confirmation.
  await new Promise(resolve => setTimeout(resolve, 100));
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await instance.executeScript(code);
      return;
    } catch (error) {
      console.warn(`[DappBrowserProvider] executeScript attempt ${attempt} failed:`, error);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      } else {
        throw error;
      }
    }
  }
}

/**
 * The provider — mounted at the TabLayout level (above the route switcher).
 */
export const DappBrowserProvider: FC<PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();

  // Sessions live as an array of DappSessionState plus a foregroundId
  // pointer. We use an array for easy rendering in the bubble host and a
  // ref mirror for stable closure access inside plugin listeners.
  const [sessionStates, setSessionStates] = useState<DappSessionState[]>([]);
  const [foregroundId, setForegroundId] = useState<string | null>(null);
  const [slotRect, setSlotRect] = useState<WebViewRect | null>(null);
  // PR-5: card switcher visibility lives in the provider so it survives
  // tab navigation alongside the bubble host.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Snapshot taken at the moment the switcher opens — restored when it
  // closes (unless the user picked a card, in which case the picked
  // session takes the foreground via restore()).
  const switcherForegroundBeforeRef = useRef<string | null>(null);
  const openSwitcher = useCallback(() => {
    switcherForegroundBeforeRef.current = foregroundIdRef.current;
    setSwitcherOpen(true);
  }, []);
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);

  const sessionStatesRef = useRef<DappSessionState[]>(sessionStates);
  const foregroundIdRef = useRef<string | null>(foregroundId);
  const slotRectRef = useRef<WebViewRect | null>(slotRect);
  // Tracks the most recent foregroundId for which `<DappActive>` actually
  // reported a non-null slot rect. The auto-park-on-tab-leave effect uses
  // this to avoid mistakenly parking a freshly opened session whose
  // DappActive hasn't even mounted yet (slotRect is null on the first
  // render after open() — that's a "not yet" state, not a "just left"
  // state, and parking it would deadlock the open path).
  const slotRectShownForRef = useRef<string | null>(null);
  // Forward ref to `restore()` so earlier-declared callbacks (e.g.
  // `open`, the confirmation auto-restore effect) can invoke it without
  // a circular useCallback dependency. Populated after `restore` is
  // defined below.
  const restoreRef = useRef<((sessionId: string) => Promise<void>) | null>(null);

  useEffect(() => {
    sessionStatesRef.current = sessionStates;
  }, [sessionStates]);
  useEffect(() => {
    foregroundIdRef.current = foregroundId;
  }, [foregroundId]);
  useEffect(() => {
    slotRectRef.current = slotRect;
  }, [slotRect]);

  const setActiveDappSession = useWalletStore(s => s.setActiveDappSession);

  // Mutation helper — updates a single session by id via a functional updater.
  const updateSession = useCallback((id: string, updater: (s: DappSessionState) => DappSessionState) => {
    setSessionStates(prev => {
      const idx = prev.findIndex(s => s.session.id === id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = updater(next[idx]);
      return next;
    });
  }, []);

  const removeSession = useCallback((id: string) => {
    setSessionStates(prev => prev.filter(s => s.session.id !== id));
  }, []);

  const getSessionStateById = useCallback((id: string): DappSessionState | undefined => {
    return sessionStatesRef.current.find(s => s.session.id === id);
  }, []);

  // ─── Plugin event listeners ─────────────────────────────────────────────
  //
  // Instead of wiring a fresh set of listeners per session (as PR-3 did),
  // we wire ONE set at provider mount time and demux by the `id` field the
  // native side now includes in every event (PR-4 chunk 7 native patch).
  // This scales to N sessions without handler churn.
  useEffect(() => {
    if (!isMobile()) return;

    const listenerRemovers: Array<() => void> = [];
    let mounted = true;

    const wire = async () => {
      const messageL = await InAppBrowser.addListener('messageFromWebview', async event => {
        const id = (event as { id?: string })?.id ?? 'default';
        const state = getSessionStateById(id);
        if (!state?.instance) return;
        try {
          const eventData = (event as { detail?: unknown })?.detail ?? event;
          const parsed = typeof eventData === 'string' ? JSON.parse(eventData) : (eventData as WebViewMessage);
          const walletMessage = parsed as WebViewMessage;
          // PR-4 chunk 8: pass the session id through to the backend so any
          // confirmation prompt this request triggers is keyed by it and
          // the React modal routes correctly.
          const response = await handleWebViewMessage(walletMessage, state.origin, id);
          await sendResponseToInstance(state.instance, response);
        } catch (error) {
          console.error('[DappBrowserProvider] Error handling WebView message:', error);
        }
      });
      listenerRemovers.push(() => messageL.remove());

      const loadL = await InAppBrowser.addListener('browserPageLoaded', async event => {
        const id = (event as { id?: string })?.id ?? 'default';
        const state = getSessionStateById(id);
        if (!state?.instance) return;
        // PR-6: clear any error state on successful load.
        updateSession(id, s => ({ ...s, isLoading: false, error: null }));
        // Inject the bridge + fetch the document title.
        try {
          await state.instance.executeScript(INJECTION_SCRIPT);
        } catch (e) {
          console.error('[DappBrowserProvider] Error injecting bridge:', e);
        }
        try {
          await state.instance.executeScript(`
            (function() {
              try {
                var t = document.title || '';
                if (window.mobileApp && window.mobileApp.postMessage) {
                  window.mobileApp.postMessage({ __midenInternal: 'title', title: t, __midenInstanceId: '${id}' });
                }
              } catch (e) { /* ignore */ }
            })();
          `);
        } catch {
          // best-effort title fetch
        }
      });
      listenerRemovers.push(() => loadL.remove());

      const urlL = await InAppBrowser.addListener('urlChangeEvent', event => {
        const id = (event as { id?: string })?.id ?? 'default';
        const newUrl = (event as { url?: string })?.url;
        if (!newUrl) return;
        try {
          const origin = new URL(newUrl).origin;
          updateSession(id, s => ({ ...s, origin }));
        } catch {
          /* ignore */
        }
      });
      listenerRemovers.push(() => urlL.remove());

      const errL = await InAppBrowser.addListener('pageLoadError', event => {
        const id = (event as { id?: string })?.id ?? 'default';
        // PR-6: surface the failure to `<DappActive>` so the user can
        // see an error overlay + retry button instead of a blank page.
        const errorMessage = (event as { error?: string })?.error ?? 'Failed to load page';
        updateSession(id, s => ({ ...s, isLoading: false, error: errorMessage }));
        console.error('[DappBrowserProvider] Page load error for instance', id, errorMessage);
      });
      listenerRemovers.push(() => errL.remove());

      const closeL = await InAppBrowser.addListener('closeEvent', async event => {
        const id = (event as { id?: string })?.id ?? 'default';
        const state = getSessionStateById(id);
        if (!state) return;
        // Native plugin closed itself (e.g. user backed out, or our own
        // close() triggered this event as part of its teardown). Remove
        // the session from state.
        clearSnapshot(id);
        removeSession(id);
        if (foregroundIdRef.current === id) {
          setForegroundId(null);
        }
        markReturningFromWebview();
        await resetViewportAfterWebview();
      });
      listenerRemovers.push(() => closeL.remove());

      if (!mounted) {
        // If we already unmounted while awaiting, tear down immediately.
        listenerRemovers.forEach(fn => fn());
      }
    };

    void wire();

    return () => {
      mounted = false;
      listenerRemovers.forEach(fn => fn());
    };
    // getSessionStateById / updateSession / removeSession are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── PR-6 cold-bubble rehydration ───────────────────────────────────────
  //
  // On first mount, load any sessions that were parked in the previous
  // app lifetime and render them as bubbles. Each gets a null instance +
  // isCold=true; tapping the bubble will lazy-instantiate the native
  // WKWebView via `openInternal`. Snapshots come from disk so bubbles
  // look correct immediately, well before any webview is opened.
  useEffect(() => {
    if (!isMobile()) return;
    let cancelled = false;

    const rehydrate = async () => {
      let persisted: PersistedSession[] = [];
      try {
        persisted = await loadPersistedSessions();
      } catch (error) {
        console.warn('[DappBrowserProvider] failed to load persisted sessions:', error);
        return;
      }
      if (cancelled || persisted.length === 0) return;

      // Load snapshots from disk in parallel. Missing files fall back to
      // the favicon tile in DappBubble — not fatal.
      await Promise.all(
        persisted.map(async p => {
          const dataUrl = await readSnapshotFromDisk(p.id);
          if (dataUrl) {
            snapshotStoreInternals.setRaw(p.id, dataUrl);
          }
        })
      );
      if (cancelled) return;

      // Materialize the cold session states. Most-recently-parked-last
      // so the bubble stack order matches the live-session order.
      const coldStates: DappSessionState[] = persisted
        .slice()
        .sort((a, b) => a.parkedAt - b.parkedAt)
        .map(p => ({
          session: fromPersisted(p),
          instance: null,
          status: 'parked' as DappInstanceStatus,
          origin: p.origin,
          isLoading: false,
          isCold: true,
          error: null
        }));

      // Merge into state — this path assumes there are no live sessions
      // yet (which is correct on first mount), so we can just set.
      setSessionStates(prev => (prev.length === 0 ? coldStates : prev));
    };

    void rehydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Public API ─────────────────────────────────────────────────────────

  const openInternal = useCallback(
    async (session: DappSession, rect: WebViewRect) => {
      try {
        const instance = await dappWebViewManager.open({
          id: session.id,
          url: session.url,
          title: t('dappBrowser'),
          toolbarType: ToolBarType.BLANK,
          showReloadButton: false,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          // Expose the dApp WKWebView to Safari Web Inspector / inspect-cli
          // / chrome-devtools-mcp in dev builds. Production builds drop
          // this so users can't poke at the runtime. The flag is plumbed
          // through to WKWebViewConfiguration.isInspectable in the iOS
          // plugin (Capacitor inappbrowser openWebView option).
          isInspectable: process.env.NODE_ENV !== 'production'
        });
        updateSession(session.id, s => ({
          ...s,
          instance,
          status: 'active'
        }));
      } catch (error) {
        console.error('[DappBrowserProvider] Error opening webview:', error);
        updateSession(session.id, s => ({ ...s, isLoading: false, status: 'closing' }));
      }
    },
    [t, updateSession]
  );

  const parkInternal = useCallback(
    async (id: string) => {
      const state = getSessionStateById(id);
      if (!state?.instance) return;
      // Snapshot first so the bubble has a frozen preview to render.
      let snapshotDataUrl: string | null = null;
      try {
        snapshotDataUrl = await captureSnapshot(id, 0.5, 0.7);
      } catch (e) {
        console.warn('[DappBrowserProvider] snapshot capture failed:', e);
      }
      try {
        await state.instance.setVisible(false);
      } catch (e) {
        console.warn('[DappBrowserProvider] setVisible(false) failed:', e);
      }
      updateSession(id, s => ({ ...s, status: 'parked' }));

      // PR-6 cold-bubble persistence: write both the session metadata and
      // the freshly-captured snapshot to disk so the bubble can be
      // rehydrated on the next cold app launch. Both writes are
      // best-effort — the user never blocks on them.
      const persistedSession = {
        ...toPersisted(state.session),
        // Keep the live origin (may differ from session.origin after
        // cross-origin navigation).
        origin: state.origin
      };
      void upsertPersistedSession(persistedSession);
      if (snapshotDataUrl) {
        void writeSnapshotToDisk(id, snapshotDataUrl);
      }
    },
    [getSessionStateById, updateSession]
  );

  const open = useCallback(
    (next: DappSession) => {
      // Dedup by id first, then by URL — tapping the same dApp tile or a
      // "recents" entry for an already-open session should restore the
      // existing session instead of spawning a duplicate. Without this,
      // repeatedly tapping a tile grows the session list unboundedly
      // and the switcher fills up with identical cards.
      const existingById = getSessionStateById(next.id);
      if (existingById) {
        void restoreRef.current?.(next.id);
        return;
      }
      const existingByUrl = sessionStatesRef.current.find(s => s.session.url === next.url && s.status !== 'closing');
      if (existingByUrl) {
        void restoreRef.current?.(existingByUrl.session.id);
        return;
      }

      // Park the current foreground (if any) so its bubble will appear
      // alongside the new session while the new one loads.
      const currentForeground = foregroundIdRef.current;
      if (currentForeground) {
        void parkInternal(currentForeground);
      }

      // Add the new session to state in the 'loading' phase. The effect
      // below will pick up foregroundId + slotRect and call openInternal
      // once the layout has reported a target rect.
      setSessionStates(prev => [
        ...prev,
        {
          session: next,
          instance: null,
          status: 'loading',
          origin: next.origin,
          isLoading: true,
          isCold: false,
          error: null
        }
      ]);
      setForegroundId(next.id);
      setActiveDappSession(next.id);
    },
    [getSessionStateById, parkInternal, setActiveDappSession, updateSession]
  );

  const close = useCallback(
    async (sessionId?: string) => {
      const id = sessionId ?? foregroundIdRef.current;
      if (!id) return;
      const state = getSessionStateById(id);
      if (!state) return;
      updateSession(id, s => ({ ...s, status: 'closing' }));
      try {
        await state.instance?.close();
      } catch (e) {
        console.warn('[DappBrowserProvider] instance.close() failed:', e);
      }
      clearSnapshot(id);
      removeSession(id);
      if (foregroundIdRef.current === id) {
        setForegroundId(null);
        setActiveDappSession(null);
      }
      // PR-6: drop the persisted session + snapshot so it doesn't reappear
      // as a cold bubble on the next app launch.
      void removePersistedSession(id);
      void removeSnapshotFromDisk(id);
      markReturningFromWebview();
      await resetViewportAfterWebview();
    },
    [getSessionStateById, removeSession, setActiveDappSession, updateSession]
  );

  const park = useCallback(
    async (sessionId?: string) => {
      const id = sessionId ?? foregroundIdRef.current;
      if (!id) return;
      await parkInternal(id);
      // If parking the foreground, clear the foregroundId so the launcher
      // shows again (with the bubble overlay).
      if (foregroundIdRef.current === id) {
        setForegroundId(null);
      }
    },
    [parkInternal]
  );

  const restore = useCallback(
    async (sessionId: string) => {
      const state = getSessionStateById(sessionId);
      if (!state) return;
      // Park the current foreground (if any and different from the restore
      // target) so its bubble appears while the restored session takes the
      // active slot.
      const currentForeground = foregroundIdRef.current;
      if (currentForeground && currentForeground !== sessionId) {
        await parkInternal(currentForeground);
      }
      // PR-6 cold-bubble lifecycle: if this session has no live native
      // instance yet (rehydrated from persistence at app launch), mark
      // it 'loading' so the foreground-driving effect calls openInternal
      // once the slot rect is reported. The bubble's cached snapshot
      // stays visible under the loading state until browserPageLoaded
      // fires — see DappActive for the crossfade.
      if (!state.instance || state.isCold) {
        updateSession(sessionId, s => ({
          ...s,
          status: 'loading',
          isLoading: true,
          isCold: false
        }));
      } else {
        // Warm restore — flip mode so the effect drives setVisible(true)
        // + setRect on the existing instance.
        updateSession(sessionId, s => ({ ...s, status: 'active' }));
      }
      setForegroundId(sessionId);
      setActiveDappSession(sessionId);

      // PR-6: if the user tapped a bubble while on HOME/ACTIVITY (not
      // /browser), the `<DappActive>` visual surface isn't mounted so
      // the foreground effect can't trigger openInternal — there's no
      // slot rect. Navigate to /browser so DappActive mounts, reports
      // the rect, and the webview comes up. For warm restores this is
      // a no-op if the user is already on /browser.
      if (typeof window !== 'undefined' && !window.location.hash.startsWith('#/browser')) {
        navigate('/browser');
      }
    },
    [getSessionStateById, parkInternal, setActiveDappSession, updateSession]
  );

  // Populate the forward ref so earlier-declared callbacks (`open`, the
  // confirmation auto-restore effect) can call `restore` without
  // circular useCallback deps.
  useEffect(() => {
    restoreRef.current = restore;
  }, [restore]);

  // ─── Effects that drive the native side ─────────────────────────────────

  // When a session becomes foreground AND a slot rect is reported, either
  // open it for the first time (status === 'loading') or setVisible(true)
  // + setRect on a previously parked instance (status === 'active').
  useEffect(() => {
    if (!foregroundId || !slotRect) return;
    const state = getSessionStateById(foregroundId);
    if (!state) return;

    if (state.status === 'loading' && !state.instance) {
      void openInternal(state.session, slotRect);
      return;
    }
    if (state.instance) {
      void state.instance.setVisible(true);
      void state.instance.setRect(slotRect);
      // Re-run the injection script on restore so any CSS the wallet
      // wants to layer onto the dApp (currently the navbar bottom
      // padding) reaches sessions that were parked before the most
      // recent app update. browserPageLoaded only fires on actual
      // page loads, not when setVisible(true) un-parks an instance,
      // so without this the CSS would never refresh on a hot-restored
      // session.
      void state.instance.executeScript(INJECTION_SCRIPT).catch(() => {});
    }
    // openInternal is stable-ish; intentionally not in deps to avoid
    // re-running on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foregroundId, slotRect?.x, slotRect?.y, slotRect?.width, slotRect?.height]);

  // Record successful slot rect reports so the auto-park effect knows
  // which foregrounds have actually been visible at least once.
  useEffect(() => {
    if (foregroundId && slotRect) {
      slotRectShownForRef.current = foregroundId;
    }
  }, [foregroundId, slotRect]);

  // When the user navigates away from /browser, DappActive unmounts and
  // clears the slot rect. Auto-park the foreground session so its bubble
  // appears on whichever tab the user is now on, and hide the native window
  // so it doesn't bleed through.
  //
  // Guard: only park if we previously SAW a slot rect for this foreground.
  // Without this guard the effect would fire immediately after open()
  // (before DappActive mounted and reported its rect), parking the
  // freshly-opened session on render 1 — which is not what the user wants.
  useEffect(() => {
    if (!foregroundId || slotRect) return;
    if (slotRectShownForRef.current !== foregroundId) return;
    void parkInternal(foregroundId);
    setForegroundId(null);
    slotRectShownForRef.current = null;
  }, [foregroundId, slotRect, parkInternal]);

  // Mirror the foreground session id into the legacy Zustand field for
  // backwards compat with callers (e.g. native-notifications) that check
  // `activeDappSessionId`.
  useEffect(() => {
    setActiveDappSession(foregroundId);
  }, [foregroundId, setActiveDappSession]);

  // PR-6: auto-restore parked sessions that receive a confirmation request.
  //
  // Flow: a parked dApp's WKWebView is still alive and JS keeps running
  // (`setVisible(false)` only hides the UIWindow). When it posts a
  // wallet message that requires user confirmation, the backend writes
  // an entry into `dappConfirmationStore` keyed by sessionId. If that
  // sessionId belongs to a parked session, `<DappConfirmationModal>`
  // (which reads the request for the foreground session only) won't
  // see it — the user would be stuck with no prompt to act on.
  //
  // Fix: subscribe to the store and whenever a pending request exists
  // for a non-foreground session, restore that session so the modal
  // can render. Restore is idempotent for sessions already foreground.
  useEffect(() => {
    if (!isMobile()) return;
    const tryAutoRestore = () => {
      const pending = dappConfirmationStore.getAllPendingRequests();
      for (const req of pending) {
        if (!req.sessionId) continue; // legacy default slot — not ours
        if (req.sessionId === foregroundIdRef.current) continue;
        const state = sessionStatesRef.current.find(s => s.session.id === req.sessionId);
        if (state && state.status !== 'closing') {
          void restore(req.sessionId);
          // Restore one at a time — subsequent requests (if any) will
          // be picked up once the user clears this one.
          break;
        }
      }
    };
    // Run once at mount in case a request landed before the subscription
    // was attached.
    tryAutoRestore();
    return dappConfirmationStore.subscribe(tryAutoRestore);
  }, [restore]);

  // PR-5: when the switcher opens, hide every active native dApp window
  // so the React-rendered switcher can be the topmost visible layer.
  // Otherwise the native UIWindows (which sit above the Capacitor host
  // window in iOS architecture A) bleed through. When the switcher
  // closes WITHOUT a restore(), put the previously-foreground session
  // back into view.
  useEffect(() => {
    if (switcherOpen) {
      // Hide all active instances. Parked ones are already hidden.
      sessionStatesRef.current.forEach(s => {
        if (s.status === 'active' && s.instance) {
          void s.instance.setVisible(false);
        }
      });
    } else {
      // Switcher closed. If a foreground session is set, ensure it's
      // visible at the slot rect (in case the user closed without
      // picking a different card). The slot-rect-driven effect will
      // call setVisible(true) + setRect once it runs, but we don't
      // need to do anything explicit here — the dependency on
      // switcherOpen is enough to trigger a re-run.
      if (foregroundIdRef.current && slotRectRef.current) {
        const state = sessionStatesRef.current.find(s => s.session.id === foregroundIdRef.current);
        if (state?.instance) {
          void state.instance.setVisible(true);
          void state.instance.setRect(slotRectRef.current);
        }
      }
    }
  }, [switcherOpen]);

  // ─── Derived backwards-compat fields ────────────────────────────────────
  //
  // IMPORTANT: read from `sessionStates` (state) here, NOT from
  // `sessionStatesRef.current`. The ref is updated by an effect AFTER the
  // render that triggered the state change, so reading the ref during
  // render returns the previous frame's data — derived fields would lag a
  // render behind every state mutation, leaving `mode === 'launcher'` for
  // one render after `open()` and breaking the launcher → active swap.

  const foregroundState = foregroundId ? sessionStates.find(s => s.session.id === foregroundId) : undefined;
  const session = foregroundState?.session ?? null;
  const mode: DappMode = foregroundState ? 'active' : 'launcher';
  const isLoading = foregroundState?.isLoading ?? false;

  const parkedSessions = useMemo(() => sessionStates.filter(s => s.status === 'parked'), [sessionStates]);

  // ─── Native navbar overlay (Architecture A — quality path) ─────────────
  //
  // The native MidenNavbarOverlayWindow at .normal+200 replaces the
  // React Footer across the entire wallet on mobile. It shows on every
  // page EXCEPT onboarding / lock screens. The React Footer is hidden
  // via the `body[data-native-navbar]` CSS hook in main.css whenever
  // the overlay is up.
  //
  // The active pill highlights based on the current woozie route:
  //   /                           → home
  //   /history*, /history-details → activity
  //   /browser, /select-account*, → browser
  //     /manage-assets*
  //   anything else (send, receive, settings, etc.) → no pill active
  //
  // The navbar stays mounted across tab switches; we just call
  // setNativeNavbarActive to update which pill is highlighted, which
  // avoids the teardown/rebuild flicker showNativeNavbar would cause.
  //
  // Taps fire a `nativeNavbarTap` Capacitor event that the listener
  // below forwards to woozie.navigate so HOME / ACTIVITY / BROWSER
  // behave identically to the React Footer's <Link> elements.
  const location = useLocation();
  const navbarShownRef = useRef(false);
  useEffect(() => {
    if (!isMobile()) return;
    const path = location.pathname;

    // Onboarding and lock screen routes never get the navbar — the
    // user shouldn't see wallet chrome before they're authenticated /
    // have set up an account.
    const isOnboardingRoute =
      path === '/welcome' ||
      path.startsWith('/onboarding') ||
      path === '/loading' ||
      path === '/forgot-password' ||
      path === '/forgot-password-info' ||
      path === '/reset-required' ||
      path === '/reset-wallet' ||
      path === '/import-account' ||
      path.startsWith('/import-account/');

    if (isOnboardingRoute) {
      document.body.removeAttribute('data-native-navbar');
      if (navbarShownRef.current) {
        InAppBrowser.hideNativeNavbar().catch(() => {});
        navbarShownRef.current = false;
      }
      return;
    }

    // Determine which pill should be highlighted. Pages that aren't
    // a top-level destination (send, receive, settings, faucet, etc.)
    // pass null so no pill is active — the navbar still shows but
    // none of the three pills look "selected". Same pattern iOS uses
    // when you drill into a settings sub-page from a tab bar.
    let activeId: string | null = null;
    if (path === '/') activeId = 'home';
    else if (path.startsWith('/history') || path.startsWith('/history-details') || path.startsWith('/token-history'))
      activeId = 'activity';
    else if (path === '/browser' || path.startsWith('/select-account') || path.startsWith('/manage-assets'))
      activeId = 'browser';

    document.body.setAttribute('data-native-navbar', '');

    if (navbarShownRef.current) {
      // Navbar already up — just refresh the active pill. Avoids the
      // teardown / rebuild flicker that showNativeNavbar would cause.
      InAppBrowser.setNativeNavbarActive({ id: activeId }).catch(() => {});
      return;
    }

    // SF Symbols chosen to mirror the React Footer's filled SVG icons:
    // - house.fill matches `home-new.svg` (filled house silhouette)
    // - chart.line.uptrend.xyaxis matches `activity-new.svg` (zigzag
    //   line over a baseline). There's no exact filled equivalent so
    //   we use the regular variant which is the closest visual match.
    // - globe matches `globe-new.svg` (circle with meridians).
    InAppBrowser.showNativeNavbar({
      items: [
        { id: 'home', title: t('home'), sfSymbol: 'house.fill' },
        { id: 'activity', title: t('activity'), sfSymbol: 'chart.line.uptrend.xyaxis' },
        { id: 'browser', title: t('browser'), sfSymbol: 'globe' }
      ],
      activeId
    }).catch(() => {});
    navbarShownRef.current = true;
  }, [location.pathname, t]);

  // Forward native navbar taps to the woozie router. Subscribed once for
  // the lifetime of the provider so we don't lose taps mid-mode-change.
  useEffect(() => {
    if (!isMobile()) return;
    let handle: { remove: () => void } | undefined;
    (async () => {
      const sub = await InAppBrowser.addListener('nativeNavbarTap', (event: { id: string }) => {
        if (event?.id === 'home') navigate('/');
        else if (event?.id === 'activity') navigate('/history');
        else if (event?.id === 'browser') navigate('/browser');
      });
      handle = sub;
    })();
    return () => {
      handle?.remove();
      // Best-effort cleanup if the provider unmounts mid-active-state.
      void InAppBrowser.hideNativeNavbar().catch(() => {});
    };
  }, []);

  const contextValue = useMemo<DappBrowserContextValue>(
    () => ({
      session,
      mode,
      isLoading,
      parkedSessions,
      sessionStates,
      open,
      close,
      park,
      restore,
      switcherOpen,
      openSwitcher,
      closeSwitcher,
      setSlotRect,
      slotRect
    }),
    [
      session,
      mode,
      isLoading,
      parkedSessions,
      sessionStates,
      open,
      close,
      park,
      restore,
      switcherOpen,
      openSwitcher,
      closeSwitcher,
      slotRect
    ]
  );

  // The confirmation modal is rendered here so it survives tab navigation.
  // PR-4 chunk 8: scope to the foreground session id so a parked dApp's
  // pending confirmation stays queued until the user surfaces that
  // session via its bubble. Falling back to undefined when no session is
  // foregrounded means the modal also picks up the legacy default-slot
  // request from the extension/desktop flow when those code paths run.
  const { request, resolve } = useDappConfirmation(foregroundId ?? undefined);

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

      {/* Bubble portal — one bubble per parked dApp. */}
      {isMobile() && <DappBubbleHost />}

      {/* PR-5: card switcher portal — fullscreen modal for managing
          every open dApp. Mounted here so it survives tab navigation. */}
      {isMobile() && <DappSwitcher open={switcherOpen} onClose={closeSwitcher} />}

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

// Re-export RefObject so consumers can pass refs through context.
export type { RefObject };
