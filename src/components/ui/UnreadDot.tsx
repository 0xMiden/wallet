import React from 'react';

import { cva } from 'class-variance-authority';

import { cn } from 'lib/ui/util';

/**
 * Where the dot sits:
 *
 * - `row` — in a row's own left margin, ahead of the leading avatar, so the title column does not
 *   move between a read row and an unread one. Mail's gutter dot.
 * - `badge` — on the top-right corner of an icon, the place a notification badge has on every
 *   platform the wallet ships on.
 */
export type UnreadDotPlacement = 'row' | 'badge';

const dotVariants = cva('pointer-events-none block rounded-full bg-notification', {
  variants: {
    placement: {
      // 8px, vertically centred in the 16px page margin; 4px from the edge leaves 4px to a 40px
      // avatar, which is the gap Mail leaves.
      row: 'absolute left-1 top-1/2 size-2 -translate-y-1/2',
      // Ringed in `page` so the mark stays legible over the glyph it overlaps.
      badge: 'absolute -top-0.5 -right-0.5 size-2 ring-2 ring-page'
    }
  },
  defaultVariants: { placement: 'row' }
});

export interface UnreadDotProps {
  /** Nothing renders when false: the element is gone, not hidden. */
  unread: boolean;
  placement?: UnreadDotPlacement;
  /**
   * What assistive tech hears instead of the colour — "Unread", or "3 unread". Rendered as text
   * inside the dot, so it joins the accessible name of the row, group or tab that contains it.
   * There is no live region: a list that refreshes must not announce anything.
   */
  label: string;
  /** Layout only. */
  className?: string;
  'data-testid'?: string;
}

/**
 * The design system's unread indicator (design-system.md, "Unread indicator"): one red dot, used
 * by the Activity tab's icon, by a group row and by an activity row. Not a per-page dot — the
 * three have to be the same mark, because they mean the same thing.
 *
 * It is never colour alone: the dot carries its own label for assistive tech, so an unread row is
 * announced as unread rather than looking identical to a read one.
 */
export const UnreadDot: React.FC<UnreadDotProps> = ({
  unread,
  placement = 'row',
  label,
  className,
  'data-testid': dataTestId
}) => {
  if (!unread) return null;

  return (
    <span data-testid={dataTestId} data-placement={placement} className={cn(dotVariants({ placement }), className)}>
      <span className="sr-only">{label}</span>
    </span>
  );
};
