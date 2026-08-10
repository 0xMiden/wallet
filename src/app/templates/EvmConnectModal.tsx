import React, { useCallback } from 'react';

import { useAppKit } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { hapticMedium } from 'lib/mobile/haptics';
import { Button } from 'lib/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';

interface EvmConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const EvmConnectModal: React.FC<EvmConnectModalProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const { open: connect } = useAppKit();
  const { status, nativeReown, useNativeReownWallet } = useEvmWalletConnection();

  const handleConnect = useCallback(async () => {
    hapticMedium();
    try {
      if (useNativeReownWallet) {
        await nativeReown.present();
        return;
      }
      await connect({ view: 'Connect', namespace: 'eip155' });
    } catch (err) {
      console.error('[EvmConnectModal] connect failed', err);
    }
  }, [connect, nativeReown, useNativeReownWallet]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <DrawerHeader>
          <DrawerTitle>{t('connectEvmWallet')}</DrawerTitle>
          <DrawerDescription>{t('connectEvmWalletDescription')}</DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4">
          {status === 'connecting' && (
            <div className="flex items-center justify-center py-12 text-sm text-grey-500">{t('preparing')}</div>
          )}

          {nativeReown.error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
              {nativeReown.error}
            </div>
          )}

          <Button variant="default" size="lg" onClick={handleConnect} className="w-full">
            {t('openWallet')}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default EvmConnectModal;
