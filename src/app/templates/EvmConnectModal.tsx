import React, { useCallback, useEffect } from 'react';

import { useAppKit, useAppKitAccount, useDisconnect } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { useEpochSdk } from 'lib/epoch';
import { hapticMedium } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { Button } from 'lib/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { BridgeTabs } from './EvmConnectModal/BridgeTabs';
import { shortenAddress } from './EvmConnectModal/shared';

interface EvmConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const EvmConnectModal: React.FC<EvmConnectModalProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const sdk = useEpochSdk();
  const currentMidenAccount = useWalletStore(s => s.currentAccount);

  const { address, isConnected, status } = useAppKitAccount({ namespace: 'eip155' });

  const { open: connect } = useAppKit();

  const { disconnect } = useDisconnect();
  useEffect(() => {
    if (!sdk) return;
    console.log('[epoch] sdk ready', sdk);
  }, [sdk]);

  const handleConnect = useCallback(async () => {
    hapticMedium();
    try {
      await connect({ view: 'Connect', namespace: 'eip155' });
    } catch (err) {
      console.error('[EvmConnectModal] connect failed', err);
    }
  }, [connect]);

  const handleDisconnect = useCallback(async () => {
    hapticMedium();
    try {
      await disconnect();
    } finally {
      onOpenChange(false);
    }
  }, [disconnect, onOpenChange]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-6">
        <DrawerHeader>
          <DrawerTitle>{isConnected ? t('evmWalletConnected') : t('connectEvmWallet')}</DrawerTitle>
          <DrawerDescription>
            {isConnected ? t('evmWalletConnectedDescription') : t('connectEvmWalletDescription')}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4">
          {!isConnected && status === 'connecting' && (
            <div className="flex items-center justify-center py-12 text-sm text-grey-500">{t('preparing')}</div>
          )}

          {isConnected && (
            <div className="flex flex-col gap-2 rounded-lg bg-grey-50 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('address')}</span>
                <span className="font-medium text-heading-gray">{address ? shortenAddress(address) : '…'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('network')}</span>
              </div>
            </div>
          )}

          {isConnected && address && currentMidenAccount && (
            <BridgeTabs evmAddress={address} midenAccount={currentMidenAccount.publicKey} />
          )}

          {!isConnected && (
            <Button variant="default" size="lg" onClick={handleConnect} className="w-full">
              {t('openWallet')}
            </Button>
          )}

          {isConnected && (
            <Button variant="destructive" size="lg" onClick={handleDisconnect} className="w-full">
              {t('disconnect')}
            </Button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default EvmConnectModal;
