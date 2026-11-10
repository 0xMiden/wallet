import React from 'react';

import { useTranslation } from 'react-i18next';

import { NetworkLogo } from 'components/NetworkChip';
import { TokenLogo } from 'components/TokenLogo';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { hapticSelection } from 'lib/mobile/haptics';
import type { OneClickAsset } from 'lib/one-click/types';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface ReceiveTokenDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Miden tokens that the selected origin token can become. */
  outputs: readonly OneClickAsset[];
  selectedOutputAssetId: string;
  /** The origin token and chain, for the description line. */
  originSymbol: string;
  originChainName: string;
  onSelect: (outputAssetId: string) => void;
}

/** The Miden tokens that the deposit can deliver. Miden is the only destination, so there is no network filter. */
export const ReceiveTokenDrawer: React.FC<ReceiveTokenDrawerProps> = ({
  open,
  onOpenChange,
  outputs,
  selectedOutputAssetId,
  originSymbol,
  originChainName,
  onSelect
}) => {
  const { t } = useTranslation();
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="near-intents-receive-token">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('nearIntentsReceiveOnMiden')}</DrawerTitle>
        </DrawerHeader>
        <DrawerDescription>
          {t('nearIntentsAvailableFor', { symbol: originSymbol, chain: originChainName })}
        </DrawerDescription>
        <div className="min-h-0 overflow-y-auto px-4 pb-6 pt-2" data-testid="near-intents-receive-token-drawer">
          <ListGroup>
            {outputs.map(output => (
              <ListRow
                key={output.assetId}
                variant="choice"
                title={output.symbol}
                subtitle={t('nearIntentsOnChain', { chain: t('miden') })}
                avatar={
                  <TokenLogo
                    symbol={output.symbol}
                    faucetId={output.faucetId}
                    size="lg"
                    badge={<NetworkLogo kind="miden" />}
                  />
                }
                checked={output.assetId === selectedOutputAssetId}
                accent="receive"
                haptic={false}
                onClick={() => {
                  hapticSelection();
                  onSelect(output.assetId);
                  onOpenChange(false);
                }}
                data-testid={`near-intents-output-${output.assetId}`}
              />
            ))}
          </ListGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
};
