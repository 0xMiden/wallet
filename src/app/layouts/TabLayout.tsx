import React, { FC, useEffect, useRef } from 'react';

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
  const { fullPage } = useAppEnv();
  const { pathname } = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);

  // Animate content on route change (mobile only, not extension)
  // Remove class after animation completes to prevent replay on display toggle
  // (resetViewportAfterWebview toggles display:none which restarts CSS animations)
  useEffect(() => {
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
      : fullPage
        ? { height: '640px', width: '600px' }
        : { height: '600px', width: '360px' };

  return (
    <div className={classNames('flex flex-col m-auto bg-app-bg', fullPage && 'rounded-3xl')} style={containerStyles}>
      {/* Animated content area */}
      <div
        ref={contentRef}
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
        style={{ willChange: 'transform, opacity' }}
      >
        {children}
      </div>

      {/* Persistent footer */}
      <div className="flex-none">
        <Footer historyBadge={historyBadge} />
      </div>
    </div>
  );
};

export default TabLayout;
