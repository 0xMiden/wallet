import React, { useCallback, useEffect, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { useEpochSdk } from 'lib/epoch';
import { hapticMedium } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { Button } from 'lib/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { getChain, useWcStore } from 'lib/walletconnect';

import { BridgeTabs } from './EvmConnectModal/BridgeTabs';
import { shortenAddress } from './EvmConnectModal/shared';

interface EvmConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const EvmConnectModal: React.FC<EvmConnectModalProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const status = useWcStore(s => s.status);
  const address = useWcStore(s => s.address);
  const chainId = useWcStore(s => s.chainId);
  const error = useWcStore(s => s.error);
  const connect = useWcStore(s => s.connect);
  const disconnect = useWcStore(s => s.disconnect);
  const hydrate = useWcStore(s => s.hydrate);
  const sdk = useEpochSdk();
  const currentMidenAccount = useWalletStore(s => s.currentAccount);

  useEffect(() => {
    if (!sdk) return;
    console.log('[epoch] sdk ready', sdk);
  }, [sdk]);

  // Seed from any persisted AppKit session, then open AppKit's connect modal
  // if we're not already connected. AppKit owns the connect UX (wallet list,
  // QR, mobile deep-links, foreground reconnect), so there's nothing to
  // hand-roll here.
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        await hydrate();
        if (useWcStore.getState().status === 'idle') await connect();
      } catch (err) {
        console.error('[EvmConnectModal] connect failed', err);
      }
    })();
  }, [open, hydrate, connect]);

  const handleConnect = useCallback(async () => {
    hapticMedium();
    try {
      await connect();
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

  const chain = useMemo(() => (chainId !== null ? getChain(chainId) : undefined), [chainId]);

  const showConnected = status === 'connected';

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-6">
        <DrawerHeader>
          <DrawerTitle>{showConnected ? t('evmWalletConnected') : t('connectEvmWallet')}</DrawerTitle>
          <DrawerDescription>
            {showConnected ? t('evmWalletConnectedDescription') : t('connectEvmWalletDescription')}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4">
          {error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500" role="alert">
              {error}
            </div>
          )}

          {!showConnected && status === 'connecting' && (
            <div className="flex items-center justify-center py-12 text-sm text-grey-500">{t('preparing')}</div>
          )}

          {showConnected && (
            <div className="flex flex-col gap-2 rounded-lg bg-grey-50 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('address')}</span>
                <span className="font-medium text-heading-gray">{address ? shortenAddress(address) : '…'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('network')}</span>
                <span className="font-medium text-heading-gray">
                  {chain?.name ?? (chainId !== null ? `Chain ${chainId}` : '…')}
                </span>
              </div>
            </div>
          )}

          {showConnected && address && currentMidenAccount && (
            <BridgeTabs evmAddress={address} midenAccount={currentMidenAccount.publicKey} />
          )}

          {!showConnected && (
            <Button variant="default" size="lg" onClick={handleConnect} className="w-full">
              {t('openWallet')}
            </Button>
          )}

          {showConnected && (
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
