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
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { type DappSession, getFallbackColor, getFallbackLetter, getFaviconUrl } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface CapsuleBarProps {
  session: DappSession;
  onClose: () => void;
  onReload: () => void;
}

export const CapsuleBar: FC<CapsuleBarProps> = ({ session, onClose, onReload }) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [faviconBroken, setFaviconBroken] = useState(false);

  const handleClose = () => {
    hapticLight();
    onClose();
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
        WebkitTouchCallout: 'none',
        touchAction: 'none'
      }}
    >
      {/* 24px drag affordance strip — PR-3 wires up framer-motion drag here */}
      <div className="flex h-6 items-center justify-center" data-drag-handle="true">
        <div className="h-1 w-8 rounded-full bg-grey-300/60" />
      </div>

      {/* 56px content row */}
      <div className="flex h-14 items-center gap-3 px-4">
        {/* Favicon */}
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

        {/* Title + origin */}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base font-semibold text-black">{session.title}</span>
          <span className="truncate text-xs text-grey-500">{session.origin}</span>
        </div>

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
