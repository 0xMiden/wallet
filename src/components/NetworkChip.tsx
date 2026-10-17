import React from 'react';

import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';
import { Pill } from 'components/ui';
import { cn } from 'lib/ui/util';

export type NetworkChipKind = 'miden' | 'ethereum';

export interface NetworkChipProps {
  kind: NetworkChipKind;
  /** Already-translated network name, e.g. "Miden" or "Sepolia". */
  label: string;
  /** Selectable chips take a click handler and render as a button. */
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** The network's mark, sized for a pill or a badge. */
export const NetworkLogo: React.FC<{ kind: NetworkChipKind }> = ({ kind }) =>
  kind === 'miden' ? (
    // The brand mark from miden.xyz: the orange glyph, no circle behind it.
    <MidenLogo data-testid="miden-logo" aria-hidden="true" className="h-3.5 w-auto" />
  ) : (
    <span className="flex h-4 w-4 items-center justify-center rounded-xl bg-network-ethereum-tint" aria-hidden="true">
      <EthLogo className="h-3 w-3 [&>path]:fill-network-ethereum-text" />
    </span>
  );

/** A quiet network tag on the same neutral surface and soft corners as wallet fields. */
export const NetworkChip: React.FC<NetworkChipProps> = ({
  kind,
  label,
  onClick,
  selected = false,
  className,
  'data-testid': dataTestId
}) => {
  return (
    <Pill
      icon={<NetworkLogo kind={kind} />}
      tone={selected ? 'inactive' : 'neutral'}
      shape="rounded"
      onClick={onClick}
      selected={onClick ? selected : undefined}
      className={cn(
        onClick && 'min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink',
        className
      )}
      data-testid={dataTestId}
    >
      {label}
    </Pill>
  );
};
