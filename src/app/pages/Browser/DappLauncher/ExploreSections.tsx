/**
 * Renders Explore's catalog sections from config: each section's `kind` picks its layout, and a
 * chip that leaves nothing to show gets a "Coming soon to Miden" state instead, and a search
 * with no match "No results".
 *
 * Every section rises in with the page's staggered reveal (`useExploreMotion().section`). When a
 * chip changes, sections it hides fade out while the rest close the gap with a layout move on the
 * tab bars' spring, and sections it shows rise in without the stagger.
 */

import React, { type FC, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { type IconName } from 'app/icons/v2';
import { EmptyState } from 'components/ui/EmptyState';
import { SectionHeader } from 'components/ui/SectionHeader';
import { exploreSectionVariant, useExploreMotion } from 'lib/animation';
import { type ExploreItem, type RecentDapp, type ResolvedExploreSection } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

import { AppList } from './AppRow';
import { DappTile, TileRow } from './DappTile';
import { FeaturedCard } from './FeaturedCard';
import { RecentsRow } from './RecentsRow';

const NONE: ReadonlySet<string> = new Set();

interface SectionBodyProps {
  resolved: ResolvedExploreSection;
  recents: RecentDapp[];
  expanded: boolean;
  onOpen: (url: string) => void;
}

const SectionBody: FC<SectionBodyProps> = ({ resolved, recents, expanded, onOpen }) => {
  const { section, items } = resolved;

  switch (section.kind) {
    case 'featured':
      if (items.length === 1 && items[0]) {
        return (
          <div className="px-4">
            <FeaturedCard item={items[0]} onOpen={onOpen} />
          </div>
        );
      }
      return (
        <TileRow>
          {items.map(item => (
            <FeaturedCard key={item.id} item={item} onOpen={onOpen} className="w-[85%] shrink-0 snap-start" />
          ))}
        </TileRow>
      );
    case 'list':
      return (
        <div className="px-4">
          <AppList items={visibleListItems(items, section.limit, expanded)} onOpen={onOpen} />
        </div>
      );
    case 'row':
      return (
        <TileRow>
          {items.map(item => (
            <DappTile key={item.id} url={item.url} name={item.name} icon={item.icon} onOpen={onOpen} />
          ))}
        </TileRow>
      );
    case 'recents':
      return <RecentsRow recents={recents} onOpen={onOpen} />;
  }
};

function visibleListItems(items: ExploreItem[], limit: number | undefined, expanded: boolean): ExploreItem[] {
  return expanded || limit === undefined ? items : items.slice(0, limit);
}

export interface ExploreEmptyState {
  /** Keys the state, so a different one animates in. */
  key: string;
  icon: IconName;
  title: string;
  description?: string;
}

export interface ExploreSectionsProps {
  /** The sections the current chip shows, from `resolveExploreSections`. */
  sections: ResolvedExploreSection[];
  recents: RecentDapp[];
  /** What to show when there are no sections: "coming soon" for a chip, "no results" for a search. */
  empty: ExploreEmptyState;
  onOpen: (url: string) => void;
  /** Whether sections present on mount play the reveal. */
  reveal: boolean;
  /** Reveal position of the first section, after whatever reveals above it. */
  firstRevealIndex: number;
  /** Whether a section entering now is part of the page's first reveal (staggered) or a filter (not). */
  staggered: boolean;
}

export const ExploreSections: FC<ExploreSectionsProps> = ({
  sections,
  recents,
  empty,
  onOpen,
  reveal,
  firstRevealIndex,
  staggered
}) => {
  const { t } = useTranslation();
  const motionTokens = useExploreMotion();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NONE);

  const shown = sections.filter(({ section }) => section.kind !== 'recents' || recents.length > 0);

  const toggle = (id: string) => {
    hapticLight();
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sectionMotion = (index: number) => ({
    layout: true,
    custom: staggered ? firstRevealIndex + index : 0,
    variants: motionTokens.section,
    initial: exploreSectionVariant.hidden,
    animate: exploreSectionVariant.shown,
    exit: exploreSectionVariant.gone,
    transition: motionTokens.layout
  });

  return (
    <div className="relative flex flex-col gap-5">
      <AnimatePresence initial={reveal} mode="popLayout">
        {shown.length === 0 ? (
          <motion.div key={`empty-${empty.key}`} {...sectionMotion(0)} className="px-4">
            <EmptyState
              data-testid="explore-empty"
              icon={empty.icon}
              title={empty.title}
              description={empty.description}
            />
          </motion.div>
        ) : (
          shown.map((resolved, index) => {
            const { section, items } = resolved;
            const isExpanded = expanded.has(section.id);
            const canExpand = section.kind === 'list' && section.limit !== undefined && items.length > section.limit;
            return (
              <motion.section
                key={section.id}
                {...sectionMotion(index)}
                aria-label={t(section.titleKey)}
                data-testid={`explore-section-${section.id}`}
                data-kind={section.kind}
              >
                <div className="px-4">
                  <SectionHeader
                    size="xl"
                    className="px-0 pb-3"
                    action={
                      canExpand && (
                        <button
                          type="button"
                          onClick={() => toggle(section.id)}
                          aria-expanded={isExpanded}
                          className="-my-2 py-2 font-heading text-sm font-bold text-accent-tint-ink"
                        >
                          {t(isExpanded ? 'exploreShowLess' : 'exploreSeeAll')}
                        </button>
                      )
                    }
                  >
                    {t(section.titleKey)}
                  </SectionHeader>
                </div>
                <SectionBody resolved={resolved} recents={recents} expanded={isExpanded} onOpen={onOpen} />
              </motion.section>
            );
          })
        )}
      </AnimatePresence>
    </div>
  );
};
