import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkLogo } from 'components/NetworkChip';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SectionHeader } from 'components/ui/SectionHeader';
import type { NearIntentsAddressKind } from 'lib/one-click/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, useIsInDrawer } from 'lib/ui/drawer';
import { AddressChain } from 'utils/miden';

import { BRIDGE_NETWORKS, BridgeNetwork, BridgeNetworkId } from './bridge-networks';
import { sendNetworkKind } from './send-network-kind';

/** A destination network the field can offer. A network with no `kind` is an EVM network. */
export type NetworkOption = Pick<BridgeNetwork, 'id' | 'name'> & { kind?: NearIntentsAddressKind };

export interface NetworkFieldProps {
  /** The networks to offer. The field shows only the ones whose kind matches the address chain. */
  networks?: readonly NetworkOption[];
  chain: AddressChain;
  network?: BridgeNetworkId;
  onSelect: (network: BridgeNetworkId) => void;
  testIdPrefix: string;
}

/**
 * A destination summary opens a full-name network list. Only an EVM address can choose: a Solana, Bitcoin or NEAR
 * address has one network. The shared sheet owns focus and mobile back.
 */
export const NetworkField: React.FC<NetworkFieldProps> = ({ chain, network, onSelect, testIdPrefix, networks }) => {
  const { t } = useTranslation();
  const nested = useIsInDrawer();
  const [open, setOpen] = useState(false);
  const kind = sendNetworkKind(chain);
  const offered: readonly NetworkOption[] = networks ?? BRIDGE_NETWORKS;
  const options = kind === undefined ? [] : offered.filter(option => (option.kind ?? 'evm') === kind);
  const choosable = kind === 'evm' && options.length > 1;
  const selected = options.find(option => option.id === network);
  const single = options.length === 1 ? options[0] : undefined;
  const destination = selected ?? single;

  return (
    <div data-testid={`${testIdPrefix}-network-options`}>
      <SectionHeader>{t('network')}</SectionHeader>
      <ListGroup surface="outline">
        <ListRow
          title={kind === undefined ? t('miden') : (destination?.name ?? t('selectNetwork'))}
          avatar={<NetworkLogo kind={kind === undefined ? 'miden' : 'ethereum'} network={destination?.id} size="md" />}
          onClick={choosable ? () => setOpen(true) : undefined}
          chevron={choosable}
          accent="send"
          data-testid={
            choosable
              ? `${testIdPrefix}-network-picker`
              : `${testIdPrefix}-network-${kind === undefined ? 'miden' : destination?.id}`
          }
        />
      </ListGroup>
      <Drawer
        nested={nested}
        open={open && choosable}
        onOpenChange={setOpen}
        screenKey={`${testIdPrefix}-destination-network`}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('selectNetwork')}</DrawerTitle>
          </DrawerHeader>
          <div className="min-h-0 overflow-y-auto">
            <ListGroup className="mx-4 mb-6">
              {options.map(option => (
                <ListRow
                  variant="choice"
                  key={option.id}
                  title={option.name}
                  avatar={<NetworkLogo kind="ethereum" network={option.id} size="md" />}
                  checked={network === option.id}
                  accent="send"
                  onClick={() => {
                    onSelect(option.id);
                    setOpen(false);
                  }}
                  data-testid={`${testIdPrefix}-network-${option.id}`}
                />
              ))}
            </ListGroup>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
};
