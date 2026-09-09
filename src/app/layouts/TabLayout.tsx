import React, { FC, ReactNode, useLayoutEffect, useRef } from 'react';

import classNames from 'clsx';
import { motion, useReducedMotion } from 'framer-motion';

import { useAppEnv } from 'app/env';
import { useHasUnclaimedNotes } from 'app/hooks/useHasUnclaimedNotes';
import { Icon, IconName } from 'app/icons/v2';
import HomeSwipeContainer from 'app/layouts/HomeSwipeContainer';
import { BottomNav, SegmentedActionBar } from 'components/ui';
import { useMotion } from 'lib/animation';
import { pageAppearance } from 'lib/animation/page-appearance';
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
 * Activity) hide it.
 */
const TAB_ROUTES: Record<string, string> = {
  home: '/',
  explore: '/browser',
  activity: '/history'
};

const ACTION_ROUTES: Record<string, string> = {
  overview: '/',
  send: '/send',
  receive: '/receive',
  earn: '/earn',
  swap: '/swap'
};

const HOME_GROUP_ROUTES = new Set(['/', '/send', '/receive', '/earn', '/swap']);

// Render order of the tab panes. Each pane stays mounted after its first
// visit, like a native tab controller, so a tab change is one visibility
// swap and each tab keeps its scroll position and state.
const TAB_ORDER = ['home', 'explore', 'activity'];

interface TabPaneProps extends PropsWithChildren {
  id: string;
  active: boolean;
}

// One tab's content. An inactive pane keeps its layout but is not painted,
// not focusable and not read by assistive tech.
const TabPane: FC<TabPaneProps> = ({ id, active, children }) => {
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
      {children}
    </div>
  );
};

function activeTabFromPath(pathname: string): string {
  const segment = pathname.split('/')[1] ?? '';
  if (segment === 'browser') return 'explore';
  if (segment === 'history' || segment === 'activity-details') return 'activity';
  return 'home';
}

function activeActionFromPath(pathname: string): string {
  if (pathname === '/send') return 'send';
  if (pathname === '/receive') return 'receive';
  if (pathname === '/earn') return 'earn';
  if (pathname === '/swap') return 'swap';
  return 'overview';
}

const TabLayout: FC<PropsWithChildren> = ({ children }) => {
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

  // The fade plays once, when the layout mounts. A tab change swaps panes
  // with no animation, like a native tab bar.
  const reduce = useReducedMotion();
  const appearance = useMotion(pageAppearance);
  const appear = !reduce && !isReturningFromWebview();
  const initial = appear ? { opacity: 0 } : false;

  const tabs = [
    {
      id: 'home',
      label: 'Home',
      icon: <Icon name={IconName.Home} className="w-6 h-6" fill="currentColor" />
    },
    // Explore tab is a dApp browser surface — extension popup has no use
    // for it (browser-the-product is already the host), so drop it there.
    ...(isExtension()
      ? []
      : [
          {
            id: 'explore',
            label: 'Explore',
            icon: <Icon name={IconName.Explore} className="w-6 h-6" />
          }
        ]),
    {
      id: 'activity',
      label: 'Activity',
      icon: <Icon name={IconName.Activity} className="w-6 h-6" />,
      showDot: hasUnclaimedNotes
    }
  ];

  const actionItems = [
    {
      id: 'overview',
      label: 'Overview',
      icon: <Icon name={IconName.Wallet} className="w-5 h-5 text-heading-gray" />
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
  // fires the selection haptic itself.
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
          : { height: '600px', width: '360px' };

  // The action bar lives inside the Home pane. A tab change swaps whole
  // panes in one frame, so the bar can never shift the content below it.
  // The Home pane holds the swipe carousel for every home-group route.
  panesRef.current[activeTab] = showActionBar ? (
    <>
      <div className="shrink-0 relative z-10">
        <SegmentedActionBar
          items={actionItems}
          activeId={activeAction}
          onChange={handleActionChange}
          layoutId="tab-layout-action-fill"
        />
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <HomeSwipeContainer />
      </div>
    </>
  ) : (
    children
  );
  const panes = TAB_ORDER.filter(id => id in panesRef.current);

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
    >
      {/* Every visited tab keeps its pane mounted under the same key, so a tab
          change is one visibility swap with no remount and no animation. */}
      <motion.div
        className="flex-1 min-h-0 relative"
        initial={initial}
        animate={{ opacity: 1 }}
        transition={appearance}
      >
        {panes.map(id => (
          <TabPane key={id} id={id} active={id === activeTab}>
            {panesRef.current[id]}
          </TabPane>
        ))}
      </motion.div>

      {/* Floating bottom nav — overlays content. The data attribute lets
          the dApp bubble host measure footer height for corner snap math.
          Forced `display:flex !important` + `z-[60]` guard against legacy
          CSS or stale compiled bundles that try to hide `[data-tabbar-footer]`
          or stack a higher z-index over it. */}
      <div
        className="absolute bottom-0 left-0 right-0 z-60 pointer-events-none"
        data-tabbar-footer="true"
        style={{ display: 'flex' }}
      >
        {/* Mobile: the body's safe-area padding (max(16px, env(...)) in
            mobile.html) already keeps the pill off the screen edge. */}
        {/* `min-w-0` lets this flex child shrink to the footer width instead of
            ballooning to the pill's min-content (the nav's wide `px-13.5` padding
            makes its min-content ~367px, which otherwise pushed the flex item to
            399px and overflowed the right edge by ~8px on a 375px-wide viewport).
            `justify-center` then centers the pill within the row. */}
        <div
          className={classNames('pointer-events-auto flex-1 min-w-0 px-4 flex justify-center', !isMobile() && 'pb-2')}
        >
          <BottomNav items={tabs} activeId={activeTab} onChange={handleTabChange} />
        </div>
      </div>
    </div>
  );
};

export default TabLayout;
