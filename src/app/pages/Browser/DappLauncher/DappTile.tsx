/**
 * Single dApp tile in the launcher's MyDappsGrid.
 *
 * The tile is the source side of the shared-element morph that animates
 * into the capsule when the user opens a dApp. The matching `layoutId`s
 * live on the favicon (`dapp-favicon-${url}`) and name (`dapp-name-${url}`)
 * of `<CapsuleBar>`. framer-motion's `LayoutGroup id="dapp-browser"` (set
 * up at `BrowserScreen` level) wires the two surfaces together.
 */

import React, { type FC, useState } from 'react';

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
}

export const DappTile: FC<DappTileProps> = ({ url, name, icon, brandColor, badge, onOpen, animationIndex = 0 }) => {
  const [iconBroken, setIconBroken] = useState(false);
  // PR-7: reduce-motion-aware springs so the shared-element morph from
  // tile → capsule collapses to an instant switch when the user has
  // reduce motion on.
  const springs = useSprings();

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
      // Entry animation: fade + slight lift so tiles reveal themselves
      // even when the surrounding section mounts on first render.
      // Staggered by `animationIndex` so each tile arrives ~30ms after
      // the previous one, matching the feel of the Recents section
      // which used to appear to animate in "for free" because its
      // data load was async and the tiles popped in after a delay.
      // Now both sections get the same visual treatment.
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        ...springs.morph,
        // Stagger delay — keeping it small so the whole strip settles
        // within ~300ms even for longer lists like My Dapps (7 items).
        delay: 0.04 + animationIndex * 0.03
      }}
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
