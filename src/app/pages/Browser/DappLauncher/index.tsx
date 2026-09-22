/**
 * Top-level launcher composition for the embedded dApp browser: Explore, laid out like an app store.
 *
 * Stack (top → bottom):
 *   <TabHeader/>        "Explore" title, and a search icon top right that swaps the title for a
 *                       field, as on Activity: it searches the catalog and opens a typed or pasted URL
 *   <CategoryChips/>    All, Tools, DeFi, Games, NFTs, Learn
 *   <ExploreSections/>  the catalog's sections for the chosen chip (`lib/dapp-browser/explore-catalog`):
 *                       today a featured card, the helper tools list and recents
 *
 * The launcher reads recents from `recent-dapps.ts` storage on mount. Every tap calls
 * `onOpen(url)`, which the parent (`BrowserScreen`) handles by creating a session and switching to
 * `<DappActive>`. On its first mount the page reveals itself top to bottom (`useExploreMotion`).
 */

import React, { type FC, useCallback, useEffect, useMemo, useState } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { TabHeader, TabHeaderAction } from 'components/ui';
import { exploreSectionVariant, useExploreMotion } from 'lib/animation';
import {
  EXPLORE_FILTERS,
  getExploreCatalog,
  getRecentDapps,
  resolveExploreSections,
  searchExploreCatalog,
  type ExploreCatalog,
  type ExploreFilter,
  type RecentDapp,
  type ResolvedExploreSection
} from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';

import { CategoryChips } from './CategoryChips';
import { type ExploreEmptyState, ExploreSections } from './ExploreSections';
import { hasRevealed, markRevealed } from './reveal-once';
import { urlForQuery } from './search-url';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  /** The catalog to show. Defaults to this platform's (`getExploreCatalog`). */
  catalog?: ExploreCatalog;
}

/** Reveal positions: the chips, then each section. */
const CHIPS_REVEAL = 0;
const FIRST_SECTION_REVEAL = 1;

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen, catalog: catalogProp }) => {
  const { t } = useTranslation();
  const motionTokens = useExploreMotion();
  const [recents, setRecents] = useState<RecentDapp[]>([]);
  const [filter, setFilter] = useState<ExploreFilter>('all');
  const catalog = useMemo(() => catalogProp ?? getExploreCatalog(), [catalogProp]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const results = useMemo(() => searchExploreCatalog(catalog, filter, query), [catalog, filter, query]);

  // While searching, the sections collapse into one results list (or "No results").
  const sections = useMemo<ResolvedExploreSection[]>(() => {
    if (!searching) return resolveExploreSections(catalog, filter);
    if (results.length === 0) return [];
    const itemIds = results.map(item => item.id);
    return [{ section: { id: 'search-results', kind: 'list', titleKey: 'exploreResults', itemIds }, items: results }];
  }, [catalog, filter, searching, results]);

  const empty: ExploreEmptyState = searching
    ? {
        key: 'search',
        icon: IconName.Search,
        title: t('exploreNoResultsTitle'),
        description: t('exploreNoResultsDescription')
      }
    : {
        key: filter,
        icon: EXPLORE_FILTERS.find(f => f.id === filter)?.icon ?? IconName.Apps,
        title: t('exploreComingSoonTitle'),
        description: t('exploreComingSoonDescription')
      };

  // As on Activity: the header's search button opens and closes the field, and closing clears it.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
  }, []);
  const toggleSearch = () => (searchOpen ? closeSearch() : setSearchOpen(true));
  useMobileBackHandler(() => {
    if (!searchOpen) return false;
    closeSearch();
    return true;
  }, [searchOpen, closeSearch]);

  const submitSearch = () => {
    const url = urlForQuery(query, results[0]?.url);
    if (!url) return;
    hapticLight();
    onOpen(url);
  };

  // The reveal plays on the first mount of the session only (see `reveal-once.ts`); after that
  // first commit, a section that enters is answering a chip and comes in without the stagger.
  const [reveal] = useState(() => motionTokens.reveal && !hasRevealed());
  // The first reveal ends when the USER replaces what is on the page (a chip, a query), not on the
  // first commit. Recents arrive from a promise that resolves after mount, so ending it on the
  // commit made the LAST section rise first, ahead of every section above it.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    markRevealed();
  }, []);

  const chooseFilter = (next: ExploreFilter) => {
    setSettled(true);
    setFilter(next);
  };

  const changeQuery = (next: string) => {
    setSettled(true);
    setQuery(next);
  };

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
      <TabHeader
        title={t('explore')}
        search={{
          open: searchOpen,
          value: query,
          onChange: changeQuery,
          placeholder: t('searchDapps'),
          onSubmit: submitSearch,
          onEscape: closeSearch,
          inputMode: 'url',
          'data-testid': 'dapp-hero-search'
        }}
        actions={
          <TabHeaderAction
            label={t('exploreSearch')}
            icon={IconName.Search}
            active={searchOpen}
            onClick={toggleSearch}
            data-testid="explore-search-toggle"
          />
        }
      />

      {/* `layoutScroll`, so the sections' layout moves measure through the scroll. */}
      <motion.main
        layoutScroll
        className="grow overflow-y-auto pt-2 pb-24"
        style={{ overscrollBehavior: 'contain' }}
        data-testid="explore-launcher"
      >
        <div className="flex flex-col gap-5">
          <motion.div {...revealProps(CHIPS_REVEAL)}>
            <CategoryChips filters={EXPLORE_FILTERS} value={filter} onChange={chooseFilter} />
          </motion.div>

          <ExploreSections
            sections={sections}
            recents={recents}
            empty={empty}
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
