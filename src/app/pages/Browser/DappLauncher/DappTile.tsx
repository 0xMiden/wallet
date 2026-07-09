/**
 * Single dApp tile in the launcher's RecentsRow.
 *
 * The tile can be the source side of the shared-element morph that animates
 * into the capsule when the user opens a dApp. The matching `layoutId`s
 * live on the favicon (`dapp-favicon-${url}`) and name (`dapp-name-${url}`)
 * of `<CapsuleBar>`. framer-motion's `LayoutGroup id="dapp-browser"` (set
 * up at `BrowserScreen` level) wires the two surfaces together — though
 * RecentsRow opts out (`enableSharedLayout={false}`) because the AppsGrid
 * cards own the morph for curated apps.
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
   * Whether this tile's favicon + name participate in the shared-layout
   * morph that transitions tile → capsule (and back on minimize). Only
   * ONE tile per URL in the launcher tree can carry the layoutId —
   * framer-motion's LayoutGroup unifies any elements sharing a
   * layoutId, so if the same URL appears in two sections (e.g. a
   * Featured dApp that's also in Recents) BOTH tiles get projected to
   * a single merged position, leaving the non-primary instance
   * rendered at 0×0 or the merged rect's size. The primary owner
   * (MyDappsGrid) defaults to `true`; secondary sections like
   * RecentsRow pass `false` so their tile renders normally and the
   * MyDappsGrid tile remains the unique morph target.
   */
  enableSharedLayout?: boolean;
}

export const DappTile: FC<DappTileProps> = ({
  url,
  name,
  icon,
  brandColor,
  badge,
  onOpen,
  enableSharedLayout = true
}) => {
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
    <button
      type="button"
      onClick={handleClick}
      // `w-full` ensures the button fills its grid cell so favicons
      // line up at consistent horizontal positions across tiles.
      className="flex w-full flex-col items-center gap-1.5 rounded-2xl p-2 active:bg-gray-100"
      aria-label={accessibleLabel}
    >
      <motion.div
        layoutId={enableSharedLayout ? `dapp-favicon-${url}` : undefined}
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
        layoutId={enableSharedLayout ? `dapp-name-${url}` : undefined}
        transition={springs.morph}
        className="w-full truncate text-center text-xs font-medium text-heading-gray"
        aria-hidden="true"
      >
        {name}
      </motion.span>
    </button>
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
