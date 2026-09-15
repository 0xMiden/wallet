import React, { useCallback } from 'react';

import { useAppKit } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { TestNetworkWarning } from 'components/TestNetworkWarning';
import { hapticMedium } from 'lib/mobile/haptics';
import { Button } from 'lib/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
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
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="evm-connect">
      {/* The body scrolls and "Open wallet" stays pinned: in landscape 80vh is
          short enough for the warning to push the button out of view. */}
      <DrawerContent className="overflow-hidden pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="evm-connect-body">
            <DrawerHeader>
              <DrawerTitle>{t('connectEvmWallet')}</DrawerTitle>
              <DrawerDescription>{t('connectEvmWalletDescription')}</DrawerDescription>
            </DrawerHeader>

            <div className="flex flex-col gap-4 px-4">
              {/* Shown before the WalletConnect handshake (#875): the bridge only
                  works on Ethereum Sepolia, so a wallet that holds real funds has
                  nothing to gain here and everything to lose. */}
              <TestNetworkWarning
                titleKey="evmConnectTestWalletTitle"
                bodyKey="evmConnectTestWalletBody"
                data-testid="evm-connect-test-wallet-warning"
              />

              {status === 'connecting' && (
                <div className="flex items-center justify-center py-12 text-sm text-grey-500">{t('preparing')}</div>
              )}

              {nativeReown.error && (
                <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
                  {nativeReown.error}
                </div>
              )}
            </div>
          </div>
          <DrawerFooter className="shrink-0">
            <Button
              variant="default"
              size="lg"
              onClick={handleConnect}
              className="w-full"
              data-testid="evm-connect-open-wallet"
            >
              {t('openWallet')}
            </Button>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default EvmConnectModal;
