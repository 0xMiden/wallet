import React from 'react';

import { useTranslation } from 'react-i18next';

import { ActivitySpinner } from 'app/atoms/ActivitySpinner';
import { formatEarnWithdrawAmount } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { IEarnWithdrawExtraInputs } from 'lib/miden/db/types';
import { navigate } from 'lib/woozie';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { ReceiptRows, TransactionSuccessLayout } from 'screens/generating-transaction/success/TransactionSuccessLayout';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

interface EarnWithdrawStatusProps {
  txId: string;
}

/**
 * Smart Withdraw post-review status screen — mirrors `EvmBridgeDepositStatus`
 * (there is NO Miden-side transaction: the withdraw is a gasless EVM intent
 * sign, so the prove/submit step screen would be theatre). Observes the
 * tracking row: spinner while the intent is being signed/submitted, a failure
 * state on phase `failed`, and the "Withdrawal Started!" success layout once
 * the Epoch intent is accepted (nonce recorded). Delivery keeps tracking in
 * Activity (Redeeming → Delivering → Received).
 */
export const EarnWithdrawStatus: React.FC<EarnWithdrawStatusProps> = ({ txId }) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(txId);
  const onDone = () => navigate('/');

  if (!loaded || !row) return <ActivitySpinner />;

  const inputs = row.extraInputs as IEarnWithdrawExtraInputs;
  const failed = inputs.phase === 'failed';
  const submitted = Boolean(inputs.withdrawIntentNonce) || inputs.phase === 'delivering' || inputs.phase === 'received';
  const amountLabel = `${formatEarnWithdrawAmount(inputs.sourceAmount)} ${inputs.sourceSymbol}`;

  if (submitted && !failed) {
    return (
      <TransactionSuccessLayout
        headerTitle={t('success')}
        title={t('withdrawalStarted')}
        footerDescription={t('withdrawalStartedDescription')}
        primaryAction={{ label: t('done'), onClick: onDone }}
        secondaryAction={{
          label: t('viewInActivities'),
          onClick: () => navigate('/history'),
          variant: ButtonVariant.Secondary
        }}
        onClose={onDone}
      >
        <TransactionSummaryBadge lhs={amountLabel} rhs="Miden" className="mt-4" />
        <ReceiptRows
          className="mt-4"
          rows={[
            { label: t('route'), value: 'Sepolia → Miden' },
            {
              label: t('status'),
              value:
                inputs.phase === 'received'
                  ? t('received')
                  : inputs.phase === 'delivering'
                    ? t('earnWithdrawStatusDelivering')
                    : t('earnWithdrawStatusRedeeming')
            }
          ]}
        />
      </TransactionSuccessLayout>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-app-bg px-4 text-heading-gray">
      <ScreenHeader title={t('transactionProcessingHeader')} closeLabel={t('close')} onClose={onDone} />
      <main className="flex flex-1 flex-col">
        <section className="flex flex-1 flex-col items-center pt-5">
          <TransactionHeroIcon state={failed ? 'failed' : 'processing'} />
          <h2 className="mt-6 text-center font-heading text-[2rem] font-bold leading-none">
            {failed ? t('withdrawalFailed') : t('withdrawalProcessing')}
          </h2>
          <TransactionSummaryBadge lhs={amountLabel} rhs="Miden" className="mt-4" />
          <p className="mt-4 text-center text-sm font-medium text-heading-gray">
            {failed ? (inputs.error ?? t('transactionErrorDescription')) : t('withdrawalProcessingDescription')}
          </p>
        </section>
        <div className="w-full shrink-0 pt-10 pb-6">
          <Button type="button" variant={ButtonVariant.Primary} onClick={onDone} className="w-full max-w-none">
            {failed ? t('done') : t('hide')}
          </Button>
        </div>
      </main>
    </div>
  );
};

export default EarnWithdrawStatus;
