import React from 'react';

import type { ExecutionTransactionWithChain } from '@epoch-protocol/epoch-intents-sdk';
import { useTranslation } from 'react-i18next';

import { NetworkLogo } from 'components/NetworkChip';
import { ReviewLayout } from 'components/review';
import { TokenLogo } from 'components/TokenLogo';
import { TokenUsdValue, UsdValue } from 'components/TokenUsdValue';
import { Card } from 'components/ui/Card';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Pill } from 'components/ui/Pill';
import { Skeleton } from 'components/ui/Skeleton';
import { IBridgeProvider } from 'lib/miden/db/types';
import type { TokenPriceInfo } from 'lib/prices/binance';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { USDCX_SYMBOL, usdcxArrivalKey } from 'lib/usdcx/constant';

export interface EvmBridgeDepositReviewProps {
  /** Deposit input amount (human string). */
  amount: string;
  /** Token symbol: names the token unless `label` is given (e.g. USDC or ETH). */
  symbol: string;
  /** The token's name in the hero and rows, such as the testnet label (`evmUsdcLabel`). */
  label?: string;
  /** Optional ≈USD value under the hero amount. Omit when there's no reliable price (e.g. testnet ETH). */
  fiat?: number;
  sourceQuote?: TokenPriceInfo;
  /** The Miden faucet the deposit arrives in: it values the output and keys the hero's token logo. */
  outputFaucetId?: string;
  /** The symbol of the Miden faucet an Epoch deposit delivers into; the arriving token is named by it. */
  deliveredSymbol?: string;
  /** Selected bridge route — drives the route label + arrival ETA. */
  route: IBridgeProvider;
  /** Output the recipient receives on Miden, as typed on every route. undefined while quoting. */
  outputAmount?: string;
  /** Circle's quoted fee for an executor-route burn (human string), paid in the source token on top of the amount. */
  fee?: string;
  /** Source network name (e.g. Sepolia). */
  networkName: string;
  networkId?: string;
  destinationName?: string;
  /** Source chain id; on the USDCx route it picks the arrival estimate (`usdcxArrivalKey`). */
  sourceChainId?: number;
  /** The actual Chrome extension host that WalletConnect can show in place of the declared dApp URL. */
  extensionId?: string;
  /** Source amount before display rounding; approvals and deposits use this amount. */
  promptAmount?: string;
  /** Configured source-chain contract that the deposit or burn targets. */
  promptContract?: string;
  /** True only for a native coin (ETH on AggLayer, a native Epoch token), not an ERC-20 that uses its symbol. */
  nativeSource?: boolean;
  /** Circle's CCTP executor route burns on the source chain instead of depositing to xReserve there. */
  usdcxExecutor?: boolean;
  /** The quoted Fast route can execute against collateral already in The Compact. */
  epochResourceLockRequired?: boolean;
  epochQuoteTransactions?: ExecutionTransactionWithChain[];
  /** Show a skeleton on the "You receive" row while the Fast quote is still loading. */
  youReceiveLoading?: boolean;
  /** Drives the confirm-button spinner while the bridge submit is in flight. */
  isSubmitting?: boolean;
  /** Whether Confirm can be pressed (quote ready / not already submitting or submitted). */
  canConfirm?: boolean;
  /** Primary-button label. Defaults to "Confirm Deposit"; pass "Retry" after a failed attempt. */
  confirmLabel?: string;
  /** Bridge submit error, shown above the CTAs. */
  error?: string;
  errorId?: UserErrorId | null;
  onConfirm: () => void;
  onBack: () => void;
}

/**
 * What a deposit arrives on Miden as: the Epoch route delivers into its token's Miden faucet (`deliveredSymbol`, else
 * the label the bridge's USDC is shown under), the Slow route delivers the plain symbol and Circle xReserve mints USDCx.
 * The amount step and the Review both name the arriving token through it.
 */
