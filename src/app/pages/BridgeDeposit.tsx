import React, { useCallback } from 'react';

import { useAppKit, useDisconnect } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { EvmBridgeDepositScreen } from 'app/templates/EvmConnectModal/EvmBridgeDepositScreen';
import { PageHeader } from 'components/PageHeader';
import { TestNetworkWarning } from 'components/TestNetworkWarning';
import { Button } from 'components/ui/Button';
import { hapticMedium } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { navigate } from 'lib/woozie';

interface BridgeDepositProps {
  onClose?: () => void;
}

export const BridgeDeposit: React.FC<BridgeDepositProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const currentMidenAccount = useWalletStore(s => s.currentAccount);
  const { open: connect } = useAppKit();
  const { disconnect } = useDisconnect();
  const { address, connected, status, nativeReown, useNativeReownWallet } = useEvmWalletConnection();

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    navigate('/receive');
  }, [onClose]);

  const handleConnect = useCallback(async () => {
    hapticMedium();
    try {
      if (useNativeReownWallet) {
        await nativeReown.present();
        return;
      }
      await connect({ view: 'Connect', namespace: 'eip155' });
    } catch (err) {
      console.error('[BridgeDeposit] connect failed', err);
    }
  }, [connect, nativeReown, useNativeReownWallet]);

  // AppKit won't open the Connect view while a wallet is already connected, so
  // "switch wallet" = disconnect the current one, then reopen the picker.
  const handleSwitchWallet = useCallback(async () => {
    hapticMedium();
    try {
      if (useNativeReownWallet) {
        await nativeReown.disconnect();
        await nativeReown.present();
        return;
      }
      await disconnect();
      await connect({ view: 'Connect', namespace: 'eip155' });
    } catch (err) {
      console.error('[BridgeDeposit] switch wallet failed', err);
    }
  }, [connect, disconnect, nativeReown, useNativeReownWallet]);

  if (connected && address && currentMidenAccount) {
    return (
      <EvmBridgeDepositScreen
        evmAddress={address}
        midenAccount={currentMidenAccount}
        onConnectAnother={handleSwitchWallet}
        onClose={handleClose}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg text-heading-gray">
      <div className="shrink-0 px-4">
        <PageHeader title={t('midenBridge')} onClose={handleClose} />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <h2 className="text-2xl font-semibold text-heading-gray">{t('connectEvmWallet')}</h2>
        <p className="max-w-80 text-sm text-text-tertiary-token">{t('connectEvmWalletDescription')}</p>

        {/* Same warning as the Receive-side connect drawer (#875). */}
        <TestNetworkWarning
          titleKey="evmConnectTestWalletTitle"
          bodyKey="evmConnectTestWalletBody"
          className="max-w-80"
          data-testid="evm-connect-test-wallet-warning"
        />

        {status === 'connecting' && <p className="text-sm text-grey-500">{t('preparing')}</p>}

        {nativeReown.error && (
          <div className="w-full rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
            {nativeReown.error}
          </div>
        )}

        <Button onClick={handleConnect} className="max-w-80">
          {t('openWallet')}
        </Button>
      </div>
    </div>
  );
};

export default BridgeDeposit;
