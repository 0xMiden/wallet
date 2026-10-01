import * as React from 'react';

import { cn } from 'lib/ui/util';

/**
 * `fill`: the neutral loading tone, for a skeleton sitting on `page`.
 * `inverse`: a translucent fixed white block for a skeleton on a colored surface
 * (e.g. the balance card's own royal-blue background, where `fill` would
 * read as a stray warm-neutral patch rather than a loading block). The fixed
 * white does not flip with theme and stays visible in both light and dark modes.
 */
export type SkeletonTone = 'fill' | 'inverse';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: SkeletonTone;
}

/**
 * A `fill`-toned block shaped like the content it stands in for (caller sets
 * width/height/radius through `className`). Pulses at the same cadence as
 * everywhere else the app shows a skeleton; static under reduced motion
 * rather than slowed — a block has no direction to read as "still moving"
 * the way `Spinner`'s ring does, so there's nothing to preserve by keeping
 * it animating.
 */
export function Skeleton({ className, tone = 'fill', ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        'animate-pulse rounded-md motion-reduce:animate-none',
        tone === 'fill' ? 'bg-fill' : 'bg-pure-white/15',
        className
      )}
      {...props}
    />
  );
}
