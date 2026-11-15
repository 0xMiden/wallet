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

import { OneClickNetworkPicker } from './OneClickPickers';
import type { SwapAmountsProps } from './SwapAmounts';

export function CommandSwap({
  offerToken,
  offerBalance,
  offerExceedsBalance,
  offerAmount,
  onOfferAmountChange,
  onSelectOfferToken,
  requestToken,
  requestAmount,
  onSelectRequestToken,
  requestLoading,
  quoteLoading,
  onSwapDirection,
  onConfirm,
  canProceed,
  statusMessage,
  statusIsError,
  statusErrorId,
  feeAssetMissing,
  oneClickNetworks,
  offerNetwork,
  requestNetwork,
  onOfferNetworkChange,
  onRequestNetworkChange
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
      className="w-full max-w-none"
    >
      {quoteLoading ? <WaveDots label={t('calculatingQuote')} /> : undefined}
    </Button>
  );
  return (
    <div data-testid="command-swap-composer" className="flex flex-col gap-5">
      <form
        id={formId}
        onSubmit={event => {
          event.preventDefault();
          if (canProceed) onConfirm();
        }}
      >
        {oneClickNetworks && offerNetwork && onOfferNetworkChange && (
          <OneClickNetworkPicker
            side="pay"
            network={offerNetwork}
            networks={oneClickNetworks}
            onSelect={onOfferNetworkChange}
          />
        )}
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
        />
        {feeAssetMissing && (
          <ErrorLine errorId="insufficientFeeAssetShort" role="note" data-testid="swap-fee-notice">
            {t('insufficientFeeAssetShort')}
          </ErrorLine>
        )}
      </form>
      <button
        type="button"
        className="flex items-center self-center rounded-full bg-accent-swap p-2 text-accent-swap-on"
        onClick={() => {
          hapticLight();
          onSwapDirection();
        }}
        aria-label={t('swapDirection')}
      >
        <Icon name={IconName.Switch} size="sm" />
      </button>
      <div data-testid="command-swap-receive">
        {oneClickNetworks && requestNetwork && onRequestNetworkChange && (
          <OneClickNetworkPicker
            side="receive"
            network={requestNetwork}
            networks={oneClickNetworks}
            onSelect={onRequestNetworkChange}
          />
        )}
        <DetailCard surface="fill">
          <DetailRow label={t('youReceive')} stacked>
            {requestLoading ? <WaveDots label={t('calculatingQuote')} /> : requestAmount || t('calculatingQuote')}
          </DetailRow>
          <button
            type="button"
            className="flex items-center gap-2 text-action text-accent-swap-ink"
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
          className={statusIsError ? 'text-body-sm text-negative-tint-ink' : 'text-body-sm text-muted'}
          data-testid="swap-status-message"
        >
          {statusMessage}
        </span>
      )}
      {outlets}
    </div>
  );
}