export function arrivingTokenName(
  route: IBridgeProvider,
  symbol: string,
  label: string,
  deliveredSymbol?: string
): string {
  switch (route) {
    case 'agglayer':
      return symbol;
    case 'usdcx':
      return USDCX_SYMBOL;
    case 'epoch':
    default:
      return deliveredSymbol || label;
  }
}

/**
 * Review step for the Receive-from-EVM bridge deposit, shown after the route is
 * chosen. Reuses the shared `ReviewLayout` shell (same shell as the Send review)
 * with a `Hero` amount and `DetailCard` rows, and defers the actual submit to
 * `onConfirm`, which the manager wires to `executeEVMToMiden` (Fast) or the
 * Agglayer bridge (Slow).
 */
export const EvmBridgeDepositReview: React.FC<EvmBridgeDepositReviewProps> = ({
  amount,
  symbol,
  label,
  sourceQuote,
  outputFaucetId,
  deliveredSymbol,
  route,
  outputAmount,
  fee,
  networkName,
  networkId,
  destinationName,
  sourceChainId,
  extensionId,
  promptAmount,
  promptContract,
  nativeSource = false,
  usdcxExecutor = false,
  epochResourceLockRequired,
  epochQuoteTransactions,
  youReceiveLoading = false,
  isSubmitting = false,
  canConfirm = false,
  confirmLabel,
  error,
  errorId = 'raw_bridge_deposit_submit_failed',
  onConfirm,
  onBack
}) => {
  const { t } = useTranslation();

  const { routeLabel, arrivalLabel } = (() => {
    switch (route) {
      case 'agglayer':
        return { routeLabel: t('slow'), arrivalLabel: t('slowArrival') };
      case 'usdcx':
        return {
          routeLabel: t('usdcxRouteName'),
          arrivalLabel: t(sourceChainId === undefined ? 'usdcxArrival' : usdcxArrivalKey(sourceChainId))
        };
      case 'epoch':
      default:
        return { routeLabel: t('fast'), arrivalLabel: t('fastArrival') };
    }
  })();
  const name = label ?? symbol;
  const receiveName = arrivingTokenName(route, symbol, name, deliveredSymbol);
  const youReceiveLabel = outputAmount != null ? `≈ ${outputAmount} ${receiveName}`.trim() : receiveName;
  const actionAmount = promptAmount ?? amount;
  const promptCopy = { amount: actionAmount, token: name, network: networkName };
  const epochUsesExistingCollateral = route === 'epoch' && epochResourceLockRequired === false;
  // A native coin is deposited as the call's value, so neither Epoch nor AggLayer asks for an approval first.
  const approvalKey = (() => {
    if (epochUsesExistingCollateral) return undefined;
    switch (route) {
      case 'epoch':
        return nativeSource ? undefined : 'bridgeWalletPromptEpochApprove';
      case 'agglayer':
        return nativeSource ? undefined : 'bridgeWalletPromptAgglayerApprove';
      default:
        return usdcxExecutor ? 'bridgeWalletPromptExecutorApprove' : 'bridgeWalletPromptUsdcxApprove';
    }
  })();
  const depositKey = epochUsesExistingCollateral
    ? undefined
    : route === 'epoch'
      ? 'bridgeWalletPromptEpochDeposit'
      : route === 'agglayer'
        ? 'bridgeWalletPromptAgglayerDeposit'
        : usdcxExecutor
          ? 'bridgeWalletPromptExecutorBurn'
          : 'bridgeWalletPromptUsdcxDeposit';

  return (
    <ReviewLayout
      accent="receive"
      hero={
        // The caption identifies what the hero amount is for — same shape as ReviewSwap's
        // You Send / You Receive pills, since Hero itself has no slot above its value.
        <div className="mt-3 flex w-full flex-col items-center">
          <Pill tone="neutral">{t('youAreDepositing')}</Pill>
          <Hero
            className="mt-2"
            visual={<TokenLogo faucetId={outputFaucetId} size="2xl" />}
            value={`${amount} ${name}`}
            subtitle={<UsdValue amount={amount} quote={sourceQuote} />}
          />
        </div>
      }
      // The details have their own hairlines and the prompt guide has its own surface.
      dividers={false}
      error={error}
      errorId={errorId}
      primary={{
        label: confirmLabel ?? t('confirmDeposit'),
        onPress: onConfirm,
        loading: isSubmitting,
        disabled: !canConfirm,
        'data-testid': 'bridge-deposit-review-confirm'
      }}
      secondary={{ label: t('back'), onPress: onBack, disabled: isSubmitting }}
    >
      <DetailCard>
        <DetailRow label={t('amount')}>{`${amount} ${name}`}</DetailRow>

        <DetailRow label={t('from')}>
          <span className="inline-flex items-center gap-2">
            <NetworkLogo kind="ethereum" network={networkId} />
            {networkName}
          </span>
        </DetailRow>

        <DetailRow label={t('to')} sub={destinationName}>
          <span className="inline-flex items-center gap-2">
            <NetworkLogo kind="miden" />
            {t('miden')}
          </span>
        </DetailRow>

        <DetailRow label={t('route')}>{`${routeLabel} ${arrivalLabel}`}</DetailRow>

        {fee !== undefined && (
          <DetailRow label={t('usdcxCircleFee')}>
            <div>
              {`${fee} ${name}`}
              <div>
                <UsdValue amount={fee} quote={sourceQuote} />
              </div>
            </div>
          </DetailRow>
        )}

        <DetailRow label={t('youReceive')}>
          {youReceiveLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : (
            <div>
              {youReceiveLabel}
              {outputAmount !== undefined && (
                <div>
                  <TokenUsdValue amount={outputAmount} faucetId={outputFaucetId} symbol={receiveName} />
                </div>
              )}
            </div>
          )}
        </DetailRow>
      </DetailCard>
      <Card className="mt-4" data-testid="bridge-wallet-prompt-guide">
        <h3 className="text-body-sm font-semibold text-ink">{t('bridgeWalletPromptTitle')}</h3>
        {extensionId && (
          <p className="mt-2 text-body-sm text-muted">
            {t('bridgeWalletPromptIdentity')}
            <code className="mt-1 block break-all text-ink">{extensionId}</code>
          </p>
        )}
        {epochUsesExistingCollateral ? (
          <>
            <p className="mt-2 text-body-sm text-muted">
              {t(
                epochQuoteTransactions?.length
                  ? 'bridgeWalletPromptEpochExistingCollateral'
                  : 'bridgeWalletPromptEpochNoTransactions'
              )}
            </p>
            {!!epochQuoteTransactions?.length && (
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-body-sm text-muted">
                {epochQuoteTransactions.map((transaction, index) => (
                  <li key={`${transaction.chainId}-${transaction.target}-${index}`}>
                    <span>
                      {t('bridgeWalletPromptQuotedCall', { number: index + 1, chainId: transaction.chainId })}
                    </span>
                    <code className="mt-1 block break-all text-ink">{transaction.target}</code>
                    {transaction.value !== '0' && (
                      <span className="mt-1 block">
                        {t('bridgeWalletPromptNativeValue')}{' '}
                        <code className="break-all text-ink">{transaction.value}</code>
                      </span>
                    )}
                    {/^0x[0-9a-fA-F]{8}/.test(transaction.callData) && (
                      <span className="mt-1 block">
                        {t('bridgeWalletPromptCallSelector')}{' '}
                        <code className="text-ink">{transaction.callData.slice(0, 10)}</code>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-body-sm text-muted">
            {approvalKey && <li>{t(approvalKey, promptCopy)}</li>}
            {depositKey && <li>{t(depositKey, promptCopy)}</li>}
          </ol>
        )}
        {promptContract && !epochUsesExistingCollateral && (
          <p className="mt-2 text-body-sm text-muted">
            {t('bridgeWalletPromptContract')}
            <code className="mt-1 block break-all text-ink">{promptContract}</code>
          </p>
        )}
        <p className="mt-2 text-body-sm text-muted">{t('bridgeWalletPromptWalletControls')}</p>
      </Card>
    </ReviewLayout>
  );
};
