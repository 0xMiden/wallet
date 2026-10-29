/**
 * The horizontal row that holds a section's cards side by side, such as several featured apps.
 */

import React, { type FC } from 'react';

export interface TileRowProps {
  children: React.ReactNode;
  /** Called with the row as it scrolls. */
  onScroll?: (row: HTMLDivElement) => void;
}

/** A horizontally scrolling row of cards, bleeding to the screen edge past the 16px gutter. */
export const TileRow: FC<TileRowProps> = ({ children, onScroll }) => (
  <div
    className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1"
    onScroll={onScroll && (event => onScroll(event.currentTarget))}
  >
    {children}
  </div>
);
