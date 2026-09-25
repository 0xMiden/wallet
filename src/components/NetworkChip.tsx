import React from 'react';

import clsx from 'clsx';

import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';
import { Pill } from 'components/ui';

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
    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#627EEA]" aria-hidden="true">
      <EthLogo className="h-2.5 w-2.5" />
    </span>
  );

// Literal class strings, so Tailwind generates them. A selected chip deepens its border to the
// network's text color, so selection never changes its size.
const NETWORK_CLASSES: Record<NetworkChipKind, { base: string; border: string; selectedBorder: string }> = {
  miden: {
    base: 'bg-network-miden-tint text-network-miden-text',
    border: 'border-network-miden-border',
    selectedBorder: 'border-network-miden-text'
  },
  ethereum: {
    base: 'bg-network-ethereum-tint text-network-ethereum-text',
    border: 'border-network-ethereum-border',
    selectedBorder: 'border-network-ethereum-text'
  }
};

/**
 * A network, as its logo and name on the app's shared Pill, tinted in that network's own soft
 * color from Bread's warm palette. The logo keeps its original colors.
 */
export const NetworkChip: React.FC<NetworkChipProps> = ({
  kind,
  label,
  onClick,
  selected = false,
  className,
  'data-testid': dataTestId
}) => {
  const styles = NETWORK_CLASSES[kind];

  return (
    <Pill
      icon={<NetworkLogo kind={kind} />}
      tone="plain"
      onClick={onClick}
      selected={onClick ? selected : undefined}
      className={clsx(styles.base, selected ? styles.selectedBorder : styles.border, className)}
      data-testid={dataTestId}
    >
      {label}
    </Pill>
  );
};
