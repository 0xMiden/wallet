import React, {
  FC,
  forwardRef,
  ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

import classNames from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useHasUnclaimedNotes } from 'app/hooks/useHasUnclaimedNotes';
import { Icon, IconName } from 'app/icons/v2';
import HomeSwipeContainer from 'app/layouts/HomeSwipeContainer';
import { PageActiveContext, usePageActive } from 'app/layouts/page-active';
import { NetworkModeStrip } from 'components/NetworkModeStrip';
import { BottomNav, BottomNavItem, SegmentedActionBar } from 'components/ui';
import { usePreset } from 'lib/animation';
import { isSwapEnabled } from 'lib/feature-flags';
import { hapticSelection } from 'lib/mobile/haptics';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { useKeyboardVisible } from 'lib/mobile/useKeyboardVisible';
import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';
import { navigate, useLocation } from 'lib/woozie';

/**
 * Layout for tab-based pages (Home, History, Settings, Browser).
 * Provides a persistent footer and animated content area.
 *
 * The top action bar is mounted when the route is in the "home"
 * tab group (/, /send, /receive, /earn, /swap) so it stays visible across
 * Overview ↔ Send ↔ Receive ↔ Earn ↔ Swap transitions. Other tabs (Explore,
 * Activity, Settings) hide it.
 *
 * Only the Settings ROOT (`/settings`) is a tab destination; `/settings/<slug>`
 * sub-pages keep their FullScreenPage drill-in so back behaviour and history
 * depth are unchanged (see PageRouter).
 */
const TAB_ROUTES: Record<string, string> = {
  home: '/',
  explore: '/browser',
  activity: '/history',
  settings: '/settings'
};

const ACTION_ROUTES: Record<string, string> = {
  overview: '/',
  send: '/send',
  receive: '/receive',
  earn: '/earn',
  swap: '/swap'
};

const HOME_GROUP_ROUTES = new Set(['/', '/send', '/receive', '/earn', '/swap']);

interface TabPaneProps extends PropsWithChildren {
  id: string;
  active: boolean;
}

// One tab's content. An inactive pane keeps its layout but is not painted,
// not focusable and not read by assistive tech.
const TabPane: FC<TabPaneProps> = ({ id, active, children }) => {
  const layerActive = usePageActive();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.toggleAttribute('inert', !active);
  }, [active]);
  return (
    <div
      ref={ref}
      // flex column so children (AllHistory, Browser) that use
      // `flex-1 min-h-0 overflow-y-auto` for their scroll region can
      // actually claim the remaining height.
      className="absolute inset-0 overflow-hidden flex flex-col"
      data-tab-pane={id}
      aria-hidden={!active || undefined}
      style={{ visibility: active ? 'visible' : 'hidden' }}
    >
      <PageActiveContext.Provider value={active && layerActive}>{children}</PageActiveContext.Provider>
    </div>
  );
};

function activeTabFromPath(pathname: string): string {
  const segment = pathname.split('/')[1] ?? '';
  if (segment === 'browser') return 'explore';
  if (segment === 'history' || segment === 'activity-details') return 'activity';
  // Exact, unlike the segment matches above: `/history/:programId` renders
  // inside this shell, so Activity has sub-paths to stay lit for, whereas the
  // only Settings route that mounts TabLayout is the bare root — every
  // `/settings/<slug>` sub-page renders in FullScreenPage (see PageRouter).
  // Matching the segment here would only ever cover paths that cannot reach
  // this function.
  if (pathname === '/settings') return 'settings';
  return 'home';
}

function activeActionFromPath(pathname: string): string {
  if (pathname === '/send') return 'send';
  if (pathname === '/receive') return 'receive';
  if (pathname === '/earn') return 'earn';
  if (pathname === '/swap') return 'swap';
  return 'overview';
}

// Docked-bar hide-on-scroll (mobile): a downward scroll past this many px hides the bar; it
// returns once no scroll event has fired for SCROLL_IDLE_MS, or as soon as the scroll reverses.
const SCROLL_HIDE_THRESHOLD_PX = 4;
const SCROLL_IDLE_MS = 250;

export interface DockedNavBarHandle {
  handleScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}

interface DockedNavBarProps {
  items: BottomNavItem[];
  activeId: string;
  onChange: (id: string) => void;
}

/**
 * The bottom nav plus its own hide-on-scroll state. A leaf on purpose: while this state lived in
 * TabLayout, every hide, show and idle reset re-rendered the whole home carousel and made Framer
 * re-measure the action bar's layout nodes, in the middle of the scroll that triggered it.
 *
 * Scroll events do not bubble, so TabLayout listens in the capture phase and forwards them here
 * through this handle, which keeps the pages unaware of the bar.
 */
