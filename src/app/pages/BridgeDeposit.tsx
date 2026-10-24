import React, { useCallback } from 'react';

import { useDisconnect } from '@reown/appkit/react';
import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useFundTelemetry } from 'app/hooks/useFundTelemetry';
import { Icon, IconName } from 'app/icons/v2';
import { EvmBridgeDepositScreen } from 'app/templates/EvmConnectModal/EvmBridgeDepositScreen';
import { FeatureUnavailableNotice, isFeatureBlocked } from 'components/FeatureUnavailable';
import { FlowLayout } from 'components/flow/FlowLayout';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { Avatar } from 'components/ui/Avatar';
import { Button } from 'components/ui/Button';
import { Card } from 'components/ui/Card';
import { IconCircle } from 'components/ui/FactRow';
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

interface ConnectStepProps {
  number: number;
  title: string;
  body: string;
  /** The step the user is on: its number fills in the receive accent and its title takes the accent ink. */
  current?: boolean;
  /** The last step draws no rail below its number. */
  last?: boolean;
}

/** One numbered step of the bridge-in walkthrough, joined to the next by a rail under its number. */
const ConnectStep: React.FC<ConnectStepProps> = ({ number, title, body, current = false, last = false }) => (
  <li className="relative flex gap-3 pb-4 last:pb-0">
    {!last && <span aria-hidden="true" className="absolute bottom-0 left-4 top-8 w-0.5 -translate-x-1/2 bg-fill" />}
    <IconCircle className={current ? 'bg-accent-receive-tint text-accent-receive-ink' : 'text-muted'}>
      <span className="text-caption-heading font-black">{number}</span>
    </IconCircle>
    <span className="min-w-0 pt-1">
      <span className={`block text-row-title ${current ? 'text-accent-receive-ink' : 'text-ink'}`}>{title}</span>
      <span className="mt-0.5 block text-caption-heading text-muted">{body}</span>
    </span>
  </li>
);

export const BridgeDeposit: React.FC<BridgeDepositProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const goBack = useBackWithFallback();
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
    goBack();
  }, [goBack, onClose]);

  // The X leaves the flow altogether: back returns to the previous screen, close returns Home.
  const handleExit = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    navigate('/');
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
        onClose={handleExit}
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
            <p className="text-explainer-heading font-bold text-muted">{t('bridgeConnectWalletBody')}</p>
          </div>

          {/* One row, read left to right: the wallet the tokens leave, then the account they arrive in. */}
          <Card
            surface="outline"
            padding="row"
            className="-my-2.5 flex items-center gap-3 py-4"
            data-testid="bridge-connect-route"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <IconCircle size="lg" className="text-muted">
                <Icon name={IconName.Wallet} />
              </IconCircle>
              <span className="min-w-0">
                <span className="block text-row-title text-ink">{t('bridgeConnectSource')}</span>
                <span className="block text-caption text-muted">{t('bridgeConnectSourceHint')}</span>
              </span>
            </span>
            <Icon
              name={IconName.ArrowRight}
              size="xs"
              fill="currentColor"
              aria-hidden="true"
              className="shrink-0 text-muted"
            />
            <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
              <span className="min-w-0">
                <span className="block truncate text-row-title text-ink">
                  {currentMidenAccount?.name ?? t('miden')}
                </span>
                <span className="block text-caption text-muted">
                  {testNetworkKey ? t('qrNetworkCaption', { network: t(testNetworkKey) }) : t('miden')}
                </span>
              </span>
              <Avatar
                size={40}
                color="var(--accent-primary)"
                icon={<Icon name={IconName.MidenLogoWhite} size="sm" />}
              />
            </span>
          </Card>

          {/* The connect step and the two after it, joined by a rail; this step is filled in the receive accent. */}
          <ol className="flex flex-col">
            <ConnectStep number={1} current title={t('bridgeConnectWalletTitle')} body={t('bridgeConnectStepBody')} />
            <ConnectStep number={2} title={t('bridgeConnectChooseTitle')} body={t('bridgeConnectChooseBody')} />
            <ConnectStep number={3} last title={t('bridgeConnectApproveTitle')} body={t('bridgeConnectApproveBody')} />
          </ol>

          {testNetwork && (
            <Notice
              tone="caution"
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
