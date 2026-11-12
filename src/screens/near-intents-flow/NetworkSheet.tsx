import React from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkChip } from 'components/NetworkChip';
import type { NearIntentsCatalogChain } from 'lib/one-click/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { chainLogoNetwork } from './chains';

export interface NetworkSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chains: readonly NearIntentsCatalogChain[];
  selectedChainId: string;
  onSelect: (chainId: string) => void;
}

/**
 * The origin chains as a two-column grid of network chips. It opens over the send token drawer, so
 * it is a nested sheet. The shared sheet closes itself on mobile back.
 */
export const NetworkSheet: React.FC<NetworkSheetProps> = ({
  open,
  onOpenChange,
  chains,
  selectedChainId,
  onSelect
}) => {
  const { t } = useTranslation();
  return (
    <Drawer nested open={open} onOpenChange={onOpenChange} screenKey="near-intents-network">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('network')}</DrawerTitle>
        </DrawerHeader>
        <div
          role="group"
          aria-label={t('network')}
          className="grid grid-cols-2 gap-2.5 px-4 pb-6"
          data-testid="near-intents-network-sheet"
        >
          {chains.map(chain => (
            <NetworkChip
              key={chain.id}
              kind="ethereum"
              network={chainLogoNetwork(chain.id)}
              label={chain.name}
              selected={chain.id === selectedChainId}
              onClick={() => {
                onSelect(chain.id);
                onOpenChange(false);
              }}
              className="w-full justify-start"
              data-testid={`near-intents-network-${chain.id}`}
            />
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
};
