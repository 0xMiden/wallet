import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';
import { Hash, isHash } from 'viem';

import { usePageActive } from 'app/layouts/page-active';
import { TRANSACTION_COLORS } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { useBridgeTracker } from 'lib/agglayer/use-bridge-tracker';
import { IBridgedReceiveExtraInputs, IBridgeProvider } from 'lib/miden/db/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { fetchXReserveAttestations, findAttestationForDomain } from 'lib/usdcx/attestation';
import { USDCX_REMOTE_DOMAIN } from 'lib/usdcx/constant';
import { ATTESTATION_POLL_MS } from 'lib/usdcx/use-attestation';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { ReceiptRows, TransactionSuccessLayout } from 'screens/generating-transaction/success/TransactionSuccessLayout';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

interface EvmBridgeDepositStatusProps {
  txId: string;
  onDone: () => void;
}

/**
 * The deposit hash to poll Circle's attestation API for. Only a USDCx row that
 * is past its Sepolia receipt has one; the other routes have no attestation.
 */
function attestationHashOf(inputs: IBridgedReceiveExtraInputs | undefined): Hash | undefined {
  if (inputs === undefined || inputs.provider !== 'usdcx' || inputs.phase !== 'delivering') return undefined;
  const hash = inputs.evmTxHash;
  return hash !== undefined && isHash(hash) ? hash : undefined;
}

function routeLabelOf(provider: IBridgeProvider, t: (key: string) => string): string {
  switch (provider) {
    case 'epoch':
      return t('fast');
    case 'usdcx':
      return t('usdcxRouteName');
    case 'agglayer':
    default:
      return t('slow');
  }
}

/** Bridge-specific post-review progress/failure/success screen. */
export const EvmBridgeDepositStatus: React.FC<EvmBridgeDepositStatusProps> = ({ txId, onDone }) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(txId);
  const pageActive = usePageActive();
  const [attested, setAttested] = useState(false);

  const inputs: IBridgedReceiveExtraInputs | undefined = row?.extraInputs;
  const attestationHash = attestationHashOf(inputs);

  // Display only: nothing on the row changes when Circle signs, because no
  // Miden note is matched for this route yet. The poll stops on the first hit.
  useBridgeTracker({
    active: pageActive && attestationHash !== undefined && !attested,
    intervalMs: ATTESTATION_POLL_MS,
    poll: async () => {
      if (attestationHash === undefined) return false;
      const attestations = await fetchXReserveAttestations(attestationHash);
      return findAttestationForDomain(attestations, USDCX_REMOTE_DOMAIN) !== undefined;
    },
    onArrival: () => setAttested(true)
  });

  if (!loaded || !row || inputs === undefined)
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );

  const failed = inputs.phase === 'failed';
  const submitted = inputs.phase === 'delivering' || inputs.phase === 'ready' || inputs.phase === 'received';
  const routeLabel = routeLabelOf(inputs.provider, t);

  if (submitted) {
    const viewExplorer = inputs.evmTxHash
      ? () =>
          openExternalUrl({
            url: `https://sepolia.etherscan.io/tx/${inputs.evmTxHash}`,
            title: 'Etherscan'
          })
      : undefined;
    const statusValue = (() => {
      switch (inputs.phase) {
        case 'received':
          return t('received');
        case 'ready':
          return t('confirmed');
        default:
          return t('delivering');
      }
    })();
    const footerDescription = (() => {
      if (inputs.provider !== 'usdcx') return t('bridgeDepositDeliveryDescription');
      return attested ? t('usdcxAttested') : t('usdcxAwaitingAttestation');
    })();
    return (
      <TransactionSuccessLayout
        headerTitle={t('success')}
        title={t('bridgeDepositSubmitted')}
        footerDescription={footerDescription}
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
            { label: t('status'), value: statusValue }
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
