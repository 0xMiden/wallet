/**
 * 4-column grid of FEATURED dApps only.
 *
 * Previously this combined featured + recents under a single "My Dapps"
 * header, but that mashed two separate concepts together and made the
 * "add to my dapps" action in the per-session menu ambiguous. Now:
 *   - `<MyDappsGrid>` renders the hardcoded featured list.
 *   - `<RecentsRow>` renders the user's recent opens as a single row
 *     BELOW this grid.
 *
 * Filter chips from `<CategoryRow>` narrow the list to a single category.
 * Each tile is a `<DappTile>` whose `layoutId` matches the `<CapsuleBar>`
 * favicon + name, so opening a dApp morphs the tile into the capsule.
 */

import React, { type FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { FEATURED_DAPPS, type FeaturedDappCategory } from 'lib/dapp-browser';

import { DappTile } from './DappTile';

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
      <div className="grid grid-cols-4 gap-1 px-2">
        {featured.map(dapp => (
          <DappTile
            key={dapp.url}
            url={dapp.url}
            name={dapp.name}
            icon={dapp.icon}
            brandColor={dapp.brandColor}
            badge={dapp.badge}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
};
