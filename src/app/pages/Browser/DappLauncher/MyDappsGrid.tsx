/**
 * 4-column grid combining recent dApps with the hardcoded featured list.
 *
 * Recents (sorted newest-first) come first; featured fill the remainder.
 * Filter chips from `<CategoryRow>` narrow the list to a single category;
 * recents are not filtered (they were chosen by the user explicitly).
 *
 * Each tile is a `<DappTile>` whose `layoutId` matches the `<CapsuleBar>`
 * favicon + name, so opening a dApp morphs the tile into the capsule.
 */

import React, { type FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { FEATURED_DAPPS, type FeaturedDappCategory, type RecentDapp } from 'lib/dapp-browser';

import { DappTile } from './DappTile';

interface MyDappsGridProps {
  recents: RecentDapp[];
  category: FeaturedDappCategory | null;
  onOpen: (url: string) => void;
}

export const MyDappsGrid: FC<MyDappsGridProps> = ({ recents, category, onOpen }) => {
  const { t } = useTranslation();

  const featured = useMemo(
    () => (category ? FEATURED_DAPPS.filter(d => d.category === category) : FEATURED_DAPPS),
    [category]
  );

  // Recents should not appear duplicated in the featured list — drop any
  // featured entry whose URL is already a recent.
  const featuredFiltered = useMemo(() => {
    const recentUrls = new Set(recents.map(r => r.url));
    return featured.filter(f => !recentUrls.has(f.url));
  }, [featured, recents]);

  // When a category filter is active, hide recents that don't match either
  // (they have no category metadata, so we always show them).
  const visibleRecents = category ? [] : recents;

  if (visibleRecents.length === 0 && featuredFiltered.length === 0) {
    return <div className="px-4 py-12 text-center text-sm text-grey-400">{t('noDappsInCategory')}</div>;
  }

  return (
    <section>
      <h2 className="mb-3 px-4 text-sm font-semibold uppercase tracking-wide text-grey-500">
        {category ? t(`category${category[0].toUpperCase()}${category.slice(1)}`) : t('myDapps')}
      </h2>
      <div className="grid grid-cols-4 gap-1 px-2">
        {visibleRecents.map(dapp => (
          <DappTile key={dapp.url} url={dapp.url} name={dapp.name} icon={dapp.favicon} onOpen={onOpen} />
        ))}
        {featuredFiltered.map(dapp => (
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