const DockedNavBar = forwardRef<DockedNavBarHandle, DockedNavBarProps>(({ items, activeId, onChange }, ref) => {
  const [scrollHidden, setScrollHidden] = useState(false);
  const lastScroll = useRef<{ target: EventTarget | null; top: number }>({ target: null, top: 0 });
  const scrollIdleTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(scrollIdleTimer.current), []);

  useImperativeHandle(ref, () => ({
    handleScroll: event => {
      const { target } = event;
      if (!(target instanceof HTMLElement)) return;
      const top = target.scrollTop;
      const previous = lastScroll.current.target === target ? lastScroll.current.top : top;
      lastScroll.current = { target, top };
      const delta = top - previous;
      if (delta > SCROLL_HIDE_THRESHOLD_PX && top > SCROLL_HIDE_THRESHOLD_PX) setScrollHidden(true);
      else if (delta < -SCROLL_HIDE_THRESHOLD_PX) setScrollHidden(false);
      window.clearTimeout(scrollIdleTimer.current);
      scrollIdleTimer.current = window.setTimeout(() => setScrollHidden(false), SCROLL_IDLE_MS);
    }
  }));

  /* Off-mobile the pill floats: `px-4` + `justify-center` center it and `pb-2` lifts it off the
       frame edge. `min-w-0` lets this flex child shrink to the footer width instead of ballooning
       to the pill's min-content, which otherwise overflowed a 375px-wide viewport. */
  return (
    <div
      className={classNames(
        'pointer-events-auto flex-1 min-w-0 flex justify-center',
        !isMobile() && 'px-4 pb-2',
        isMobile() && 'transition-transform duration-300 ease-out motion-reduce:transition-none',
        scrollHidden && 'translate-y-full'
      )}
    >
      {/* The test network is named in the bar's right corner, not a banner above every page. */}
      <BottomNav
        items={items}
        activeId={activeId}
        onChange={onChange}
        docked={isMobile()}
        accessory={<NetworkModeStrip />}
      />
    </div>
  );
});

