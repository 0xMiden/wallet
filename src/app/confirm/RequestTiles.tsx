import React, { FC } from 'react';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Icon, IconName } from 'app/icons/v2';
import { cn } from 'lib/ui/util';

/** Bread ··· the site: the two tiles that open the connect and signature windows. Decorative. */
export const RequestTiles: FC<{ className?: string }> = ({ className }) => (
  <div className={cn('flex items-center gap-2.5', className)} aria-hidden="true">
    <span className="flex size-16 items-center justify-center rounded-xl bg-fill">
      <BreadLogo style={{ width: 30, height: 'auto' }} />
    </span>
    <span className="flex gap-1">
      <span className="size-1 rounded-full bg-muted opacity-60" />
      <span className="size-1 rounded-full bg-muted opacity-60" />
      <span className="size-1 rounded-full bg-muted opacity-60" />
    </span>
    <span className="flex size-16 items-center justify-center rounded-xl bg-fill text-ink">
      <Icon name={IconName.Globe} fill="currentColor" size="lg" />
    </span>
  </div>
);
