import React from 'react';

import { cn } from 'lib/ui/util';

export interface IconCircleProps {
  children: React.ReactNode;
  /** Tone and colour: a tint class replaces the default `fill` disc. */
  className?: string;
}

/** The 32px round `fill` disc holding a 16px glyph: a section header's or a fact's leading icon. */
export const IconCircle: React.FC<IconCircleProps> = ({ children, className }) => (
  <span
    aria-hidden="true"
    data-slot="icon"
    className={cn(
      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill [&>svg]:h-4 [&>svg]:w-4',
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
  description: React.ReactNode;
  /** `li` inside a list, `div` otherwise. */
  as?: 'li' | 'div';
  /** `h3` where the facts are a sheet's sections. */
  titleAs?: 'span' | 'h3';
  'data-testid'?: string;
}

/**
 * One fact in a list of them: the icon circle leading, the title over a `muted` description that
 * wraps (which `ListRow`, a one-line subtitle, cannot do), and the hairline above every row but the
 * first starting after the circle: 32px plus the 12px gap.
 */
export const FactRow: React.FC<FactRowProps> = ({
  leading,
  title,
  description,
  as: Row = 'div',
  titleAs: Title = 'span',
  'data-testid': dataTestId
}) => (
  <Row
    data-slot="fact-row"
    data-testid={dataTestId}
    className="relative flex min-w-0 items-start gap-3 py-3.5 before:absolute before:top-0 before:right-0 before:left-11 before:h-px before:bg-hairline first:before:hidden"
  >
    {leading}
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <Title className="min-w-0 break-words text-row-title text-ink">{title}</Title>
      <p className="break-words text-caption-heading text-muted">{description}</p>
    </div>
  </Row>
);
