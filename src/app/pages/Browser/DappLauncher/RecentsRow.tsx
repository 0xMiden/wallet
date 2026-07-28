/**
 * Single-row strip showing up to 4 most-recently-opened dApps.
 *
 * Lives BELOW the `<AppsGrid>` curated cards so the user can clearly
 * distinguish "apps we've curated for you" from "apps you've opened
 * recently" (Recents).
 *
 * - Capped at 4 entries (one row of 4 tiles).
 * - Sorted newest-first (the provider's `getRecentDapps` already
 *   sorts by `lastOpenedAt` desc).
 * - Hidden when there are no recents at all.
 */

import React, { type FC } from 'react';

import { useTranslation } from 'react-i18next';

import { type RecentDapp } from 'lib/dapp-browser';

import { DappTile } from './DappTile';

const MAX_VISIBLE = 4;

interface RecentsRowProps {
  recents: RecentDapp[];
  onOpen: (url: string) => void;
}

export const RecentsRow: FC<RecentsRowProps> = ({ recents, onOpen }) => {
  const { t } = useTranslation();

  if (recents.length === 0) return null;

  const visible = recents.slice(0, MAX_VISIBLE);

  return (
    <section>
      <h2 className="mb-3 px-4 text-sm font-semibold uppercase tracking-wide text-text-muted">{t('recents')}</h2>
      <div className="grid grid-cols-4 gap-1 px-2">
        {visible.map(dapp => (
          <DappTile
            key={dapp.url}
            url={dapp.url}
            name={dapp.name}
            icon={dapp.favicon}
            onOpen={onOpen}
            // Don't participate in the capsule morph — if this URL also
            // lives in AppsGrid (curated app opened recently), that
            // section is the primary morph target and sharing the
            // layoutId here would cause framer-motion to merge both
            // instances into one projected rect (rendering this tile at
            // 0×0 OR the AppsGrid card at the wrong size).
            enableSharedLayout={false}
          />
        ))}
      </div>
    </section>
  );
};
