/**
 * Single-row, horizontally-scrollable list of FEATURED dApps.
 *
 * Previously this was a 4-column grid that wrapped to 2 rows when
 * there were more than 4 featured dApps (7 by default). Matching the
 * new `<RecentsRow>` which is always one row, we now render featured
 * dApps as a horizontally-scrolling strip with fixed-width tiles so
 * the section is visually consistent with Recents: one line, scroll
 * horizontally when there are more than fit on screen.
 *
 * Filter chips from `<CategoryRow>` narrow the list to a single category.
 * Each tile is a `<DappTile>` whose `layoutId` matches the `<CapsuleBar>`
 * favicon + name, so opening a dApp morphs the tile into the capsule.
 */

import React, { type FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { FEATURED_DAPPS, type FeaturedDappCategory } from 'lib/dapp-browser';

import { DappTile } from './DappTile';

// Each tile takes a fixed width so the horizontal strip has a
// predictable rhythm (matching the ~93pt column width of the
// previous 4-col grid on iPhone 17).
const TILE_WIDTH = 93;

interface MyDappsGridProps {
  category: FeaturedDappCategory | null;
  onOpen: (url: string) => void;
}

export const MyDappsGrid: FC<MyDappsGridProps> = ({ category, onOpen }) => {
  const { t } = useTranslation();

  const featured = useMemo(
    () => (category ? FEATURED_DAPPS.filter(d => d.category === category) : FEATURED_DAPPS),
    [category]
  );

  if (featured.length === 0) {
    return <div className="px-4 py-12 text-center text-sm text-grey-400">{t('noDappsInCategory')}</div>;
  }

  return (
    <section>
      <h2 className="mb-3 px-4 text-sm font-semibold uppercase tracking-wide text-grey-500">
        {category ? t(`category${category[0].toUpperCase()}${category.slice(1)}`) : t('myDapps')}
      </h2>
      <div
        className="flex gap-1 overflow-x-auto px-2 pb-1"
        style={{
          // Hide the horizontal scrollbar on mobile — the scroll is
          // touch-driven and the bar would steal vertical space.
          scrollbarWidth: 'none'
        }}
      >
        {featured.map((dapp, index) => (
          <div key={dapp.url} style={{ width: TILE_WIDTH, flexShrink: 0 }}>
            <DappTile
              url={dapp.url}
              name={dapp.name}
              icon={dapp.icon}
              brandColor={dapp.brandColor}
              badge={dapp.badge}
              onOpen={onOpen}
              animationIndex={index}
            />
          </div>
        ))}
      </div>
    </section>
  );
};
