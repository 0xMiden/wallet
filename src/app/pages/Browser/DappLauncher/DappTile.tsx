/**
 * A rounded app tile with the name under it, and the horizontal row that holds them (Recents and
 * `row` sections).
 *
 * A tile can carry the capsule morph's layoutIds (`morph`), but only when no other section shows its
 * url: framer-motion merges every element sharing a layoutId into one projected box, so a second
 * holder renders at the wrong size. Recents never carry them.
 */

import React, { type FC } from 'react';

import { motion } from 'framer-motion';

import { useExploreMotion } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';

import { AppIcon, AppName } from './AppIcon';

export interface DappTileProps {
  url: string;
  name: string;
  icon?: string;
  onOpen: (url: string) => void;
  morph?: boolean;
}

export const DappTile: FC<DappTileProps> = ({ url, name, icon, onOpen, morph = false }) => {
  const { press } = useExploreMotion();

  // onClick, not onPointerDown, so a horizontal or vertical scroll that grazes a tile doesn't open it.
  return (
    <motion.button
      type="button"
      {...press}
      onClick={() => {
        hapticLight();
        onOpen(url);
      }}
      aria-label={name}
      data-testid="dapp-tile"
      data-dapp-url={url}
      className="flex w-18 shrink-0 snap-start flex-col items-center gap-1.5 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
    >
      <AppIcon url={url} name={name} icon={icon} size="tile" surface="page" morph={morph} />
      <AppName url={url} morph={morph} className="w-full text-center font-heading text-xs font-bold text-ink">
        {name}
      </AppName>
    </motion.button>
  );
};

export interface TileRowProps {
  children: React.ReactNode;
  'data-testid'?: string;
}

/** A horizontally scrolling row of tiles, bleeding to the screen edge past the 16px gutter. */
export const TileRow: FC<TileRowProps> = ({ children, 'data-testid': dataTestId }) => (
  <div
    data-testid={dataTestId}
    className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1"
  >
    {children}
  </div>
);
