import React from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkLogo } from 'components/NetworkChip';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { BridgeNetwork } from 'screens/send-flow/bridge-networks';

export interface EvmBridgeNetworkDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chains the deposit can start from on the chosen route. */
  networks: readonly BridgeNetwork[];
  selected: BridgeNetwork;
  onSelect: (network: BridgeNetwork) => void;
}

/**
 * Bottom-sheet picker for the source network of a deposit. The USDCx route lists every chain of the
 * source table with a local xReserve; the other routes have one source and never open it.
 */
export const EvmBridgeNetworkDrawer: React.FC<EvmBridgeNetworkDrawerProps> = ({
  open,
  onOpenChange,
  networks,
  selected,
  onSelect
}) => {
  const { t } = useTranslation();

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="evm-bridge-network">
      <DrawerContent className="pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('selectNetwork')}</DrawerTitle>
        </DrawerHeader>

        <ListGroup className="mx-4">
          {networks.map(network => (
            <ListRow
              key={network.id}
              title={network.name}
              avatar={<NetworkLogo kind="ethereum" />}
              checked={network.id === selected.id}
              onClick={() => onSelect(network)}
              data-testid={`bridge-network-${network.id}`}
            />
          ))}
        </ListGroup>
      </DrawerContent>
    </Drawer>
  );
};
