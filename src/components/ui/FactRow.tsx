import React from 'react';

import { cn } from 'lib/ui/util';

export interface IconCircleProps {
  children: React.ReactNode;
  /** `md` (default) the 32px disc with a 16px glyph; `sm` a 20px disc whose glyph keeps its own size. */
  size?: 'md' | 'sm';
  /** Tone and colour: a tint class replaces the default `fill` disc. */
  className?: string;
}

/** The round `fill` disc holding a leading glyph: a section header's, a fact's or a checklist item's. */
export const IconCircle: React.FC<IconCircleProps> = ({ children, size = 'md', className }) => (
  <span
    aria-hidden="true"
    data-slot="icon"
    className={cn(
      'flex shrink-0 items-center justify-center rounded-full bg-fill',
      size === 'md' ? 'h-8 w-8 [&>svg]:h-4 [&>svg]:w-4' : 'size-5',
      className
    )}
  >
    {children}
  </span>
);

export interface FactRowProps {
  /** An `IconCircle`. */
  leading: React.ReactNode;
  title: React.ReactNode;
  /** Required by `fact`; an `item` has none. */
  description?: React.ReactNode;
  /** `fact` (default): title over a wrapping description after a 32px circle. `item`: one line after a 20px circle. */
  variant?: 'fact' | 'item';
  /** `li` inside a list, `div` otherwise. */
  as?: 'li' | 'div';
  /** `h3` where the facts are a sheet's sections. */
  titleAs?: 'span' | 'h3';
  'data-testid'?: string;
}

const ROW_VARIANT = {
  // The hairline starts after the circle (32px plus the 12px gap); the same inset is declared for an
  // inset plain `ListGroup`.
  fact: 'items-start gap-3 py-3.5 before:left-11 [--row-flush-inset:44px]',
  // 20px circle plus the 10px gap.
  item: 'items-center gap-2.5 py-2.5 before:left-7.5 [--row-flush-inset:30px]'
} as const;

/**
 * One fact in a list of them: the icon circle leading, the title over a `muted` description that
 * wraps (which `ListRow`, a one-line subtitle, cannot do), and the hairline above every row but the
 * first starting after the circle. The `item` variant is a one-line checklist entry.
 */
export const FactRow: React.FC<FactRowProps> = ({
  leading,
  title,
  description,
  variant = 'fact',
  as: Row = 'div',
  titleAs: Title = 'span',
  'data-testid': dataTestId
}) => (
  <Row
    data-slot="fact-row"
    data-testid={dataTestId}
    className={cn(
      'relative flex min-w-0 before:absolute before:top-0 before:right-0 before:h-px before:bg-hairline first:before:hidden',
      ROW_VARIANT[variant]
    )}
  >
    {leading}
    {variant === 'item' ? (
      <Title className="min-w-0 break-words text-value text-ink">{title}</Title>
    ) : (
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Title className="min-w-0 break-words text-row-title text-ink">{title}</Title>
        <p className="break-words text-caption-heading text-muted">{description}</p>
      </div>
    )}
  </Row>
);
