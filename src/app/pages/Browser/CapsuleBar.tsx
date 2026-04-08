/**
 * Top-of-screen capsule chrome shown while a dApp is foregrounded.
 *
 * Layout:
 * - 24px drag affordance strip at the top (draggable for minimize)
 * - 56px content row with favicon, title, origin, action buttons
 *
 * Total height: 80px + safe-area-top.
 *
 * Background: matches the existing Footer style — translucent white with
 * a heavy backdrop blur — so the dApp content peeks through subtly.
 *
 * Action buttons in the content row (right-aligned):
 *   [Switch dApps badge?]  [Minimize?]  [Reload]  [Close]
 *
 * NOTE: this row uses ONLY top-level buttons. There used to be a `⋯`
 * dropdown that wrapped Reload, but the dropdown rendered into the
 * vertical strip immediately below the capsule — i.e. directly into
 * native-WKWebView territory — and the WKWebView paints over it, so
 * the menu was completely invisible to the user. Reload became
 * unreachable. The fix is to lift Reload up into a first-class capsule
 * button so the user can tap it without opening anything.
 */

import React, { type FC, useState } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import {
  type DappSession,
  getDappDisplayName,
  getDappHostname,
  getFallbackColor,
  getFallbackLetter,
  getFaviconUrl
} from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface CapsuleBarProps {
  session: DappSession;
  onClose: () => void;
  onReload: () => void;
  /** Optional drag handler — when provided, the top 24px strip becomes draggable. */
  onMinimize?: () => void;
  /**
   * PR-5: when there is more than one open dApp, this opens the card
   * switcher. The capsule shows a small tabs button with the count badge
   * between favicon and ⋯ menu when this is provided AND tabsCount > 1.
   */
  onOpenSwitcher?: () => void;
  /** Total number of open dApp sessions (foreground + parked). */
  tabsCount?: number;
}

const MINIMIZE_DISTANCE_THRESHOLD = 120;
const MINIMIZE_VELOCITY_THRESHOLD = 600;

