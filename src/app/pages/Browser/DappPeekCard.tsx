/**
 * A single peek card in the parked-dApps tray.
 *
 * Replaces the old 72pt floating bubble with a portrait mini-card that
 * looks like a shrunken phone screen — much closer to the iOS App
 * Switcher aesthetic. The card renders:
 *  - The parked session's snapshot filling the background (object-cover,
 *    top-aligned so the viewport the user last saw is what shows).
 *  - A dark bottom gradient for text contrast on any page color.
 *  - A favicon + truncated display name docked at the bottom-left.
 *  - A small × close button at the top-right (frontmost card only).
 *  - An optional "+N" badge at the top-left when there are more parked
 *    sessions than the tray can show at once. Tapping the badge opens
 *    the fullscreen switcher.
 *
 * The card is positioned by its parent (`<DappPeekTray>`), which
 * cascades siblings from the right edge with diminishing scale so the
 * stack looks like a real deck.
 */

import React, { type FC, useState } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { springs } from 'lib/animation';
import { type DappSession, getDappDisplayName, getFallbackColor, getFallbackLetter } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

export const CARD_WIDTH = 104;
export const CARD_HEIGHT = 132;
/**
 * Per-step horizontal offset between stacked cards. With CARD_WIDTH=104 and
 * a 30pt offset, each card behind the front one shows about 30pt of its
 * right edge — enough to read the favicon + a truncated word.
 */
export const CARD_STACK_OFFSET = 30;

interface DappPeekCardProps {
  session: DappSession;
  snapshot?: string;
  /** 0 = frontmost (rightmost), higher = further back in the stack. */
  stackIndex: number;
  /** Overflow count rendered as "+N" on the frontmost card only. */
  overflowCount?: number;
  onTap: () => void;
  onClose: () => void;
  onShowAll: () => void;
}

export const DappPeekCard: FC<DappPeekCardProps> = ({
  session,
  snapshot,
  stackIndex,
  overflowCount = 0,
  onTap,
  onClose,
  onShowAll
}) => {
  const { t } = useTranslation();
  const [faviconBroken, setFaviconBroken] = useState(false);

  const displayName = getDappDisplayName(session);
  const fallbackColor = getFallbackColor(session.origin);
  const fallbackLetter = getFallbackLetter(session.origin);
  const showFavicon = !!session.favicon && !faviconBroken;
  const isFront = stackIndex === 0;

  // Stack tuning: each card behind the front one slides LEFT and scales
  // DOWN slightly, producing a cascading deck look. The scale falloff is
  // gentle (6% per step) so back cards remain recognizable as cards, not
  // just edge slivers.
  const xOffset = -stackIndex * CARD_STACK_OFFSET;
  const scale = 1 - stackIndex * 0.06;
  const opacity = 1 - stackIndex * 0.12;

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    hapticLight();
    onClose();
  };

  const handleShowAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    hapticLight();
    onShowAll();
  };

  const handleTap = () => {
    hapticLight();
    onTap();
  };

  return (
    <motion.div
      // Animate layout so cards reflow smoothly when siblings are added
      // or removed (e.g. park a new dApp → existing cards slide left to
      // make room for the new frontmost card on the right).
      layout
      initial={{ opacity: 0, y: 40, scale: scale * 0.9 }}
      animate={{ opacity, x: xOffset, y: 0, scale }}
      exit={{ opacity: 0, y: 40, scale: scale * 0.9 }}
      transition={springs.sheetPresent}
      // Each card sits at the right edge; the negative x from animate()
      // stacks the back cards leftward.
      className="pointer-events-auto absolute bottom-0 right-0 origin-bottom-right"
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        // Back cards render below front cards so the front overlaps.
        zIndex: 100 - stackIndex
      }}
    >
      <button
        type="button"
        onClick={handleTap}
        aria-label={t('restoreDappCard', { name: displayName }) ?? `Restore ${displayName}`}
        className="group relative block h-full w-full overflow-hidden rounded-2xl bg-white"
        style={{
          // Layered shadow: tight contact + wide soft halo with a subtle
          // brand-color tint picked from the dApp's fallback color. Gives
          // each card a faint aura that hints at identity even before
          // the user reads the label.
          boxShadow: `0 1px 2px rgba(15,23,42,0.18), 0 10px 28px rgba(15,23,42,0.2), 0 14px 36px ${fallbackColor}40`
        }}
      >
        {/* Snapshot layer — top-anchored so the frozen preview shows
            the viewport the user was last looking at. Falls back to a
            colored tile with the dApp's first letter when no snapshot
            exists yet (fresh cold session or first park before the
            snapshot store has settled). */}
        {snapshot ? (
          <img
            src={snapshot}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: fallbackColor }}>
            <span className="text-3xl font-bold text-pure-white">{fallbackLetter}</span>
          </div>
        )}

        {/* Subtle top highlight + bottom gradient for contrast. The
            bottom gradient is tall enough (40% of card height) to
            guarantee legible white text on any page color. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black/85 via-black/40 to-transparent" />

        {/* Label row — favicon + display name docked at the bottom-left. */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 px-2 pb-2">
          <div className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[3px] bg-pure-white/95">
            {showFavicon ? (
              <img
                src={session.favicon ?? undefined}
                alt=""
                className="h-full w-full object-contain"
                onError={() => setFaviconBroken(true)}
              />
            ) : (
              <span className="text-[8px] font-bold" style={{ color: fallbackColor }}>
                {fallbackLetter}
              </span>
            )}
          </div>
          <span className="min-w-0 truncate text-[11px] font-semibold leading-tight text-pure-white drop-shadow">
            {displayName}
          </span>
        </div>
      </button>

      {/* Close — top right. Front card only so back cards aren't
          littered with tiny tap targets the user can't hit reliably. */}
      {isFront && (
        <button
          type="button"
          onClick={handleClose}
          aria-label={t('closeDappCard', { name: displayName }) ?? `Close ${displayName}`}
          className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm transition-transform active:scale-90"
        >
          <Icon name={IconName.Close} size="xs" className="text-pure-white" fill="currentColor" />
        </button>
      )}

      {/* Overflow "+N" — front card only, top-left. Tapping opens the
          fullscreen switcher where every parked session is browsable. */}
      {isFront && overflowCount > 0 && (
        <button
          type="button"
          onClick={handleShowAll}
          aria-label={t('showAllDapps', { count: overflowCount }) ?? `+${overflowCount} more`}
          className="absolute left-1.5 top-1.5 flex h-6 items-center rounded-full bg-black/60 px-2 backdrop-blur-sm transition-transform active:scale-95"
        >
          <span className="text-[10px] font-bold text-pure-white">+{overflowCount}</span>
        </button>
      )}
    </motion.div>
  );
};
