import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { PageHeader } from 'components/PageHeader';
import { Spinner } from 'components/ui/Spinner';
import type { IOneClickTrackingData } from 'lib/miden/db/types';
import { openWalletPayment } from 'lib/mobile/wallet-payments';
import { depositPaymentLinks, type WalletPaymentLink } from 'lib/one-click/payment-links';
import { isExtension, isMobile } from 'lib/platform';
import { navigate, Redirect } from 'lib/woozie';
import { type DepositAddressStatus, DepositAddressView } from 'screens/deposit-flow/DepositAddressView';
import {
  type DepositBadgeSide,
  type DepositProcessingFailure,
  DepositProcessingView
} from 'screens/deposit-flow/DepositProcessingView';
import { DepositQrSheet } from 'screens/deposit-flow/DepositQrSheet';
import { DepositSuccessView } from 'screens/deposit-flow/DepositSuccessView';
import { useDeadlinePassed } from 'screens/deposit-flow/expiry-countdown';
import { OpenWalletSheet } from 'screens/deposit-flow/OpenWalletSheet';
import { DEPOSIT_SCREEN_PATH } from 'screens/deposit-flow/pending-deposit-route';
import type { DepositFee, DepositLayout } from 'screens/deposit-flow/types';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';
import { truncateAddress } from 'utils/string';

import { chainLogoNetwork } from './chains';
import {
  nearIntentsBridgeFee,
  nearIntentsChainName,
  nearIntentsDepositedValue,
  nearIntentsReceivedValue,
  nearIntentsSentValue
} from './deposit-display';
import {
  depositDeadlineMs,
  type NearIntentsDepositScreen,
  nearIntentsDepositScreenOf,
  nearIntentsTrackingOf,
  waitsForDeposit
} from './deposit-status';
import { arrivalMinutes } from './format';
import { installedPaymentLinks, useInstalledPaymentWallets } from './useInstalledPaymentWallets';

/** Where the page goes when the row is unknown, and where back goes when the page has no history. */
const FALLBACK_PATH = '/receive';
/** The Home route: where close and Done go. */
const HOME_PATH = '/';

export interface NearIntentsDepositPageProps {
  rowId: string;
}

/**
 * The deposit page of one NEAR Intents tracking row. It reads everything from the row, so it shows the same deposit
 * after a reload, and it follows the phase that the tracking loop (`reconcileOneClickSwaps`) writes. It shows the
 * shared deposit views: the address screen while the address takes a deposit, the processing steps after 1Click sees
 * the deposit, the failure for a refund or a failed swap, and the success screen. An unknown row goes back to Receive.
 */
export const NearIntentsDepositPage: React.FC<NearIntentsDepositPageProps> = ({ rowId }) => {
  const { row, loaded } = useTransactionRow(rowId);
  const tracking = nearIntentsTrackingOf(row);
  // One timer to the deadline, only while the address waits: the page renders again when the deadline passes.
  const deadline = tracking && waitsForDeposit(tracking.phase) ? depositDeadlineMs(tracking) : Number.NaN;
  const deadlinePassed = useDeadlinePassed(deadline);

  if (!loaded) {
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );
  }
  if (!tracking) return <Redirect to={FALLBACK_PATH} />;
  return (
    <NearIntentsDepositScreenView
      tracking={tracking}
      screen={nearIntentsDepositScreenOf(tracking.phase, deadlinePassed)}
    />
  );
};

