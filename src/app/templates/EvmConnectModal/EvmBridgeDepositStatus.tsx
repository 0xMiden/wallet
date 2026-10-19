import React, { useRef } from 'react';

import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { creditedAmount, formatMoneyAmount, TRANSACTION_COLORS } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { FlowLayout } from 'components/flow/FlowLayout';
import { Hero } from 'components/ui/Hero';
import { Spinner } from 'components/ui/Spinner';
import { AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL } from 'lib/agglayer';
import { IBridgedReceiveExtraInputs, IBridgeProvider, ITransaction } from 'lib/miden/db/types';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { AssetMetadata } from 'lib/miden/metadata/types';
import { openExternalUrl } from 'lib/mobile/external-browser';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { evmUsdcLabel, midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { isUserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { isUsdcxExecutorSource } from 'lib/usdcx/constant';
import { DEFAULT_CHAIN_ID, evmExplorerUrl, getChain } from 'lib/walletconnect/config';
import { TransactionHeroIcon } from 'screens/generating-transaction/components';
import { ReceiptRows, TransactionSuccessLayout } from 'screens/generating-transaction/success/TransactionSuccessLayout';
import { TransactionSummaryBadge } from 'screens/generating-transaction/TransactionSummaryBadge';
import { useTransactionRow } from 'screens/generating-transaction/useTransactionRow';

import { UsdcxDepositSteps } from './UsdcxDepositSteps';
import { UsdcxExecuteAction } from './UsdcxExecuteAction';

interface EvmBridgeDepositStatusProps {
  txId: string;
  onDone: () => void;
  /**
   * The deposit has taken one wallet confirmation and is about to ask for the next. The Slow (AggLayer)
   * and USDCx routes can say this: the screen raises their approve and their bridge, deposit or burn
   * prompts itself, so it knows when an approval was signed. Only the Fast (Epoch) route cannot: it
   * hands the whole sequence to the Epoch SDK, which reports nothing back on the deposit path, so there
   * it stays false and the processing copy, which warns that the wallet may ask more than once, covers
   * the gap.
   */
  awaitingNextConfirmation?: boolean;
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

/**
 * The status word and the footer of a submitted deposit. A USDCx row follows Circle: the
 * app-root watcher moves it to `ready` on the attestation (Confirmed), and the consume of
 * the minted note moves it to `received` (Completed).
 */
function submittedCopyOf(
  inputs: IBridgedReceiveExtraInputs,
  t: (key: string) => string
): { statusValue: string; footerDescription?: string } {
  const usdcx = inputs.provider === 'usdcx';
  // An executor-route deposit in flight explains itself through `UsdcxExecuteAction`, step by step.
  const executorInFlight =
    usdcx &&
    inputs.phase === 'delivering' &&
    (inputs.cctp !== undefined ||
      inputs.usdcxSource?.route === 'cctp-executor' ||
      isUsdcxExecutorSource(inputs.sourceChainId));
  switch (inputs.phase) {
    case 'received':
      return usdcx
        ? { statusValue: t('completed'), footerDescription: t('usdcxReceived') }
        : { statusValue: t('received'), footerDescription: t('bridgeDepositDeliveryDescription') };
    case 'ready':
      return {
        statusValue: t('confirmed'),
        footerDescription: usdcx ? t('usdcxAttested') : t('bridgeDepositDeliveryDescription')
      };
    default:
      return {
        statusValue: t('delivering'),
        footerDescription: executorInFlight
          ? undefined
          : usdcx
            ? t('usdcxAwaitingAttestation')
            : t('bridgeDepositDeliveryDescription')
      };
  }
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
export const EvmBridgeDepositStatus: React.FC<EvmBridgeDepositStatusProps> = ({
  txId,
  onDone,
  awaitingNextConfirmation = false
}) => {
  const { t } = useTranslation();
  const { row, loaded } = useTransactionRow(txId);
  const assetsMetadata = useWalletStore(state => state.assetsMetadata);
  const nativeFaucetId = useMidenFaucetId();
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });

  const inputs: IBridgedReceiveExtraInputs | undefined = row?.extraInputs;
  const firstLoadedRow = useRef<{ txId: string; failed?: boolean }>({ txId });
  if (firstLoadedRow.current.txId !== txId) firstLoadedRow.current = { txId };
  const matchingRow = loaded && row?.id === txId && inputs !== undefined;
  if (matchingRow && firstLoadedRow.current.failed === undefined) {
    firstLoadedRow.current.failed = inputs.phase === 'failed';
  }
  const failureId =
    inputs?.error == null
      ? 'transactionErrorDescription'
      : inputs.error
        ? isUserErrorId(inputs.errorId)
          ? inputs.errorId
          : 'raw_bridge_deposit_failed'
        : null;
  useUserVisibleError(
    matchingRow && inputs.phase === 'failed' && firstLoadedRow.current.failed === false ? failureId : null,
    'status_screen'
  );

  if (!loaded || !row || row.id !== txId || inputs === undefined)
    return (
      <div className="flex h-8 justify-center pt-5">
        <Spinner />
      </div>
    );

  // A Fast deposit is what the wallet signed for, so it rounds up; a Slow amount is what was typed.
  const sourceAmount = formatMoneyAmount(
    inputs.sourceAmount,
    inputs.provider === 'epoch' ? 'pays' : 'typed',
    inputs.sourceSymbol
  );
  // ETH and Circle's USDC (the xReserve route) keep their symbol; any other source is the configured Epoch USDC.
  const keepsSourceSymbol = inputs.provider === 'usdcx' || inputs.sourceSymbol === AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL;
  const sourceSymbol = keepsSourceSymbol ? inputs.sourceSymbol : evmUsdcLabel(bridgeConfig, inputs.sourceSymbol);
  const sourceLabel = `${sourceAmount} ${sourceSymbol}`;
  const failed = inputs.phase === 'failed';
  const submitted = inputs.phase === 'delivering' || inputs.phase === 'ready' || inputs.phase === 'received';
  // A failure has its own message, and a submitted deposit has left this screen, so the wait only
  // speaks while the deposit is still in flight.
  const waiting = awaitingNextConfirmation && !failed && !submitted;
  const routeLabel = routeLabelOf(inputs.provider, t);
  const sourceChain = getChain(inputs.sourceChainId ?? DEFAULT_CHAIN_ID);

  if (submitted) {
    const sourceTxUrl = inputs.evmTxHash ? evmExplorerUrl(sourceChain, 'tx', inputs.evmTxHash) : undefined;
    const viewExplorer =
      sourceTxUrl && sourceChain ? () => openExternalUrl({ url: sourceTxUrl, title: sourceChain.name }) : undefined;
    const { statusValue, footerDescription } = submittedCopyOf(inputs, t);
    return (
      <TransactionSuccessLayout
        accent="receive"
        headerTitle={t('success')}
        title={t('bridgeDepositSubmitted')}
        footerDescription={footerDescription}
        primaryAction={{ label: t('done'), onClick: onDone }}
        secondaryAction={
          viewExplorer
            ? { label: t('viewOnBlockExplorer'), onClick: viewExplorer, variant: ButtonVariant.Secondary }
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
            { label: t('route'), value: `${routeLabel} · ${sourceChain?.name ?? ''} → Miden` },
            { label: t('status'), value: statusValue }
          ]}
        />
        {inputs.provider === 'usdcx' && (
          <UsdcxDepositSteps
            sourceChainId={inputs.sourceChainId}
            sourceConfig={inputs.usdcxSource}
            phase={inputs.phase}
            cctp={inputs.cctp}
            className="mt-4"
          />
        )}
        {inputs.provider === 'usdcx' &&
          (inputs.cctp !== undefined ||
            inputs.usdcxSource?.route === 'cctp-executor' ||
            isUsdcxExecutorSource(inputs.sourceChainId)) && (
            <UsdcxExecuteAction
              txId={row.id}
              sourceChainId={inputs.sourceChainId}
              sourceConfig={inputs.usdcxSource}
              phase={inputs.phase}
              cctp={inputs.cctp}
              className="mt-4"
            />
          )}
      </TransactionSuccessLayout>
    );
  }

  // The receipt's frame, which this view turns into in place: the header, the scroller and the pinned
  // CTA stay put across the swap, and the CTA spans the margin on a wide screen (#1469).
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-ink">
      <FlowLayout
        title={t('transactionProcessingHeader')}
        onClose={onDone}
        footer={
          <Button
            type="button"
            accent="receive"
            variant={ButtonVariant.Primary}
            onClick={onDone}
            className="w-full max-w-none"
          >
            {failed ? t('done') : t('hide')}
          </Button>
        }
      >
        <section className="flex w-full flex-col items-center pt-5">
          <Hero
            visual={<TransactionHeroIcon accent="receive" state={failed ? 'failed' : 'processing'} />}
            name={
              failed
                ? t('bridgeDepositFailed')
                : waiting
                  ? t('bridgeDepositAwaitingNextConfirmation')
                  : t('bridgeDepositProcessing')
            }
          />
          <TransactionSummaryBadge
            lhs={sourceLabel}
            rhs="Miden"
            fillForArrow={TRANSACTION_COLORS.bridge}
            className="mt-4"
          />
          {/* The wait is announced: it appears while the user is looking at their wallet, not at
              this screen, and it is the cue that the flow is not finished. A raw wallet or RPC error
              can carry an unbreakable token (calldata, a URL), and only `wrap-anywhere` keeps it from
              widening this centred line past the margin. */}
          <p
            className="mt-4 w-full text-center text-sm font-medium text-ink wrap-anywhere select-text"
            role={failed ? undefined : 'status'}
            data-testid="bridge-deposit-processing-description"
          >
            {failed
              ? (inputs.error ?? t('transactionErrorDescription'))
              : waiting
                ? t('bridgeDepositAwaitingNextConfirmationDescription')
                : t('bridgeDepositProcessingDescription')}
          </p>
        </section>
      </FlowLayout>
    </div>
  );
};
