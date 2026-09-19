import React from 'react';

import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from 'lib/ui/util';

const headingVariants = cva('min-w-0 truncate', {
  variants: {
    /** `sm`: 13px bold `muted` (default, the spec label). `lg`: 18px Nunito extrabold `ink`, for a
     * page-level section title such as Settings' coloured group headers. */
    size: {
      sm: 'font-sans text-[13px] leading-[17px] font-bold text-muted',
      lg: 'font-heading text-lg font-extrabold text-ink'
    }
  },
  defaultVariants: { size: 'sm' }
});

export interface SectionHeaderProps extends VariantProps<typeof headingVariants> {
  /** The label, in sentence case. */
  children: React.ReactNode;
  /** Heading level; `h2` under a page title. */
  as?: 'h2' | 'h3';
  /** Trailing action beside the label (for example a text button). */
  action?: React.ReactNode;
  /**
   * Leading glyph, drawn `aria-hidden` in a 32px round `bg-fill` circle before the label. The
   * glyph keeps its own colour (an SVG with its own fills) — the circle is decoration only.
   */
  icon?: React.ReactNode;
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

/** The label over a `ListGroup`: 13px bold `muted`, 8px above its group, inset 4px. */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  children,
  as: Heading = 'h2',
  action,
  icon,
  size,
  className,
  'data-testid': dataTestId
}) => (
  <div className={cn('flex items-center justify-between gap-3 px-1 pb-2', className)} data-testid={dataTestId}>
    {icon ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill [&>svg]:h-4 [&>svg]:w-4"
        >
          {icon}
        </span>
        <Heading className={headingVariants({ size })}>{children}</Heading>
      </span>
    ) : (
      <Heading className={headingVariants({ size })}>{children}</Heading>
    )}
    {action && <div className="shrink-0">{action}</div>}
  </div>
);
