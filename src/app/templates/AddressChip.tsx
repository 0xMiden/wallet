import React, { FC } from 'react';

import AddressShortView from 'app/atoms/AddressShortView';
import { CopyChip } from 'components/ui/CopyChip';
import { cn } from 'lib/ui/util';

export interface AddressChipProps {
  address: string;
  displayName?: string;
  trim?: boolean;
  className?: string;
  'data-testid'?: string;
}

// `min-w-0` lets the chip shrink inside a flex row that constrains its width (every call site:
// history's DetailRow value column, or ExternalLinkValue's row) so Pill's own `truncate` can
// actually ellipsis a long value — e.g. a "You (account name)" display name — instead of forcing
// the row wider. Without it a flex item defaults to its content's natural width and overflows.
const DEFAULT_CLASS_NAME = 'min-w-0 text-muted font-sans text-xs font-medium leading-none';

/**
 * A copyable, trimmed address: the Pill-with-copy (`CopyChip`) built around an
 * `AddressShortView`. `className` is merged after the neutral default via `cn`, so a caller's own
 * color/weight/size still wins.
 *
 * No `aria-label`: the trimmed address/name IS the chip's accessible name (an `aria-label` would
 * replace it, so a screen reader would hear "Copy to clipboard, button" instead of the value),
 * and `CopyChip`'s own `aria-live` region already announces "Copied" on tap — a label wired to
 * the copied state would announce it a second time.
 */
const AddressChip: FC<AddressChipProps> = ({ address, displayName, trim, className, 'data-testid': dataTestId }) => (
  <CopyChip text={address} className={cn(DEFAULT_CLASS_NAME, className)} data-testid={dataTestId}>
    <AddressShortView address={address} displayName={displayName} trim={trim} />
  </CopyChip>
);

export default AddressChip;
