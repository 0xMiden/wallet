import React, { useCallback } from 'react';

import { useDisconnect } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { useFundTelemetry } from 'app/hooks/useFundTelemetry';
import { Icon, IconName } from 'app/icons/v2';
import { EvmBridgeDepositScreen } from 'app/templates/EvmConnectModal/EvmBridgeDepositScreen';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { FlowLayout } from 'components/flow/FlowLayout';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { Button } from 'components/ui/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { ListGroup } from 'components/ui/ListGroup';
import { Notice } from 'components/ui/Notice';
import { SectionHeader } from 'components/ui/SectionHeader';
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
  const { disconnect } = useDisconnect();
  const { address, connected, status, nativeReown, useNativeReownWallet } = useEvmWalletConnection();
  // The test-wallet warning belongs to the test networks; on mainnet the funds are real and it is not shown.
  const testNetworkKey = getTestNetworkNameKey();
  const testNetwork = testNetworkKey !== null;
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
      await appkit.openConnectModal();
    } catch (err) {
      console.error('[BridgeDeposit] connect failed', err);
    }
  }, [nativeReown, useNativeReownWallet]);

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
      await appkit.openConnectModal();
    } catch (err) {
      console.error('[BridgeDeposit] switch wallet failed', err);
    }
  }, [disconnect, nativeReown, useNativeReownWallet]);

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
            {t(status === 'connecting' ? 'preparing' : 'bridgeConnectWalletAction')}
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          <div>
            <SectionHeader size="2xl">{t('bridgeConnectWalletTitle')}</SectionHeader>
            <p className="text-explainer text-muted">{t('bridgeConnectWalletBody')}</p>
          </div>

          <DetailCard surface="outline" face="heading">
            <DetailRow label={t('from')} sub={t('bridgeConnectSourceHint')}>
              {t('bridgeConnectSource')}
            </DetailRow>
            <DetailRow
              label={t('to')}
              sub={testNetworkKey ? t('qrNetworkCaption', { network: t(testNetworkKey) }) : t('miden')}
            >
              {currentMidenAccount?.name ?? t('miden')}
            </DetailRow>
          </DetailCard>

          <div>
            <SectionHeader>{t('bridgeConnectNextTitle')}</SectionHeader>
            <ListGroup surface="plain" insetHairlines>
              <FactRow
                leading={
                  <IconCircle className="bg-accent-receive-tint text-accent-receive">
                    <Icon name={IconName.CrossChain} size="xs" />
                  </IconCircle>
                }
                title={t('bridgeConnectChooseTitle')}
                description={t('bridgeConnectChooseBody')}
              />
              <FactRow
                leading={
                  <IconCircle className="bg-accent-receive-tint text-accent-receive">
                    <Icon name={IconName.ShieldCheck} size="xs" fill="currentColor" />
                  </IconCircle>
                }
                title={t('bridgeConnectApproveTitle')}
                description={t('bridgeConnectApproveBody')}
              />
            </ListGroup>
          </div>

          {testNetwork && (
            <Notice
              tone="warning"
              variant="inline"
              icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
              title={t('evmConnectTestWalletTitle')}
              data-testid="evm-connect-test-wallet-warning"
            >
              {t('bridgeConnectTestWalletBody')}
            </Notice>
          )}
        </div>
        {status === 'connecting' && (
          <p role="status" className="mt-4 text-body-sm text-muted">
            {t('preparing')}
          </p>
        )}
        {nativeReown.error && (
          <Notice tone="negative" role="alert" className="mt-4" errorId="raw_bridge_connect_failed">
            {nativeReown.error}
          </Notice>
        )}
        <FeatureUnavailableNotice availability={bridgeIn} className="mt-4" />
      </FlowLayout>
    </div>
  );
};

export default BridgeDeposit;
