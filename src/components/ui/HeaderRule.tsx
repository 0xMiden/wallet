import React from 'react';

import { cn } from 'lib/ui/util';

/**
 * The 4px rounded rule on `fill` that ends a page header: under a tab root's title (TabRootHeader,
 * inset with `mx-4`) and under a pushed page's row (PageHeader, inset by the caller's margin).
 */
export const HeaderRule: React.FC<{ className?: string }> = ({ className }) => (
  <div aria-hidden="true" className={cn('h-1 shrink-0 rounded-full bg-fill', className)} />
);
