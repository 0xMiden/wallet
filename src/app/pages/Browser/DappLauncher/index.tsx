/**
 * Top-level launcher composition for the embedded dApp browser: Explore, laid out like an app store.
 *
 * Stack (top → bottom):
 *   <TabRootHeader/>    the shared tab-root band: "Explore" title with a search icon top right that
 *                       swaps the title for a field (it searches the catalog and opens a typed or
 *                       pasted URL), and under it the category row — All, Tools, DeFi, Games, NFTs,
 *                       Learn — drawn by the same control, at the same height, as Activity's filters
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
import { TabHeaderAction, TabRootHeader } from 'components/ui';
import type { SegmentedControlItem } from 'components/ui/SegmentedControl';
import { useExploreMotion } from 'lib/animation';
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

import { type ExploreEmptyState, ExploreSections } from './ExploreSections';
import { hasRevealed, markRevealed } from './reveal-once';
import { urlForQuery } from './search-url';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  /** PR-1's BrowserScreen still passes this; PR-2 reads recents from storage instead.  */
  recentUrls?: string[];
  /** The catalog to show. Defaults to this platform's (`getExploreCatalog`). */
  catalog?: ExploreCatalog;
}

/** The categories are header chrome now, so the reveal starts at the first section. */
const FIRST_SECTION_REVEAL = 0;

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

  const categories = useMemo<SegmentedControlItem<ExploreFilter>[]>(
    () => EXPLORE_FILTERS.map(f => ({ id: f.id, label: t(f.labelKey), 'data-testid': `explore-chip-${f.id}` })),
    [t]
  );

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

  return (
    <>
      <TabRootHeader
        title={t('explore')}
        search={{
          open: searchOpen,
          value: query,
          onChange: setQuery,
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
        filter={{
          items: categories,
          value: filter,
          onChange: setFilter,
          'aria-label': t('exploreCategoriesLabel'),
          'data-testid': 'explore-category-chips'
        }}
      />

      {/* `layoutScroll`, so the sections' layout moves measure through the scroll. */}
      {/* `pt-2` and nothing more: the first section title sits right under the category row. */}
      <motion.main
        layoutScroll
        className="grow overflow-y-auto pt-2 pb-24"
        style={{ overscrollBehavior: 'contain' }}
        data-testid="explore-launcher"
      >
        <ExploreSections
          sections={sections}
          recents={recents}
          empty={empty}
          onOpen={onOpen}
          reveal={reveal}
          firstRevealIndex={FIRST_SECTION_REVEAL}
          staggered={!settled}
        />
      </motion.main>
    </>
  );
};
