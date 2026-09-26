import React from 'react';

import { cn } from 'lib/ui/util';

import { outlineSurfaceClassName } from './surfaces';

export interface ListGroupProps {
  /** `ListRow`s, as direct children: each draws the hairline above itself. */
  children: React.ReactNode;
  /**
   * Which of the three list surfaces this group takes (design-system.md, "Surfaces"):
   *
   * - `plain` — no surface. The rows sit flush on the page margin, divided by full-width
   *   hairlines, under a `SectionHeader` in the Settings-root treatment. For a page whose body IS
   *   the list: Settings and its sub-pages, the Address Book, Explore's app lists.
   * - `fill` (default) — a 16px-radius `fill` surface, for a group embedded in a page or a sheet
   *   that has to read as one block: the Receive actions, a sheet's choices, a small group beside
   *   other content.
   * - `outline` — a hairline edge on `page`, for a card that has to separate itself where it
   *   sits: Activity's rows, pending transfers, Earn's cards, the home prompt card.
   */
  surface?: 'fill' | 'plain' | 'outline';
  /** `ul` for a list whose rows are `li`s; it carries `role="list"`, which WebKit drops from a marker-less `ul`. */
  as?: 'div' | 'ul';
  /**
   * `plain` only: each row keeps its own hairline inset instead of running the full width, read from
   * the row's `--row-flush-inset` (its leading visual plus gap: `CheckboxRow`, `FactRow`). A row that
   * declares none still runs full width.
   */
  insetHairlines?: boolean;
  /** Layout only (margins, width). */
  className?: string;
  'aria-label'?: string;
  /** A decorative stand-in (a loading placeholder) that assistive tech should skip. */
  'aria-hidden'?: boolean;
  'data-testid'?: string;
}

/**
 * A group of list rows. The rows draw the hairlines between them, inset past their own leading
 * visual, so the group itself is only the surface — which `surface` picks: `plain` for a page that
 * is a list, `fill` for a group embedded in a page or sheet, `outline` for a card that has to
 * separate itself.
 */
export const ListGroup: React.FC<ListGroupProps> = ({
  children,
  surface = 'fill',
  as: Group = 'div',
  insetHairlines = false,
  className,
  'aria-label': ariaLabel,
  'aria-hidden': ariaHidden,
  'data-testid': dataTestId
}) => (
  <Group
    className={cn(
      'flex flex-col overflow-hidden',
      surface === 'fill' && 'rounded-2xl bg-fill',
      // A hairline edge on `page` instead of the fill.
      surface === 'outline' && ['rounded-2xl', outlineSurfaceClassName],
      // No surface to inset from: the rows' content sits on the page margin and their hairlines
      // run the full width, so a plain group lines up with the page's other content.
      surface === 'plain' &&
        (insetHairlines
          ? '[&>*]:px-0 [&>*]:before:left-[var(--row-flush-inset,0px)]'
          : '[&>*]:px-0 [&>*]:before:left-0'),
      className
    )}
    role={Group === 'ul' ? 'list' : undefined}
    aria-label={ariaLabel}
    aria-hidden={ariaHidden || undefined}
    data-testid={dataTestId}
  >
    {children}
  </Group>
);
