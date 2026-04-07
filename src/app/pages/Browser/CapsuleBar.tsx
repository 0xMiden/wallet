/**
 * Top-of-screen capsule chrome shown while a dApp is foregrounded.
 *
 * Layout (PR-1 visual spec):
 * - 24px drag affordance strip at the top (PR-3 makes this draggable;
 *   PR-1 ships it as a static visual cue)
 * - 56px content row with favicon, title, origin, ⋯ menu, ✕ close
 *
 * Total height: 80px + safe-area-top.
 *
 * Background: matches the existing Footer style — translucent white with
 * a heavy backdrop blur — so the dApp content peeks through subtly.
 *
 * The "⋯" menu in PR-1 just exposes Reload + Close. PR-2 adds Share, Copy
 * URL, and Open in System Browser; PR-5 adds the "Switch dApps" entry that
 * opens the card switcher.
 */

import React, { type FC, useState } from 'react';

import classNames from 'clsx';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { springs } from 'lib/animation';
import { type DappSession, getFallbackColor, getFallbackLetter, getFaviconUrl } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface CapsuleBarProps {
  session: DappSession;
  onClose: () => void;
  onReload: () => void;
  /** Optional drag handler — when provided, the top 24px strip becomes draggable. */
  onMinimize?: () => void;
}

const MINIMIZE_DISTANCE_THRESHOLD = 120;
const MINIMIZE_VELOCITY_THRESHOLD = 600;

export const CapsuleBar: FC<CapsuleBarProps> = ({ session, onClose, onReload, onMinimize }) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
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
    setMenuOpen(false);
    onReload();
  };

  const toggleMenu = () => {
    hapticLight();
    setMenuOpen(prev => !prev);
  };

  const fallbackColor = getFallbackColor(session.origin);
  const fallbackLetter = getFallbackLetter(session.origin);
  const faviconUrl = session.favicon ?? getFaviconUrl(session.origin);

  return (
    <header
      className="fixed left-0 right-0 top-0 z-[60] flex flex-col"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
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
          taps in the content row below remain unaffected. */}
      <motion.div
        className="flex h-6 items-center justify-center"
        data-drag-handle="true"
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
        {/* Favicon — layoutId target for the launcher tile morph (PR-2). */}
        <motion.div
          layoutId={`dapp-favicon-${session.url}`}
          transition={springs.morph}
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
        </motion.div>

        {/* Title + origin — title is the layoutId target so the tile name
            morphs into the capsule title. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <motion.span
            layoutId={`dapp-name-${session.url}`}
            transition={springs.morph}
            className="truncate text-base font-semibold text-black"
          >
            {session.title}
          </motion.span>
          <span className="truncate text-xs text-grey-500">{session.origin}</span>
        </div>

        {/* Minimize button — drag handle is the gesture path on real devices,
            this button is the discoverable + accessible alternative. Calling
            it via the menu doesn't work because the menu drops below the
            capsule into native-webview territory and gets covered. */}
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

        {/* Overflow menu trigger */}
        <button
          type="button"
          onClick={toggleMenu}
          aria-label={t('moreOptions') ?? 'More options'}
          className={classNames(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            menuOpen ? 'bg-grey-200' : 'hover:bg-grey-100'
          )}
        >
          <Icon name={IconName.Settings} size="sm" className="text-grey-700" />
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
      </div>

      {/* Hairline at the bottom edge */}
      <div className="h-px w-full bg-grey-100" />

      {/* Overflow menu (anchored absolutely so it doesn't shift the capsule layout) */}
      {menuOpen && (
        <div
          className="absolute right-2 top-full mt-1 w-44 rounded-xl border border-grey-100 bg-pure-white shadow-lg"
          role="menu"
        >
          <button
            type="button"
            onClick={handleReload}
            className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-sm text-grey-800 hover:bg-grey-50"
            role="menuitem"
          >
            <Icon name={IconName.Refresh} size="sm" className="text-grey-600" />
            <span>{t('reload') ?? 'Reload'}</span>
          </button>
        </div>
      )}
    </header>
  );
};
