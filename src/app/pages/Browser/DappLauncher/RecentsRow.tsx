/**
 * Single-row strip showing up to 4 most-recently-opened dApps.
 *
 * Lives BELOW the `<MyDappsGrid>` featured tiles. Unlike the old
 * combined grid which mixed recents into the featured list, recents
 * are now a first-class section with their own header so the user
 * can clearly distinguish "apps we've curated for you" (My Dapps)
 * from "apps you've opened recently" (Recents).
 *
 * - Capped at 4 entries (one row of 4 tiles matches the launcher's
 *   4-column grid).
 * - Sorted newest-first (the provider's `getRecentDapps` already
 *   sorts by `lastOpenedAt` desc).
 * - Hidden entirely when the category filter is active, since
 *   recents have no category metadata.
 * - Hidden when there are no recents at all.
 */

import React, { type FC } from 'react';

import { useTranslation } from 'react-i18next';

import { type FeaturedDappCategory, type RecentDapp } from 'lib/dapp-browser';

import { DappTile } from './DappTile';

const MAX_VISIBLE = 4;

interface RecentsRowProps {
  recents: RecentDapp[];
  category: FeaturedDappCategory | null;
  onOpen: (url: string) => void;
}

export const RecentsRow: FC<RecentsRowProps> = ({ recents, category, onOpen }) => {
  const { t } = useTranslation();

  // When the user is filtering by category, the Recents section is
  // hidden — recents don't carry category metadata so we can't filter
  // them and mixing an unfiltered row into a filtered view is noisy.
  if (category) return null;
  if (recents.length === 0) return null;

  const visible = recents.slice(0, MAX_VISIBLE);

  return (
    <section>
      <h2 className="mb-3 px-4 text-sm font-semibold uppercase tracking-wide text-grey-500">
        {t('recents') ?? 'Recents'}
      </h2>
      <div className="grid grid-cols-4 gap-1 px-2">
        {visible.map(dapp => (
          <DappTile key={dapp.url} url={dapp.url} name={dapp.name} icon={dapp.favicon} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
};
