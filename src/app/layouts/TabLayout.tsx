import React, { FC, useLayoutEffect, useRef } from 'react';

import classNames from 'clsx';

import { useAppEnv } from 'app/env';
import { useHistoryBadge } from 'app/hooks/useHistoryBadge';
import Footer from 'app/layouts/PageLayout/Footer';
import { isReturningFromWebview } from 'lib/mobile/webview-state';
import { isDesktop, isExtension, isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';
import { useLocation } from 'lib/woozie';

/**
 * Layout for tab-based pages (Home, History, Settings, Browser).
 * Provides a persistent footer and animated content area.
 */
const TabLayout: FC<PropsWithChildren> = ({ children }) => {
  const historyBadge = useHistoryBadge();
  const { fullPage, sidePanel } = useAppEnv();
  const { pathname } = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);

  // Animate content on route change (mobile only, not extension).
  //
  // CRITICAL: this MUST be useLayoutEffect, not useEffect. With
  // useEffect, the contentRef element renders + paints first (in its
  // base state, at translateX(0)), and then the effect fires AFTER
  // the paint to add the .mobile-page-enter class. The element then
  // jumps from translateX(0) to translateX(8%) (the animation's
  // `from` keyframe) and animates back to translateX(0). The user
  // sees a brief flash of the page at the destination, followed by a
  // visible jump-right and animate-left. It's intermittent because
  // useEffect timing relative to paint varies under React's
  // scheduler.
  //
  // useLayoutEffect runs synchronously after DOM mutations but BEFORE
  // the browser paints. So the class is in place by the time the
  // first paint happens, and the page only ever visibly renders at
  // translateX(8%) → animate → translateX(0). No flash, no jump.
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    if (isMobile() && isReturningFromWebview()) return;
    // Skip animation on extension
    if (isExtension()) return;

    const el = contentRef.current;
    el.classList.remove('mobile-page-enter');
    // Force reflow to restart animation
    void el.offsetWidth;
    el.classList.add('mobile-page-enter');

    // Remove class after animation completes to prevent restart on display toggle
    const handleAnimationEnd = () => {
      el.classList.remove('mobile-page-enter');
    };
    el.addEventListener('animationend', handleAnimationEnd, { once: true });

    return () => {
      el.removeEventListener('animationend', handleAnimationEnd);
    };
  }, [pathname]);

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
      className={classNames('relative m-auto bg-app-bg overflow-hidden', fullPage && 'rounded-3xl')}
      style={containerStyles}
    >
      {/* Content area — fills entire container, scrolls behind footer.
          key={pathname} forces React to fully remount the element on
          every route change. Without it, React's reconciler reuses
          the same DOM element across routes (TabLayout sits at the
          same JSX position in PageRouter for /, /history, /browser),
          which can let residual animation state leak between
          navigations. The key + useLayoutEffect combo guarantees a
          fresh element with the .mobile-page-enter class applied
          before the first paint. */}
      <div
        key={pathname}
        ref={contentRef}
        className="absolute inset-0 flex flex-col"
        style={{ willChange: 'transform, opacity' }}
      >
        {children}
      </div>

      {/* Floating footer with blur — overlays content. The data attribute lets
          the dApp bubble host measure the footer height for corner snap math. */}
      <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none" data-tabbar-footer="true">
        <div className="pointer-events-auto">
          <Footer historyBadge={historyBadge} />
        </div>
      </div>
    </div>
  );
};

export default TabLayout;
