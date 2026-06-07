import React, { useCallback, useEffect } from 'react';

import { useAppKit, useAppKitAccount, useDisconnect } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { useEpochSdk } from 'lib/epoch';
import { hapticMedium } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { Button } from 'lib/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useNativeReown } from 'lib/walletconnect/useNativeReown';

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
  const nativeReown = useNativeReown();
  const useNativeReownWallet = nativeReown.available;
  const evmAddress = useNativeReownWallet ? nativeReown.state.address : address;
  const evmConnected = useNativeReownWallet ? nativeReown.state.connected : isConnected;
  const evmStatus = useNativeReownWallet ? (nativeReown.connecting ? 'connecting' : 'idle') : status;

  useEffect(() => {
    if (!sdk) return;
    console.log('[epoch] sdk ready', sdk);
  }, [sdk]);

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

  const handleDisconnect = useCallback(async () => {
    hapticMedium();
    try {
      if (useNativeReownWallet) {
        await nativeReown.disconnect();
      } else {
        await disconnect();
      }
    } finally {
      onOpenChange(false);
    }
  }, [disconnect, nativeReown, onOpenChange, useNativeReownWallet]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-6">
        <DrawerHeader>
          <DrawerTitle>{evmConnected ? t('evmWalletConnected') : t('connectEvmWallet')}</DrawerTitle>
          <DrawerDescription>
            {evmConnected ? t('evmWalletConnectedDescription') : t('connectEvmWalletDescription')}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4">
          {!evmConnected && evmStatus === 'connecting' && (
            <div className="flex items-center justify-center py-12 text-sm text-grey-500">{t('preparing')}</div>
          )}

          {nativeReown.error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
              {nativeReown.error}
            </div>
          )}

          {evmConnected && (
            <div className="flex flex-col gap-2 rounded-lg bg-grey-50 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('address')}</span>
                <span className="font-medium text-heading-gray">{evmAddress ? shortenAddress(evmAddress) : '…'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('network')}</span>
                <span className="font-medium text-heading-gray">Sepolia</span>
              </div>
            </div>
          )}

          {evmConnected && evmAddress && currentMidenAccount && (
            <BridgeTabs evmAddress={evmAddress} midenAccount={currentMidenAccount.publicKey} />
          )}

          {!evmConnected && (
            <Button variant="default" size="lg" onClick={handleConnect} className="w-full">
              {t('openWallet')}
            </Button>
          )}

          {evmConnected && (
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
