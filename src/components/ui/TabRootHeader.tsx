import React, { ReactNode } from 'react';

import { SegmentedControl, type SegmentedControlItem } from './SegmentedControl';
import { TabHeader, type TabHeaderProps } from './TabHeader';

/**
 * The filter row a tab root may carry under its rule: the items and the selection only. Size,
 * layout, look and padding are the header's, not the page's — three tab roots each styling their
 * own row is what this component exists to end.
 */
export interface TabRootFilter<T extends string = string> {
  items: readonly SegmentedControlItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Already-translated accessible name for the row. */
  'aria-label': string;
  'data-testid'?: string;
}

export interface TabRootHeaderProps<T extends string = string> {
  title: string;
  /** Icon actions on the right of the title, e.g. a `TabHeaderAction` search toggle. */
  actions?: ReactNode;
  /** In-header search: while open the field takes the title's place in the same row. */
  search?: TabHeaderProps['search'];
  /** The filter row under the title. Omitted on a tab root that does not filter (Settings). */
  filter?: TabRootFilter<T>;
}

/**
 * The top of every tab root — Activity, Explore, Settings — in one piece: the 56px title row, the
 * 4px rule under it, and, directly under that, the filter row.
 *
 * Two numbers are the point of this component. The title row plus the rule is 60px, which is what
 * Home's `SegmentedActionBar` occupies, so switching tabs never moves the content line. And the
 * filter row is 52px of its own, tight under the rule, instead of the 72px of padding each page
 * used to choose for itself.
 *
 * The rule is rendered HERE, not by `TabHeader`, because a divider each page draws for itself is
 * how three tab roots ended up with three of them.
 */
export function TabRootHeader<T extends string = string>({ title, actions, search, filter }: TabRootHeaderProps<T>) {
  return (
    <>
      <TabHeader title={title} actions={actions} search={search} />
      {/* Ahmad's rule: 4px on `fill`, inset to the page margin, the full width of the content
          under it. Flush against both rows — the 60px budget leaves it no padding to spend. */}
      <div aria-hidden="true" className="mx-4 h-1 shrink-0 rounded-full bg-fill" />
      {filter && (
        <SegmentedControl
          items={filter.items}
          value={filter.value}
          onChange={filter.onChange}
          aria-label={filter['aria-label']}
          data-testid={filter['data-testid']}
          // 6px above and below the 40px items: room for the raised bubble's shadow and the focus
          // ring, and nothing more.
          className="shrink-0 px-4 py-1.5"
        />
      )}
    </>
  );
}

export default TabRootHeader;
