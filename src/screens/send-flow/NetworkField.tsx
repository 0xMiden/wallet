import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkLogo } from 'components/NetworkChip';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SectionHeader } from 'components/ui/SectionHeader';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, useIsInDrawer } from 'lib/ui/drawer';
import { AddressChain } from 'utils/miden';

import { BRIDGE_NETWORKS, BridgeNetwork, BridgeNetworkId } from './bridge-networks';

export interface NetworkFieldProps {
  networks?: readonly BridgeNetwork[];
  chain: AddressChain;
  network?: BridgeNetworkId;
  onSelect: (network: BridgeNetworkId) => void;
  testIdPrefix: string;
}

/** A destination summary opens a full-name network list. The shared sheet owns focus and mobile back. */
export const NetworkField: React.FC<NetworkFieldProps> = ({
  chain,
  network,
  onSelect,
  testIdPrefix,
  networks = BRIDGE_NETWORKS
}) => {
  const { t } = useTranslation();
  const nested = useIsInDrawer();
  const [open, setOpen] = useState(false);
  const choosable = chain !== 'miden' && networks.length > 1;
  const selected = networks.find(option => option.id === network);
  const single = networks.length === 1 ? networks[0] : undefined;
  const destination = selected ?? single;

  return (
    <div data-testid={`${testIdPrefix}-network-options`}>
      <SectionHeader>{t('network')}</SectionHeader>
      <ListGroup surface="outline">
        <ListRow
          title={chain === 'miden' ? t('miden') : (destination?.name ?? t('selectNetwork'))}
          avatar={<NetworkLogo kind={chain === 'miden' ? 'miden' : 'ethereum'} network={destination?.id} size="md" />}
          onClick={choosable ? () => setOpen(true) : undefined}
          chevron={choosable}
          accent="send"
          data-testid={
            choosable
              ? `${testIdPrefix}-network-picker`
              : `${testIdPrefix}-network-${chain === 'miden' ? 'miden' : destination?.id}`
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
              {networks.map(option => (
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
