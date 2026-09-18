import React from 'react';

import { cn } from 'lib/ui/util';

export interface SectionHeaderProps {
  /** The label, in sentence case. */
  children: React.ReactNode;
  /** Heading level; `h2` under a page title. */
  as?: 'h2' | 'h3';
  /** Trailing action beside the label (for example a text button). */
  action?: React.ReactNode;
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

/** The label over a `ListGroup`: 13px bold `muted`, 8px above its group, inset 4px. */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  children,
  as: Heading = 'h2',
  action,
  className,
  'data-testid': dataTestId
}) => (
  <div className={cn('flex items-center justify-between gap-3 px-1 pb-2', className)} data-testid={dataTestId}>
    <Heading className="min-w-0 truncate font-sans text-[13px] leading-[17px] font-bold text-muted">{children}</Heading>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);
