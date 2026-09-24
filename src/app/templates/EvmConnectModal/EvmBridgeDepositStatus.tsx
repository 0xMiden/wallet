import React from 'react';

import { useTranslation } from 'react-i18next';

import { TRANSACTION_COLORS } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { IBridgedReceiveExtraInputs } from 'lib/miden/db/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { ReceiptRows, TransactionSuccessLayout } from 'screens/generating-transaction/success/TransactionSuccessLayout';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

interface EvmBridgeDepositStatusProps {
  txId: string;
  onDone: () => void;
}

/** Bridge-specific post-review progress/failure/success screen. */
export const EvmBridgeDepositStatus: React.FC<EvmBridgeDepositStatusProps> = ({ txId, onDone }) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(txId);

  if (!loaded || !row)
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );

  const inputs = row.extraInputs as IBridgedReceiveExtraInputs;
  const failed = inputs.phase === 'failed';
  const submitted = inputs.phase === 'delivering' || inputs.phase === 'ready' || inputs.phase === 'received';
  const routeLabel = inputs.provider === 'epoch' ? t('fast') : t('slow');

  if (submitted) {
    const viewExplorer = inputs.evmTxHash
      ? () =>
          openExternalUrl({
            url: `https://sepolia.etherscan.io/tx/${inputs.evmTxHash}`,
            title: 'Etherscan'
          })
      : undefined;
    return (
      <TransactionSuccessLayout
        headerTitle={t('success')}
        title={t('bridgeDepositSubmitted')}
        footerDescription={t('bridgeDepositDeliveryDescription')}
        primaryAction={{ label: t('done'), onClick: onDone }}
        secondaryAction={
          viewExplorer
            ? { label: t('viewOnEtherscan'), onClick: viewExplorer, variant: ButtonVariant.Secondary }
            : undefined
        }
        onClose={onDone}
      >
        {/* A bridge-in row wears the bridge slate in Activity and on its detail page, so its
            arrow does too — the badge's default is the Send blue, which is another flow's colour
            on a screen about money arriving. */}
        <TransactionSummaryBadge
          lhs={`${inputs.sourceAmount} ${inputs.sourceSymbol}`}
          rhs={inputs.outputAmount ? `${inputs.outputAmount} ${inputs.outputSymbol ?? ''}`.trim() : 'Miden'}
          fillForArrow={TRANSACTION_COLORS.bridge}
          className="mt-4"
        />
        <ReceiptRows
          className="mt-4"
          rows={[
            { label: t('route'), value: `${routeLabel} · Sepolia → Miden` },
            {
              label: t('status'),
              value:
                inputs.phase === 'received'
                  ? t('received')
                  : inputs.phase === 'ready'
                    ? t('confirmed')
                    : t('delivering')
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
            name={failed ? t('bridgeDepositFailed') : t('bridgeDepositProcessing')}
          />
          <TransactionSummaryBadge
            lhs={`${inputs.sourceAmount} ${inputs.sourceSymbol}`}
            rhs="Miden"
            fillForArrow={TRANSACTION_COLORS.bridge}
            className="mt-4"
          />
          <p className="mt-4 text-center text-sm font-medium text-ink">
            {failed ? (inputs.error ?? t('transactionErrorDescription')) : t('bridgeDepositProcessingDescription')}
          </p>
        </section>
        <div className="w-full shrink-0 pt-10">
          <Button type="button" variant={ButtonVariant.Primary} onClick={onDone} className="w-full">
            {failed ? t('done') : t('hide')}
          </Button>
        </div>
      </main>
    </div>
  );
};
