import React, { ReactNode } from 'react';

import { SegmentedControl, type SegmentedControlItem } from './SegmentedControl';
import { TabHeader, type TabHeaderProps } from './TabHeader';

/**
 * The filter row a tab root may carry under its title: the items and the selection only. Size,
 * layout, appearance and padding are the header's, not the page's — three tab roots each styling
 * their own row is what this component exists to end.
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
 * The top of every tab root — Activity, Explore, Settings — in one piece: the 60px title row, the
 * hairline that closes it, and, directly under that, the filter row.
 *
 * Two numbers are the point of this component. The title row plus its hairline is 61px, which is
 * exactly what Home's `SegmentedActionBar` occupies, so switching tabs never moves the content
 * line. And the filter row is 52px of its own, tight under the hairline, instead of the 72px of
 * padding each page used to choose for itself.
 *
 * The filter row is the segmented control in its default appearance: the raised white pill sliding
 * on the tab-bar spring. It is not configurable, deliberately — a solid `accent` pill puts white
 * on the brand orange at 3.0:1, which the spec allows only at 19px bold.
 */
export function TabRootHeader<T extends string = string>({ title, actions, search, filter }: TabRootHeaderProps<T>) {
  return (
    <>
      <TabHeader title={title} actions={actions} search={search} />
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
