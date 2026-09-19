/**
 * Explore's category chips: a single-select, horizontally scrolling row on a `fill` track, with the
 * tab bars' raised bubble sliding to the chosen chip on the same spring, the same press dip, and a
 * selection haptic when the choice changes.
 *
 * Built on the shared `Highlight` primitive the way the bottom nav is. Swap it for the design
 * system's `SegmentedControl` once that lands (brian/ds-segmented-control).
 */

import React, { type FC } from 'react';

import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Highlight, HighlightItem } from 'components/ui/animate/highlight';
import { useTabBarMotion } from 'lib/animation';
import { type ExploreFilter, type ExploreFilterDescriptor } from 'lib/dapp-browser';
import { hapticSelection } from 'lib/mobile/haptics';
import { cn } from 'lib/ui/util';

export interface CategoryChipsProps {
  filters: ExploreFilterDescriptor[];
  value: ExploreFilter;
  onChange: (value: ExploreFilter) => void;
}

export const CategoryChips: FC<CategoryChipsProps> = ({ filters, value, onChange }) => {
  const { t } = useTranslation();
  const motionTokens = useTabBarMotion();

  const select = (id: ExploreFilter) => {
    if (id === value) return;
    hapticSelection();
    onChange(id);
  };

  return (
    // `layoutScroll`, so the bubble's shared-layout move measures chips correctly after a scroll.
    <motion.div layoutScroll className="no-scrollbar overflow-x-auto px-4">
      <div
        role="group"
        aria-label={t('exploreCategoriesLabel')}
        data-testid="explore-category-chips"
        className="inline-flex items-center gap-0.5 rounded-full bg-fill p-1"
      >
        <Highlight
          controlledItems
          value={value}
          click={false}
          exitDelay={0}
          transition={motionTokens.highlight}
          className="inset-0 rounded-full bg-raised shadow-raised transition-shadow group-active:shadow-raised-pressed"
        >
          {filters.map(filter => {
            const active = filter.id === value;
            return (
              <HighlightItem key={filter.id} value={filter.id} asChild as="span" className="flex">
                <motion.button
                  type="button"
                  aria-pressed={active}
                  data-testid={`explore-chip-${filter.id}`}
                  onClick={() => select(filter.id)}
                  {...motionTokens.press}
                  transition={motionTokens.highlight}
                  className={cn(
                    'group relative flex h-8 items-center rounded-full px-3.5 whitespace-nowrap',
                    'text-pill transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/30',
                    active ? 'text-ink' : 'text-muted'
                  )}
                >
                  <span className="relative">{t(filter.labelKey)}</span>
                </motion.button>
              </HighlightItem>
            );
          })}
        </Highlight>
      </div>
    </motion.div>
  );
};
