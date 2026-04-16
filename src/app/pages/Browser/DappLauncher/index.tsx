/**
 * Top-level launcher composition for the embedded dApp browser.
 *
 * Stack (top → bottom):
 *   <Header/>            wallet account header
 *   <HeroSearch/>        search/URL bar
 *   <FeaturedCarousel/>  large brand-color cards
 *   <CategoryRow/>       chip filters (DeFi, NFT, Tools, Social)
 *   <MyDappsGrid/>       4-col featured tiles
 *   <RecentsRow/>        1-row of up to 4 recent opens
 *
 * The launcher reads recents from `recent-dapps.ts` storage on mount.
 * Tile + carousel taps call `onOpen(url)` which the parent
 * (`BrowserScreen`) handles by creating a session and switching to
 * `<DappActive>`.
 */

import React, { type FC, useEffect, useState } from 'react';

import Header from 'app/layouts/PageLayout/Header';
import { type FeaturedDappCategory, getRecentDapps, type RecentDapp } from 'lib/dapp-browser';

import { CategoryRow } from './CategoryRow';
import { FeaturedCarousel } from './FeaturedCarousel';
import { HeroSearch } from './HeroSearch';
import { MyDappsGrid } from './MyDappsGrid';
import { RecentsRow } from './RecentsRow';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  /** PR-1's BrowserScreen still passes this; PR-2 reads recents from storage instead.  */
  recentUrls?: string[];
}

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen }) => {
  const [recents, setRecents] = useState<RecentDapp[]>([]);
  const [category, setCategory] = useState<FeaturedDappCategory | null>(null);

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
      <Header />

      <main className="grow space-y-5 overflow-y-auto pb-24 pt-2" style={{ overscrollBehavior: 'contain' }}>
        <HeroSearch onSubmit={onOpen} />

        <FeaturedCarousel onOpen={onOpen} />

        <CategoryRow active={category} onToggle={setCategory} />

        <MyDappsGrid category={category} onOpen={onOpen} />

        <RecentsRow recents={recents} category={category} onOpen={onOpen} />
      </main>
    </>
  );
};
