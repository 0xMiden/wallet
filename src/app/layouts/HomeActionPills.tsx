/**
 * Secondary pill of Send + Receive actions shown above the native
 * bottom toolbar pill on the Home tab.
 *
 * Pattern: mirrors the reference video where a shorter pill sits
 * directly above the main toolbar pill and animates in/out when the
 * relevant surface is active. Here "relevant surface" = Home tab +
 * the Send / Receive full-screen flows (which launched from Home).
 *
 * Visibility rules:
 *  - Visible on `/` (Home), `/send`, `/receive`.
 *  - Hidden everywhere else (History, Browser, Settings, onboarding…).
 *  - When visible on `/send` or `/receive`, the matching pill shows
 *    a highlighted state so the user knows which flow they're in.
 *  - Tapping a pill while NOT on that route navigates there.
 *  - Tapping while ALREADY on that route is a no-op (instead of a
 *    noisy re-navigation).
 *
 * Layout:
 *  - Fixed, anchored to the left edge with 16pt padding.
 *  - Width is deliberately limited (~200pt) so the pill occupies the
 *    empty space to the LEFT of the parked-dApp peek tray (which is
 *    right-anchored and up to ~164pt wide). This means the peek tray
 *    doesn't need to shift up to make room — pills and cards share
 *    the same vertical band horizontally offset.
 *  - Vertical position matches the peek tray's (same `bottom` offset)
 *    so they look like one coherent bottom row of floating chrome.
 *
 * Animation:
 *  - Mounts + unmounts via `AnimatePresence`.
 *  - Enter: slides up from behind the main toolbar (+y offset + fade
 *    + scale) — feels like the pill was "tucked" under the toolbar
 *    and is now sliding out.
 *  - Exit: reverses the slide.
 *  - Spring tuned for a snappy settle with just a hint of bounce.
 *
 * Portal:
 *  - Rendered via `createPortal` into `document.body` so the
 *    `#root > div` height !important rule doesn't stretch the
 *    positioning container (same gotcha the peek tray hit).
 */

import React, { type FC, useCallback, useEffect, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { springs } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate, useLocation } from 'lib/woozie';

// The tray's bottom offset in main.css is driven by the native
// navbar pill's height + the home-indicator safe area. We measure
// the React footer element the same way `DappPeekTray` does so the
// pill sits right at the peek-tray's vertical level regardless of
// device.
const FOOTER_HEIGHT_FALLBACK = 130;
const MIN_MEASURED_FOOTER = 110;
// The parked-dApp peek tray occupies the right portion of the same
// vertical band (card width 104 + 2×30pt cascade offsets + 16pt
// right margin ≈ 180pt). Anything to the left of that is empty
// space we can use for the action pills without pushing the tray up.
const STACK_RESERVED_WIDTH = 180;
const EDGE_PADDING = 16;
// Pill visual height — intentionally shorter than the main toolbar
// pill (which is ~76pt) so the secondary row reads as ancillary.
const PILL_HEIGHT = 56;

type PillAction = 'send' | 'receive';

interface PillDef {
  action: PillAction;
  label: string;
  icon: IconName;
  path: string;
}

export const HomeActionPills: FC = () => {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [footerHeight, setFooterHeight] = useState(FOOTER_HEIGHT_FALLBACK);

  // Visible on Home + the two full-screen flows that the pills
  // launch. Everywhere else the component returns null (and its
  // AnimatePresence wrapper, mounted one level up, plays the exit
  // animation).
  const isVisible =
    pathname === '/' || pathname === '/send' || pathname.startsWith('/send/') || pathname === '/receive';

  // Measure the React footer (same method as `DappPeekTray`). The
  // footer is `display: none` on mobile once the native navbar is
  // up, so the measurement goes through the MIN_MEASURED_FOOTER
  // sanity check — any value below 110pt is almost certainly the
  // React footer's pre-overlay render and we fall back to the
  // constant.
  useEffect(() => {
    const measure = () => {
      const footer = document.querySelector('[data-tabbar-footer="true"]') as HTMLElement | null;
      const measured = footer?.offsetHeight ?? 0;
      setFooterHeight(measured >= MIN_MEASURED_FOOTER ? measured : FOOTER_HEIGHT_FALLBACK);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const pills: PillDef[] = [
    {
      action: 'send',
      label: t('send') ?? 'Send',
      icon: IconName.ArrowRightUp,
      path: '/send'
    },
    {
      action: 'receive',
      label: t('receive') ?? 'Receive',
      icon: IconName.ArrowRightDown,
      path: '/receive'
    }
  ];

  const handleTap = useCallback(
    (path: string) => {
      // No-op if already on the target route — avoids stacking a
      // duplicate navigation entry when the pill is the active one.
      if (pathname === path || pathname.startsWith(path + '/')) return;
      hapticLight();
      navigate(path);
    },
    [pathname]
  );

  const isActive = useCallback((path: string) => pathname === path || pathname.startsWith(path + '/'), [pathname]);

  if (typeof document === 'undefined') return null;

  const pillWidth = Math.max(0, (document.body.clientWidth || window.innerWidth) - STACK_RESERVED_WIDTH - EDGE_PADDING);

  return createPortal(
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="home-action-pills"
          // Entry: slide up from behind the main toolbar with a
          // slight fade + scale. Exit reverses.
          initial={{ opacity: 0, y: 24, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.92 }}
          transition={springs.sheetPresent}
          className="fixed flex items-center rounded-full"
          style={{
            bottom: footerHeight + 4,
            left: EDGE_PADDING,
            width: pillWidth,
            height: PILL_HEIGHT,
            // Matches the main toolbar pill's glassy background — a
            // soft white with heavy backdrop blur so the underlying
            // page shows through subtly.
            background: 'rgba(255,255,255,0.82)',
            backdropFilter: 'blur(24px) saturate(1.6)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
            boxShadow: '0 4px 24px rgba(15,23,42,0.12), 0 1px 3px rgba(15,23,42,0.08)',
            zIndex: 55,
            padding: 4
          }}
          aria-label={t('homeActionPills') ?? 'Quick actions'}
        >
          {pills.map(pill => {
            const active = isActive(pill.path);
            return (
              <button
                key={pill.action}
                type="button"
                onClick={() => handleTap(pill.path)}
                aria-label={pill.label}
                aria-pressed={active}
                className="relative flex flex-1 items-center justify-center gap-1.5 rounded-full transition-colors"
                style={{
                  height: PILL_HEIGHT - 8,
                  // Active state uses a pale gray fill (matches the
                  // main toolbar's active indicator) so the user
                  // instantly sees which flow they're in.
                  background: active ? 'rgba(15,23,42,0.08)' : 'transparent'
                }}
              >
                <Icon name={pill.icon} size="sm" className="text-heading-gray" fill="currentColor" />
                <span className="text-xs font-semibold text-heading-gray">{pill.label}</span>
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
