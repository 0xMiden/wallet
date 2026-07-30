import React, { FC, useEffect, useRef } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';

import { useAppEnv } from 'app/env';
import { useHasUnclaimedNotes } from 'app/hooks/useHasUnclaimedNotes';
import { Icon, IconName } from 'app/icons/v2';
import HomeSwipeContainer from 'app/layouts/HomeSwipeContainer';
import { BottomNav, SegmentedActionBar } from 'components/ui';
import { springs } from 'lib/animation';
import { isEarnEnabled, isSwapEnabled } from 'lib/feature-flags';
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
  const prevPathnameRef = useRef<string | null>(null);

  // Hide the floating BottomNav whenever the mobile soft keyboard is up —
  // the keyboard inset (mobile.html) shrinks the layout, and the navbar
  // hovering right above the keyboard looks odd. Refcounted with the other
  // useHideNavbarWhileOpen callers (drawers, flows), so it composes.
  useHideNavbarWhileOpen(useKeyboardVisible());

  // During render `prevPathnameRef.current` still holds the previous path
  // (the effect below updates it AFTER commit). That's exactly what we need
  // to decide whether the incoming page should slide in.
  const prevPathname = prevPathnameRef.current;
  const skipSlideIn =
    isExtension() ||
    (isMobile() && isReturningFromWebview()) ||
    (prevPathname !== null && HOME_GROUP_ROUTES.has(prevPathname) && HOME_GROUP_ROUTES.has(pathname));

  useEffect(() => {
    prevPathnameRef.current = pathname;
  }, [pathname]);

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
    // Earn and Swap segments are feature-gated (isEarnEnabled / isSwapEnabled).
    ...(isEarnEnabled()
      ? [
          {
            id: 'earn',
            label: 'Earn',
            icon: <Icon name={IconName.Earn} className="w-5 h-5" />
          }
        ]
      : []),
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
      {/* Top action bar — sits outside the animated content tree so it
          stays fixed across intra-home-group navigations. */}
      {showActionBar && (
        <div className="shrink-0 relative z-10">
          <SegmentedActionBar
            items={actionItems}
            activeId={activeAction}
            onChange={handleActionChange}
            layoutId="tab-layout-action-fill"
          />
        </div>
      )}

      {/* Animated content. For home-group routes we mount the
          HomeSwipeContainer once (a five-page horizontal carousel) and let it
          drive intra-group transitions via drag — pathname is just the
          source of truth for which page is centered. For other routes
          (Browser, Activity, etc.) we still slide each new page in via
          framer. The motion.div is keyed by group so the carousel doesn't
          remount when only the centered page changes. */}
      <div className="flex-1 min-h-0 relative">
        <motion.div
          key={showActionBar ? 'home-group' : pathname}
          // flex column so non-home children (AllHistory, Browser) that use
          // `flex-1 min-h-0 overflow-y-auto` for their scroll region can
          // actually claim the remaining height. Without this their list
          // collapses to 0 and transactions appear missing.
          className="absolute inset-0 overflow-hidden flex flex-col"
          initial={skipSlideIn ? false : { x: '8%', opacity: 0.5 }}
          animate={{ x: 0, opacity: 1 }}
          transition={springs.standard}
        >
          {showActionBar ? <HomeSwipeContainer /> : children}
        </motion.div>
      </div>

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
