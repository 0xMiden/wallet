import React from 'react';

import { cn } from 'lib/ui/util';

export interface ListGroupProps {
  /** `ListRow`s, as direct children: each draws the hairline above itself. */
  children: React.ReactNode;
  /**
   * `fill` (default): the group is a 16px-radius `fill` surface. `outline`: the same shape as a
   * hairline edge on `page`. `plain`: no surface — the rows sit
   * flush on the page margin, divided by full-width hairlines (Settings' groups, under their
   * coloured headers).
   */
  surface?: 'fill' | 'plain' | 'outline';
  /** Layout only (margins, width). */
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

/**
 * A group of list rows on the shared `fill`, with 16px corners. The rows draw the hairlines between
 * them, inset past their own leading visual, so the group itself is only the surface.
 */
export const ListGroup: React.FC<ListGroupProps> = ({
  children,
  surface = 'fill',
  className,
  'aria-label': ariaLabel,
  'data-testid': dataTestId
}) => (
  <div
    className={cn(
      'flex flex-col overflow-hidden',
      surface === 'fill' && 'rounded-2xl bg-fill',
      // A hairline edge on `page` instead of the fill.
      surface === 'outline' && 'rounded-2xl border border-hairline bg-page',
      // No surface to inset from: the rows' content sits on the page margin and their hairlines
      // run the full width, so a plain group lines up with the page's other content.
      surface === 'plain' && '[&>*]:px-0 [&>*]:before:left-0',
      className
    )}
    aria-label={ariaLabel}
    data-testid={dataTestId}
  >
    {children}
  </div>
);
