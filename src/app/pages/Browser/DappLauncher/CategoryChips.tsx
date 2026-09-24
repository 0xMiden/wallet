/**
 * Explore's category chips: a single-select, horizontally scrolling row of pills — the design
 * system's `SegmentedControl` in its `pills` appearance, the same control Activity's filters use, so
 * the two rows move, sound and read alike.
 */

import React, { type FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { SegmentedControl, type SegmentedControlItem } from 'components/ui';
import { type ExploreFilter, type ExploreFilterDescriptor } from 'lib/dapp-browser';

export interface CategoryChipsProps {
  filters: ExploreFilterDescriptor[];
  value: ExploreFilter;
  onChange: (value: ExploreFilter) => void;
}

export const CategoryChips: FC<CategoryChipsProps> = ({ filters, value, onChange }) => {
  const { t } = useTranslation();

  const items = useMemo<SegmentedControlItem<ExploreFilter>[]>(
    () =>
      filters.map(filter => ({ id: filter.id, label: t(filter.labelKey), 'data-testid': `explore-chip-${filter.id}` })),
    [filters, t]
  );

  return (
    <SegmentedControl
      items={items}
      value={value}
      onChange={onChange}
      appearance="pills"
      aria-label={t('exploreCategoriesLabel')}
      data-testid="explore-category-chips"
      className="shrink-0 px-4 py-4"
    />
  );
};