const NearIntentsDepositScreenView: React.FC<{ tracking: IOneClickTrackingData; screen: NearIntentsDepositScreen }> = ({
  tracking,
  screen
}) => {
  const { t } = useTranslation();
  const back = useBackWithFallback(FALLBACK_PATH);
  const installed = useInstalledPaymentWallets();
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const [walletSheetOpen, setWalletSheetOpen] = useState(false);
  const layout: DepositLayout = isExtension() ? 'extension' : 'mobile';
  const goHome = () => navigate(HOME_PATH);

  const origin = tracking.originAsset;
  const chainName = nearIntentsChainName(tracking);
  const routeName = t('bridgeRouteNearIntents');
  const bridgeFee: DepositFee = nearIntentsBridgeFee(tracking) ?? { kind: 'rate', text: t('unknown') };
  const sentValue = nearIntentsSentValue(tracking);
  const receivedValue = nearIntentsReceivedValue(tracking);
  const sent: DepositBadgeSide = { value: sentValue, symbol: origin.symbol, rounding: 'exact' };
  const received: DepositBadgeSide = {
    value: receivedValue,
    symbol: tracking.destinationAsset.symbol,
    rounding: 'down'
  };
  // The wallet logos key on the Miden faucet the token arrives in, for both sides.
  const logoFaucetId = tracking.faucetId;
  const depositAddress = tracking.depositAddress ?? '';
  // Only wallets on this phone that can take the deposit, each with the address and amount filled in.
  const walletLinks = isMobile() ? installedPaymentLinks(depositPaymentLinks(tracking), installed) : [];

  const openWallet = async (link: WalletPaymentLink): Promise<boolean> => {
    // Check the deadline again. The app can come back from the background before the page updates.
    const current = depositPaymentLinks(tracking).find(candidate => candidate.wallet === link.wallet);
    if (!current) return false;
    return openWalletPayment(current, depositDeadlineMs(tracking));
  };

  /** The failure of a deposit that 1Click refunded or could not complete, with the row's own reason. */
  const failureOf = (reason: 'refunded' | 'failed'): DepositProcessingFailure => {
    switch (reason) {
      case 'refunded':
        return {
          message: t('depositFlowNearRefunded', { address: truncateAddress(tracking.request.refundTo) }),
          errorId: 'raw_bridge_deposit_failed'
        };
      case 'failed':
        // The same rule as the relay route: the row's message, else the generic one.
        if (tracking.error) return { message: tracking.error, errorId: 'raw_bridge_deposit_failed' };
        return { message: t('transactionErrorDescription'), errorId: 'transactionErrorDescription' };
    }
  };

  const frame = { phase: tracking.phase, address: depositAddress };

  switch (screen.kind) {
    case 'success':
      return (
        <PageFrame {...frame}>
          <DepositSuccessView
            sent={sent}
            received={received}
            networkName={chainName}
            routeName={routeName}
            bridgeFee={bridgeFee}
            feeSymbol={origin.symbol}
            onDone={goHome}
            onDepositAgain={() => navigate(DEPOSIT_SCREEN_PATH)}
          />
        </PageFrame>
      );
    case 'processing':
    case 'failed':
      return (
        <PageFrame {...frame} header={<PageHeader title={t('transactionProcessingHeader')} onClose={goHome} />}>
          {screen.kind === 'failed' ? (
            <DepositProcessingView
              sent={sent}
              received={received}
              activeStep={1}
              slow={false}
              failure={failureOf(screen.reason)}
            />
          ) : (
            <DepositProcessingView sent={sent} received={received} activeStep={screen.step} slow={false} />
          )}
        </PageFrame>
      );
    case 'address': {
      const status = ((): DepositAddressStatus => {
        switch (screen.state) {
          case 'waiting':
            return { kind: 'waiting' };
          case 'incomplete':
            return { kind: 'partial', received: nearIntentsDepositedValue(tracking) };
          case 'expired':
            return {
              kind: 'failed',
              title: t('nearIntentsStatusExpired'),
              reason: t('depositFlowNearExpiredBody'),
              errorId: null,
              hideAddress: true
            };
        }
      })();
      const deadline = depositDeadlineMs(tracking);
      return (
        <PageFrame
          {...frame}
          header={
            <PageHeader
              title={
                layout === 'extension'
                  ? t('depositFlowDepositTokenTitle', { token: origin.symbol })
                  : t('depositFlowDetailsTitle')
              }
              onBack={back}
              onClose={goHome}
            />
          }
          testId="near-intents-deposit-address"
        >
          <DepositAddressView
            layout={layout}
            address={depositAddress}
            amount={sentValue}
            sourceToken={{ symbol: origin.symbol, logoFaucetId }}
            network={{ id: chainLogoNetwork(origin.blockchain), name: chainName }}
            received={receivedValue}
            receivedToken={{ symbol: tracking.destinationAsset.symbol, logoFaucetId }}
            bridgeFee={bridgeFee}
            routeName={routeName}
            arrivesIn={t('nearIntentsTimeEstimate', { minutes: arrivalMinutes(tracking.quote.quote.timeEstimate) })}
            status={status}
            expiresAt={Number.isFinite(deadline) ? deadline : undefined}
            ownAddress={false}
            memo={tracking.depositMemo}
            onShowQr={() => setQrSheetOpen(true)}
            onOpenWallet={walletLinks.length > 0 ? () => setWalletSheetOpen(true) : undefined}
          />
          <DepositQrSheet open={qrSheetOpen} onOpenChange={setQrSheetOpen} value={depositAddress} />
          <OpenWalletSheet
            open={walletSheetOpen}
            onOpenChange={setWalletSheetOpen}
            links={walletLinks}
            onOpenWallet={openWallet}
          />
        </PageFrame>
      );
    }
  }
};

interface PageFrameProps {
  /** The tracking phase, on the page box for the end-to-end suites (`data-phase`). */
  phase: IOneClickTrackingData['phase'];
  /** The full deposit address, on the page box for the end-to-end suites: the extension layout shows it short. */
  address: string;
  header?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}

/** The page box of every screen: the header (when the screen has one) over the view, as the Deposit flow draws it. */
const PageFrame: React.FC<PageFrameProps> = ({ phase, address, header, testId, children }) => (
  <div
    className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg text-ink"
    data-testid="near-intents-deposit-page"
    data-phase={phase}
    data-deposit-address={address}
  >
    {header && <div className="shrink-0 px-4">{header}</div>}
    <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden" data-testid={testId}>
      {children}
    </div>
  </div>
);

export default NearIntentsDepositPage;
