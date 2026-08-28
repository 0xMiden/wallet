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
 * ("amount → recipient") plus the recipient, total paid and transaction-id rows
 * where that data is available. Consume/claim rows relabel the receipt: the
 * address is the note sender ("From"), the amount is "Total Consumed", and the
 * claimed note ids get their own "Notes Consumed" row.
 */
export const SendSuccess: FC<TransactionSuccessProps> = ({ transaction, txHash, onDoneClick, onViewExplorer }) => {
  const { t } = useTranslation();
  const { amountText, feeText } = useReceiptAmount(transaction);
  const isConsume = transaction?.type === 'consume';
  const destinationAddress = transaction?.secondaryAccountId;
  const recipient = destinationAddress ? truncateAddress(destinationAddress, false, 8, 8) : undefined;
  const noteIds = useMemo(() => {
    if (!isConsume) return undefined;
    if (transaction?.noteIds?.length) return transaction.noteIds;
    return transaction?.noteId ? [transaction.noteId] : undefined;
  }, [isConsume, transaction?.noteId, transaction?.noteIds]);

  const rows = useMemo(
    () =>
      buildReceiptRows(t, {
        destinationAddress,
        destinationLabel: isConsume ? t('from') : undefined,
        amountText,
        amountLabel: isConsume ? t('totalConsumed', { defaultValue: 'Total Consumed' }) : undefined,
        noteIds,
        feeText,
        txHash,
        onViewExplorer
      }),
    [amountText, destinationAddress, feeText, isConsume, noteIds, onViewExplorer, t, txHash]
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
      <SuccessSummaryPill lhs={amountText} rhs={isConsume ? t('consumed', { defaultValue: 'Consumed' }) : recipient} />
      <SuccessDivider />
      <ReceiptRows rows={rows} className="mt-2" />
    </TransactionSuccessLayout>
  );
};
