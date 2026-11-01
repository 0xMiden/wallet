import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { NetworkLogo, NetworkChip } from 'components/NetworkChip';
import { TokenLogo } from 'components/TokenLogo';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Pill } from 'components/ui/Pill';
import { hapticLight } from 'lib/mobile/haptics';
import { OneClickAsset } from 'lib/one-click/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

export interface OneClickNetworkOption {
  id: string;
  name: string;
  kind: 'miden' | 'ethereum';
  logoNetwork?: string;
}

export const oneClickLogoNetwork = (networkId: string, configuredLogo?: string): string | undefined => {
  if (networkId === 'eth') return 'ethereum';
  if (networkId === 'arb') return 'arbitrum';
  if (networkId === 'op') return 'optimism';
  return configuredLogo ?? (networkId === 'miden' ? undefined : networkId);
};

interface OneClickNetworkPickerProps {
  side: 'pay' | 'receive';
  network: OneClickNetworkOption;
  networks: readonly OneClickNetworkOption[];
  onSelect: (network: OneClickNetworkOption) => void;
}

export const OneClickNetworkPicker: React.FC<OneClickNetworkPickerProps> = ({ side, network, networks, onSelect }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <NetworkChip
        kind={network.kind}
        network={oneClickLogoNetwork(network.id, network.logoNetwork)}
        label={network.name}
        onClick={() => setOpen(true)}
        data-testid={`one-click-${side}-network-picker`}
      />
      <Drawer open={open} onOpenChange={setOpen} screenKey={`one-click-${side}-network`}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('selectNetwork')}</DrawerTitle>
          </DrawerHeader>
          <ListGroup className="mx-4 mb-6">
            {networks.map(option => (
              <ListRow
                key={option.id}
                variant="choice"
                title={option.name}
                avatar={
                  <NetworkLogo
                    kind={option.kind}
                    network={oneClickLogoNetwork(option.id, option.logoNetwork)}
                    size="md"
                  />
                }
                checked={option.id === network.id}
                accent="swap"
                onClick={() => {
                  hapticLight();
                  onSelect(option);
                  setOpen(false);
                }}
                data-testid={`one-click-${side}-network-${option.id}`}
              />
            ))}
          </ListGroup>
        </DrawerContent>
      </Drawer>
    </>
  );
};

interface OneClickAssetPickerProps {
  side: 'pay' | 'receive';
  network: OneClickNetworkOption;
  asset?: OneClickAsset;
  assets: readonly OneClickAsset[];
  onSelect: (asset: OneClickAsset) => void;
}

export const OneClickAssetPicker: React.FC<OneClickAssetPickerProps> = ({ side, network, asset, assets, onSelect }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const options = assets.filter(candidate => candidate.blockchain === network.id);

  return (
    <>
      <Pill
        size="md"
        tone="neutral"
        shape="rounded"
        onClick={() => setOpen(true)}
        trailingIcon={<Icon name={IconName.ChevronDown} size="xs" className="text-accent-swap" aria-hidden="true" />}
        className="min-w-0 max-w-full"
        aria-label={t('oneClickSelectAsset', { network: network.name })}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={`one-click-${side}-asset-picker`}
      >
        {asset && <TokenLogo faucetId={asset.faucetId} size="sm" />}
        <span className="text-row-title truncate">{asset?.symbol ?? t('selectAToken')}</span>
      </Pill>
      <Drawer open={open} onOpenChange={setOpen} screenKey={`one-click-${side}-asset`}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('selectAToken')}</DrawerTitle>
          </DrawerHeader>
          <div className="min-h-0 overflow-y-auto px-4 pb-6">
            <ListGroup>
              {options.map(option => (
                <ListRow
                  key={option.assetId}
                  variant="choice"
                  title={option.symbol}
                  avatar={<TokenLogo faucetId={option.faucetId} />}
                  checked={option.assetId === asset?.assetId}
                  accent="swap"
                  onClick={() => {
                    hapticLight();
                    onSelect(option);
                    setOpen(false);
                  }}
                  data-testid={`one-click-asset-${side}-${option.assetId}`}
                />
              ))}
            </ListGroup>
            {options.length === 0 && <p className="px-4 py-8 text-body-sm text-muted">{t('oneClickNoAssets')}</p>}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
};
