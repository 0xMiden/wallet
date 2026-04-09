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

import React, { type FC, useCallback } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { springs } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import { navigate, useLocation } from 'lib/woozie';

// The parked-dApp peek tray occupies the right portion of the same
// vertical band (card width 104 + 2×30pt cascade offsets + 16pt
// right margin ≈ 180pt). Anything to the left of that is empty
// space we can use for the action pills without pushing the tray up.
const STACK_RESERVED_WIDTH = 180;
const EDGE_PADDING = 16;
// Pill visual height — intentionally shorter than the main toolbar
// pill (which is ~76pt) so the secondary row reads as ancillary.
const PILL_HEIGHT = 56;
// The native navbar pill's top edge sits approximately 130pt above
// the viewport's bottom edge (navbar height ~88pt + home-indicator
// safe area ~34pt + a bit of gutter on iPhone 17). We position our
// pill's bottom at exactly this value so it sits flush against the
// navbar's top edge with no visible seam — looks like one
// integrated two-row unit.
const NAVBAR_TOP_FROM_BOTTOM = 130;

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

  // Visible on Home + the two full-screen flows that the pills
  // launch. Everywhere else the component returns null (and its
  // AnimatePresence wrapper, mounted one level up, plays the exit
  // animation).
  const isVisible =
    pathname === '/' || pathname === '/send' || pathname.startsWith('/send/') || pathname === '/receive';

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
          // Container styling mirrors the main toolbar pill in
          // `<Footer>` so both pills read as the same class of
          // element: same `rounded-[26px]` corner radius, same
          // `bg-white/60` translucent fill, same `blur(6px)` backdrop,
          // same `shadow-[0px_4px_20px_0px_rgba(0,0,0,0.08)]` drop
          // shadow. The only difference is this pill's left anchor +
          // limited width — the main toolbar stretches full-width.
          className="fixed flex items-center rounded-[26px] px-2 py-2 shadow-[0px_4px_20px_0px_rgba(0,0,0,0.08)]"
          style={{
            // Flush against the top of the native navbar — the
            // pill's bottom edge sits exactly where the navbar's
            // top edge is, so there's no visible seam and the two
            // pills read as one integrated unit.
            bottom: NAVBAR_TOP_FROM_BOTTOM,
            left: EDGE_PADDING,
            width: pillWidth,
            height: PILL_HEIGHT,
            backgroundColor: 'rgba(255, 255, 255, 0.6)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            zIndex: 55
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
                className="relative flex flex-1 items-center justify-center gap-1.5 rounded-full"
                style={{
                  height: PILL_HEIGHT - 16
                }}
              >
                {/* Active-state pill background — mirrors the main
                    toolbar nav button's styling (bg-pill-active/18 +
                    rounded-full absolute fill) so a tapped Send /
                    Receive pill looks identical to a tapped Home /
                    Activity / Browser tab. */}
                {active && <span className="absolute inset-0 rounded-full bg-pill-active/18" aria-hidden="true" />}
                <Icon
                  name={pill.icon}
                  size="sm"
                  className={active ? 'relative z-10 text-pill-active' : 'relative z-10 text-heading-gray'}
                  fill="currentColor"
                />
                <span
                  className={
                    active
                      ? 'relative z-10 text-xs font-semibold text-pill-active'
                      : 'relative z-10 text-xs font-semibold text-heading-gray'
                  }
                >
                  {pill.label}
                </span>
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
