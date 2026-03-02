import * as React from 'react';

import { cn } from './util';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('bg-muted rounded-md animate-pulse', className)} {...props} />;
}

export { Skeleton };
