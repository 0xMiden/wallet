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

import { springs } from 'lib/animation';
import { type FeaturedDapp, type RecentDapp } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface DappTileProps {
  url: string;
  name: string;
  icon?: string;
  brandColor?: string;
  badge?: 'featured' | 'new' | 'verified';
  onOpen: (url: string) => void;
}

export const DappTile: FC<DappTileProps> = ({ url, name, icon, brandColor, badge, onOpen }) => {
  const [iconBroken, setIconBroken] = useState(false);

  const handleClick = () => {
    hapticLight();
    onOpen(url);
  };

  const showFallback = !icon || iconBroken;
  const fallbackBg = brandColor ?? '#94A3B8';

  return (
    <motion.button
      type="button"
      layoutId={`dapp-tile-${url}`}
      transition={springs.morph}
      onPointerDown={handleClick}
      className="flex flex-col items-center gap-1.5 rounded-2xl p-2 active:bg-grey-100"
      aria-label={name}
    >
      <motion.div
        layoutId={`dapp-favicon-${url}`}
        transition={springs.morph}
        className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl"
        style={{ background: showFallback ? fallbackBg : 'rgba(0,0,0,0.04)' }}
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
        className="w-full truncate text-center text-xs font-medium text-grey-700"
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
