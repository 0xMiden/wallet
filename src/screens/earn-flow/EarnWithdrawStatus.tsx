import React from 'react';

import { useTranslation } from 'react-i18next';

import { formatEarnWithdrawAmount } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { accentForTransactionType } from 'components/flow/accent';
import { PageHeader } from 'components/PageHeader';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { StatusBadge } from 'components/ui/StatusBadge';
import { IEarnWithdrawExtraInputs } from 'lib/miden/db/types';
import { cn } from 'lib/ui/util';
import { navigate } from 'lib/woozie';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { ReceiptRows, TransactionSuccessLayout } from 'screens/generating-transaction/success/TransactionSuccessLayout';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

/**
 * An earn row's icon is the earn slate wherever it is drawn, so the arrow beside it is too; the
 * badge's default is the Send blue, another flow's colour.
 */
const EARN_ARROW_FILL = 'var(--tx-earn)';

interface EarnWithdrawStatusProps {
  txId: string;
}

/**
 * Smart Withdraw post-review status screen - mirrors `EvmBridgeDepositStatus`
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

  if (!loaded || !row)
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );

  const inputs: IEarnWithdrawExtraInputs = row.extraInputs;
  const failed = inputs.phase === 'failed';
  const prepared = inputs.submissionState === 'prepared';
  const submitted =
    inputs.submissionState === 'accepted' ||
    (inputs.submissionState === undefined && Boolean(inputs.withdrawIntentNonce)) ||
    inputs.phase === 'delivering' ||
    inputs.phase === 'received';
  const amountLabel = `${formatEarnWithdrawAmount(inputs.sourceAmount)} ${inputs.sourceSymbol}`;

  if (submitted && !failed) {
    return (
      <TransactionSuccessLayout
        headerTitle={t('success')}
        title={t('withdrawalStarted')}
        footerDescription={t('withdrawalStartedDescription')}
        accent={accentForTransactionType('earn-withdraw')}
        primaryAction={{ label: t('done'), onClick: onDone }}
        secondaryAction={{
          label: t('viewInActivities'),
          onClick: () => navigate('/history'),
          variant: ButtonVariant.Secondary
        }}
        onClose={onDone}
      >
        <TransactionSummaryBadge lhs={amountLabel} rhs="Miden" fillForArrow={EARN_ARROW_FILL} className="mt-4" />
        <ReceiptRows
          className="mt-4"
          rows={[
            { label: t('route'), value: 'Sepolia → Miden' },
            {
              label: t('status'),
              // A status word is a `StatusBadge`, never a bare line of text: the closed set
              // already carries these three and picks each one's tone and label.
              value: (
                <StatusBadge
                  status={
                    inputs.phase === 'received'
                      ? 'received'
                      : inputs.phase === 'delivering'
                        ? 'delivering'
                        : 'redeeming'
                  }
                  live
                  data-testid="earn-withdraw-status-badge"
                />
              )
            }
          ]}
        />
      </TransactionSuccessLayout>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-app-bg px-4 text-ink">
      <PageHeader title={t('transactionProcessingHeader')} onClose={onDone} />
      <main className="flex flex-1 flex-col">
        <section className="flex flex-1 flex-col items-center pt-5">
          <Hero
            visual={<TransactionHeroIcon state={failed ? 'failed' : 'processing'} />}
            name={failed ? t('withdrawalFailed') : t('withdrawalProcessing')}
          />
          <TransactionSummaryBadge lhs={amountLabel} rhs="Miden" fillForArrow={EARN_ARROW_FILL} className="mt-4" />
          {/* The `Hero`'s own secondary line; an error takes the negative ink, as on every other
              screen that reports one. */}
          <p className={cn('mt-4 text-center text-body-sm', failed ? 'text-negative-ink' : 'text-muted')}>
            {failed
              ? (inputs.error ?? t('transactionErrorDescription'))
              : t(prepared ? 'withdrawalCheckingDescription' : 'withdrawalProcessingDescription')}
          </p>
        </section>
        <div className="w-full shrink-0 pt-10 pb-6">
          <Button
            type="button"
            variant={ButtonVariant.Primary}
            accent="earn"
            onClick={onDone}
            className="w-full max-w-none"
          >
            {failed ? t('done') : t('hide')}
          </Button>
        </div>
      </main>
    </div>
  );
};

export default EarnWithdrawStatus;
