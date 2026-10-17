import React from 'react';

import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';
import { Icon, IconName } from 'app/icons/v2';
import { Pill } from 'components/ui/Pill';
import { cn } from 'lib/ui/util';

import { networkLogo } from './network-logo';

export type NetworkChipKind = 'miden' | 'ethereum';

export interface NetworkChipProps {
  kind: NetworkChipKind;
  /** Canonical bridge network slug, shared with the network selector. */
  network?: string;
  /** Already-translated network name, e.g. "Miden" or "Sepolia". */
  label: string;
  /** Selectable chips take a click handler and render as a button. */
  onClick?: () => void;
  selected?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** One network identity, scaled for a summary tag or the 40px leading slot of a choice row. */
export const NetworkLogo: React.FC<{ kind: NetworkChipKind; network?: string; size?: 'sm' | 'md' }> = ({
  kind,
  network,
  size = 'sm'
}) => {
  const logo = networkLogo(network);
  const sizing = size === 'md' ? 'h-8 w-8' : 'h-4 w-4';
  if (kind === 'miden')
    return (
      <MidenLogo
        data-testid="miden-logo"
        aria-hidden="true"
        className={size === 'md' ? 'h-6 w-auto' : 'h-3.5 w-auto'}
      />
    );
  if (logo) return <img src={logo} alt="" aria-hidden="true" className={cn('shrink-0 object-contain', sizing)} />;
  // Unknown networks must not inherit Ethereum's identity. Sepolia uses Ethereum's own mark.
  if (network && !['ethereum', 'mainnet', 'sepolia'].includes(network)) {
    return <Icon name={IconName.Globe} size={size === 'md' ? 'lg' : 'xs'} className="text-muted" aria-hidden="true" />;
  }
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-full bg-network-ethereum-tint', sizing)}
      aria-hidden="true"
    >
      <EthLogo className={cn('[&>path]:fill-network-ethereum-text', size === 'md' ? 'h-6 w-6' : 'h-3 w-3')} />
    </span>
  );
};

/** A quiet network tag on the same neutral surface and soft corners as wallet fields. */
export const NetworkChip: React.FC<NetworkChipProps> = ({
  kind,
  network,
  label,
  onClick,
  selected = false,
  className,
  'data-testid': dataTestId
}) => {
  return (
    <Pill
      icon={<NetworkLogo kind={kind} network={network} />}
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
