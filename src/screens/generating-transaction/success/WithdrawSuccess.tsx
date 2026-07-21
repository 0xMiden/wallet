import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { formatEarnWithdrawAmount } from 'app/templates/history/transactionUtils';
import { ButtonVariant } from 'components/Button';
import { IEarnWithdrawExtraInputs } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';

import {
  SuccessDivider,
  SuccessSummaryPill,
  TransactionSuccessLayout,
  TransactionSuccessProps
} from './TransactionSuccessLayout';

/**
 * "Withdrawal Started!" receipt for a Smart Withdraw (`earn-withdraw`). Shown
 * once the Epoch redeem intent is accepted — the bridged funds are still in
 * flight, so the amount comes from `extraInputs.sourceAmount`/`sourceSymbol`
 * (the row's atomic `amount` is native-asset base units — wrong decimals for a
 * USDC hero) and there is no Miden tx hash to link. Delivery keeps tracking in
 * Activity (Redeeming → Delivering → Received).
 */
export const WithdrawSuccess: FC<TransactionSuccessProps> = ({ transaction, onDoneClick }) => {
  const { t } = useTranslation();
  const inputs = transaction?.extraInputs as IEarnWithdrawExtraInputs | undefined;
  const amountText = inputs ? `${formatEarnWithdrawAmount(inputs.sourceAmount)} ${inputs.sourceSymbol}` : undefined;

  return (
    <TransactionSuccessLayout
      headerTitle=""
      title={t('withdrawalStarted', { defaultValue: 'Withdrawal Started!' })}
      primaryAction={{ label: t('done'), onClick: onDoneClick, variant: ButtonVariant.Primary }}
      secondaryAction={{
        label: t('viewInActivities'),
        onClick: () => navigate('/history'),
        variant: ButtonVariant.Secondary
      }}
      onClose={onDoneClick}
    >
      <SuccessSummaryPill lhs={amountText} rhs="Miden" />
      <SuccessDivider />
      <p className="mt-6 w-full text-center text-sm font-medium text-gray">
        {t('withdrawalStartedDescription', {
          defaultValue: 'Your funds are being bridged back to Miden. Track delivery in Activity.'
        })}
      </p>
    </TransactionSuccessLayout>
  );
};
