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

  // When a category filter is active recents are hidden (they have no
  // category metadata so we can't tell which ones belong), and we MUST
  // skip the recent-vs-featured dedup in that case — otherwise a
  // featured Zoro that the user has already visited would be hidden by
  // the recent zoroswap which is itself hidden, and the DeFi filter
  // would show "No dApps in this category yet" even though Zoro is
  // right there. With no category active we keep the dedup so the
  // user doesn't see the same dApp twice in one grid.
  const featuredFiltered = useMemo(() => {
    if (category) return featured;
    const recentUrls = new Set(recents.map(r => r.url));
    return featured.filter(f => !recentUrls.has(f.url));
  }, [category, featured, recents]);

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
