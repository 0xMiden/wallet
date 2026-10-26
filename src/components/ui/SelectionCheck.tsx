import React from 'react';

import { ReactComponent as CheckIcon } from 'app/icons/v2/checkmark.svg';
import { ACCENT_CLASSES, type FlowAccent } from 'components/flow/accent';
import { cn } from 'lib/ui/util';

/**
 * The round selection check a list row draws when it is the chosen one (ListRow, AssetListItem):
 * 22px on the brand accent. A selected state is one of the things a flow's colour carries
 * (design-system.md, "Action colours"), so an accented row passes its flow as `accent`, which sets
 * both the fill and the check's on-colour ink.
 */
export const SelectionCheck: React.FC<{ accent?: FlowAccent }> = ({ accent }) => (
  <span
    data-slot="check"
    aria-hidden="true"
    className={cn(
      'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-accent-primary',
      accent && ACCENT_CLASSES[accent].bg
    )}
  >
    <CheckIcon className={cn('h-2 w-2.5', ACCENT_CLASSES[accent ?? 'brand'].onFill)} />
  </span>
);
