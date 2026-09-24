import React from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkChip } from 'components/NetworkChip';
import { AddressChain } from 'utils/miden';

import { BRIDGE_NETWORKS, BridgeNetworkId } from './bridge-networks';

export interface NetworkFieldProps {
  /** The address's chain family: a Miden address carries its network, a `0x` address does not. */
  chain: AddressChain;
  /** The chosen destination network for a `0x` address. */
  network?: BridgeNetworkId;
  onSelect: (network: BridgeNetworkId) => void;
  /** Test id prefix: `<prefix>-network-options` and `<prefix>-network-<id>`. */
  testIdPrefix: string;
}

/**
 * The "Network" row under an address. A Miden address shows Miden. A `0x` address offers the
 * bridge networks as chips to pick from; while there is only one, it is shown as a fact rather
 * than as a lone chip that looks selectable but has no alternative (the caller selects it).
 */
export const NetworkField: React.FC<NetworkFieldProps> = ({ chain, network, onSelect, testIdPrefix }) => {
  const { t } = useTranslation();
  const choosable = BRIDGE_NETWORKS.length > 1;

  return (
    <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-network-options`}>
      <span className="text-sm text-text-muted">{t('network')}</span>
      <div className="flex flex-wrap gap-2">
        {chain === 'miden' ? (
          <NetworkChip kind="miden" label={t('miden')} data-testid={`${testIdPrefix}-network-miden`} />
        ) : (
          BRIDGE_NETWORKS.map(option => (
            <NetworkChip
              key={option.id}
              kind="ethereum"
              label={option.name}
              selected={choosable && network === option.id}
              onClick={choosable ? () => onSelect(option.id) : undefined}
              data-testid={`${testIdPrefix}-network-${option.id}`}
            />
          ))
        )}
      </div>
    </div>
  );
};
