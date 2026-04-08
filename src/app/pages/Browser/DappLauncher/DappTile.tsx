/**
 * Single dApp tile in the launcher's MyDappsGrid.
 *
 * The tile is the source side of the shared-element morph that animates
 * into the capsule when the user opens a dApp. The matching `layoutId`s
 * live on the favicon (`dapp-favicon-${url}`) and name (`dapp-name-${url}`)
 * of `<CapsuleBar>`. framer-motion's `LayoutGroup id="dapp-browser"` (set
 * up at `BrowserScreen` level) wires the two surfaces together.
 */

import React, { type FC, useEffect, useState } from 'react';

import { motion } from 'framer-motion';

import { useSprings } from 'lib/animation';
import { type FeaturedDapp, type RecentDapp } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface DappTileProps {
  url: string;
  name: string;
  icon?: string;
  brandColor?: string;
  badge?: 'featured' | 'new' | 'verified';
  onOpen: (url: string) => void;
  /**
   * Index within the containing section. Used to stagger the entry
   * animation so tiles fade in sequentially (~30ms between each).
   * Defaults to 0 for uses that don't want a stagger.
   */
  animationIndex?: number;
  /**
   * Base delay (in seconds) applied to the entry animation BEFORE the
   * per-index stagger kicks in. Sections that mount synchronously with
   * the TabLayout slide-in (e.g. the featured list at initial launcher
   * render) should pass ~0.2 so their tiles start animating only after
   * the 150ms tab transform has settled — otherwise the composed
   * parent-transform + child-y motion looks janky. Sections that
   * mount asynchronously (e.g. Recents after `getRecentDapps` resolves)
   * can leave this at the default 0.04 since the tab has already
   * settled by the time they mount.
   */
  entryBaseDelay?: number;
}

export const DappTile: FC<DappTileProps> = ({
  url,
  name,
  icon,
  brandColor,
  badge,
  onOpen,
  animationIndex = 0,
  entryBaseDelay = 0.04
}) => {
  const [iconBroken, setIconBroken] = useState(false);
  // PR-7: reduce-motion-aware springs so the shared-element morph from
  // tile → capsule collapses to an instant switch when the user has
  // reduce motion on.
  const springs = useSprings();
  // State-driven entry animation: tiles start hidden (y: -16, opacity
  // 0) and flip visible after `entryBaseDelay + animationIndex * 0.04`
  // seconds. This sidesteps framer-motion's `initial` prop entirely,
  // which doesn't play nicely with elements inside a `LayoutGroup` —
  // when the outer `<BrowserScreen>` wraps the launcher in
  // `<LayoutGroup id="dapp-browser">` for the tile → capsule morph,
  // framer-motion's layout tracker intercepts any element that has
  // a `layoutId` and its `initial` → `animate` entry gets suppressed
  // or distorted. By driving the animation through a React state
  // flip (isVisible false → true) instead of initial, we use the
  // normal `animate` path which layout-tracked elements respect.
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    const delayMs = Math.round((entryBaseDelay + animationIndex * 0.04) * 1000);
    const timer = window.setTimeout(() => setIsVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [entryBaseDelay, animationIndex]);

  const handleClick = () => {
    hapticLight();
    onOpen(url);
  };

  const showFallback = !icon || iconBroken;
  const fallbackBg = brandColor ?? '#94A3B8';
  // PR-7: include the badge state in the accessible name so screen
  // readers announce verified status, not just the dApp name.
  const accessibleLabel = badge === 'verified' ? `${name}, verified dApp` : name;

  // Use onClick (NOT onPointerDown) so a vertical scroll that grazes
  // a tile doesn't accidentally open the dApp. The browser fires
  // onClick only when the touch hasn't moved enough to be a drag,
  // which is the correct tap-vs-scroll discrimination.
  return (
    <motion.button
      type="button"
      layoutId={`dapp-tile-${url}`}
      // `initial={false}` tells framer-motion to start at the current
      // `animate` values without playing an entry animation from
      // `initial`. Combined with the state-driven `isVisible` flip
      // above, the first render places the tile at (opacity 0, y -16)
      // and the timeout-triggered state change animates it to
      // (opacity 1, y 0). This avoids the `initial` → LayoutGroup
      // interference bug where layoutId-tracked elements skip their
      // entry animation entirely.
      initial={false}
      animate={{ opacity: isVisible ? 1 : 0, y: isVisible ? 0 : -16 }}
      transition={springs.snappy}
      onClick={handleClick}
      className="flex flex-col items-center gap-1.5 rounded-2xl p-2 active:bg-grey-100"
      aria-label={accessibleLabel}
    >
      <motion.div
        layoutId={`dapp-favicon-${url}`}
        transition={springs.morph}
        className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl"
        style={{ background: showFallback ? fallbackBg : 'rgba(0,0,0,0.04)' }}
        aria-hidden="true"
      >
        {showFallback ? (
          <span className="text-lg font-semibold text-pure-white">{name.charAt(0).toUpperCase()}</span>
        ) : (
          <img
            src={icon}
            alt=""
            className="h-9 w-9 object-contain"
            onError={() => setIconBroken(true)}
            draggable={false}
          />
        )}
        {badge === 'verified' && (
          <span className="absolute -bottom-0 -right-0 flex h-4 w-4 items-center justify-center rounded-full border-2 border-pure-white bg-primary-500 text-[10px] text-pure-white">
            ✓
          </span>
        )}
      </motion.div>
      <motion.span
        layoutId={`dapp-name-${url}`}
        transition={springs.morph}
        className="w-full truncate text-center text-xs font-medium text-heading-gray"
        aria-hidden="true"
      >
        {name}
      </motion.span>
    </motion.button>
  );
};

/** Convenience constructor: build a tile from a `FeaturedDapp`. */
export function tileFromFeatured(dapp: FeaturedDapp, onOpen: (url: string) => void) {
  return (
    <DappTile
      key={dapp.url}
      url={dapp.url}
      name={dapp.name}
      icon={dapp.icon}
      brandColor={dapp.brandColor}
      badge={dapp.badge}
      onOpen={onOpen}
    />
  );
}

/** Convenience constructor: build a tile from a `RecentDapp`. */
export function tileFromRecent(dapp: RecentDapp, onOpen: (url: string) => void) {
  return <DappTile key={dapp.url} url={dapp.url} name={dapp.name} icon={dapp.favicon} onOpen={onOpen} />;
}