const TabLayout: FC<PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const { fullPage, sidePanel } = useAppEnv();
  const { pathname } = useLocation();
  const hasUnclaimedNotes = useHasUnclaimedNotes();
  // Content of each tab that has been shown. The active tab's entry is
  // refreshed on every render; the others keep their last content mounted.
  const panesRef = useRef<Partial<Record<string, ReactNode>>>({});

  // Hide the floating BottomNav whenever the mobile soft keyboard is up —
  // the keyboard inset (mobile.html) shrinks the layout, and the navbar
  // hovering right above the keyboard looks odd. Refcounted with the other
  // useHideNavbarWhileOpen callers (drawers, flows), so it composes.
  useHideNavbarWhileOpen(useKeyboardVisible());

  const dockedBar = useRef<DockedNavBarHandle>(null);

  // The `fade` preset plays once, when the layout mounts. A tab change swaps
  // panes with no animation, like a native tab bar.
  const reduce = useReducedMotion();
  const fade = usePreset('fade');
  const appear = !reduce && !isReturningFromWebview();
  const initial = appear ? (fade.initial ?? false) : false;

  const tabs = [
    {
      id: 'home',
      label: t('home'),
      icon: <Icon name={IconName.Home} className="w-6 h-6" fill="currentColor" />
    },
    // Explore tab is a dApp browser surface — extension popup has no use
    // for it (browser-the-product is already the host), so drop it there.
    ...(isExtension()
      ? []
      : [
          {
            id: 'explore',
            label: t('explore'),
            icon: <Icon name={IconName.Explore} className="w-6 h-6" />
          }
        ]),
    {
      id: 'activity',
      label: t('activity'),
      icon: <Icon name={IconName.Activity} className="w-6 h-6" />,
      showDot: hasUnclaimedNotes
    },
    {
      id: 'settings',
      label: t('settings'),
      icon: <Icon name={IconName.Settings} className="w-6 h-6" fill="currentColor" />
    }
  ];

  const actionItems = [
    {
      id: 'overview',
      label: 'Overview',
      icon: <Icon name={IconName.Wallet} className="w-5 h-5 text-ink" />
    },
    {
      id: 'send',
      label: 'Send',
      icon: <Icon name={IconName.Send} className="w-5 h-5" />
    },
    {
      id: 'receive',
      label: 'Receive',
      icon: <Icon name={IconName.Receive} className="w-5 h-5" />
    },
    {
      id: 'earn',
      label: 'Earn',
      icon: <Icon name={IconName.Earn} className="w-5 h-5" />
    },
    // Only the Swap segment is feature-gated (isSwapEnabled); Earn ships unconditionally.
    ...(isSwapEnabled()
      ? [
          {
            id: 'swap',
            label: 'Swap',
            icon: <Icon name={IconName.Convert} className="w-5 h-5" fill="currentColor" />
          }
        ]
      : [])
  ];

  const activeTab = activeTabFromPath(pathname);
  const activeAction = activeActionFromPath(pathname);
  const showActionBar = HOME_GROUP_ROUTES.has(pathname);

  // Fires for re-taps on the active tab too (BottomNav forwards them), so a
  // Home tap from /send, /receive, etc. returns to Overview; a tap on the
  // route we're already on stays a silent no-op.
  const handleTabChange = (id: string) => {
    const to = TAB_ROUTES[id];
    if (to && to !== pathname) {
      hapticSelection();
      navigate(to);
    }
  };

  // SegmentedActionBar already no-ops re-taps on the active segment and
  // fires the selection haptic itself; a swipe buzzes in HomeSwipeContainer.
  const handleActionChange = (id: string) => {
    const to = ACTION_ROUTES[id];
    if (to && to !== pathname) navigate(to);
  };

  // Platform-specific sizing:
  // - Mobile: 100% to inherit from parent chain (body has safe area padding)
  // - Desktop: Responsive with max-width for comfortable reading
  // - Extension: Fixed sizes for popup/fullpage modes
  const containerStyles = isMobile()
    ? { height: '100%', width: '100%' }
    : isDesktop()
      ? { height: '100%', width: '100%', maxWidth: '600px' }
      : sidePanel
        ? { height: '100%', width: '100%' }
        : fullPage
          ? { height: '640px', width: '600px' }
          : // Popup: fill the body's fixed 600px from the router's container
            // rather than hard-coding it.
            { height: '100%', width: '360px' };

  // The action bar lives inside the Home pane. A tab change swaps whole
  // panes in one frame, so the bar can never shift the content below it.
  // The Home pane holds the swipe carousel for every home-group route.
  panesRef.current[activeTab] = showActionBar ? (
    <>
      <div className="shrink-0 relative z-10">
        <SegmentedActionBar items={actionItems} activeId={activeAction} onChange={handleActionChange} />
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <HomeSwipeContainer />
      </div>
    </>
  ) : (
    children
  );
  // Each pane stays mounted after its first visit, like a native tab controller, so a tab change is
  // one visibility swap and each tab keeps its scroll position and state. Panes render in visit
  // order: a tab only ever joins the end, so no pane moves and no list of tab ids can fall behind.
  const panes = Object.keys(panesRef.current);

  return (
    <div
      // Mobile clips horizontally only (`clip` keeps overflow-y visible) so
      // the BottomNav shadow can fade into the body's safe-area padding
      // strip below the container; fixed-size extension/desktop frames keep
      // full overflow-hidden.
      className={classNames(
        'relative m-auto bg-app-bg flex flex-col',
        isMobile() ? 'overflow-x-clip' : 'overflow-hidden'
      )}
      style={containerStyles}
      onScrollCapture={isMobile() ? event => dockedBar.current?.handleScroll(event) : undefined}
    >
      {/* Every visited tab keeps its pane mounted under the same key, so a tab
          change is one visibility swap with no remount and no animation. */}
      <motion.div
        className="flex-1 min-h-0 relative"
        initial={initial}
        animate={fade.animate}
        transition={fade.transition}
      >
        {panes.map(id => (
          <TabPane key={id} id={id} active={id === activeTab}>
            {panesRef.current[id]}
          </TabPane>
        ))}
      </motion.div>

      {/* Bottom nav — overlays content (floating pill off-mobile, docked bar
          on mobile). The data attribute lets
          the dApp bubble host measure footer height for corner snap math.
          Forced `display:flex !important` + `z-[60]` guard against legacy
          CSS or stale compiled bundles that try to hide `[data-tabbar-footer]`
          or stack a higher z-index over it. */}
      <div
        className="absolute bottom-0 left-0 right-0 z-60 pointer-events-none"
        data-tabbar-footer="true"
        style={{
          display: 'flex',
          // Mobile docks the bar: sink the footer through the body's safe-area
          // padding, which mobile.html declares as --app-safe-bottom, so the
          // bar's background runs under the home indicator while its own
          // safe-area bottom padding keeps the items above it. Reading the
          // property rather than repeating its value is what keeps the bar on
          // the screen edge when the inset is smaller than the floor.
          ...(isMobile() ? { bottom: 'calc(-1 * var(--app-safe-bottom, max(16px, env(safe-area-inset-bottom))))' } : {})
        }}
      >
        <DockedNavBar ref={dockedBar} items={tabs} activeId={activeTab} onChange={handleTabChange} />
      </div>
    </div>
  );
};

export default TabLayout;
