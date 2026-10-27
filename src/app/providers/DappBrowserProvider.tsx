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
 *    session via the singular fields. `<DappPeekTray>` reads the full
 *    `parkedSessions` array to render one peek card per parked dApp.
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
 *  - The `<DappPeekTray>` portal (rendered as a sibling of children)
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import { AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import {
  DappWebViewInstance,
  type HostCloseRequest,
  InAppBrowser,
  type MorphCard,
  type MorphVelocity,
  type PresentationMorphEvent,
  ToolBarType,
  dappWebViewManager
} from '@miden/dapp-browser';
import breadLogoSvg from 'app/icons/brand/new-bread.svg?raw';
import { DappConfirmationModal } from 'app/pages/Browser/DappConfirmationModal';
import { DappPeekTray } from 'app/pages/Browser/DappPeekTray';
import { DappSwitcher } from 'app/pages/Browser/DappSwitcher';
import { MidenDAppErrorType } from 'lib/adapter/types';
import { MORPH_TIMING } from 'lib/animation/morph';
import {
  INJECTION_SCRIPT,
  type DappSession,
  type PersistedSession,
  type WebViewMessage,
  fromPersisted,
  handleWebViewMessage,
  loadPersistedSessions,
  parseOrigin,
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
import { getDappDisplayName } from 'lib/dapp-browser/dapp-session';
import { type DappMotion, applyMorphEvent, classifyMorphEvent, isMorphCard } from 'lib/dapp-browser/morph-motion';
import { PRESENTATION_SCRIPT } from 'lib/dapp-browser/presentation-script';
import { captureSnapshot, clearSnapshot, getSnapshot, snapshotStoreInternals } from 'lib/dapp-browser/snapshot-store';
import { type WebViewRect, rectsEqual } from 'lib/dapp-browser/webview-rect';
import { useOverlayScreenKey } from 'lib/e2e/useOverlayScreenKey';
import { externalPageFailed } from 'lib/mobile/external-page-failed';
import { faucetNoTopInsetScript, isFaucetOrigin } from 'lib/mobile/faucet-top-inset';
import { useHideDappBubblesWhileOpen } from 'lib/mobile/useHideDappBubblesWhileOpen';
import { resetViewportAfterWebview } from 'lib/mobile/viewport-reset';
import { markReturningFromWebview } from 'lib/mobile/webview-state';
import { isIOS, isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';
import { selectIsReady, useWalletStore } from 'lib/store';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { useModalsParams } from 'lib/ui/dialog';
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
  /**
   * Live origin — the SOLE security principal for every dApp request from this
   * session (`handleWebViewMessage` → `processDApp` → `getDApp`). Seeded from the
   * URL the webview is told to load and updated by `urlChangeEvent` so cross-origin
   * nav is tracked.
   */
  origin: string;
  /**
   * True once an `urlChangeEvent` has reported the URL of the load currently in
   * this session's webview, i.e. `origin` was derived from the document that is
   * actually there rather than from the URL we asked for.
   *
   * The gap matters because the two are not the same after a server-side redirect,
   * and `origin` decides whether a `PRIVATE_NOTES_REQUEST` is served from a stored
   * `Auto` grant with no prompt at all. The dApp's document runs in another
   * process and can post through `window.mobileApp.postMessage` as soon as it
   * parses, with no ordering guarantee against the plugin's `urlChangeEvent` — so
   * requests that arrive first are refused rather than attributed to an origin we
   * have not confirmed. Dropping a request is safe; mis-attributing one is not.
   *
   * Cleared ONLY in `openInternal` (a load this provider starts), and never set for
   * an opaque document, which has no origin to bind a grant or an answer to. A soft reload
   * goes through `InAppBrowser.reload` and never clears it, which matters because
   * Android's `doUpdateVisitedHistory` deliberately skips `urlChangeEvent` on a
   * reload — clearing it there would leave the session permanently refused.
   */
  originConfirmed: boolean;
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
  /** Native-confirmed display policy, independent of wallet permissions. */
  presentation: 'browser' | 'fullscreen';
  policyResolved?: boolean;
  policyRevision?: number;
  policyLifetime?: string;
}

interface ManagedCloseRecord {
  request: HostCloseRequest;
  ready: boolean;
  needsDestination: boolean;
  finalized: Promise<void>;
  terminal: Promise<void>;
  settle: () => void;
}

interface SessionFinalization {
  finalized: Promise<void>;
  viewportReady: Promise<void>;
}

interface DappBrowserContextValue {
  policyPending: boolean;
  presentation: 'browser' | 'fullscreen';
  reportPresentationLayout: (id: string, lifetime: string, revision: number, rect: WebViewRect) => void;
  reportLauncherCommit: (active: boolean) => void;

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
  /**
   * Restore a parked session to the foreground, from the card the gesture started on. Resolves true when the native
   * morph carries the page to the slot, false when it is shown without one.
   */
  restore: (sessionId: string, gesture?: RestoreGesture) => Promise<boolean>;
  /** The native morph in flight (#1817), null at rest. */
  motion: DappMotion | null;
  /** Publish the peek card a collapse lands on, null while no card is on screen. */
  reportLandingCard: (card: MorphCard | null) => void;
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
  /**
   * Hold the foreground dApp's native window hidden while a host-WebView overlay
   * is open above it. Returns the release; a no-op once released.
   */
  holdHostOverlay: () => () => void;
}

type ParkGuard = (afterHide: boolean) => boolean;

interface PendingLegacyPark {
  lifetime: symbol;
  instance: DappWebViewInstance;
  revision: number;
  guard?: ParkGuard;
  clearedShown: boolean;
  promise: Promise<true | undefined>;
}

/** Where a restore gesture started: the peek card's rect and the release velocity, in host CSS px. */
export interface RestoreGesture {
  card: MorphCard;
  velocity?: MorphVelocity;
}

/** The native morph the provider follows, with what it needs to commit or abandon it. */
interface MorphFlight {
  revision: number;
  motion: DappMotion;
  instance: DappWebViewInstance;
  /** Settles the park() waiting on this motion: true once a collapse committed its park. */
  finish: (parked: boolean) => void;
  /** Armed once this flight is settled, so finish and its outgoing park run one time. */
  settled?: boolean;
  /** A collapse's snapshot, requested once native accepted the morph. */
  snapshot: Promise<string | null> | null;
  guard?: ParkGuard;
}

type MorphRequest = Parameters<DappWebViewInstance['morph']>[0];

/** Returns a page native started collapsing to the slot; nothing follows it, the page is already foreground. */
function springBack(instance: DappWebViewInstance): void {
  void sendMorph(instance, { to: 'expanded', card: null, morphId: crypto.randomUUID() });
}

/** Whether native accepted a morph; a plugin without the method (an older build) never does. */
async function sendMorph(instance: DappWebViewInstance, request: MorphRequest): Promise<boolean> {
  try {
    return (await instance.morph(request)).accepted === true;
  } catch (error) {
    console.warn('[DappBrowserProvider] morph failed:', error);
    return false;
  }
}

// Asked for only once native accepted the collapse, so the plugin can encode it from the proxy it took as the motion
// started instead of rendering the page again.
function requestParkSnapshot(id: string): Promise<string | null> {
  return captureSnapshot(id, 0.5, 0.7).catch(error => {
    console.warn('[DappBrowserProvider] snapshot capture failed:', error);
    return null;
  });
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
 * While `open`, hide the foreground dApp's native window (it sits above the
 * host WebView and would cover a host overlay) and move parked-dApp bubbles
 * aside. A no-op outside the provider: extension, desktop, confirm window.
 */
export function useHideForegroundDappWhileOpen(open: boolean): void {
  const holdHostOverlay = useContext(DappBrowserContext)?.holdHostOverlay;
  useEffect(() => (open && holdHostOverlay ? holdHostOverlay() : undefined), [open, holdHostOverlay]);
  useHideDappBubblesWhileOpen(open);
}

/**
 * True while a dApp session owns the screen. A persistent notice reads this and
 * waits rather than taking a host-overlay hold: a hold hides the dApp window for
 * as long as it is held, which is right for a sheet the user opened and wrong
 * for a card that stays until it is dismissed. False outside the provider:
 * extension, desktop, confirm window.
 */
export function useForegroundDappActive(): boolean {
  return useContext(DappBrowserContext)?.mode === 'active';
}

/**
 * Send a JSON response back to the injected bridge in a specific instance.
 * Mirrors the PR-3 helper in `useDappBrowserWebView`; the retry loop protects
 * against the rare case where executeScript races the injection of
 * `window.__midenWalletResponse`.
 *
 * `stillTarget` is asked before every attempt, after each sleep, and the answer
 * is dropped once it says no (#1416). A navigation can commit after it, so the
 * script re-checks `expectedOrigin` first, on the unforgeable `location`; "null"
 * (any opaque document) and "" never deliver, and `null` sends a dataless answer unbound.
 */
async function sendResponseToInstance(
  instance: DappWebViewInstance,
  response: unknown,
  expectedOrigin: string | null,
  stillTarget: () => boolean,
  retries = 3
): Promise<void> {
  if (expectedOrigin === 'null' || expectedOrigin === '') return;
  const hand = `window.__midenWalletResponse(${JSON.stringify(JSON.stringify(response))});`;
  const code =
    expectedOrigin === null
      ? hand
      : `(function () { if (location.origin !== ${JSON.stringify(expectedOrigin)}) return; ${hand} })();`;
  // Small delay before the first attempt to give the bridge time to settle
  // after an awaited user confirmation.
  await new Promise(resolve => setTimeout(resolve, 100));
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (!stillTarget()) return;
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

/** Only iOS reports the phone's top inset to the faucet under our header (`faucet-top-inset.ts`). */
const needsFaucetTopInset = (origin: string): boolean => isIOS() && isFaucetOrigin(origin);

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
  const [slotRect, setSlotRectState] = useState<WebViewRect | null>(null);
  // An equal rect keeps the previous object, so every effect keyed on it stays quiet.
  const setSlotRect = useCallback((rect: WebViewRect | null) => {
    setSlotRectState(previous => (rectsEqual(previous ?? undefined, rect ?? undefined) ? previous : rect));
  }, []);
  // PR-5: card switcher visibility lives in the provider so it survives
  // tab navigation alongside the bubble host.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Read through the ref by listeners and effects of the commit that set it; `motion` is its rendered copy.
  const [motion, setMotion] = useState<DappMotion | null>(null);
  const flightRef = useRef<MorphFlight | null>(null);
  const landingCardRef = useRef<MorphCard | null>(null);
  const morphEventRef = useRef<(event: PresentationMorphEvent) => void>(() => undefined);
  const adoptCollapseRef = useRef<
    (id: string, instance: DappWebViewInstance, lifetime: string, morphId: string, guard: ParkGuard) => Promise<boolean>
  >(async () => false);
  const dropFlightRef = useRef<(id: string) => void>(() => undefined);

  // The confirmation modal is rendered here so it survives tab navigation.
  // PR-4 chunk 8: scope to the foreground session id so a parked dApp's
  // pending confirmation stays queued until the user surfaces that
  // session via its bubble. Falling back to undefined when no session is
  // foregrounded means the modal also picks up the legacy default-slot
  // request from this platform's non-session callers (faucet-webview,
  // native notifications). This provider is mounted only on mobile
  // (`App.tsx`); desktop renders its own `DesktopDappConfirmationModal`
  // against the same default slot, and the extension uses its popup.
  const { request, resolve } = useDappConfirmation(foregroundId ?? undefined);

  // Host-WebView overlays that must sit above a foregrounded dApp (the network
  // banner's sheet); while any holds, the foreground window stays hidden.
  const [hostOverlays, setHostOverlays] = useState(0);
  const holdHostOverlay = useCallback(() => {
    setHostOverlays(n => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setHostOverlays(n => Math.max(0, n - 1));
    };
  }, []);

  // Readiness and hydration gate native visibility even before routing removes the reported slot.
  const location = useLocation();
  const isWalletReady = useWalletStore(selectIsReady);
  const isHydrated = useWalletStore(s => s.isInitialized);

  const walletShellActive = useMemo(() => {
    if (!isWalletReady || !isHydrated) return false;
    const path = location.pathname;
    if (path === '/welcome') return false;
    if (path.startsWith('/onboarding')) return false;
    if (path === '/forgot-password') return false;
    if (path === '/forgot-password-info') return false;
    if (path === '/reset-required') return false;
    if (path === '/reset-wallet') return false;
    return true;
  }, [location.pathname, isWalletReady, isHydrated]);

  const { alertParams, confirmParams } = useModalsParams();
  const foregroundBlocked =
    !walletShellActive || !!request || switcherOpen || hostOverlays > 0 || alertParams.isOpen || confirmParams.isOpen;
  const foregroundBlockedRef = useRef(foregroundBlocked);
  const foregroundOwnershipRevision = useRef(0);
  const intentRevisionRef = useRef(0);
  const beginIntent = useCallback((): number => ++intentRevisionRef.current, []);
  const isCurrentIntent = useCallback((revision: number): boolean => intentRevisionRef.current === revision, []);
  // Bumped only by restore, per session. A legacy park already in flight commits only while its captured value remains.
  const restoreGeneration = useRef<Map<string, number>>(new Map());
  if (foregroundBlocked && !foregroundBlockedRef.current) foregroundOwnershipRevision.current++;
  foregroundBlockedRef.current = foregroundBlocked;
  const openSwitcher = useCallback(() => setSwitcherOpen(true), []);
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
  const restoreRef = useRef<((sessionId: string) => Promise<boolean>) | null>(null);
  const restoreWithIntentRef = useRef<((id: string, revision: number) => Promise<boolean>) | null>(null);
  const parkRef = useRef<((sessionId: string, guard?: ParkGuard) => Promise<void>) | null>(null);
  const nativeMinimizations = useRef(new Set<string>());

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
      const current = prev[idx];
      if (!current) return prev;
      const next = [...prev];
      next[idx] = updater(current);
      return next;
    });
  }, []);

  const removeSession = useCallback((id: string) => {
    sessionStatesRef.current = sessionStatesRef.current.filter(s => s.session.id !== id);
    setSessionStates(prev => prev.filter(s => s.session.id !== id));
  }, []);

  const getSessionStateById = useCallback((id: string): DappSessionState | undefined => {
    return sessionStatesRef.current.find(s => s.session.id === id);
  }, []);

  // Native handles can materialize later; lifetime identity changes only on removal and a new session.
  const sessionLifetimes = useRef(new Map<string, symbol>());
  // A same-event open parks the previous loading row inside the updater, so that commit already shows it
  // parked. The effect persists each recorded id once the committed row is still parked, then drops the set.
  const slotlessParkedIds = useRef(new Set<string>());
  useEffect(() => {
    const recorded = slotlessParkedIds.current;
    if (recorded.size === 0) return;
    for (const id of recorded) {
      const state = sessionStates.find(candidate => candidate.session.id === id);
      if (state?.status === 'parked' && sessionLifetimes.current.has(id)) {
        void upsertPersistedSession({ ...toPersisted(state.session), origin: state.origin });
      }
    }
    recorded.clear();
  }, [sessionStates]);
  const pendingParks = useRef(new Map<string, PendingLegacyPark>());
  const openingSessions = useRef(new Map<string, symbol>());
  const listenerSetup = useRef<Promise<void>>(Promise.resolve());
  const finalizations = useRef(new Map<string, SessionFinalization>());
  const managedTokens = useRef(new Map<string, string>());
  const managedClosings = useRef(new Map<string, ManagedCloseRecord>());
  const providerAlive = useRef(true);
  const providerEpoch = useRef(Symbol());
  const [launcherCommitted, setLauncherCommitted] = useState(false);
  const hostCommitGeneration = useRef(0);
  const [closeRevision, setCloseRevision] = useState(0);
  const [presentationLayout, setPresentationLayout] = useState<{
    id: string;
    lifetime: string;
    revision: number;
    rect: WebViewRect;
  } | null>(null);
  const presentationLayoutRef = useRef(presentationLayout);
  presentationLayoutRef.current = presentationLayout;
  const reportPresentationLayout = useCallback((id: string, lifetime: string, revision: number, rect: WebViewRect) => {
    if (managedTokens.current.get(id) !== lifetime || rect.width <= 0 || rect.height <= 0) return;
    setPresentationLayout(previous =>
      previous?.id === id &&
      previous.lifetime === lifetime &&
      previous.revision === revision &&
      previous.rect.x === rect.x &&
      previous.rect.y === rect.y &&
      previous.rect.width === rect.width &&
      previous.rect.height === rect.height
        ? previous
        : { id, lifetime, revision, rect }
    );
  }, []);
  const reportLauncherCommit = useCallback((active: boolean) => {
    setLauncherCommitted(active);
  }, []);
  const finalizeSession = useCallback(
    (id: string, resetViewport = true): Promise<void> => {
      const existing = finalizations.current.get(id);
      if (existing) return existing.finalized;
      if (!getSessionStateById(id)) return Promise.resolve();
      // Remove the session before notifying confirmation subscribers so it cannot auto-restore.
      sessionLifetimes.current.delete(id);
      const token = managedTokens.current.get(id);
      if (token) dappWebViewManager.reserveClose(id, token);
      dropFlightRef.current(id);
      removeSession(id);
      if (foregroundIdRef.current === id) {
        foregroundIdRef.current = null;
        setForegroundId(null);
        setActiveDappSession(null);
      }
      dappConfirmationStore.resolveConfirmation(id, { confirmed: false });
      clearSnapshot(id);
      if (resetViewport) markReturningFromWebview();
      const viewportReady = resetViewport ? resetViewportAfterWebview() : Promise.resolve();
      const finalized = Promise.all([
        removePersistedSession(id).catch(error => console.warn('[DappBrowserProvider] remove session failed:', error)),
        removeSnapshotFromDisk(id).catch(error => console.warn('[DappBrowserProvider] remove snapshot failed:', error)),
        viewportReady
      ]).then(() => undefined);
      finalizations.current.set(id, { finalized, viewportReady });
      return finalized;
    },
    [getSessionStateById, removeSession, setActiveDappSession]
  );

  const requestManagedClose = useCallback(
    (event: HostCloseRequest) => {
      if (!providerAlive.current || managedTokens.current.get(event.id) !== event.token) return;
      const existing = managedClosings.current.get(event.token);
      if (existing) {
        if (existing.request.requestId !== event.requestId) {
          existing.request = event;
          setCloseRevision(n => n + 1);
        }
        return;
      }
      const needsDestination = event.visible === true;
      const resetViewport = needsDestination && foregroundIdRef.current === event.id && !foregroundBlockedRef.current;
      let settle = () => {};
      const terminal = new Promise<void>(resolve => {
        settle = resolve;
      });
      const record: ManagedCloseRecord = {
        request: event,
        ready: false,
        needsDestination,
        finalized: Promise.resolve(),
        terminal,
        settle
      };
      managedClosings.current.set(event.token, record);
      record.finalized = finalizeSession(event.id, resetViewport);
      void (finalizations.current.get(event.id)?.viewportReady ?? Promise.resolve()).finally(() => {
        if (!providerAlive.current || managedClosings.current.get(event.token) !== record) return;
        record.ready = true;
        setCloseRevision(n => n + 1);
      });
      setCloseRevision(n => n + 1);
    },
    [finalizeSession]
  );

  // A child layout receipt certifies the retained launcher. Other host destinations commit here.
  useLayoutEffect(() => {
    const generation = ++hostCommitGeneration.current;
    for (const record of managedClosings.current.values()) {
      if (!record.ready) continue;
      const needsLauncher =
        record.needsDestination && location.pathname === '/browser' && !foregroundBlocked && !foregroundId;
      if (needsLauncher && (!launcherCommitted || slotRect)) continue;
      void InAppBrowser.completeManagedClose({ ...record.request, hostCommitGeneration: generation }).catch(() => {
        // Native retains the surface and offers Retry/Exit now after a failed fence.
      });
    }
  }, [closeRevision, location.pathname, foregroundBlocked, foregroundId, slotRect, launcherCommitted]);

  useEffect(() => {
    providerAlive.current = true;
    const openings = openingSessions.current;
    const tokens = managedTokens.current;
    const closings = managedClosings.current;
    return () => {
      providerAlive.current = false;
      providerEpoch.current = Symbol();
      openings.clear();
      for (const [id, token] of tokens) {
        dappWebViewManager.reserveClose(id, token);
        void InAppBrowser.close({ id, managedHostCloseToken: token, force: true })
          .catch(() => {})
          .finally(() => dappWebViewManager.forget(id, token));
      }
      tokens.clear();
      for (const record of closings.values()) record.settle();
      closings.clear();
    };
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
      const managedL = await InAppBrowser.addListener('hostCloseRequested', requestManagedClose);
      listenerRemovers.push(() => managedL.remove());
      const presentationL = await InAppBrowser.addListener('presentationChanged', event => {
        if (
          event.managedHostCloseToken !== managedTokens.current.get(event.id) ||
          !Number.isSafeInteger(event.policyRevision) ||
          typeof event.policyResolved !== 'boolean'
        )
          return;
        updateSession(event.id, s => {
          if (s.policyLifetime === event.managedHostCloseToken && (s.policyRevision ?? -1) >= event.policyRevision!)
            return s;
          return {
            ...s,
            presentation: event.display,
            policyResolved: event.policyResolved,
            policyRevision: event.policyRevision,
            policyLifetime: event.managedHostCloseToken
          };
        });
      });
      listenerRemovers.push(() => presentationL.remove());
      const minimizeL = await InAppBrowser.addListener('presentationMinimizeRequested', event => {
        const state = getSessionStateById(event.id);
        const lifetime = event.managedHostCloseToken;
        const instance = state?.instance;
        const park = parkRef.current;
        // With a morph id native has already started this collapse (#1817).
        const morphId = typeof event.morphId === 'string' && event.morphId ? event.morphId : null;
        const flight = flightRef.current;
        if (
          morphId &&
          flight?.motion.id === event.id &&
          flight.instance === instance &&
          flight.motion.target === 'collapsed' &&
          !flight.motion.acknowledging
        ) {
          // A second tap retargets native's own spring; the collapse already followed carries on under the new id. A tap
          // native saw before the morph JS sent since (an older sequence) was superseded by it, so it changes nothing.
          if (
            lifetime === flight.motion.lifetime &&
            Number.isSafeInteger(event.visibilitySequence) &&
            event.visibilitySequence === instance.currentVisibilitySequence
          )
            updateFlight(flight, { ...flight.motion, morphId });
          return;
        }
        // Not this provider's page, or one going away: there is nothing to adopt or spring back.
        if (
          !mounted ||
          !lifetime ||
          !instance ||
          managedTokens.current.get(event.id) !== lifetime ||
          managedClosings.current.has(lifetime)
        )
          return;
        if (
          !park ||
          foregroundBlockedRef.current ||
          foregroundIdRef.current !== event.id ||
          state.status !== 'active' ||
          !state.policyResolved ||
          state.policyRevision !== event.policyRevision ||
          nativeMinimizations.current.has(lifetime) ||
          !Number.isSafeInteger(event.visibilitySequence) ||
          event.visibilitySequence !== instance.currentVisibilitySequence
        ) {
          // A collapse the host does not own springs back, unless a host hold is hiding the page anyway.
          if (morphId && foregroundIdRef.current === event.id && !foregroundBlockedRef.current) springBack(instance);
          return;
        }
        const ownership = foregroundOwnershipRevision.current;
        const owns: ParkGuard = afterHide => {
          const current = getSessionStateById(event.id);
          return (
            mounted &&
            foregroundOwnershipRevision.current === ownership &&
            !foregroundBlockedRef.current &&
            !dappConfirmationStore.getPendingRequest(event.id) &&
            foregroundIdRef.current === event.id &&
            managedTokens.current.get(event.id) === lifetime &&
            !managedClosings.current.has(lifetime) &&
            current?.instance === instance &&
            current.policyResolved === true &&
            current.policyRevision === event.policyRevision &&
            (afterHide ||
              (current.status === 'active' && instance.currentVisibilitySequence === event.visibilitySequence))
          );
        };
        nativeMinimizations.current.add(lifetime);
        void (morphId ? adoptCollapseRef.current(event.id, instance, lifetime, morphId, owns) : park(event.id, owns))
          .catch(error => {
            console.warn('[DappBrowserProvider] native minimize failed:', error);
          })
          .finally(() => nativeMinimizations.current.delete(lifetime));
      });
      listenerRemovers.push(() => minimizeL.remove());
      const morphL = await InAppBrowser.addListener('presentationMorph', event => {
        if (mounted) morphEventRef.current(event);
      });
      listenerRemovers.push(() => morphL.remove());

      const messageL = await InAppBrowser.addListener('messageFromWebview', async event => {
        const id = (event as { id?: string })?.id ?? 'default';
        const state = getSessionStateById(id);
        if (!state?.instance) return;
        try {
          const eventData = (event as { detail?: unknown })?.detail ?? event;
          const parsed: unknown = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;

          // Internal wallet-authored messages (title fetch, etc.) ride
          // on the same postMessage channel as dApp wallet requests.
          // Short-circuit them here — without this filter they flow
          // through handleWebViewMessage → processDApp, hit the default
          // switch arm, and generate junk __midenWalletResponse traffic
          // back into the dApp on every page load.
          if (parsed && typeof parsed === 'object' && '__midenInternal' in parsed) {
            const internal = parsed as { __midenInternal?: string; title?: unknown };
            if (internal.__midenInternal === 'title') {
              const title = typeof internal.title === 'string' ? internal.title.trim() : '';
              if (title) {
                updateSession(id, s => ({ ...s, session: { ...s.session, title } }));
              }
            }
            return;
          }

          // Shape-check before casting. handleWebViewMessage / processDApp
          // dispatch on the string payload, but we refuse to forward
          // anything that isn't the expected { type, payload, reqId }
          // envelope so malformed dApp data can't poison the queue.
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            typeof (parsed as { type?: unknown }).type !== 'string' ||
            typeof (parsed as { reqId?: unknown }).reqId !== 'string'
          ) {
            console.warn('[DappBrowserProvider] Ignoring malformed WebView message');
            return;
          }
          const walletMessage = parsed as WebViewMessage;
          // Refuse anything origin-scoped until `urlChangeEvent` has confirmed the
          // origin of the load this message came from. `state.origin` is the only
          // thing standing between a page and another page's approved session (an
          // `Auto` grant serves private notes and balances with no prompt at all),
          // and it is repaired by a cross-process event with no ordering guarantee
          // against the dApp's own inline scripts. PING is exempt: it is the bridge's
          // availability probe, answered locally with PONG and never reaching
          // `processDApp`, so it carries no origin-derived authority.
          if (!state.originConfirmed && walletMessage.payload !== 'PING') {
            // A refusal with no data, sent at once: nothing to bind.
            await sendResponseToInstance(
              state.instance,
              {
                type: 'MIDEN_PAGE_ERROR_RESPONSE',
                payload: null,
                reqId: walletMessage.reqId,
                error: MidenDAppErrorType.NotGranted
              },
              null,
              () => true
            );
            return;
          }
          // PR-4 chunk 8: pass the session id through to the backend so any
          // confirmation prompt this request triggers is keyed by it and
          // the React modal routes correctly.
          const requestOrigin = state.origin;
          const response = await handleWebViewMessage(walletMessage, requestOrigin, id);
          if (walletMessage.payload === 'PING') {
            // A PONG carries no data either, and the origin it would be bound to may not be confirmed yet.
            await sendResponseToInstance(state.instance, response, null, () => true);
            return;
          }
          // The page may have left the origin that asked while this ran (a wait lasts up to five
          // minutes), and its successor can redefine the response hook, so the answer goes only to
          // that origin (#1416).
          await sendResponseToInstance(state.instance, response, requestOrigin, () => {
            const current = getSessionStateById(id);
            return (
              current !== undefined &&
              current.instance === state.instance &&
              current.originConfirmed &&
              current.origin === requestOrigin
            );
          });
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
        // Re-read: the snapshot above predates the await, and `urlChangeEvent` may have confirmed the
        // origin since. An unconfirmed one is left to that handler.
        const loaded = getSessionStateById(id);
        if (loaded?.instance === state.instance && loaded.originConfirmed && needsFaucetTopInset(loaded.origin)) {
          await state.instance.executeScript(faucetNoTopInsetScript(loaded.origin)).catch(() => undefined);
        }
        try {
          // JSON.stringify the id so a non-alphanumeric session id
          // (future-proofing; today it's dapp-<ts>-<rand>) cannot
          // escape the string literal and inject arbitrary JS into
          // the dApp WebView.
          const idLiteral = JSON.stringify(id);
          await state.instance.executeScript(`
            (function() {
              try {
                var t = document.title || '';
                if (window.mobileApp && window.mobileApp.postMessage) {
                  window.mobileApp.postMessage({ __midenInternal: 'title', title: t, __midenInstanceId: ${idLiteral} });
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
          // url and origin are rewritten together, and only together: `parkInternal`
          // persists `toPersisted(session).url` next to this live origin, so a pair
          // that drifts apart makes the next cold restore load one page under
          // another page's approved session.
          updateSession(id, s => ({
            ...s,
            origin,
            originConfirmed: origin !== 'null',
            session: { ...s.session, url: newUrl, origin }
          }));
          // The script is a no-op in any other document, so no loading check: a later `browserPageLoaded`
          // for the faucet document injects again.
          const current = getSessionStateById(id);
          if (current?.instance && needsFaucetTopInset(origin)) {
            void current.instance.executeScript(faucetNoTopInsetScript(origin)).catch(() => undefined);
          }
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
        const token = event.managedHostCloseToken;
        if (token) {
          const record = managedClosings.current.get(token);
          const current = managedTokens.current.get(id) === token;
          if (!current && !record) return;
          await (record?.finalized ?? (current ? finalizeSession(id, false) : Promise.resolve()));
          if (managedClosings.current.get(token) === record) managedClosings.current.delete(token);
          if (managedTokens.current.get(id) === token) managedTokens.current.delete(id);
          dappWebViewManager.forget(id, token);
          record?.settle();
        } else if (!managedTokens.current.has(id)) {
          await finalizeSession(id);
        }
      });
      listenerRemovers.push(() => closeL.remove());

      const permissionL = await InAppBrowser.addListener('permissionDeniedToast', () => {
        if (mounted) reportUserVisibleError('raw_dapp_permission_denied', 'native_toast');
      });
      listenerRemovers.push(() => permissionL.remove());

      if (!mounted) {
        // If we already unmounted while awaiting, tear down immediately.
        listenerRemovers.forEach(fn => fn());
      }
    };

    listenerSetup.current = wire();

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
          if (dataUrl && !cancelled) {
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
          // Display-only until `openInternal` re-derives it from the URL this
          // session will actually load — a legacy record can carry an origin from
          // a page its `url` never pointed at.
          origin: p.origin,
          isLoading: false,
          isCold: true,
          originConfirmed: false,
          error: null,
          presentation: 'browser',
          policyResolved: !isMobile()
        }));

      // Merge into state — this path assumes there are no live sessions
      // yet (which is correct on first mount), so we can just set.
      setSessionStates(prev => {
        if (prev.length > 0) return prev;
        for (const state of coldStates) sessionLifetimes.current.set(state.session.id, Symbol());
        return coldStates;
      });
    };

    void rehydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Public API ─────────────────────────────────────────────────────────

  const openInternal = useCallback(
    async (session: DappSession, rect: WebViewRect) => {
      const lifetime = sessionLifetimes.current.get(session.id);
      if (!lifetime || openingSessions.current.get(session.id) === lifetime) return;
      openingSessions.current.set(session.id, lifetime);
      const epoch = providerEpoch.current;
      const token = crypto.randomUUID();
      managedTokens.current.set(session.id, token);
      try {
        await listenerSetup.current;
        if (
          !providerAlive.current ||
          providerEpoch.current !== epoch ||
          sessionLifetimes.current.get(session.id) !== lifetime
        )
          return;
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
          ...(isMobile()
            ? {
                initiallyVisible: false,
                managedHostClose: {
                  token,
                  errorLabel: t('breadCloseError'),
                  retryLabel: t('retry'),
                  exitLabel: t('breadExitNow')
                },
                breadPresentation: {
                  script: PRESENTATION_SCRIPT,
                  logoSvg: breadLogoSvg,
                  backLabel: t('breadPresentationBack'),
                  hintLabel: t('breadPresentationHint'),
                  retryLabel: t('retry'),
                  errorLabel: t('breadPresentationError'),
                  readinessTimeoutMs: 30000
                }
              }
            : {}),
          isInspectable: process.env.NODE_ENV !== 'production'
        });
        // An early native close can arrive while openWebView is still pending.
        if (
          !providerAlive.current ||
          providerEpoch.current !== epoch ||
          sessionLifetimes.current.get(session.id) !== lifetime
        ) {
          if (!managedClosings.current.has(token)) {
            await InAppBrowser.close({ id: session.id, managedHostCloseToken: token, force: true });
            if (managedTokens.current.get(session.id) === token) await finalizations.current.get(session.id)?.finalized;
            if (managedTokens.current.get(session.id) === token) managedTokens.current.delete(session.id);
            dappWebViewManager.forget(session.id, token);
          }
          return;
        }
        updateSession(session.id, s => {
          const returned: DappSessionState = {
            ...s,
            instance,
            status: foregroundIdRef.current === session.id ? 'active' : 'parked',
            // Stamp the principal from the URL this load actually starts at, rather
            // than carrying over whatever origin the state (or a persisted record)
            // happened to hold — a cold restore's persisted origin can be from a page
            // this load is not opening. Unconfirmed until `urlChangeEvent` reports the
            // document that really committed (a redirect can land elsewhere).
            origin: parseOrigin(session.url),
            originConfirmed: false
          };
          if (s.status === 'loading' && s.instance === null && returned.status === 'parked') {
            slotlessParkedIds.current.add(session.id);
          }
          return returned;
        });
      } catch (error) {
        if (managedClosings.current.has(token)) return;
        if (
          !providerAlive.current ||
          providerEpoch.current !== epoch ||
          sessionLifetimes.current.get(session.id) !== lifetime
        ) {
          if (managedTokens.current.get(session.id) === token) await finalizations.current.get(session.id)?.finalized;
          if (managedTokens.current.get(session.id) === token) managedTokens.current.delete(session.id);
          dappWebViewManager.forget(session.id, token);
          return;
        }
        if (managedTokens.current.get(session.id) === token) managedTokens.current.delete(session.id);
        console.error('[DappBrowserProvider] Error opening webview:', error);
        updateSession(session.id, s => ({ ...s, isLoading: false, status: 'closing' }));
      } finally {
        if (openingSessions.current.get(session.id) === lifetime) openingSessions.current.delete(session.id);
      }
    },
    [t, updateSession]
  );

  const reconcileVisibility = useCallback(
    async (id: string, lifetime: symbol, instance: DappWebViewInstance) => {
      let revision: number;
      do {
        revision = intentRevisionRef.current;
        const state = getSessionStateById(id);
        if (
          !providerAlive.current ||
          finalizations.current.has(id) ||
          sessionLifetimes.current.get(id) !== lifetime ||
          state?.instance !== instance
        )
          return;
        const visible =
          foregroundIdRef.current === id &&
          state.status === 'active' &&
          !!slotRectRef.current &&
          !foregroundBlockedRef.current &&
          !dappConfirmationStore.getPendingRequest(id);
        try {
          await instance.setVisible(visible);
        } catch (error) {
          console.warn('[DappBrowserProvider] visibility reconciliation failed:', error);
          return;
        }
        if (sessionLifetimes.current.get(id) !== lifetime || getSessionStateById(id)?.instance !== instance) return;
      } while (!isCurrentIntent(revision));
    },
    [getSessionStateById, isCurrentIntent]
  );

  const parkLegacy = useCallback(
    (id: string, revision: number, guard?: ParkGuard): Promise<true | undefined> => {
      const state = getSessionStateById(id);
      if (!isCurrentIntent(revision) || !state?.instance || (guard && !guard(false))) return Promise.resolve(undefined);
      const lifetime = sessionLifetimes.current.get(id);
      if (!lifetime) return Promise.resolve(undefined);
      const instance = state.instance;
      // Clear the "was visible" watermark so the auto-park effect
      // below doesn't treat a subsequent restore() as a stale-foreground
      // → auto-park trigger. Without this, parking session A then
      // tapping its bubble would:
      //   1. restore() → setForegroundId(A)
      //   2. React renders with slotRect=null (DappActive not yet mounted)
      //   3. auto-park effect sees foregroundId=A && !slotRect && ref=A
      //   4. fires parkInternal(A) again → session flashes then re-parks
      // (User-visible: "dApp opens and closes immediately on first tap,
      // works on second tap once the ref was cleared by step 4.")
      const noteUnguardedClear = (pending: PendingLegacyPark) => {
        if (guard || slotRectShownForRef.current !== id) return;
        slotRectShownForRef.current = null;
        pending.clearedShown = true;
      };
      const stored = pendingParks.current.get(id);
      if (stored && stored.lifetime === lifetime && stored.instance === instance) {
        if (revision >= stored.revision) {
          stored.revision = revision;
          stored.guard = guard;
          noteUnguardedClear(stored);
        }
        return stored.promise;
      }

      let settlePark: (committed: true | undefined) => void = () => undefined;
      let failPark: (error: unknown) => void = () => undefined;
      const promise = new Promise<true | undefined>((resolve, reject) => {
        settlePark = resolve;
        failPark = reject;
      });
      const record: PendingLegacyPark = {
        lifetime,
        instance,
        revision,
        guard,
        clearedShown: false,
        promise
      };
      noteUnguardedClear(record);
      pendingParks.current.set(id, record);
      const restoreShownSlot = () => {
        if (!record.clearedShown || foregroundIdRef.current !== id) return;
        if (sessionLifetimes.current.get(id) !== record.lifetime) return;
        if (getSessionStateById(id)?.instance !== record.instance) return;
        slotRectShownForRef.current = id;
      };
      void (async () => {
        let committed: true | undefined;
        let failure: unknown;
        try {
          // Snapshot first so the bubble has a frozen preview to render.
          let snapshotDataUrl: string | null = null;
          try {
            snapshotDataUrl = await captureSnapshot(id, 0.5, 0.7);
          } catch (e) {
            console.warn('[DappBrowserProvider] snapshot capture failed:', e);
          }
          if (
            !isCurrentIntent(record.revision) ||
            finalizations.current.has(id) ||
            sessionLifetimes.current.get(id) !== record.lifetime ||
            getSessionStateById(id)?.instance !== record.instance ||
            (record.guard && !record.guard(false))
          ) {
            restoreShownSlot();
            return;
          }
          try {
            await record.instance.setVisible(false);
          } catch (e) {
            console.warn('[DappBrowserProvider] setVisible(false) failed:', e);
          }
          if (
            finalizations.current.has(id) ||
            sessionLifetimes.current.get(id) !== record.lifetime ||
            getSessionStateById(id)?.instance !== record.instance
          ) {
            restoreShownSlot();
            return;
          }
          if (!isCurrentIntent(record.revision) || (record.guard && !record.guard(true))) {
            if (
              sessionLifetimes.current.get(id) === record.lifetime &&
              getSessionStateById(id)?.instance === record.instance
            ) {
              await reconcileVisibility(id, record.lifetime, record.instance);
            }
            restoreShownSlot();
            return;
          }
          if (record.guard && slotRectShownForRef.current === id) slotRectShownForRef.current = null;
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
          committed = true;
        } catch (error) {
          failure = error;
        } finally {
          if (pendingParks.current.get(id) === record) pendingParks.current.delete(id);
          if (failure === undefined) settlePark(committed);
          else failPark(failure);
        }
      })();
      return promise;
    },
    [getSessionStateById, isCurrentIntent, reconcileVisibility, updateSession]
  );

  const parkBackgroundSessions = useCallback(
    (revision: number, target: string) => {
      for (const state of sessionStatesRef.current) {
        const id = state.session.id;
        if (state.status !== 'active' || id === target || id === foregroundIdRef.current) continue;
        const generation = restoreGeneration.current.get(id);
        void parkLegacy(id, revision, () => restoreGeneration.current.get(id) === generation);
      }
    },
    [parkLegacy]
  );

  const open = useCallback(
    (next: DappSession) => {
      if (getSessionStateById(next.id)?.status === 'closing') return;
      if (!getSessionStateById(next.id) && managedTokens.current.has(next.id)) return;
      const revision = beginIntent();
      foregroundOwnershipRevision.current++;
      // Dedup by id first, then by URL — tapping the same dApp tile or a
      // "recents" entry for an already-open session should restore the
      // existing session instead of spawning a duplicate. Without this,
      // repeatedly tapping a tile grows the session list unboundedly
      // and the switcher fills up with identical cards.
      const existingById = getSessionStateById(next.id);
      if (existingById) {
        void restoreWithIntentRef.current?.(next.id, revision);
        return;
      }
      if (managedTokens.current.has(next.id)) return;
      const existingByUrl = sessionStatesRef.current.find(s => s.session.url === next.url && s.status !== 'closing');
      if (existingByUrl) {
        void restoreWithIntentRef.current?.(existingByUrl.session.id, revision);
        return;
      }

      parkBackgroundSessions(revision, next.id);
      // Park the current foreground (if any) so its bubble will appear
      // alongside the new session while the new one loads; a reopen of it
      // restores it, so the park yields to that restore.
      const currentForeground = foregroundIdRef.current;
      if (currentForeground) {
        const generation = restoreGeneration.current.get(currentForeground);
        void parkLegacy(
          currentForeground,
          revision,
          () => restoreGeneration.current.get(currentForeground) === generation
        );
      }

      finalizations.current.delete(next.id);
      sessionLifetimes.current.set(next.id, Symbol());

      // Add the new session to state in the 'loading' phase. The effect
      // below will pick up foregroundId + slotRect and call openInternal
      // once the layout has reported a target rect.
      setSessionStates(prev => [
        ...prev.map((state): DappSessionState => {
          const returned: DappSessionState =
            state.session.id !== next.id && state.status === 'loading' && state.instance === null
              ? { ...state, status: 'parked', isLoading: false }
              : state;
          if (state.status === 'loading' && state.instance === null && returned.status === 'parked') {
            slotlessParkedIds.current.add(state.session.id);
          }
          return returned;
        }),
        {
          session: next,
          instance: null,
          status: 'loading',
          origin: next.origin,
          isLoading: true,
          isCold: false,
          originConfirmed: false,
          error: null,
          presentation: 'browser',
          policyResolved: !isMobile()
        }
      ]);
      foregroundIdRef.current = next.id;
      setForegroundId(next.id);
      setActiveDappSession(next.id);
    },
    [beginIntent, getSessionStateById, parkBackgroundSessions, parkLegacy, setActiveDappSession]
  );

  const close = useCallback(
    async (sessionId?: string) => {
      const id = sessionId ?? foregroundIdRef.current;
      if (!id) return;
      if (foregroundIdRef.current === id) foregroundOwnershipRevision.current++;
      const token = managedTokens.current.get(id);
      const closing = token ? managedClosings.current.get(token) : undefined;
      if (closing) {
        await Promise.all([closing.terminal, closing.finalized]);
        return;
      }
      const state = getSessionStateById(id);
      if (!state) return;
      if (state.instance?.managedHostCloseToken) {
        await state.instance.close();
        await finalizations.current.get(id)?.finalized;
        return;
      }
      const finalized = finalizeSession(id);
      try {
        await state.instance?.close();
      } catch (e) {
        console.warn('[DappBrowserProvider] instance.close() failed:', e);
      }
      await finalized;
    },
    [finalizeSession, getSessionStateById]
  );

  // ─── Native morph (#1817) ───────────────────────────────────────────────
  //
  // The plugin moves the live page between the slot and its peek card on one native spring and reports it through
  // `presentationMorph` events. One flight is followed at a time: a newer morph replaces it, and the events of the
  // replaced morph id stop matching. A collapse commits its park only once native reports it settled, so a reversed
  // or cancelled collapse leaves the session as it was.
  const updateFlight = useCallback((flight: MorphFlight, next: DappMotion) => {
    flight.motion = next;
    if (flightRef.current === flight) setMotion(next);
  }, []);

  // The foreground an expand replaced stayed shown under it; once that motion ends it parks, unless the motion that
  // replaced this one carries it on.
  const parkOutgoing = useCallback(
    (flight: MorphFlight, next?: MorphFlight) => {
      if (!isCurrentIntent(flight.revision)) return;
      const outgoing = flight.motion.outgoingId;
      if (outgoing && outgoing !== next?.motion.id && outgoing !== next?.motion.outgoingId) {
        const generation = restoreGeneration.current.get(outgoing);
        void parkLegacy(outgoing, flight.revision, () => restoreGeneration.current.get(outgoing) === generation);
      }
    },
    [isCurrentIntent, parkLegacy]
  );

  // Reversed, cancelled or replaced: the session stays as it was, so nothing is committed here.
  const endFlight = useCallback(
    (flight: MorphFlight, parked: boolean) => {
      if (flightRef.current === flight) {
        flightRef.current = null;
        setMotion(null);
      }
      // The first stop owns finish and the outgoing park. The acknowledgement hide does not come through here.
      if (flight.settled) return;
      flight.settled = true;
      flight.finish(parked);
      parkOutgoing(flight);
    },
    [parkOutgoing]
  );

  const supersede = useCallback(
    (previous: MorphFlight, next: MorphFlight) => {
      // Native retargeted the replaced spring, so that motion ends without parking.
      if (previous.settled) return;
      previous.settled = true;
      previous.finish(false);
      parkOutgoing(previous, next);
    },
    [parkOutgoing]
  );

  // A close, or a reopen under the same id, leaves a flight without its page.
  const flightLive = useCallback(
    (flight: MorphFlight) =>
      !finalizations.current.has(flight.motion.id) &&
      getSessionStateById(flight.motion.id)?.instance === flight.instance,
    [getSessionStateById]
  );

  // Native leaves a morph it rejects untouched, so whatever was flying still is; a settled collapse is dropped instead,
  // since its acknowledgement may have passed while the rejected morph was followed. Resume only while this rejection
  // is still the flight followed and the caller allows it. A flight this call does not resume is settled, including
  // when a newer flight has already taken its place.
  const restoreFlight = useCallback(
    (rejected: MorphFlight, previous: MorphFlight | null, allowResume: boolean) => {
      const resume =
        flightRef.current === rejected &&
        allowResume &&
        previous &&
        flightLive(previous) &&
        // A settled flight already had its rejection or terminal event; native emits nothing more for it.
        !previous.settled &&
        !previous.motion.acknowledging
          ? previous
          : null;
      if (flightRef.current === rejected) {
        flightRef.current = resume;
        setMotion(resume?.motion ?? null);
      }
      const followed = flightRef.current;
      if (rejected !== followed) {
        if (followed) supersede(rejected, followed);
        else endFlight(rejected, false);
      }
      if (previous && previous !== followed && previous !== rejected) {
        if (followed) supersede(previous, followed);
        else endFlight(previous, false);
      }
    },
    [endFlight, flightLive, supersede]
  );

  // The settled page holds the card pose until its card has painted under it (two frames, at most the timeout); the
  // hide the visibility effect then sends is the acknowledgement that hands the pixels over.
  const acknowledgeCollapse = useCallback((flight: MorphFlight) => {
    let frame = 0;
    let timer: number | undefined;
    const hide = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      if (flightRef.current !== flight) return;
      flightRef.current = null;
      setMotion(null);
    };
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(hide);
    });
    timer = window.setTimeout(hide, MORPH_TIMING.ackTimeoutMs);
  }, []);

  const commitCollapse = useCallback(
    (flight: MorphFlight) => {
      const { id } = flight.motion;
      const state = getSessionStateById(id);
      // A native minimize whose ownership lapsed in flight is not the host's to commit.
      if (
        !state ||
        !isCurrentIntent(flight.revision) ||
        !flightLive(flight) ||
        dappConfirmationStore.getPendingRequest(id) ||
        (flight.guard && !flight.guard(true))
      ) {
        endFlight(flight, false);
        if (state && flightLive(flight) && foregroundIdRef.current === id && !foregroundBlockedRef.current)
          springBack(flight.instance);
        return;
      }
      if (slotRectShownForRef.current === id) slotRectShownForRef.current = null;
      updateSession(id, s => ({ ...s, status: 'parked' }));
      if (foregroundIdRef.current === id) {
        foregroundIdRef.current = null;
        setForegroundId(null);
      }
      void upsertPersistedSession({ ...toPersisted(state.session), origin: state.origin });
      parkOutgoing(flight);
      // The snapshot may still be encoding; it is persisted when it lands, unless the session went away meanwhile.
      // Stored on the flight so the acceptance continuation, which can still see this flight, does not ask again.
      flight.snapshot ??= requestParkSnapshot(id);
      void flight.snapshot.then(dataUrl => {
        if (dataUrl && flightLive(flight)) void writeSnapshotToDisk(id, dataUrl);
      });
      // Still followed: the page stays shown at the card pose until the acknowledgement hides it.
      updateFlight(flight, { ...flight.motion, acknowledging: true });
      if (!flight.settled) {
        flight.settled = true;
        flight.finish(true);
      }
      acknowledgeCollapse(flight);
    },
    [
      acknowledgeCollapse,
      endFlight,
      flightLive,
      getSessionStateById,
      isCurrentIntent,
      parkOutgoing,
      updateFlight,
      updateSession
    ]
  );

  const handleMorphEvent = useCallback(
    (event: PresentationMorphEvent) => {
      const flight = flightRef.current;
      // A settled collapse waiting for its acknowledgement has had its terminal event.
      if (!flight || flight.motion.acknowledging) return;
      const action = classifyMorphEvent(flight.motion, event);
      if (action.kind === 'ignore') return;
      updateFlight(flight, applyMorphEvent(flight.motion, event));
      // A retarget only changes where the page is headed; `settled` says where it ended.
      if (action.kind === 'settle' && action.target === 'collapsed') commitCollapse(flight);
      else if (action.kind === 'settle' || action.kind === 'cancel') endFlight(flight, false);
    },
    [commitCollapse, endFlight, updateFlight]
  );

  /**
   * Starts the native collapse of the foreground `id` toward the published landing card. Resolves 'unaccepted' when
   * native will not carry it (the caller parks the legacy way), else once the motion ends: true if it parked.
   */
  const parkByMorph = useCallback(
    async (id: string, revision: number): Promise<boolean | 'unaccepted'> => {
      const state = getSessionStateById(id);
      const instance = state?.instance;
      const lifetime = managedTokens.current.get(id);
      // Only a shown foreground can move: a host hold has already hidden it, and a closing window is going away.
      if (
        !isCurrentIntent(revision) ||
        !instance ||
        !lifetime ||
        state.status !== 'active' ||
        foregroundIdRef.current !== id ||
        foregroundBlockedRef.current ||
        managedClosings.current.has(lifetime)
      )
        return 'unaccepted';
      const previous = flightRef.current;
      let resolveParked: (parked: boolean) => void = () => undefined;
      const parked = new Promise<boolean>(resolve => {
        resolveParked = resolve;
      });
      const flight: MorphFlight = {
        revision,
        motion: {
          id,
          lifetime,
          morphId: crypto.randomUUID(),
          target: 'collapsed',
          outgoingId: null,
          started: false,
          acknowledging: false,
          progress: 1,
          velocity: 0,
          tracking: false,
          eventSeq: 0
        },
        instance,
        finish: value => resolveParked(value),
        snapshot: null
      };
      // Followed before the command resolves, so an event that overtakes the answer still matches. Sent before the
      // first state update: Capacitor posts a call a microtask later, behind the render that update schedules.
      flightRef.current = flight;
      const sent = sendMorph(instance, {
        to: 'collapsed',
        card: landingCardRef.current,
        morphId: flight.motion.morphId
      });
      setMotion(flight.motion);
      const accepted = await sent;
      if (!isCurrentIntent(revision)) {
        restoreFlight(flight, previous, false);
        return false;
      }
      if (!accepted) {
        restoreFlight(flight, previous, true);
        return 'unaccepted';
      }
      if (previous && previous !== flight) supersede(previous, flight);
      // A collapse that already ended (cancelled before the answer arrived) needs no snapshot. A settle that
      // already stored this flight's promise is not asked again while the flight is still current.
      if (flightRef.current === flight) flight.snapshot ??= requestParkSnapshot(id);
      return parked;
    },
    [getSessionStateById, isCurrentIntent, restoreFlight, supersede]
  );

  // Follows a collapse native started from its own button, guarded like the native minimize it answers.
  const adoptNativeCollapse = useCallback(
    (id: string, instance: DappWebViewInstance, lifetime: string, morphId: string, guard: ParkGuard) => {
      const revision = beginIntent();
      parkBackgroundSessions(revision, id);
      const previous = flightRef.current;
      return new Promise<boolean>(resolve => {
        const flight: MorphFlight = {
          revision,
          motion: {
            id,
            lifetime,
            morphId,
            target: 'collapsed',
            outgoingId: null,
            // Native started it before the minimize event, and may have emitted `started` before it too (Android).
            started: true,
            acknowledging: false,
            progress: 1,
            velocity: 0,
            tracking: false,
            eventSeq: 0
          },
          instance,
          finish: resolve,
          // Native took its proxy as the collapse started, so the snapshot can be asked for at once.
          snapshot: requestParkSnapshot(id),
          guard
        };
        flightRef.current = flight;
        setMotion(flight.motion);
        // Native's own collapse replaced whatever motion this page had.
        if (previous && previous !== flight) supersede(previous, flight);
      });
    },
    [beginIntent, parkBackgroundSessions, supersede]
  );

  // A closing session stops its motion natively and emits nothing more, so its flight is dropped here.
  const dropFlight = useCallback(
    (id: string) => {
      const flight = flightRef.current;
      if (flight?.motion.id === id) endFlight(flight, false);
      // An outgoing foreground that closes leaves nothing to park when the expand ends.
      else if (flight?.motion.outgoingId === id) updateFlight(flight, { ...flight.motion, outgoingId: null });
    },
    [endFlight, updateFlight]
  );

  // A motion whose terminal event never arrives (a lost bridge message) is resolved the way native would have
  // ended it: a collapse parks the legacy way, an expand is left at rest.
  const expireFlight = useCallback(
    (flight: MorphFlight) => {
      if (flightRef.current !== flight || flight.settled) return;
      if (!isCurrentIntent(flight.revision)) {
        endFlight(flight, false);
        return;
      }
      if (flight.motion.target === 'expanded') {
        endFlight(flight, false);
        return;
      }
      // Claimed before the legacy park resolves, which is what finishes the waiter.
      flight.settled = true;
      flightRef.current = null;
      setMotion(null);
      parkOutgoing(flight);
      const { id } = flight.motion;
      const { guard } = flight;
      const generation = restoreGeneration.current.get(id);
      // The morph spent the visibility sequence the guard was taken at, so it is checked as after a hide.
      void parkLegacy(
        id,
        flight.revision,
        () => (!guard || guard(true)) && restoreGeneration.current.get(id) === generation
      ).then(committed => {
        if (committed && isCurrentIntent(flight.revision) && foregroundIdRef.current === id) {
          foregroundIdRef.current = null;
          setForegroundId(null);
        }
        flight.finish(committed === true);
      });
    },
    [endFlight, isCurrentIntent, parkLegacy, parkOutgoing]
  );

  // Re-armed by every accepted event, since each one is a new `motion`; a held page or a settled collapse has none.
  useEffect(() => {
    const flight = flightRef.current;
    if (!motion || flight?.motion !== motion || motion.tracking || motion.acknowledging) return;
    const timer = window.setTimeout(() => expireFlight(flight), MORPH_TIMING.eventTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [motion, expireFlight]);

  // Sent with an expand only once the host acknowledged the session's current policy, as the position effect does.
  const acknowledgedRevision = useCallback(
    (id: string): number | undefined => {
      const state = getSessionStateById(id);
      const layout = presentationLayoutRef.current;
      return state?.policyResolved &&
        layout?.id === id &&
        layout.lifetime === state.policyLifetime &&
        layout.revision === state.policyRevision
        ? state.policyRevision
        : undefined;
    },
    [getSessionStateById]
  );

  // A parked page, or one collapsing toward its card, expands natively. A cold one has no page yet, a pending approval
  // keeps its page hidden behind the modal, and a host hold would cancel the motion on its first frame.
  const canExpandByMorph = useCallback((id: string, state: DappSessionState): boolean => {
    const token = managedTokens.current.get(id);
    const flight = flightRef.current;
    const collapsing = flight?.motion.id === id && flight.motion.target === 'collapsed' && !flight.motion.acknowledging;
    return (
      !!state.instance &&
      !state.isCold &&
      !!token &&
      !managedClosings.current.has(token) &&
      !foregroundBlockedRef.current &&
      !dappConfirmationStore.getPendingRequest(id) &&
      (state.status === 'parked' || collapsing)
    );
  }, []);

  /**
   * Commits `id` as the foreground at once and expands its page natively from the gesture's card. A foreground it
   * replaces stays shown under it until the motion ends. Resolves whether native accepted the expand.
   */
  const restoreByMorph = useCallback(
    async (id: string, instance: DappWebViewInstance, revision: number, gesture?: RestoreGesture): Promise<boolean> => {
      const lifetime = managedTokens.current.get(id);
      if (!lifetime) return false;
      const current = foregroundIdRef.current;
      const outgoingId = current && current !== id ? current : null;
      // Eager, so an event or a minimize handled before the next render already sees the new foreground.
      foregroundIdRef.current = id;
      const previous = flightRef.current;
      const flight: MorphFlight = {
        revision,
        motion: {
          id,
          lifetime,
          morphId: crypto.randomUUID(),
          target: 'expanded',
          outgoingId,
          started: false,
          acknowledging: false,
          progress: 0,
          velocity: 0,
          tracking: false,
          eventSeq: 0
        },
        instance,
        finish: () => undefined,
        snapshot: null
      };
      flightRef.current = flight;
      const policyRevision = acknowledgedRevision(id);
      // Sent before the first state update: Capacitor posts a call a microtask later, behind the render it schedules.
      const sent = sendMorph(instance, {
        to: 'expanded',
        card: gesture?.card ?? null,
        morphId: flight.motion.morphId,
        ...(gesture?.velocity ? { velocity: gesture.velocity } : {}),
        ...(policyRevision === undefined ? {} : { policyRevision })
      });
      // Committed before native answers, so DappActive mounts while the page is still small and its capsule can
      // return alongside it.
      setSessionStates(prev =>
        prev.map((state): DappSessionState => {
          const returned: DappSessionState =
            state.session.id !== id && state.status === 'loading' && state.instance === null
              ? { ...state, status: 'parked', isLoading: false }
              : state;
          if (state.status === 'loading' && state.instance === null && returned.status === 'parked') {
            slotlessParkedIds.current.add(state.session.id);
          }
          return returned;
        })
      );
      updateSession(id, s => ({ ...s, status: 'active' }));
      setForegroundId(id);
      setActiveDappSession(id);
      setMotion(flight.motion);
      // From another tab the capsule and slot exist only once DappActive mounts on /browser.
      if (typeof window !== 'undefined' && !window.location.hash.startsWith('#/browser')) navigate('/browser');
      const accepted = await sent;
      if (!isCurrentIntent(revision)) {
        restoreFlight(flight, previous, false);
        return false;
      }
      if (!accepted) {
        // The position effect shows the page the way it always has; the replaced foreground parks now, so a collapse
        // of it that was flying is not resumed. That settlement parks the outgoing once.
        restoreFlight(flight, previous, previous?.motion.id !== outgoingId);
        return false;
      }
      // Accepted: native retargeted whatever motion this page or the replaced one had.
      if (previous && previous !== flight) supersede(previous, flight);
      return true;
    },
    [acknowledgedRevision, isCurrentIntent, restoreFlight, setActiveDappSession, supersede, updateSession]
  );

  // Deduped by value: the tray republishes on every layout change and resize, and each one is a bridge call.
  const reportLandingCard = useCallback((card: MorphCard | null) => {
    // A card with no size is published as none: native would collapse with the fade-scale for it anyway.
    const next = isMorphCard(card) ? card : null;
    const previous = landingCardRef.current;
    if (
      previous === next ||
      (previous &&
        next &&
        previous.x === next.x &&
        previous.y === next.y &&
        previous.width === next.width &&
        previous.height === next.height &&
        previous.cornerRadius === next.cornerRadius)
    )
      return;
    landingCardRef.current = next;
    void dappWebViewManager
      .setMorphTarget(next)
      .catch(error => console.warn('[DappBrowserProvider] setMorphTarget failed:', error));
  }, []);

  const park = useCallback(
    async (sessionId?: string, guard?: ParkGuard) => {
      const id = sessionId ?? foregroundIdRef.current;
      if (!id || !getSessionStateById(id)?.instance || finalizations.current.has(id) || (guard && !guard(false)))
        return;
      const revision = beginIntent();
      parkBackgroundSessions(revision, id);
      if (!guard && foregroundIdRef.current === id) foregroundOwnershipRevision.current++;
      // A collapse native carries commits the park itself, once it settles. A guarded park answers a native minimize
      // that started no collapse, and keeps its sequence check: a morph attempt would spend the sequence.
      // Read before that answer: a restore while native answers wins over the fallback below.
      const generation = restoreGeneration.current.get(id);
      if (!guard && (await parkByMorph(id, revision)) !== 'unaccepted') return;
      if (!isCurrentIntent(revision)) return;
      const committed = await parkLegacy(
        id,
        revision,
        afterHide => (!guard || guard(afterHide)) && restoreGeneration.current.get(id) === generation
      );
      if (!isCurrentIntent(revision) || !committed || (guard && !guard(true))) return;
      // If parking the foreground, clear the foregroundId so the launcher
      // shows again (with the bubble overlay).
      if (foregroundIdRef.current === id) {
        foregroundIdRef.current = null;
        setForegroundId(null);
      }
    },
    [beginIntent, getSessionStateById, isCurrentIntent, parkBackgroundSessions, parkByMorph, parkLegacy]
  );

  const restoreWithIntent = useCallback(
    async (sessionId: string, revision: number, gesture?: RestoreGesture): Promise<boolean> => {
      const state = getSessionStateById(sessionId);
      const lifetime = sessionLifetimes.current.get(sessionId);
      if (!isCurrentIntent(revision) || !state || !lifetime || finalizations.current.has(sessionId)) return false;
      foregroundOwnershipRevision.current++;
      // Stored before either body, including when this session is already foreground, so a legacy park of it that is
      // still awaiting its snapshot cannot mark it parked once this restore has begun.
      restoreGeneration.current.set(sessionId, (restoreGeneration.current.get(sessionId) ?? 0) + 1);
      // That park cleared the shown-slot mark and left its record on the older revision. The foreground and the
      // slot stay as they are, so put the mark back while the slot is still a rect. The record's revision, guard,
      // and promise stay; the later slot clear joins that same record.
      const pending = pendingParks.current.get(sessionId);
      if (
        foregroundIdRef.current === sessionId &&
        slotRectRef.current !== null &&
        pending?.clearedShown &&
        pending.lifetime === lifetime &&
        pending.instance === state.instance
      ) {
        slotRectShownForRef.current = sessionId;
      }
      parkBackgroundSessions(revision, sessionId);
      // A warm page expands natively; every other restore takes the path below.
      if (state.instance && canExpandByMorph(sessionId, state))
        return restoreByMorph(sessionId, state.instance, revision, gesture);
      // Park the current foreground (if any and different from the restore
      // target) so its bubble appears while the restored session takes the
      // active slot.
      const currentForeground = foregroundIdRef.current;
      let parkedForeground = false;
      if (currentForeground && currentForeground !== sessionId) {
        parkedForeground = (await parkLegacy(currentForeground, revision)) === true;
      }
      if (!isCurrentIntent(revision)) return false;
      const target = getSessionStateById(sessionId);
      if (!target || finalizations.current.has(sessionId) || sessionLifetimes.current.get(sessionId) !== lifetime) {
        if (parkedForeground && foregroundIdRef.current === currentForeground) {
          foregroundIdRef.current = null;
          setForegroundId(null);
          setActiveDappSession(null);
        }
        return false;
      }
      // PR-6 cold-bubble lifecycle: if this session has no live native
      // instance yet (rehydrated from persistence at app launch), mark
      // it 'loading' so the foreground-driving effect calls openInternal
      // once the slot rect is reported. The bubble's cached snapshot
      // stays visible under the loading state until browserPageLoaded
      // fires — see DappActive for the crossfade.
      setSessionStates(prev =>
        prev.map((state): DappSessionState => {
          const returned: DappSessionState =
            state.session.id !== sessionId && state.status === 'loading' && state.instance === null
              ? { ...state, status: 'parked', isLoading: false }
              : state;
          if (state.status === 'loading' && state.instance === null && returned.status === 'parked') {
            slotlessParkedIds.current.add(state.session.id);
          }
          return returned;
        })
      );
      if (!target.instance || target.isCold) {
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
      foregroundIdRef.current = sessionId;
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
      return false;
    },
    [
      canExpandByMorph,
      getSessionStateById,
      isCurrentIntent,
      parkBackgroundSessions,
      parkLegacy,
      restoreByMorph,
      setActiveDappSession,
      updateSession
    ]
  );

  const restore = useCallback(
    (id: string, gesture?: RestoreGesture): Promise<boolean> => {
      if (!getSessionStateById(id) || !sessionLifetimes.current.has(id) || finalizations.current.has(id))
        return Promise.resolve(false);
      return restoreWithIntent(id, beginIntent(), gesture);
    },
    [beginIntent, getSessionStateById, restoreWithIntent]
  );

  // Populate the forward ref so earlier-declared callbacks (`open`, the
  // confirmation auto-restore effect) can call `restore` without
  // circular useCallback deps.
  useEffect(() => {
    restoreRef.current = restore;
    restoreWithIntentRef.current = restoreWithIntent;
    parkRef.current = park;
    morphEventRef.current = handleMorphEvent;
    adoptCollapseRef.current = adoptNativeCollapse;
    dropFlightRef.current = dropFlight;
  }, [adoptNativeCollapse, dropFlight, handleMorphEvent, park, restore, restoreWithIntent]);

  // ─── Effects that drive the native side ─────────────────────────────────

  // Opening needs a reported slot.
  useEffect(() => {
    if (!foregroundId || !slotRect) return;
    const state = getSessionStateById(foregroundId);
    if (state?.status === 'loading' && !state.instance) void openInternal(state.session, slotRect);
    // openInternal is stable-ish; intentionally not in deps to avoid
    // re-running on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foregroundId, slotRect?.x, slotRect?.y, slotRect?.width, slotRect?.height]);

  // Record successful slot rect reports so the auto-park effect knows
  // which foregrounds have actually been visible at least once.
  //
  // A record lasts for one stay in the foreground: releasing the foreground clears it. Parking waits for the snapshot
  // while the session is still foreground, and DappActive re-measures the slot on timers after it mounts, so a record
  // made during that wait would outlive the park, make the next restore of that session look already shown, and park
  // it again before its slot reports.
  useEffect(() => {
    if (!foregroundId) {
      slotRectShownForRef.current = null;
    } else if (slotRect) {
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
    const id = foregroundId;
    const lifetime = sessionLifetimes.current.get(id);
    const instance = getSessionStateById(id)?.instance;
    const pending = pendingParks.current.get(id);
    const samePark =
      !!pending &&
      pending.clearedShown &&
      pending.lifetime === lifetime &&
      pending.instance === instance &&
      isCurrentIntent(pending.revision);
    if (slotRectShownForRef.current !== id && !samePark) return;
    slotRectShownForRef.current = null;
    const revision = beginIntent();
    parkBackgroundSessions(revision, id);
    const generation = restoreGeneration.current.get(id);
    const joined = pendingParks.current.get(id);
    if (joined && joined.lifetime === lifetime && joined.instance === instance) {
      joined.revision = revision;
      joined.guard = () => restoreGeneration.current.get(id) === generation;
    }
    // The page collapses into its card over whichever tab is now showing; without the native morph it hides at once.
    // A restore while native answers keeps the session; otherwise the foreground clears at once.
    void parkByMorph(id, revision).then(outcome => {
      if (outcome !== 'unaccepted' || !isCurrentIntent(revision)) return;
      if (restoreGeneration.current.get(id) !== generation) return;
      void parkLegacy(id, revision, () => restoreGeneration.current.get(id) === generation);
      if (foregroundIdRef.current === id) setForegroundId(null);
    });
  }, [
    foregroundId,
    slotRect,
    beginIntent,
    getSessionStateById,
    isCurrentIntent,
    parkBackgroundSessions,
    parkByMorph,
    parkLegacy
  ]);

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
      // Guard: if the CURRENT foreground session already has its own
      // pending confirmation, do NOT let another session's pending
      // request yank foreground away. Otherwise a previously-authorized
      // parked dApp could interrupt an active confirmation the user is
      // about to act on — at best a UX hijack, at worst an opportunity
      // for a malicious second dApp to bury a victim's approval dialog.
      // The user can still manually restore the parked dApp from its
      // bubble badge (rendered by <DappPeekTray>) once they've cleared
      // the current prompt.
      const currentForeground = foregroundIdRef.current;
      if (currentForeground) {
        const foregroundHasPending = pending.some(r => r.sessionId === currentForeground);
        if (foregroundHasPending) return;
      }
      for (const req of pending) {
        if (!req.sessionId) continue; // legacy default slot — not ours
        if (req.sessionId === currentForeground) continue;
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
  const policyPending = foregroundState?.policyResolved === false;
  const presentation = foregroundState?.presentation ?? 'browser';

  const parkedSessions = useMemo(() => sessionStates.filter(s => s.status === 'parked'), [sessionStates]);

  // E2E-only. Names the current dApp-browser surface in the screen-key signal
  // (`lib/e2e/screen-key`), which the mobile suites take one screenshot per
  // change of. Every dApp transition happens on ONE route, `/browser`, so
  // without this the entire feature — open, park, restore, switch between
  // sessions — is a single unchanging key, and the one suite whose failures are
  // purely visual would document none of the transitions it exists to catch.
  //
  // The gate is the same three conditions the E2E driver uses for "this dApp is
  // up": foregrounded, done loading, and holding a slot to draw into.
  // `foregroundId` is assigned well before the native webview has a rect, let
  // alone a painted frame, so publishing any earlier would spend the one
  // screenshot-per-change on a blank slot.
  //
  // The label is `getDappDisplayName` — the same string the capsule bar shows —
  // so the key names what the user is looking at instead of the session id,
  // which is regenerated on every run and would sort as noise.
  const dappScreenKeyPart = switcherOpen
    ? 'dapp-switcher'
    : foregroundState && foregroundState.status === 'active' && !foregroundState.isLoading && slotRect
      ? `dapp:${getDappDisplayName(foregroundState.session)}`
      : '';
  useOverlayScreenKey(Boolean(dappScreenKeyPart), dappScreenKeyPart);

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
      slotRect,
      motion,
      reportLandingCard,
      holdHostOverlay,
      reportLauncherCommit,
      policyPending,
      presentation,
      reportPresentationLayout
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
      setSlotRect,
      slotRect,
      motion,
      reportLandingCard,
      holdHostOverlay,
      reportLauncherCommit,
      policyPending,
      presentation,
      reportPresentationLayout
    ]
  );

  const visibilityTargets = sessionStates.map(state => ({
    id: state.session.id,
    instance: state.instance,
    active: state.status === 'active',
    policyRevision: state.policyRevision,
    policyResolved: state.policyResolved,
    policyLifetime: state.policyLifetime,
    lifetime: sessionLifetimes.current.get(state.session.id)
  }));
  const visibilityTargetsRef = useRef(visibilityTargets);
  if (
    visibilityTargets.length !== visibilityTargetsRef.current.length ||
    visibilityTargets.some((target, i) => {
      const previous = visibilityTargetsRef.current[i];
      return (
        target.id !== previous?.id ||
        target.instance !== previous.instance ||
        target.active !== previous.active ||
        target.policyRevision !== previous.policyRevision ||
        target.policyResolved !== previous.policyResolved ||
        target.policyLifetime !== previous.policyLifetime ||
        target.lifetime !== previous.lifetime
      );
    })
  )
    visibilityTargetsRef.current = visibilityTargets;
  const stableVisibilityTargets = visibilityTargetsRef.current;

  const foregroundVisibilityTarget = stableVisibilityTargets.find(target => target.id === foregroundId);
  const foregroundInstance = foregroundVisibilityTarget?.instance;
  const foregroundActive = foregroundVisibilityTarget?.active;
  const foregroundLifetime = foregroundVisibilityTarget?.lifetime;
  const foregroundPolicyRevision = foregroundVisibilityTarget?.policyRevision;
  const foregroundPolicyResolved = foregroundVisibilityTarget?.policyResolved;
  const foregroundPolicyLifetime = foregroundVisibilityTarget?.policyLifetime;
  const foregroundOwnership = foregroundOwnershipRevision.current;
  const hasSlot = slotRect !== null;
  const motionId = motion?.id;
  const motionOutgoingId = motion?.outgoingId;
  const motionAcknowledging = motion?.acknowledging;

  // Re-run the injection script once per warm foreground change, so wallet CSS (the navbar bottom padding) reaches
  // a session parked before the latest app update: setVisible(true) fires no browserPageLoaded. A loading page is
  // injected by browserPageLoaded itself. An expanding page gets it once it settles, off the frames that move it.
  const foregroundExpanding = motion?.target === 'expanded' && motionId === foregroundId;
  useEffect(() => {
    if (!foregroundId || !foregroundInstance || foregroundExpanding) return;
    if (getSessionStateById(foregroundId)?.isLoading !== false) return;
    void foregroundInstance
      .executeScript(INJECTION_SCRIPT)
      .catch(e => console.warn('[DappBrowserProvider] executeScript failed:', e));
  }, [foregroundExpanding, foregroundId, foregroundInstance, getSessionStateById]);

  // Generic dialogs are outside this provider. All native windows remain hidden while the host owns visibility.
  // A moving page stays shown until its motion ends, unless the host takes visibility: then the hide cancels it. The
  // flight is read from the ref, which an effect earlier in this commit may have just set; clearing it re-runs this
  // effect, and that hide is what acknowledges a settled collapse.
  useEffect(() => {
    if (!isMobile()) return;
    const flight = foregroundBlocked ? null : flightRef.current;
    const reveal = !foregroundBlocked && !!slotRectRef.current && foregroundActive;
    for (const target of stableVisibilityTargets) {
      if (flight && (target.id === flight.motion.id || target.id === flight.motion.outgoingId)) continue;
      if (target.instance && (target.id !== foregroundId || !reveal)) {
        void target.instance
          .setVisible(false)
          .catch(e => console.warn('[DappBrowserProvider] setVisible(false) failed:', e));
      }
    }
  }, [
    foregroundId,
    foregroundBlocked,
    foregroundActive,
    stableVisibilityTargets,
    hasSlot,
    motionId,
    motionOutgoingId,
    motionAcknowledging
  ]);

  // Only foreground identity, eligibility or geometry can restart positioning and the native paint fence.
  useEffect(() => {
    if (!isMobile()) return;
    const rect = slotRectRef.current;
    const instance = foregroundInstance;
    const id = foregroundId;
    if (!instance || !id || !rect) return;
    // Nothing crosses the bridge for a page in flight; this runs again once its motion ends.
    if (flightRef.current?.motion.id === id && !flightRef.current.motion.acknowledging) return;
    const reveal = !foregroundBlocked && foregroundActive;
    let cancelled = false;
    const position = async () => {
      try {
        await instance.setRect(rect);
      } catch (e) {
        console.warn('[DappBrowserProvider] setRect failed:', e);
        return;
      }
      if (
        !reveal ||
        cancelled ||
        foregroundOwnershipRevision.current !== foregroundOwnership ||
        foregroundBlockedRef.current ||
        foregroundIdRef.current !== id ||
        sessionLifetimes.current.get(id) !== foregroundLifetime ||
        getSessionStateById(id)?.instance !== instance ||
        getSessionStateById(id)?.policyRevision !== foregroundPolicyRevision ||
        !slotRectRef.current
      )
        return;
      try {
        const acknowledged =
          foregroundPolicyResolved &&
          presentationLayout?.id === id &&
          presentationLayout.lifetime === foregroundPolicyLifetime &&
          presentationLayout.revision === foregroundPolicyRevision &&
          presentationLayout.rect.x === rect.x &&
          presentationLayout.rect.y === rect.y &&
          presentationLayout.rect.width === rect.width &&
          presentationLayout.rect.height === rect.height;
        if (acknowledged) await instance.setVisible(true, foregroundPolicyRevision);
        else await instance.setVisible(true);
      } catch (e) {
        console.warn('[DappBrowserProvider] setVisible(true) failed:', e);
      }
    };
    void position();
    return () => {
      cancelled = true;
    };
  }, [
    foregroundId,
    foregroundOwnership,
    foregroundBlocked,
    foregroundInstance,
    foregroundActive,
    foregroundLifetime,
    foregroundPolicyRevision,
    foregroundPolicyResolved,
    foregroundPolicyLifetime,
    presentationLayout,
    slotRect?.x,
    slotRect?.y,
    slotRect?.width,
    slotRect?.height,
    motionId,
    getSessionStateById
  ]);

  // Read account info for the modal — kept here to avoid prop-drilling
  const currentAccount = useWalletStore(s => s.currentAccount);
  const accounts = useWalletStore(s => s.accounts);
  const accountId = useMemo(() => {
    if (currentAccount?.publicKey) return currentAccount.publicKey;
    if (accounts && accounts.length > 0) return accounts[0]!.publicKey;
    return null;
  }, [currentAccount, accounts]);

  // E2E-only observability. The dApp itself renders in a native webview that
  // CDP cannot see, so the suite needs the wallet's own view of the world to
  // assert against: which session is foregrounded, what each session's
  // lifecycle status is, and — the load-bearing one — the slot rect the
  // wallet last asked the plugin to position the webview at. The dApp-browser
  // spec compares that rect against the size the dApp page reports for itself,
  // which is how a "resized the frame but never re-laid-out the content"
  // regression is caught.
  //
  // Observations contain no approval or snapshot payloads. The failure trigger
  // exercises the production notification tree, not native touch reachability.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__TEST_DAPP_BROWSER__ = {
      get pendingConfirmationCount() {
        return dappConfirmationStore.getAllPendingRequests().length;
      },
      hasPendingConfirmation: (id: string) => dappConfirmationStore.hasPendingRequest(id),
      hasSnapshot: (id: string) => getSnapshot(id) !== undefined,
      notifyExternalPageFailed: externalPageFailed,
      foregroundId,
      mode: foregroundId ? 'active' : 'launcher',
      switcherOpen,
      slotRect,
      // The native morph in flight, so a step can wait for the page to come to rest.
      motion: motion && {
        id: motion.id,
        target: motion.target,
        started: motion.started,
        acknowledging: motion.acknowledging,
        progress: motion.progress,
        tracking: motion.tracking
      },
      sessions: sessionStates.map(s => ({
        id: s.session.id,
        url: s.session.url,
        origin: s.origin,
        status: s.status,
        isLoading: s.isLoading,
        isCold: s.isCold,
        error: s.error
      }))
    };
  }, [foregroundId, switcherOpen, slotRect, sessionStates, motion]);

  return (
    <DappBrowserContext.Provider value={contextValue}>
      {children}

      {/* Bubble portal — one bubble per parked dApp. Gated on
          `walletShellActive` so the bubbles never render on the lock
          screen, the welcome / onboarding flow, the forgot-password
          flow, or the reset-required screen.
          The user shouldn't see persistent dApp chrome until they've
          actually unlocked the wallet and are inside the main shell. */}
      {isMobile() && walletShellActive && <DappPeekTray />}

      {/* PR-5: card switcher portal — fullscreen modal for managing
          every open dApp. Mounted here so it survives tab navigation. */}
      {isMobile() && <DappSwitcher open={switcherOpen} onClose={closeSwitcher} />}

      {/* Confirmation modal — visible whenever the store has a pending request,
          regardless of which tab the user is on. */}
      <AnimatePresence>
        {request && (
          <DappConfirmationModal key={request.id} request={request} accountId={accountId} onResolve={resolve} />
        )}
      </AnimatePresence>
    </DappBrowserContext.Provider>
  );
};

// Re-export RefObject so consumers can pass refs through context.
export type { RefObject };
