import React, { useCallback } from 'react';

import { useAppKit, useDisconnect } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { useFundTelemetry } from 'app/hooks/useFundTelemetry';
import { IconName } from 'app/icons/v2';
import { EvmBridgeDepositScreen } from 'app/templates/EvmConnectModal/EvmBridgeDepositScreen';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { FlowLayout } from 'components/flow/FlowLayout';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { Button } from 'components/ui/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { EmptyState } from 'components/ui/EmptyState';
import { Notice } from 'components/ui/Notice';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { hapticMedium } from 'lib/mobile/haptics';
import { useWalletStore } from 'lib/store';
import { useBridgeInAvailability } from 'lib/usdcx/use-bridge-in-availability';
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
  // The test-wallet warning belongs to the test networks; on mainnet the funds are real and it is not shown.
  const testNetwork = getTestNetworkNameKey() !== null;
  // This surface owns the `fund` flow, which starts here rather than at the
  // deposit form: the connect step is part of funding, and dropping out of it is
  // exactly the abandonment worth seeing.
  const reportDeposit = useFundTelemetry();
  const walletReady = connected && address && currentMidenAccount;
  // A ready wallet hands the page to the deposit screen, which holds for the route cards it greys out.
  const bridgeIn = useBridgeInAvailability({ hold: !walletReady });

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
      const appkit = await import('lib/walletconnect/appkit');
      await appkit.prepareAppKitConnection();
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
      const appkit = await import('lib/walletconnect/appkit');
      await appkit.prepareAppKitConnection();
      await connect({ view: 'Connect', namespace: 'eip155' });
    } catch (err) {
      console.error('[BridgeDeposit] switch wallet failed', err);
    }
  }, [connect, disconnect, nativeReown, useNativeReownWallet]);

  if (walletReady) {
    return (
      <EvmBridgeDepositScreen
        evmAddress={address}
        midenAccount={currentMidenAccount}
        onConnectAnother={handleSwitchWallet}
        onClose={handleClose}
        reportDeposit={reportDeposit}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg text-ink">
      <NetworkModeBanner />
      <FlowLayout
        title={t('bridgeInTitle')}
        onBack={handleClose}
        footer={
          <Button
            accent="receive"
            onClick={handleConnect}
            disabled={isFeatureBlocked(bridgeIn) || status === 'connecting'}
            className="w-full max-w-none"
            data-testid="bridge-connect-wallet"
          >
            {t('openWallet')}
          </Button>
        }
      >
        <EmptyState
          title={t('connectEvmWallet')}
          description={t('connectEvmWalletDescription')}
          icon={IconName.CrossChain}
        />
        <DetailCard face="heading" className="mt-6">
          <DetailRow label={t('to')} sub={currentMidenAccount?.name}>
            {t('miden')}
          </DetailRow>
        </DetailCard>
        {testNetwork && (
          <Notice
            tone="warning"
            title={t('evmConnectTestWalletTitle')}
            className="mt-4"
            data-testid="evm-connect-test-wallet-warning"
          >
            {t('evmConnectTestWalletBody')}
          </Notice>
        )}
        {status === 'connecting' && <p className="mt-4 text-body-sm text-muted">{t('preparing')}</p>}
        {nativeReown.error && (
          <Notice tone="negative" role="alert" className="mt-4">
            {nativeReown.error}
          </Notice>
        )}
        <FeatureUnavailableNotice availability={bridgeIn} className="mt-4" />
      </FlowLayout>
    </div>
  );
};

export default BridgeDeposit;
