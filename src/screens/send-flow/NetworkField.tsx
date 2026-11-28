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
  networks?: readonly NetworkOption[];
  /** Omit the chain to offer every configured destination before the address is valid. */
  chain?: AddressChain;
  network?: BridgeNetworkId;
  requireSelection?: boolean;
  onSelect: (network: BridgeNetworkId) => void;
  testIdPrefix: string;
}

export const NetworkField: React.FC<NetworkFieldProps> = ({
  chain,
  network,
  requireSelection = false,
  onSelect,
  testIdPrefix,
  networks
}) => {
  const { t } = useTranslation();
  const nested = useIsInDrawer();
  const [open, setOpen] = useState(false);
  const kind = chain === undefined ? undefined : sendNetworkKind(chain);
  const offered: readonly NetworkOption[] = networks ?? BRIDGE_NETWORKS;
  const options = chain === undefined ? offered : offered.filter(option => (option.kind ?? 'evm') === kind);
  const selected = options.find(option => option.id === network);
  const canPick = chain === undefined || kind === 'evm';
  const needsSelection = canPick && requireSelection && selected === undefined;
  const choosable = canPick && (options.length > 1 || (options.length === 1 && needsSelection));
  const single = options.length === 1 && !needsSelection ? options[0] : undefined;
  const destination = selected ?? single;
  const isMiden = chain === 'miden';

  return (
    <div data-testid={`${testIdPrefix}-network-options`}>
      <SectionHeader>{t('network')}</SectionHeader>
      <ListGroup surface="outline">
        <ListRow
          title={isMiden ? t('miden') : (destination?.name ?? t('selectNetwork'))}
          avatar={<NetworkLogo kind={isMiden ? 'miden' : 'ethereum'} network={destination?.id} size="md" />}
          onClick={choosable ? () => setOpen(true) : undefined}
          chevron={choosable}
          accent="send"
          data-testid={
            choosable
              ? `${testIdPrefix}-network-picker`
              : `${testIdPrefix}-network-${isMiden ? 'miden' : destination?.id}`
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
