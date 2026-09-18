import React from 'react';

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

/**
 * A network, as its logo and name on the app's shared Pill: a quiet grey chip that picks up the
 * Send accent when selected.
 */
export const NetworkChip: React.FC<NetworkChipProps> = ({
  kind,
  label,
  onClick,
  selected = false,
  className,
  'data-testid': dataTestId
}) => (
  <Pill
    icon={<NetworkLogo kind={kind} />}
    tone={selected ? 'selected' : 'neutral'}
    accent="send"
    onClick={onClick}
    selected={onClick ? selected : undefined}
    className={className}
    data-testid={dataTestId}
  >
    {label}
  </Pill>
);
