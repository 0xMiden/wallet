import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';
import { IBridgedSendExtraInputs } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { bridgeRouteValue, bridgeSpeedLabel, buildReceiptRows } from './receipt';
import {
  ReceiptRows,
  SuccessDivider,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptAmount
} from './TransactionSuccessLayout';

export interface BridgeSuccessProps extends TransactionSuccessProps {
  /** Typed bridged-send payload, narrowed by the dispatcher. */
  bridgedInputs: IBridgedSendExtraInputs;
}

/**
 * Success receipt for a send that was routed out of Miden through a bridge.
 * Adds an "Arriving on Ethereum" sub-line (with a FAST/SLOW speed badge) under
 * the amount and a "Route" row naming the provider, on top of the shared
 * recipient / total-paid / source-tx rows.
 */
export const BridgeSuccess: FC<BridgeSuccessProps> = ({
  transaction,
  txHash,
  onDoneClick,
  onViewExplorer,
  bridgedInputs
}) => {
  const { t } = useTranslation();
  // A bridged send pays a network fee on the Miden side like any other send, and
  // `complete.ts` records it on the row -- it was simply never read here.
  const { amountText, feeText } = useReceiptAmount(transaction);
  const destinationAddress = bridgedInputs.destinationAddress ?? transaction?.secondaryAccountId;
  const recipient = destinationAddress ? truncateAddress(destinationAddress, false, 8, 8) : undefined;

  const rows = useMemo(
    () =>
      buildReceiptRows(t, {
        destinationAddress,
        amountText,
        feeText,
        txHash,
        onViewExplorer,
        route: bridgeSpeedLabel(t, bridgedInputs.provider),
        routeSub: bridgeRouteValue(t, bridgedInputs.provider)
      }),
    [amountText, bridgedInputs.provider, destinationAddress, feeText, onViewExplorer, t, txHash]
  );

  return (
    <TransactionSuccessLayout
      headerTitle=""
      title={t('paymentSent', { defaultValue: 'Payment Sent!' })}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewInActivities'),
        onClick: () => navigate('/history'),
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    >
      <SuccessSummaryPill lhs={amountText} rhs={recipient} />
      <SuccessDivider />
      <ReceiptRows rows={rows} className="mt-2" />
    </TransactionSuccessLayout>
  );
};
