/**
 * Top-level launcher composition for the embedded dApp browser.
 *
 * Stack (top → bottom):
 *   <TabHeader/>         "Explore" title + settings button
 *   <HeroSearch/>        search/URL bar
 *   <AppsGrid/>          2×2 curated app cards (EXPLORE_GRID_DAPPS)
 *   <RecentsRow/>        1-row of up to 4 recent opens
 *
 * The launcher reads recents from `recent-dapps.ts` storage on mount.
 * Card + tile taps call `onOpen(url)` which the parent
 * (`BrowserScreen`) handles by creating a session and switching to
 * `<DappActive>`.
 */

import React, { type FC, useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { TabHeader } from 'components/ui';
import { getRecentDapps, type RecentDapp } from 'lib/dapp-browser';

import { AppsGrid } from './AppsGrid';
import { HeroSearch } from './HeroSearch';
import { RecentsRow } from './RecentsRow';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  /** PR-1's BrowserScreen still passes this; PR-2 reads recents from storage instead.  */
  recentUrls?: string[];
}

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen }) => {
  const { t } = useTranslation();
  const [recents, setRecents] = useState<RecentDapp[]>([]);

  // Load recents from preferences on mount.
  useEffect(() => {
    let cancelled = false;
    getRecentDapps()
      .then(list => {
        if (!cancelled) setRecents(list);
      })
      .catch(() => {
        if (!cancelled) setRecents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <TabHeader title={t('explore')} />

      <main className="grow space-y-5 overflow-y-auto pb-24 pt-2" style={{ overscrollBehavior: 'contain' }}>
        <HeroSearch onSubmit={onOpen} />

        <AppsGrid onOpen={onOpen} />

        <RecentsRow recents={recents} onOpen={onOpen} />
      </main>
    </>
  );
};
