import React from 'react';

import clsx from 'clsx';

import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { ReactComponent as MidenLogo } from 'app/icons/logos/miden.svg';

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

const NetworkLogo: React.FC<{ kind: NetworkChipKind }> = ({ kind }) =>
  kind === 'miden' ? (
    // The brand mark from miden.xyz: the orange glyph, no circle behind it.
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
      <MidenLogo data-testid="miden-logo" className="h-3.5 w-auto" />
    </span>
  ) : (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#627EEA]" aria-hidden="true">
      <EthLogo className="h-2.5 w-2.5" />
    </span>
  );

/**
 * A network, shown as its logo and name on a quiet grey chip. Replaces the solid
 * orange network pills, which competed with the primary button for attention.
 * A selected chip picks up the Send accent on its border and tint.
 */
export const NetworkChip: React.FC<NetworkChipProps> = ({
  kind,
  label,
  onClick,
  selected = false,
  className,
  'data-testid': dataTestId
}) => {
  const classes = clsx(
    'inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5',
    'font-heading text-sm font-bold leading-none text-heading-gray',
    selected ? 'border-accent-send bg-accent-send-tint' : 'border-border-subtle bg-surface-interactive',
    className
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={selected} data-testid={dataTestId} className={classes}>
        <NetworkLogo kind={kind} />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <span data-testid={dataTestId} className={classes}>
      <NetworkLogo kind={kind} />
      <span>{label}</span>
    </span>
  );
};
