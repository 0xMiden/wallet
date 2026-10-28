/**
 * Top-level launcher composition for the embedded dApp browser: Explore, laid out like an app store.
 *
 * Stack (top → bottom):
 *   <TabRootHeader/>    the shared tab-root band: "Explore" title with a search icon top right that
 *                       swaps the title for a field (it searches the catalog and opens a typed or
 *                       pasted URL), and under it the category row — All, Finance, Arcade, Others —
 *                       drawn by the same control, at the same height, as Activity's filters
 *   <ExploreSections/>  the sections of the effective network's catalog (`lib/explore-config`, drawn
 *                       through `lib/dapp-browser/explore-catalog`) for the chosen chip, then recents
 *
 * The launcher reads recents from `recent-dapps.ts` storage on mount. Every tap calls
 * `onOpen(url)`, which the parent (`BrowserScreen`) handles by creating a session and switching to
 * `<DappActive>`. On its first mount the page reveals itself top to bottom (`useExploreMotion`).
 */

import React, { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { usePageActive } from 'app/layouts/page-active';
import { TabHeaderAction, TabRootHeader } from 'components/ui';
import type { SegmentedControlItem } from 'components/ui/SegmentedControl';
import { exploreSectionVariant, useExploreMotion } from 'lib/animation';
import {
  EXPLORE_FILTERS,
  getExploreCatalog,
  getRecentDapps,
  localizeExploreCatalog,
  resolveExploreSections,
  searchExploreCatalog,
  type ExploreFilter,
  type RecentDapp,
  type ResolvedExploreSection
} from 'lib/dapp-browser';
import { useExploreCatalog } from 'lib/explore-config/use-explore-catalog';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';

import { ArcadeLanding } from './ArcadeLanding';
import { type ExploreEmptyState, ExploreSections } from './ExploreSections';
import { FinanceHero } from './FinanceHero';
import { hasRevealed, markRevealed } from './reveal-once';
import { urlForQuery } from './search-url';

interface DappLauncherProps {
  onOpen: (url: string) => void;
  requestedFilter?: ExploreFilter;
  entryIntent?: number;
  onChooseFilter?: (filter: ExploreFilter) => void;
}

/** The categories are header chrome now, so the reveal starts at the first section. */
const FIRST_SECTION_REVEAL = 0;

/** The apps the All chip features, in order, with each one's headline; an app the catalog lacks is skipped. */
const ALL_FEATURED: { id: string; headlineKey: string }[] = [
  { id: 'port0', headlineKey: 'exploreFeaturedPort0Headline' },
  { id: 'geoquizz', headlineKey: 'exploreFeaturedGeoquizzHeadline' },
  { id: 'qash', headlineKey: 'exploreFeaturedQashHeadline' }
];

export const DappLauncher: FC<DappLauncherProps> = ({ onOpen, requestedFilter, onChooseFilter, entryIntent }) => {
  const { t, i18n } = useTranslation();
  const active = usePageActive();
  const motionTokens = useExploreMotion();
  const [recents, setRecents] = useState<RecentDapp[]>([]);
  const [keptFilter, setFilter] = useState<ExploreFilter>('all');
  const filter = requestedFilter ?? keptFilter;
  useEffect(() => {
    if (requestedFilter) setFilter(requestedFilter);
  }, [requestedFilter]);
  const published = useExploreCatalog();
  // Pending for the one storage read before the network's floor is known: nothing is drawn, not even the empty state.
  const pending = published === undefined;
  // The language the rest of the page renders in, so the document's text matches it.
  const locale = i18n.resolvedLanguage ?? 'en';
  const catalog = useMemo(
    () => localizeExploreCatalog(getExploreCatalog(published ?? null), locale, t('recents')),
    [published, locale, t]
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const results = useMemo(() => searchExploreCatalog(catalog, filter, query), [catalog, filter, query]);

  // The Finance hero's apps: Finance's items in the order its sections show them, each once.
  const financeItems = useMemo(() => {
    const seen = new Set<string>();
    return resolveExploreSections(catalog, 'finance')
      .flatMap(({ items }) => items)
      .filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
  }, [catalog]);

  const categories = useMemo<SegmentedControlItem<ExploreFilter>[]>(
    () => EXPLORE_FILTERS.map(f => ({ id: f.id, label: t(f.labelKey), 'data-testid': `explore-chip-${f.id}` })),
    [t]
  );

  // While searching, the sections collapse into one results list (or "No results").
  const sections = useMemo<ResolvedExploreSection[]>(() => {
    if (!searching) {
      const resolved = resolveExploreSections(catalog, filter);
      // The All chip opens on a Featured row unless the catalog already publishes one.
      if (filter !== 'all' || resolved.some(({ section }) => section.kind === 'featured')) return resolved;
      const items = ALL_FEATURED.flatMap(({ id }) => catalog.items.filter(item => item.id === id));
      if (items.length === 0) return resolved;
      const itemIds = items.map(item => item.id);
      return [
        { section: { id: 'featured', kind: 'featured', title: t('exploreFeatured'), itemIds }, items },
        ...resolved
      ];
    }
    if (results.length === 0) return [];
    const itemIds = results.map(item => item.id);
    return [{ section: { id: 'search-results', kind: 'list', title: t('exploreResults'), itemIds }, items: results }];
  }, [catalog, filter, searching, results, t]);

  const featuredHeadlines = useMemo(
    () => Object.fromEntries(ALL_FEATURED.map(({ id, headlineKey }) => [id, t(headlineKey)])),
    [t]
  );

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
    closeSearch();
  };

  // The reveal plays on the first mount of the session only (see `reveal-once.ts`); after that
  // first commit, a section that enters is answering a chip and comes in without the stagger.
  const [reveal] = useState(() => motionTokens.reveal && !hasRevealed());
  // The first reveal ends when the USER replaces what is on the page (a chip, a query), not on the
  // first commit. Recents arrive from a promise that resolves after mount, so ending it on the
  // commit made the LAST section rise first, ahead of every section above it. The stagger belongs
  // to a reveal that is actually playing: on a return from a dApp `reveal` is already false, and a
  // section arriving late then enters like one answering a chip, with no delay in front of it.
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    if (entryIntent === undefined) return;
    // An explicit Home → Arcade push reveals the landing, not a retained search.
    // Ordinary tab returns, chip replacements and Back keep their search state.
    setSearchOpen(false);
    setQuery('');
    setSettled(true);
  }, [entryIntent]);
  useEffect(() => {
    markRevealed();
  }, []);

  const chooseFilter = (next: ExploreFilter) => {
    setSettled(true);
    setFilter(next);
    onChooseFilter?.(next);
  };

  const changeQuery = (next: string) => {
    setSettled(true);
    setQuery(next);
  };

  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  return (
    <>
      <TabRootHeader
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
        filter={{
          items: categories,
          value: filter,
          onChange: chooseFilter,
          'aria-label': t('exploreCategoriesLabel'),
          'data-testid': 'explore-category-chips'
        }}
      />

      {/* `layoutScroll`, so the sections' layout moves measure through the scroll. */}
      {/* `pt-2` and nothing more: the first section title sits right under the category row. */}
      <motion.main
        layoutScroll
        className="grow overflow-y-auto pt-2 pb-[calc(6rem+var(--wallet-control-safe-bottom,0px))]"
        style={{ overscrollBehavior: 'contain' }}
        data-testid="explore-launcher"
      >
        {filter === 'arcade' && !searching ? (
          <ArcadeLanding catalog={catalog} pending={pending} onOpen={onOpen} />
        ) : (
          !pending && (
            <>
              {filter === 'finance' && !searching && financeItems.length > 0 && (
                <motion.div
                  className="px-4 pb-5"
                  custom={0}
                  variants={motionTokens.section}
                  initial={exploreSectionVariant.hidden}
                  animate={exploreSectionVariant.shown}
                >
                  <FinanceHero items={financeItems} />
                </motion.div>
              )}
              <ExploreSections
                sections={sections}
                recents={recents}
                headlines={featuredHeadlines}
                empty={empty}
                onOpen={onOpen}
                reveal={reveal}
                firstRevealIndex={FIRST_SECTION_REVEAL}
                staggered={reveal && !settled}
              />
            </>
          )
        )}
      </motion.main>
    </>
  );
};
