import React from 'react';

import { cn } from 'lib/ui/util';

export interface ListGroupProps {
  /** `ListRow`s, as direct children: each draws the hairline above itself. */
  children: React.ReactNode;
  /**
   * `fill` (default): the group is a 16px-radius `fill` surface. `plain`: no surface — the rows sit
   * on the page, still divided by their hairlines (Settings' groups, under their coloured headers).
   */
  surface?: 'fill' | 'plain';
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
    className={cn('flex flex-col overflow-hidden', surface === 'fill' && 'rounded-2xl bg-fill', className)}
    aria-label={ariaLabel}
    data-testid={dataTestId}
  >
    {children}
  </div>
);
