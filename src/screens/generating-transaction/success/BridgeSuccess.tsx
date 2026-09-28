import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { TRANSACTION_COLORS } from 'app/templates/history/transactionUtils';
import { ButtonVariant } from 'components/Button';
import { accentForTransactionType } from 'components/flow/accent';
import { IBridgedSendExtraInputs } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { bridgeRouteValue, bridgeSpeedLabel, buildReceiptRows } from './receipt';
import {
  ReceiptRows,
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
      accent={accentForTransactionType(transaction?.type)}
      title={t('paymentSent', { defaultValue: 'Payment Sent!' })}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewInActivities'),
        onClick: () => navigate('/history'),
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    >
      {/* A bridged send is drawn in the bridge slate everywhere it is listed — the Activity row's
          glyph, its detail page's section rule — so its arrow is too. The page around it keeps the
          Send flow's colour, which is the flow the user came through; the arrow is the one mark
          that names the transaction, and the badge's default names a plain send. */}
      <SuccessSummaryPill lhs={amountText} rhs={recipient} fillForArrow={TRANSACTION_COLORS.bridge} />
      <ReceiptRows rows={rows} className="mt-6" />
    </TransactionSuccessLayout>
  );
};
