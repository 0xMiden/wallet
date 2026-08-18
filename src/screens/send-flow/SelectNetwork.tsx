import React, { useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { ReactComponent as EthLogo } from 'app/icons/logos/eth.svg';
import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { BRIDGE_NETWORKS, BRIDGE_OUTPUT_TOKEN_SYMBOL, SendNetworkId } from './bridge-networks';

export interface SelectNetworkDrawerProps {
  open: boolean;
  selectedNetwork?: SendNetworkId;
  onOpenChange: (open: boolean) => void;
  onSelect: (network: SendNetworkId) => void;
}

/** Destination-network picker for cross-chain sends. */
export const SelectNetworkDrawer: React.FC<SelectNetworkDrawerProps> = ({
  open,
  selectedNetwork,
  onOpenChange,
  onSelect
}) => {
  const { t } = useTranslation();

  const selectNetwork = useCallback(
    (network: SendNetworkId) => {
      hapticLight();
      onSelect(network);
      onOpenChange(false);
    },
    [onSelect, onOpenChange]
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="network">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('selectNetwork')}</DrawerTitle>
        </DrawerHeader>
        <div className="flex h-120 min-h-0 flex-col px-4 pb-4">
          <div className="flex min-h-0 flex-col overflow-y-auto divide-y divide-rule-default no-scrollbar">
            {BRIDGE_NETWORKS.map(network => (
              <button
                key={network.id}
                type="button"
                data-testid={`send-network-${network.id}`}
                aria-pressed={network.id === selectedNetwork}
                onClick={() => selectNetwork(network.id)}
                className="flex items-center gap-3 py-3.5 text-left"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-500">
                  <EthLogo data-testid={`send-network-${network.id}-logo`} className="h-5 w-3" />
                </span>
                <div className="flex flex-1 flex-col">
                  <span className="text-base font-bold text-heading-gray">{network.name}</span>
                  <span className="text-xs text-heading-gray/50">
                    {t('receiveOnArrivesAs', { network: network.name, symbol: BRIDGE_OUTPUT_TOKEN_SYMBOL })}
                  </span>
                </div>
                {network.id === selectedNetwork && (
                  <Icon name={IconName.CheckboxCircleFill} size="sm" className="text-primary-500" fill="currentColor" />
                )}
              </button>
            ))}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