export const CapsuleBar: FC<CapsuleBarProps> = ({
  session,
  onClose,
  onReload,
  onMinimize,
  onOpenSwitcher,
  tabsCount = 1
}) => {
  const { t } = useTranslation();
  const [faviconBroken, setFaviconBroken] = useState(false);

  const handleClose = () => {
    hapticLight();
    onClose();
  };

  const handleDragEnd = (_: unknown, info: { offset: { y: number }; velocity: { y: number } }) => {
    const dy = info.offset.y;
    const vy = info.velocity.y;
    const shouldMinimize = onMinimize && (dy > MINIMIZE_DISTANCE_THRESHOLD || vy > MINIMIZE_VELOCITY_THRESHOLD);
    if (shouldMinimize && onMinimize) {
      onMinimize();
    }
  };

  const handleReload = () => {
    hapticLight();
    onReload();
  };

  const fallbackColor = getFallbackColor(session.origin);
  const fallbackLetter = getFallbackLetter(session.origin);
  const faviconUrl = session.favicon ?? getFaviconUrl(session.origin);

  // Prefer a hostname-only presentation so the tabs badge, minimize,
  // reload, and close buttons fit without truncating the URL. When
  // the session has a real page title (captured from the <title> tag
  // after load) we show it; otherwise fall back to the hostname with
  // `www.` stripped. We hide the secondary hostname line when it
  // would just repeat the title — that happened constantly because
  // many dApps set <title> to the bare hostname, so the capsule
  // showed e.g. "miden.xyz / miden.xyz" stacked.
  const hostname = getDappHostname(session.url);
  const displayTitle = getDappDisplayName(session);
  const showHostnameRow = displayTitle !== hostname;

  return (
    <header
      className="fixed left-0 right-0 top-0 z-[60] flex flex-col"
      // PR-7: explicit landmark role so VoiceOver/TalkBack announces
      // the capsule as a banner region when the user swipes into it.
      role="banner"
      aria-label={t('dappBrowserCapsule') ?? 'dApp browser header'}
      style={{
        // No paddingTop here — public/mobile.html already applies
        // env(safe-area-inset-top) on the body, which becomes the
        // containing block for this fixed header. Re-applying it
        // would double-count the inset and leave an empty 50pt band
        // above the drag handle on iPhone 17.
        background: 'rgba(255,255,255,0.85)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none'
        // Note: touchAction: 'none' is intentionally NOT set on the header
        // because it would block synthesized click events from touches on the
        // child buttons (minimize, moreOptions, close). Only the drag handle
        // strip below sets touchAction: 'none' so framer-motion can own it.
      }}
    >
      {/* 24px drag affordance strip — PR-3 wires up framer-motion drag here.
          The strip is draggable in y; releasing past 120px or velocity > 600px/s
          calls onMinimize(). The drag is constrained to the strip itself so
          taps in the content row below remain unaffected.

          PR-7: role + aria-roledescription so screen readers announce
          "draggable" — users without the gesture capability still have
          the Minimize button below as an accessible alternative path. */}
      <motion.div
        className="flex h-6 items-center justify-center"
        data-drag-handle="true"
        role={onMinimize ? 'button' : undefined}
        aria-roledescription={onMinimize ? 'draggable' : undefined}
        aria-label={onMinimize ? (t('dragToMinimize') ?? 'Drag down to minimize') : undefined}
        drag={onMinimize ? 'y' : false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        dragMomentum={false}
        onDragEnd={handleDragEnd}
        style={{ touchAction: 'none' }}
      >
        <div className="h-1 w-8 rounded-full bg-grey-300/60" />
      </motion.div>

      {/* 56px content row */}
      <div className="flex h-14 items-center gap-3 px-4">
        {/* Favicon — was a layoutId target for the launcher tile morph
            (PR-2), but the morph competed with TabLayout's CSS slide-in
            and produced a visible jiggle. Reverted to a plain div. */}
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md"
          style={{ background: faviconBroken || !faviconUrl ? fallbackColor : 'transparent' }}
        >
          {faviconBroken || !faviconUrl ? (
            <span className="text-sm font-semibold text-pure-white">{fallbackLetter}</span>
          ) : (
            <img
              src={faviconUrl}
              alt=""
              className="h-full w-full object-contain"
              onError={() => setFaviconBroken(true)}
            />
          )}
        </div>

        {/* Title + hostname — secondary hostname line is hidden when
            the title already matches the hostname (common case: <title>
            is just "miden.xyz") so we don't stack two identical
            strings. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base font-semibold text-black">{displayTitle}</span>
          {showHostnameRow && <span className="truncate text-xs text-grey-500">{hostname}</span>}
        </div>

        {/* Minimize button — drag handle is the gesture path on real devices,
            this button is the discoverable + accessible alternative. */}
        {onMinimize && (
          <button
            type="button"
            onClick={() => {
              hapticLight();
              onMinimize();
            }}
            aria-label={t('minimize') ?? 'Minimize'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-grey-100"
          >
            <Icon name={IconName.ArrowDown} size="sm" className="text-grey-700" />
          </button>
        )}

        {/* Reload button — promoted from a hidden dropdown to a top-level
            action because the dropdown anchored below the capsule rendered
            into native-WKWebView territory and was completely invisible. */}
        <button
          type="button"
          onClick={handleReload}
          aria-label={t('reload') ?? 'Reload'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-grey-100"
        >
          <Icon name={IconName.Refresh} size="sm" className="text-grey-700" />
        </button>

        {/* Close button */}
        <button
          type="button"
          onClick={handleClose}
          aria-label={t('close') ?? 'Close'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-grey-100"
        >
          <Icon name={IconName.Close} size="sm" className="text-grey-700" />
        </button>

        {/* PR-5 card switcher button — sits at the far right of the
            capsule (after Close) so it visually anchors to the right
            edge like Safari's tabs button. Shows a count badge of how
            many dApps are open. Hidden when there's only one. */}
        {onOpenSwitcher && tabsCount > 1 && (
          <button
            type="button"
            onClick={() => {
              hapticLight();
              onOpenSwitcher();
            }}
            aria-label={t('switchDapps') ?? 'Switch dApps'}
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-grey-100"
          >
            <div className="flex h-5 w-5 items-center justify-center rounded-md border-[1.5px] border-grey-700">
              <span className="text-[10px] font-bold leading-none text-grey-700">{tabsCount}</span>
            </div>
          </button>
        )}
      </div>

      {/* Hairline at the bottom edge */}
      <div className="h-px w-full bg-grey-100" />
    </header>
  );
};
