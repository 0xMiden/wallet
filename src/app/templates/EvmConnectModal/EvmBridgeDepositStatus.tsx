import React from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { creditedAmount, formatMoneyAmount, TRANSACTION_COLORS } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { PageHeader } from 'components/PageHeader';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL } from 'lib/agglayer';
import { IBridgedReceiveExtraInputs, ITransaction } from 'lib/miden/db/types';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { AssetMetadata } from 'lib/miden/metadata/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { evmUsdcLabel, midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { ReceiptRows, TransactionSuccessLayout } from 'screens/generating-transaction/success/TransactionSuccessLayout';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

interface EvmBridgeDepositStatusProps {
  txId: string;
  onDone: () => void;
}

/**
 * The badge's output side: the stored "you receive" amount in flight, and what was credited once the
 * note is received, so the quote never shows beside Received. An unscalable faucet withholds the
 * number; its record is the placeholder's, so the row's own output symbol names the asset.
 */
const outputLabel = (
  bridgeConfig: BridgeConfigSnapshot,
  row: ITransaction,
  inputs: IBridgedReceiveExtraInputs,
  assetsMetadata: Record<string, AssetMetadata>,
  nativeFaucetId: string | null
): string => {
  if (inputs.phase === 'received') {
    const metadata = resolveDisplayMetadata(row.faucetId, assetsMetadata, nativeFaucetId);
    const symbol = midenTokenLabel(
      bridgeConfig,
      row.faucetId,
      hasKnownScale(metadata) ? metadata.symbol : (inputs.outputSymbol ?? metadata.symbol)
    );
    const amount = creditedAmount(row.amount, metadata);
    return amount === undefined ? symbol : `${amount} ${symbol}`;
  }
  if (!inputs.outputAmount) return 'Miden';
  return `${formatMoneyAmount(inputs.outputAmount, 'typed')} ${midenTokenLabel(bridgeConfig, row.faucetId, inputs.outputSymbol ?? '')}`.trim();
};

/** Bridge-specific post-review progress/failure/success screen. */
export const EvmBridgeDepositStatus: React.FC<EvmBridgeDepositStatusProps> = ({ txId, onDone }) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(txId);
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });

  if (!loaded || !row)
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );

  const inputs = row.extraInputs as IBridgedReceiveExtraInputs;
  // A Fast deposit is what the wallet signed for, so it rounds up; a Slow amount is what was typed.
  const sourceAmount = formatMoneyAmount(
    inputs.sourceAmount,
    inputs.provider === 'epoch' ? 'pays' : 'typed',
    inputs.sourceSymbol
  );
  // The bridge-in picker offers only ETH and the configured USDC, so any source but ETH is that USDC, as on the Review.
  const sourceSymbol =
    inputs.sourceSymbol === AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL
      ? inputs.sourceSymbol
      : evmUsdcLabel(bridgeConfig, inputs.sourceSymbol);
  const sourceLabel = `${sourceAmount} ${sourceSymbol}`;
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
          lhs={sourceLabel}
          rhs={outputLabel(bridgeConfig, row, inputs, assetsMetadata, nativeFaucetId)}
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
            lhs={sourceLabel}
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
