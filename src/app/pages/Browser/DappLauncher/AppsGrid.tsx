/**
 * 2-column grid containing the two faucet apps from `EXPLORE_GRID_DAPPS`.
 *
 * Replaces the old FeaturedCarousel + CategoryRow + MyDappsGrid stack:
 * the simplified Explore page shows a hand-picked set of apps as
 * cards (icon + name + genre + one-line description), no category
 * filtering, no horizontal scrolling.
 *
 * Each card is the source side of the shared-element morph into the
 * `<CapsuleBar>` — the icon and name carry the same
 * `dapp-favicon-${url}` / `dapp-name-${url}` layoutIds, so opening an
 * app morphs the card into the capsule (see `BrowserScreen`'s
 * `LayoutGroup id="dapp-browser"`).
 */

import React, { type FC, useState } from 'react';

import { motion } from 'framer-motion';

import { useSprings } from 'lib/animation';
import { getExploreGridDapps, type FeaturedDapp } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface AppsGridProps {
  onOpen: (url: string) => void;
}

interface AppCardProps {
  dapp: FeaturedDapp;
  onOpen: (url: string) => void;
}

const getFaucetDapps = () => getExploreGridDapps().filter(dapp => dapp.id === 'swap-faucet' || dapp.id === 'faucet');

const AppCard: FC<AppCardProps> = ({ dapp, onOpen }) => {
  const [iconBroken, setIconBroken] = useState(false);
  const springs = useSprings();

  const showFallback = !dapp.icon || iconBroken;

  const handleClick = () => {
    hapticLight();
    onOpen(dapp.url);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex flex-col items-center gap-3 rounded-2xl border border-[#E5E5EA] bg-white p-4 text-left active:opacity-90"
      aria-label={dapp.name}
    >
      <motion.div
        layoutId={`dapp-favicon-${dapp.url}`}
        transition={springs.morph}
        className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl"
        style={{ background: showFallback ? dapp.brandColor : 'rgba(0,0,0,0.04)' }}
        aria-hidden="true"
      >
        {showFallback ? (
          <span className="text-lg font-semibold text-pure-white">{dapp.name.charAt(0).toUpperCase()}</span>
        ) : (
          <img
            src={dapp.icon}
            alt=""
            className="h-8 w-8 object-contain"
            onError={() => setIconBroken(true)}
            draggable={false}
          />
        )}
      </motion.div>
      <div className="flex flex-col gap-0.5 w-full items-center">
        <motion.span
          layoutId={`dapp-name-${dapp.url}`}
          transition={springs.morph}
          className="font-heading text-base font-bold text-heading-gray"
          aria-hidden="true"
        >
          {dapp.name}
        </motion.span>
        {dapp.genre && (
          <span className="font-heading text-[10px] font-semibold uppercase tracking-wide text-accent-primary">
            {dapp.genre}
          </span>
        )}
        <span className="font-heading text-xs font-medium leading-snug text-heading-gray opacity-50">
          {dapp.shortDescription}
        </span>
      </div>
    </button>
  );
};

export const AppsGrid: FC<AppsGridProps> = ({ onOpen }) => (
  <section className="grid grid-cols-2 gap-3 px-4">
    {getFaucetDapps().map(dapp => (
      <AppCard key={dapp.id} dapp={dapp} onOpen={onOpen} />
    ))}
  </section>
);
