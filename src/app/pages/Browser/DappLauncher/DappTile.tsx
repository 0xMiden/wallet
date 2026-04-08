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
      // Entry animation: tiles drop from 48pt above their final
      // position down into place. No `layoutId` on the button because
      // nothing else in the app shares that id — the actual tile →
      // capsule morph is handled by the INNER favicon + name elements
      // which have their own `layoutId`s. Keeping layoutId off the
      // button is what makes `initial` fire reliably; elements
      // tracked by the launcher's `LayoutGroup` get their initial
      // prop intercepted by framer-motion's layout system, which was
      // causing the drop animation to be skipped entirely.
      //
      // Tween with explicit duration (not a spring) so the drop is
      // visually unambiguous — the spring variants were settling in
      // ~300ms and with the small drop distance it read as a fade
      // rather than a drop. 500ms + ease-out is slow enough to be
      // clearly perceived as a falling motion.
      initial={{ opacity: 0, y: -48 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.5,
        ease: [0.22, 1, 0.36, 1],
        delay: entryBaseDelay + animationIndex * 0.06
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
