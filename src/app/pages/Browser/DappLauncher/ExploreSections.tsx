/**
 * Renders Explore's catalog sections from config: each section's `kind` picks its layout, and a
 * chip that leaves nothing to show gets a "Coming soon to Miden" state instead, and a search
 * with no match "No results".
 *
 * Every section rises in with the page's staggered reveal (`useExploreMotion().section`). When a
 * chip changes, sections it hides fade out while the rest close the gap with a layout move on the
 * tab bars' spring, and sections it shows rise in without the stagger.
 */

import React, { type FC } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { type IconName } from 'app/icons/v2';
import { EmptyState } from 'components/ui/EmptyState';
import { ListGroup } from 'components/ui/ListGroup';
import { SectionHeader } from 'components/ui/SectionHeader';
import { exploreSectionVariant, useExploreMotion } from 'lib/animation';
import { type RecentDapp, type ResolvedExploreSection } from 'lib/dapp-browser';

import { AppList, AppRow } from './AppRow';
import { FeaturedCard } from './FeaturedCard';
import { TileRow } from './TileRow';

interface SectionBodyProps {
  resolved: ResolvedExploreSection;
  recents: RecentDapp[];
  onOpen: (url: string) => void;
}

const SectionBody: FC<SectionBodyProps> = ({ resolved, recents, onOpen }) => {
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
          <AppList items={items} onOpen={onOpen} />
        </div>
      );
    case 'recents':
      // The dApps opened last, newest first (`getRecentDapps` sorts them), on the rows of the other lists.
      // No second line: the recorded name is usually the dApp's host already.
      if (recents.length === 0) return null;
      return (
        <div className="px-4" data-testid="explore-recents">
          <ListGroup surface="plain">
            {recents.map(dapp => (
              <AppRow
                key={dapp.url}
                url={dapp.url}
                name={dapp.name}
                icon={dapp.favicon}
                onOpen={onOpen}
                testId="recent-dapp-row"
              />
            ))}
          </ListGroup>
        </div>
      );
  }
};

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

  const shown = sections.filter(({ section }) => section.kind !== 'recents' || recents.length > 0);

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
            const { section } = resolved;
            const motionProps = sectionMotion(index);
            return (
              <motion.section
                key={section.id}
                {...motionProps}
                aria-label={t(section.titleKey)}
                data-testid={`explore-section-${section.id}`}
                data-kind={section.kind}
                // The reveal order, rendered so it can be read: `style.opacity` is identical for
                // every revealing section whatever its place in the sequence. It reads the property
                // framer is given rather than recomputing it, so a test of the attribute is a test
                // of the animation input and the two cannot drift.
                data-reveal-index={motionProps.custom}
              >
                <div className="px-4">
                  <SectionHeader size="xl" className="px-0 pb-3">
                    {t(section.titleKey)}
                  </SectionHeader>
                </div>
                <SectionBody resolved={resolved} recents={recents} onOpen={onOpen} />
              </motion.section>
            );
          })
        )}
      </AnimatePresence>
    </div>
  );
};
