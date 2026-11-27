import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { TRANSACTION_COLORS } from 'app/templates/history/transactionUtils';
import { ButtonVariant } from 'components/Button';
import { accentForTransactionType } from 'components/flow/accent';
import { ErrorDetails } from 'components/ui/ErrorDetails';
import { IOneClickTrackingData } from 'lib/miden/db/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { navigate } from 'lib/woozie';
import { truncateHash } from 'utils/string';

import { TransactionHeroIcon } from '../components';
import {
  nearIntentsDeliveredText,
  nearIntentsDeliveryFailureKeys,
  nearIntentsDeliveryOutcome,
  nearIntentsDeliveryReason,
  nearIntentsDestinationName,
  nearIntentsMinimumText,
  nearIntentsOutputText,
  nearIntentsQuotedText,
  nearIntentsSentText
} from '../helper';
import {
  ReceiptRow,
  ReceiptRows,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptFeeText
} from './TransactionSuccessLayout';

export interface NearIntentsSendSuccessProps extends TransactionSuccessProps {
  /** The 1Click tracking of the send, narrowed by the dispatcher. */
  tracking: IOneClickTrackingData;
}

/** An explorer link that 1Click gives. Only an https link opens; any other value gives no link. */
const httpsUrl = (url: string): string | undefined => (/^https:\/\/[^\s]+$/.test(url) ? url : undefined);

/**
 * Receipt of a send through NEAR Intents, shown when the Miden transaction to the deposit address completes. The
 * funds are then sent; the delivery on the destination chain continues and Activity follows it, so the first action
 * opens the row's detail page. The rows that depend on the delivery (the amount the recipient got, the destination
 * transaction) show only when 1Click has reported them; before that the quote's amount shows as an estimate, with
 * its minimum. A row that 1Click already refunded or failed keeps that title and reason.
 */
export const NearIntentsSendSuccess: FC<NearIntentsSendSuccessProps> = ({
  transaction,
  txHash,
  onDoneClick,
  onViewExplorer,
  tracking
}) => {
  const { t } = useTranslation();
  const feeText = useReceiptFeeText(transaction);
  // From the row's own quote, never from `assetsMetadata`: the wallet can have no metadata for the faucet yet.
  const sentText = nearIntentsSentText(tracking);
  const deliveredText = nearIntentsDeliveredText(tracking);
  const quotedText = nearIntentsQuotedText(tracking);
  const minimumText = nearIntentsMinimumText(tracking);
  const networkName = nearIntentsDestinationName(tracking);
  const destinationTx = tracking.statusResponse?.swapDetails.destinationChainTxHashes[0];
  const destinationUrl = destinationTx ? httpsUrl(destinationTx.explorerUrl) : undefined;
  const outcome = nearIntentsDeliveryOutcome(tracking.phase);
  const failure = outcome === 'failed' ? nearIntentsDeliveryFailureKeys(tracking.phase) : undefined;

  const rows = useMemo(() => {
    const list: ReceiptRow[] = [
      { label: t('to'), value: tracking.request.recipient, stacked: true },
      { label: t('network'), value: networkName },
      { label: t('transactionRoute', { defaultValue: 'Route' }), value: t('bridgeRouteNearIntents') }
    ];
    if (sentText) list.push({ label: t('totalPaid', { defaultValue: 'Total Paid' }), value: sentText });
    if (deliveredText) {
      list.push({ label: t('nearIntentsYouReceived'), value: deliveredText });
    } else {
      if (quotedText) list.push({ label: t('nearIntentsSendExpectedAmount'), value: `≈ ${quotedText}` });
      if (minimumText) list.push({ label: t('oneClickMinimumReceived'), value: minimumText });
    }
    if (feeText) list.push({ label: t('networkFee'), value: feeText });
    if (destinationTx) {
      list.push({
        label: t('nearIntentsDestinationTransaction'),
        value: truncateHash(destinationTx.hash, 6, 4),
        onClick: destinationUrl ? () => openExternalUrl({ url: destinationUrl, title: networkName }) : undefined,
        actionLabel: t('nearIntentsViewOnExplorer', { network: networkName })
      });
    }
    if (txHash) {
      list.push({
        label: t('sourceTx', { defaultValue: 'Transaction ID' }),
        value: truncateHash(txHash, 6, 4),
        onClick: onViewExplorer,
        actionLabel: t('viewOnMidenscan')
      });
    }
    return list;
  }, [
    deliveredText,
    destinationTx,
    destinationUrl,
    feeText,
    minimumText,
    networkName,
    onViewExplorer,
    quotedText,
    sentText,
    t,
    tracking.request.recipient,
    txHash
  ]);

  const description = (() => {
    switch (outcome) {
      case 'failed':
        return failure ? t(failure.description) : undefined;
      case 'delivered':
        return t('nearIntentsSendDeliveredDescription', { network: networkName });
      case 'pending':
        return t('nearIntentsSendSentDescription', { network: networkName });
    }
  })();
  const reason = failure ? nearIntentsDeliveryReason(tracking) : undefined;

  return (
    <TransactionSuccessLayout
      headerTitle=""
      accent={accentForTransactionType(transaction?.type)}
      hero={failure ? <TransactionHeroIcon state="failed" /> : undefined}
      title={failure ? t(failure.title) : t('paymentSent', { defaultValue: 'Payment Sent!' })}
      footerDescription={description}
      // Activity follows the delivery (the app-root `BridgeIntentWatcher` keeps its status current), so it comes first.
      primaryAction={{
        label: t('viewInActivities'),
        onClick: () => navigate(transaction ? `/history-details/${transaction.id}` : '/history'),
        variant: ButtonVariant.Primary
      }}
      secondaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Secondary }}
      onClose={onDoneClick}
    >
      {/* The bridge slate arrow, as a bridged send has: the payment left Miden. */}
      <SuccessSummaryPill
        lhs={sentText}
        rhs={nearIntentsOutputText(tracking)}
        fillForArrow={TRANSACTION_COLORS.bridge}
      />
      <ReceiptRows rows={rows} className="mt-6" />
      {reason !== undefined && <ErrorDetails details={reason} className="mt-2 w-full items-center" />}
    </TransactionSuccessLayout>
  );
};
