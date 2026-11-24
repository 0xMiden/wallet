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
  /** The chain the route is on, or none while the route has no chain: no row is then checked. */
  selected?: BridgeNetwork;
  onSelect: (network: BridgeNetwork) => void;
}

/**
 * Bottom-sheet picker for the source network of a deposit. It lists every chain any deposit route starts from (a
 * Circle source, an Epoch route that takes a token, an AggLayer chain), whatever the token; the token drawer then
 * offers what the picked chain bridges.
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
              variant="choice"
              accent="receive"
              key={network.id}
              title={network.name}
              avatar={<NetworkLogo kind="ethereum" network={network.id} size="md" />}
              checked={network.id === selected?.id}
              onClick={() => onSelect(network)}
              data-testid={`bridge-network-${network.id}`}
            />
          ))}
        </ListGroup>
      </DrawerContent>
    </Drawer>
  );
};
