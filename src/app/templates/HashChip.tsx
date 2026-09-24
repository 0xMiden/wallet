import React, { FC } from 'react';

import HashShortView from 'app/atoms/HashShortView';
import { CopyChip } from 'components/ui/CopyChip';
import { cn } from 'lib/ui/util';

export interface HashChipProps {
  hash: string;
  trimHash?: boolean;
  trimAfter?: number;
  firstCharsCount?: number;
  lastCharsCount?: number;
  displayName?: string;
  className?: string;
  'data-testid'?: string;
}

// `min-w-0` lets the chip shrink inside a flex row that constrains its width (every call site:
// history's DetailRow value column, or ExternalLinkValue's row) so Pill's own `truncate` can
// actually ellipsis a long value instead of forcing the row wider. Without it a flex item defaults
// to its content's natural width and overflows.
const DEFAULT_CLASS_NAME = 'min-w-0 text-ink font-sans text-sm font-normal';

/**
 * A copyable, trimmed hash: the Pill-with-copy (`CopyChip`) built around a `HashShortView`.
 * `className` is merged after the neutral default via `cn`, so a caller's own color/weight/size
 * (e.g. SwapDetail's muted note-id chips) still wins.
 *
 * No `aria-label`: the trimmed hash IS the chip's accessible name (an `aria-label` would replace
 * it, so a screen reader would hear "Copy to clipboard, button" instead of the value), and
 * `CopyChip`'s own `aria-live` region already announces "Copied" on tap — a label wired to the
 * copied state would announce it a second time.
 */
const HashChip: FC<HashChipProps> = ({
  hash,
  trimHash,
  trimAfter,
  firstCharsCount,
  lastCharsCount,
  displayName,
  className,
  'data-testid': dataTestId
}) => (
  <CopyChip text={hash} className={cn(DEFAULT_CLASS_NAME, className)} data-testid={dataTestId}>
    <HashShortView
      hash={hash}
      trimHash={trimHash}
      trimAfter={trimAfter}
      firstCharsCount={firstCharsCount}
      lastCharsCount={lastCharsCount}
      displayName={displayName}
    />
  </CopyChip>
);

export default HashChip;
