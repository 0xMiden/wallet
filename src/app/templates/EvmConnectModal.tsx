import React, { useCallback } from 'react';

import { useAppKit } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/ui/Button';
import { Notice } from 'components/ui/Notice';
import { hapticMedium } from 'lib/mobile/haptics';
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
      <DrawerContent className="pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
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
              <Notice
                tone="warning"
                icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
                title={t('evmConnectTestWalletTitle')}
                data-testid="evm-connect-test-wallet-warning"
              >
                {t('evmConnectTestWalletBody')}
              </Notice>

              {status === 'connecting' && (
                <div className="flex items-center justify-center py-12 text-body-sm text-muted">{t('preparing')}</div>
              )}

              {nativeReown.error && (
                <div
                  className="rounded-2xl bg-negative-tint px-3 py-2 text-caption text-negative-tint-ink"
                  role="alert"
                >
                  {nativeReown.error}
                </div>
              )}
            </div>
          </div>
          <DrawerFooter className="shrink-0">
            <Button onClick={handleConnect} className="max-w-none" data-testid="evm-connect-open-wallet">
              {t('openWallet')}
            </Button>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default EvmConnectModal;
