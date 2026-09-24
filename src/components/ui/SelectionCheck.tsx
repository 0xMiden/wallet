import React from 'react';

import { ReactComponent as CheckIcon } from 'app/icons/v2/checkmark.svg';
import { cn } from 'lib/ui/util';

/**
 * The round selection check a list row draws when it is the chosen one (ListRow, AssetListItem):
 * 22px on the brand accent. A selected state is one of the things a flow's colour carries
 * (design-system.md, "Action colours"), so an accented row passes its flow's fill as `className`.
 */
export const SelectionCheck: React.FC<{ className?: string }> = ({ className }) => (
  <span
    data-slot="check"
    aria-hidden="true"
    className={cn(
      'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-accent-primary',
      className
    )}
  >
    <CheckIcon className="h-2 w-2.5 fill-pure-white" />
  </span>
);
