/**
 * Top-level launcher composition for the embedded dApp browser: Explore, laid out like an app store.
 *
 * Stack (top → bottom):
 *   <TabHeader/>        "Explore" title
 *   <HeroSearch/>       search / paste-a-URL field
 *   <CategoryChips/>    All, Tools, DeFi, Games, NFTs, Learn
 *   <ExploreSections/>  the catalog's sections for the chosen chip (`lib/dapp-browser/explore-catalog`):
 *                       today a featured card, the helper tools list and recents
 *
 * The launcher reads recents from `recent-dapps.ts` storage on mount. Every tap calls
 * `onOpen(url)`, which the parent (`BrowserScreen`) handles by creating a session and switching to
 * `<DappActive>`. On its first mount the page reveals itself top to bottom (`useExploreMotion`).
 */

import React, { type FC, useEffect, useMemo, useState } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { TabHeader } from 'components/ui';
import { exploreSectionVariant, useExploreMotion } from 'lib/animation';
import {
  EXPLORE_FILTERS,
  getExploreCatalog,
  getRecentDapps,
  resolveExploreSections,
  type ExploreCatalog,
  type ExploreFilter,
  type RecentDapp
} from 'lib/dapp-browser';

import { CategoryChips } from './CategoryChips';
import { ExploreSections } from './ExploreSections';
import { HeroSearch } from './HeroSearch';
import { hasRevealed, markRevealed } from './reveal-once';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  /** PR-1's BrowserScreen still passes this; PR-2 reads recents from storage instead.  */
  recentUrls?: string[];
  /** The catalog to show. Defaults to this platform's (`getExploreCatalog`). */
  catalog?: ExploreCatalog;
}

/** Reveal positions: the search, then the chips, then each section. */
const SEARCH_REVEAL = 0;
const CHIPS_REVEAL = 1;
const FIRST_SECTION_REVEAL = 2;

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen, catalog: catalogProp }) => {
  const { t } = useTranslation();
  const motionTokens = useExploreMotion();
  const [recents, setRecents] = useState<RecentDapp[]>([]);
  const [filter, setFilter] = useState<ExploreFilter>('all');
  const catalog = useMemo(() => catalogProp ?? getExploreCatalog(), [catalogProp]);
  const sections = useMemo(() => resolveExploreSections(catalog, filter), [catalog, filter]);
  const emptyIcon = EXPLORE_FILTERS.find(f => f.id === filter)?.icon ?? IconName.Apps;

  // The reveal plays on the first mount of the session only (see `reveal-once.ts`); after that
  // first commit, a section that enters is answering a chip and comes in without the stagger.
  const [reveal] = useState(() => motionTokens.reveal && !hasRevealed());
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    markRevealed();
    setSettled(true);
  }, []);

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

  const revealProps = (index: number) => ({
    custom: index,
    variants: motionTokens.section,
    initial: reveal ? exploreSectionVariant.hidden : false,
    animate: exploreSectionVariant.shown
  });

  return (
    <>
      <TabHeader title={t('explore')} />

      {/* `layoutScroll`, so the sections' layout moves and the capsule morph measure through the scroll. */}
      <motion.main
        layoutScroll
        className="grow overflow-y-auto pt-2 pb-24"
        style={{ overscrollBehavior: 'contain' }}
        data-testid="explore-launcher"
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <motion.div {...revealProps(SEARCH_REVEAL)}>
              <HeroSearch onSubmit={onOpen} />
            </motion.div>
            <motion.div {...revealProps(CHIPS_REVEAL)}>
              <CategoryChips filters={EXPLORE_FILTERS} value={filter} onChange={setFilter} />
            </motion.div>
          </div>

          <ExploreSections
            sections={sections}
            recents={recents}
            filter={filter}
            emptyIcon={emptyIcon}
            onOpen={onOpen}
            reveal={reveal}
            firstRevealIndex={FIRST_SECTION_REVEAL}
            staggered={!settled}
          />
        </div>
      </motion.main>
    </>
  );
};
