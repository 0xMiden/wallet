import React, { FC, useEffect, useRef } from 'react';

import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { isMobile } from 'lib/platform';
import { PropsWithChildren } from 'lib/props-with-children';

/**
 * Wrapper for full-screen pages (Send, Receive, etc.) that slides in from the right.
 * Animation is only enabled for mobile (disabled for Chrome extension).
 */
const FullScreenPage: FC<PropsWithChildren> = ({ children }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Full-screen routes replace TabLayout entirely. Keep the shared hidden
  // state active so mobile also repaints the safe-area strip into which the
  // old BottomNav shadow extended.
  useHideNavbarWhileOpen();

  useEffect(() => {
    if (!containerRef.current) return;

    // Only animate on mobile
    if (!isMobile()) return;

    const el = containerRef.current;
    el.classList.add('mobile-page-enter');

    // Remove class after animation completes to prevent restart on display toggle
    // (resetViewportAfterWebview toggles display:none which restarts CSS animations)
    const handleAnimationEnd = () => {
      el.classList.remove('mobile-page-enter');
    };
    el.addEventListener('animationend', handleAnimationEnd, { once: true });

    return () => {
      el.removeEventListener('animationend', handleAnimationEnd);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full bg-app-bg"
      style={{ willChange: 'transform, opacity' }}
    >
      {children}
    </div>
  );
};

export default FullScreenPage;
