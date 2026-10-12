import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { ButtonVariant } from 'components/Button';
import { IRegisterNameExtraInputs } from 'lib/miden/db/types';
import { formatMidenName } from 'lib/miden/name/encoding';
import { navigate } from 'lib/woozie';

import { useTransactionSummaryBadgeContent } from '../TransactionSummaryBadge';
import { buildReceiptRows } from './receipt';
import {
  ReceiptRows,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps,
  useReceiptFeeText
} from './TransactionSuccessLayout';

/**
 * Receipt for a completed `register-name` row. The transaction only sends the
 * request to the registry: the name is not in the account yet. Thus the
 * secondary action opens the status page, which follows the registration to
 * the end.
 *
 * The pill and the price row use the same data as the in-progress badge, so
 * the price does not change when the receipt replaces the badge.
 */
export const MidenNameSuccess: FC<TransactionSuccessProps> = ({ transaction, txHash, onDoneClick, onViewExplorer }) => {
  const { t } = useTranslation();
  const badgeContent = useTransactionSummaryBadgeContent(transaction);
  const feeText = useReceiptFeeText(transaction);

  const inputs: IRegisterNameExtraInputs | undefined = transaction?.extraInputs;
  const name = inputs?.label ? formatMidenName(inputs.label) : undefined;
  const priceText = typeof badgeContent?.rhs === 'string' ? badgeContent.rhs : undefined;
  const txId = transaction?.id;

  const rows = useMemo(() => {
    const receiptRows = buildReceiptRows(t, {
      amountText: priceText,
      amountLabel: t('totalPaid', { defaultValue: 'Total Paid' }),
      feeText,
      txHash,
      onViewExplorer
    });
    if (name) {
      receiptRows.unshift({ label: t('midenNameReceiptName'), value: name });
    }
    return receiptRows;
  }, [feeText, name, onViewExplorer, priceText, t, txHash]);

  return (
    <TransactionSuccessLayout
      headerTitle=""
      title={t('midenNameStepRequestSent')}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={
        txId
          ? {
              label: t('midenNameViewStatus'),
              onClick: () => navigate(`/miden-name/status/${txId}`),
              variant: ButtonVariant.Secondary
            }
          : undefined
      }
      onClose={onDoneClick}
    >
      <SuccessSummaryPill lhs={badgeContent?.lhs} rhs={badgeContent?.rhs} separator={badgeContent?.separator} />
      <ReceiptRows rows={rows} className="mt-6" />
    </TransactionSuccessLayout>
  );
};
