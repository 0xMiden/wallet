import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';

import { buildReceiptRows } from './receipt';
import {
  ReceiptRows,
  SuccessAmountBlock,
  SuccessDivider,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptAmount
} from './TransactionSuccessLayout';

/**
 * "Transaction Complete!" send receipt — and the fallback for every other
 * transaction type that doesn't have a bespoke success view (plain in-network
 * send, consume/claim, execute, guardian ops, …). Shows the amount, recipient,
 * total paid and source-tx rows where that data is available.
 */
export const SendSuccess: FC<TransactionSuccessProps> = ({ transaction, txHash, onDoneClick, onViewExplorer }) => {
  const { t } = useTranslation();
  const { amountText } = useReceiptAmount(transaction);
  const destinationAddress = transaction?.secondaryAccountId;

  const rows = useMemo(
    () => buildReceiptRows(t, { destinationAddress, amountText, txHash, onViewExplorer }),
    [amountText, destinationAddress, onViewExplorer, t, txHash]
  );

  return (
    <TransactionSuccessLayout
      headerTitle={t('success', { defaultValue: 'Success!' })}
      title={t('transactionComplete', { defaultValue: 'Transaction Complete!' })}
      footerDescription={t('transactionSuccessDescription')}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      onClose={onDoneClick}
    >
      <SuccessDivider />
      <SuccessAmountBlock amountText={amountText} />
      <ReceiptRows rows={rows} className="mt-4" />
    </TransactionSuccessLayout>
  );
};
