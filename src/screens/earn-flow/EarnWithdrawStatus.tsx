import React, { useEffect, useRef } from 'react';

import { useTranslation } from 'react-i18next';
import { useSWRConfig } from 'swr';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { usePageMountedByReturn, usePageRevealedByLayer } from 'app/layouts/page-active';
import { earnWithdrawAmountFields, formatMoneyAmount } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { accentForTransactionType } from 'components/flow/accent';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { StatusBadge } from 'components/ui/StatusBadge';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { marketUidChainId } from 'lib/epoch/market-uid';
import { IEarnWithdrawExtraInputs } from 'lib/miden/db/types';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { useWalletStore } from 'lib/store';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { cn } from 'lib/ui/util';
import { HistoryAction, navigate, useLocation } from 'lib/woozie';
import { networkName } from 'screens/earn-flow/earn-mapping';
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
  const { trigger, state } = useLocation();
  const mountedByReturn = usePageMountedByReturn();
  const revealedByLayer = usePageRevealedByLayer();
  const newSubmission =
    trigger === HistoryAction.Push && state?.newSubmissionTxId === txId && !mountedByReturn && !revealedByLayer;
  // The spinner is not a nonfailed row: the first database result may already be a persisted failure.
  const firstLoadedFailed = useRef<boolean>();
  if (loaded && row && firstLoadedFailed.current === undefined) {
    firstLoadedFailed.current = row.extraInputs.phase === 'failed';
  }
  useUserVisibleError(
    loaded && row?.extraInputs.phase === 'failed' && (firstLoadedFailed.current === false || newSubmission)
      ? 'raw_earn_withdraw_failed'
      : null,
    'status_screen'
  );
  const { mutate } = useSWRConfig();
  const refreshedReceipt = useRef<string>();
  const receiptId = row?.extraInputs?.phase === 'received' ? row.id : undefined;
  const receiptAccountId = row?.accountId;
  useEffect(() => {
    if (!receiptId || !receiptAccountId || refreshedReceipt.current === receiptId) return;
    refreshedReceipt.current = receiptId;
    // Drop the old position snapshot as the real credit arrives. Active readers refresh now;
    // a covered Earn page reloads when it returns, even within its normal 30-second read interval.
    void mutate(key => Array.isArray(key) && key[0] === 'earn-positions' && key[1] === receiptAccountId, undefined, {
      revalidate: true
    });
  }, [receiptId, receiptAccountId, mutate]);
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const onDone = () => navigate('/');

  if (!loaded || !row)
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );

  const inputs: IEarnWithdrawExtraInputs = row.extraInputs;
  const sourceChainId = typeof inputs.marketUid === 'string' ? marketUidChainId(inputs.marketUid) : undefined;
  const sourceNetwork = sourceChainId === undefined ? t('network') : networkName(String(sourceChainId));
  const failed = inputs.phase === 'failed';
  const prepared = inputs.submissionState === 'prepared';
  const submitted =
    inputs.submissionState === 'accepted' ||
    (inputs.submissionState === undefined && Boolean(inputs.withdrawIntentNonce)) ||
    inputs.phase === 'delivering' ||
    inputs.phase === 'received';
  const amountLabel = `${formatMoneyAmount(inputs.sourceAmount, 'receives', inputs.sourceSymbol)} ${inputs.sourceSymbol}`;
  // Once received, the arrow points at what was credited, as the Activity row shows it. Until the
  // delivered faucet's scale is known it stays on the network: the row's output symbol is the
  // bridged source token, so it cannot name what arrived.
  const delivered = resolveDisplayMetadata(row.faucetId, assetsMetadata, nativeFaucetId);
  const credited =
    inputs.phase === 'received' && row.amount !== undefined && hasKnownScale(delivered)
      ? earnWithdrawAmountFields(inputs, row.amount, delivered)
      : undefined;
  const destinationLabel = credited
    ? [credited.amount, credited.token].filter(part => part !== undefined).join(' ')
    : 'Miden';

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
        <TransactionSummaryBadge
          lhs={amountLabel}
          rhs={destinationLabel}
          fillForArrow={EARN_ARROW_FILL}
          className="mt-4 face-heading"
        />
        <ReceiptRows
          surface="outline"
          face="heading"
          className="mt-4"
          rows={[
            // The source chain is the market's own, read from the row's market uid, never a fixed network.
            { label: t('route'), value: `${sourceNetwork} → Miden` },
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
    // The shared pushed-page frame, like every other earn page: header, body, pinned action.
    <SubPageLayout
      data-testid="earn-withdraw-status-page"
      title={t('transactionProcessingHeader')}
      onClose={onDone}
      footer={
        <Button
          type="button"
          variant={ButtonVariant.Primary}
          accent="earn"
          onClick={onDone}
          className="w-full max-w-none"
        >
          {failed ? t('done') : t('hide')}
        </Button>
      }
    >
      <section className="flex flex-1 flex-col items-center pt-5">
        <Hero
          visual={<TransactionHeroIcon state={failed ? 'failed' : 'processing'} accent="earn" />}
          name={failed ? t('withdrawalFailed') : t('withdrawalProcessing')}
        />
        <TransactionSummaryBadge lhs={amountLabel} rhs="Miden" fillForArrow={EARN_ARROW_FILL} className="mt-4" />
        {/* The `Hero`'s own secondary line; an error takes the negative ink, as on every other
            screen that reports one, and wraps a raw error's unbreakable token inside the margin. */}
        <p
          className={cn(
            'mt-4 w-full text-center text-body-sm wrap-anywhere select-text',
            failed ? 'text-negative-ink' : 'text-muted'
          )}
        >
          {failed
            ? (inputs.error ?? t('transactionErrorDescription'))
            : t(prepared ? 'withdrawalCheckingDescription' : 'withdrawalProcessingDescription')}
        </p>
      </section>
    </SubPageLayout>
  );
};

export default EarnWithdrawStatus;
