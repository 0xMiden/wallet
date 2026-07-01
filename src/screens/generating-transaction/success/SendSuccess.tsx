import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';
import { navigate } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

import { buildReceiptRows } from './receipt';
import {
  ReceiptRows,
  SuccessDivider,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptAmount
} from './TransactionSuccessLayout';

/**
 * "Payment Sent!" send receipt — and the fallback for every other transaction
 * type that doesn't have a bespoke success view (plain in-network send,
 * consume/claim, execute, guardian ops, …). Shows a summary pill
 * ("amount → recipient") plus the recipient, total paid and source-tx rows
 * where that data is available.
 */
export const SendSuccess: FC<TransactionSuccessProps> = ({ transaction, txHash, onDoneClick, onViewExplorer }) => {
  const { t } = useTranslation();
  const { amountText } = useReceiptAmount(transaction);
  const destinationAddress = transaction?.secondaryAccountId;
  const recipient = destinationAddress ? truncateAddress(destinationAddress, false, 8, 8) : undefined;

  const rows = useMemo(
    () => buildReceiptRows(t, { destinationAddress, amountText, txHash, onViewExplorer }),
    [amountText, destinationAddress, onViewExplorer, t, txHash]
  );

  // "Payment Sent!" reads wrong for claim/guardian ops that fall through here.
  const title =
    transaction?.type === 'send'
      ? t('paymentSent', { defaultValue: 'Payment Sent!' })
      : t('transactionComplete', { defaultValue: 'Transaction Complete!' });

  return (
    <TransactionSuccessLayout
      headerTitle=""
      title={title}
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
