/**
 * Top-level launcher composition for the embedded dApp browser.
 *
 * Stack (top → bottom):
 *   <Header/>            wallet account header
 *   <HeroSearch/>        search/URL bar
 *   <FeaturedCarousel/>  large brand-color cards
 *   <CategoryRow/>       chip filters (DeFi, NFT, Tools, Social)
 *   <MyDappsGrid/>       4-col recents + featured tiles
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

interface DappLauncherProps {
  onOpen: (url: string) => void;
  /** PR-1's BrowserScreen still passes this; PR-2 reads recents from storage instead.  */
  recentUrls?: string[];
}

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen }) => {
  const [recents, setRecents] = useState<RecentDapp[]>([]);
  const [category, setCategory] = useState<FeaturedDappCategory | null>(null);

  // Load recents from preferences on mount, but DELAY the state update
  // until after TabLayout's mobile-slide-in animation has settled
  // (~150ms). Without this delay, the recents resolve mid-animation
  // and the resulting re-render adds new tiles to MyDappsGrid, causing
  // a layout reflow that visibly "jiggles" the slide-in. The 200ms
  // gate is well past the 150ms animation end and well before the
  // user could realistically interact with the page.
  useEffect(() => {
    let cancelled = false;
    getRecentDapps()
      .then(list => {
        if (cancelled) return;
        setTimeout(() => {
          if (!cancelled) setRecents(list);
        }, 200);
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

        <MyDappsGrid recents={recents} category={category} onOpen={onOpen} />
      </main>
    </>
  );
};
