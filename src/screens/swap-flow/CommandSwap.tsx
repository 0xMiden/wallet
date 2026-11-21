import React, { useId } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { WaveDots } from 'components/ui';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { ErrorLine } from 'components/ui/ErrorLine';
import { amountExceedsTokenDecimals, typedAmountExceedsBalance } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { useCommandWorkbenchSlots } from 'screens/command/CommandWorkbench';
import { SelectAmount } from 'screens/send-flow/SelectAmount';

import type { SwapAmountsProps } from './SwapAmounts';

export function CommandSwap({
  offerToken,
  offerBalance,
  offerExceedsBalance,
  offerAmount,
  onOfferAmountChange,
  onSelectOfferToken,
  offerTokenAnchorRef,
  requestToken,
  requestAmount,
  onSelectRequestToken,
  requestTokenAnchorRef,
  requestLoading,
  quoteLoading,
  onSwapDirection,
  onConfirm,
  canProceed,
  statusMessage,
  statusIsError,
  statusErrorId,
  feeAssetMissing
}: SwapAmountsProps): React.ReactElement {
  const { t } = useTranslation();
  const formId = useId();
  const config = useBridgeConfigSnapshot({ load: false });
  useUserVisibleError(statusMessage && statusIsError ? (statusErrorId ?? null) : null, 'inline');
  const precisionError = amountExceedsTokenDecimals(offerAmount, offerToken.decimals);
  const balanceError = offerExceedsBalance ?? typedAmountExceedsBalance(offerAmount, offerBalance, offerToken.decimals);
  const amountError = feeAssetMissing
    ? 'insufficientFeeAsset'
    : precisionError
      ? 'amountExceedsTokenDecimals'
      : balanceError
        ? 'amountMustBeLessThanBalance'
        : undefined;
  const outlets = useCommandWorkbenchSlots(
    <Button
      type="submit"
      form={formId}
      title={offerAmount ? t('reviewSwap') : t('enterAmount')}
      variant={ButtonVariant.Primary}
      accent="swap"
      data-testid="swap-review-submit"
      disabled={!canProceed}
      className="w-full max-w-none sm:w-auto sm:min-w-40"
    >
      {quoteLoading ? <WaveDots label={t('calculatingQuote')} /> : undefined}
    </Button>
  );
  return (
    <div
      data-testid="command-swap-composer"
      className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
    >
      <form
        id={formId}
        className="min-w-0 rounded-2xl border border-hairline bg-page p-4 sm:p-5"
        onSubmit={event => {
          event.preventDefault();
          if (canProceed) onConfirm();
        }}
      >
        <SelectAmount
          embedded
          showAmountShortcuts
          showAmountDivider={false}
          label={t('youPay')}
          accent="swap"
          token={{
            id: offerToken.faucetId,
            name: offerToken.symbol,
            decimals: offerToken.decimals,
            balance: offerBalance,
            fiatPrice: 0,
            scaleIsKnown: true
          }}
          tokenLabel={midenTokenLabel(config, offerToken.faucetId, offerToken.symbol)}
          amount={offerAmount}
          isValidAmount={Number(offerAmount) > 0 && !precisionError && !balanceError}
          error={amountError}
          errorId={feeAssetMissing ? null : amountError}
          hideErrorText={feeAssetMissing}
          amountDecimalsLimit={offerToken.decimals}
          amountMaxLength={80}
          onAmountChange={onOfferAmountChange}
          onSelectToken={onSelectOfferToken}
          tokenAnchorRef={offerTokenAnchorRef}
        />
        {feeAssetMissing && (
          <ErrorLine errorId="insufficientFeeAssetShort" role="note" data-testid="swap-fee-notice">
            {t('insufficientFeeAssetShort')}
          </ErrorLine>
        )}
      </form>
      <button
        type="button"
        className="flex size-11 items-center justify-center self-center justify-self-center rounded-xl border border-hairline bg-accent-tint text-accent-tint-ink focus-visible:outline-2 focus-visible:outline-accent-tint-ink"
        onClick={() => {
          hapticLight();
          onSwapDirection();
        }}
        aria-label={t('swapDirection')}
      >
        <Icon name={IconName.Switch} size="sm" />
      </button>
      <div
        data-testid="command-swap-receive"
        className="flex min-w-0 flex-col gap-3 rounded-2xl border border-accent-tint-ink/25 bg-accent-tint p-4 sm:p-5"
      >
        <DetailCard surface="fill">
          <DetailRow label={t('youReceive')} stacked>
            {requestLoading ? (
              <WaveDots label={t('calculatingQuote')} />
            ) : requestAmount ? (
              <span className="break-all text-title-tab tabular-nums text-ink">{requestAmount}</span>
            ) : (
              t('calculatingQuote')
            )}
          </DetailRow>
          <button
            ref={requestTokenAnchorRef}
            type="button"
            aria-haspopup={requestTokenAnchorRef ? 'dialog' : undefined}
            className="flex w-full items-center gap-2 px-4 py-3 text-action text-accent-swap-ink hover:bg-fill-pressed focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-swap-ink"
            onClick={() => {
              hapticLight();
              onSelectRequestToken();
            }}
            aria-label={t('youReceive')}
          >
            <TokenLogo faucetId={requestToken.faucetId} size="sm" />
            {midenTokenLabel(config, requestToken.faucetId, requestToken.symbol)}
            <Icon name={IconName.ChevronDown} size="xs" />
          </button>
        </DetailCard>
      </div>
      {statusMessage && (
        <span
          className={
            statusIsError
              ? 'text-body-sm text-negative-tint-ink md:col-span-3'
              : 'text-body-sm text-muted md:col-span-3'
          }
          data-testid="swap-status-message"
        >
          {statusMessage}
        </span>
      )}
      {outlets}
    </div>
  );
}
