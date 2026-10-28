import React, { useCallback, useEffect, useState } from 'react';

import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { formatNetworkFeeEstimate, useNetworkFeeEstimateDetails } from 'app/hooks/useNetworkFeeEstimate';
import { ReviewLayout } from 'components/review';
import { SwapTokenInfoButton } from 'components/SwapTokenInfoSheet';
import { Toggle } from 'components/Toggle';
import { TokenLogo } from 'components/TokenLogo';
import { TokenUsdValue } from 'components/TokenUsdValue';
import { TxStory } from 'components/tx-stage/TxStory';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { InfoHint } from 'components/ui/InfoHint';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SegmentedControl } from 'components/ui/SegmentedControl';
import { TextField } from 'components/ui/TextField';
import { formatBigInt } from 'lib/i18n/numbers';
import { SWAP_VERDICT_LABEL_KEYS, swapEtaBlocksSubmit, SwapQuote, swapVerdict } from 'lib/miden/swap/quote';
import { SwapToken } from 'lib/miden/swap/tokens';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error-contract';

import { swapPayEstimate } from './amount-display';
import { EXPIRY_PRESETS, ExpiryPresetId, presetForSeconds } from './expiry';
import { SLIPPAGE_PERCENT_BOUNDS, slippageBpsToPercent, slippagePercentToBps } from './slippage';

export interface ReviewSwapProps {
  offerToken: SwapToken;
  offerAmount: string;
  requestToken: SwapToken;
  requestAmount: string;
  /** The user took the receive field over: the slippage no longer sets it, so its row says so. */
  requestEdited: boolean;
  /** Latest quote for the pair; drives the Rate, Fill and "Usually fills in" rows. */
  quote?: SwapQuote;
  expirySeconds: string;
  slippageBps: number;
  autoConsume: boolean;
  onExpirySecondsChange: (seconds: string) => void;
  onSlippageBpsChange: (bps: number) => void;
  onAutoConsumeChange: (enabled: boolean) => void;
  submitError?: string | null;
  submitErrorId?: UserErrorId | null;
  onGoBack: () => void;
  onSubmit: () => void;
  /** A submission is in flight: the expiry holds still until it settles. */
  submitting?: boolean;
}

/** The fill price as a number, or `undefined` when there isn't one to show. */
function parseRate(fillPrice?: string): number | undefined {
  const rate = Number(fillPrice);
  if (!rate || !Number.isFinite(rate)) return undefined;
  return rate;
}

/** `50` ppm → `"0.005"`: the fee as a percent with no trailing zeros. */
function feePpmToPercent(feePpm: number): string {
  return (feePpm / 10_000).toFixed(4).replace(/\.?0+$/, '');
}

/**
 * What a full fill pays over the ask, as a display amount, or undefined when the solver names no
 * expected amount or it is not above the ask. Shown only beside a `full` verdict, where it is the
 * amount the user actually receives.
 */
function expectedOverAsk(quote: SwapQuote, decimals: number): string | undefined {
  const expected = quote.eta.expectedRequestedAmount;
  if (expected === null || !/^\d+$/.test(expected)) return undefined;
  const amount = BigInt(expected);
  return amount > quote.requestedAmount ? formatBigInt(amount, decimals) : undefined;
}

function fillWarningKey(quote?: SwapQuote): string | undefined {
  if (!quote || swapEtaBlocksSubmit(quote.eta)) return undefined;
  switch (quote.eta.fillStatus) {
    case 'none':
      return 'swapNoFillWarning';
    case 'partial':
      return 'swapPartialFillWarning';
    case 'full':
      return undefined;
  }
}

/**
 * The rate figure's formatter for one destination. The destination prints at four significant
 * figures, plain or exponential as `Number#toString` picks; every frame of a count keeps that
 * string's shape (its decimals, or its mantissa digits), so the row does not jitter and the last
 * frame is the settled string. The exponential frame stays a string: a `Number` round-trip would
 * strip a trailing zero.
 */
function rateFormatterFor(rate: number): (value: number) => string {
  const settled = Number(rate.toPrecision(4)).toString();
  const exponent = settled.indexOf('e');
  const point = settled.indexOf('.');
  if (exponent !== -1) {
    const digits = point === -1 ? 0 : exponent - point - 1;
    return value => value.toExponential(digits);
  }
  const decimals = point === -1 ? 0 : settled.length - point - 1;
  // Rounded to four figures first, or a rate past 9999 would settle on 12346 where the quote says 12350.
  return value => Number(value.toPrecision(4)).toFixed(decimals);
}

/**
 * Human "usually fills in" estimate. Prefers the live next-batch ETA, which the solver names only
 * when the order is at market and fills fully or partly, then the pair's 24h median, then a static
 * fallback (both live signals are often null on the current testnet book).
 */
function formatFillsIn(t: TFunction, quote?: SwapQuote): string {
  const seconds = quote?.eta.estimatedSeconds ?? quote?.eta.median24hSeconds;
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return t('swapEtaFallback');
  }
  return seconds < 90
    ? t('swapEtaSeconds', { seconds: Math.round(seconds) })
    : t('swapEtaMinutes', { minutes: Math.round(seconds / 60) });
}

const SwapArrows: React.FC = () => (
  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-swap text-accent-swap-on">
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M5.5 13V4M5.5 4L3 6.5M5.5 4L8 6.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 5v9M12.5 14L10 11.5M12.5 14L15 11.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </span>
);

/**
 * Swap review screen: a two-amount hero (You Send / You Receive) with a swap
 * glyph between them, then the Rate row. When a rate is available the receive
 * amount is quote-derived and already has the solver margin baked in, so a
 * short note discloses that fee to reconcile "amount × rate" with the shown
 * receive amount. No fabricated fill-time / network-fee rows are rendered.
 */
export const ReviewSwap: React.FC<ReviewSwapProps> = ({
  offerToken,
  offerAmount,
  requestToken,
  requestAmount,
  requestEdited,
  quote,
  expirySeconds,
  slippageBps,
  autoConsume,
  onExpirySecondsChange,
  onSlippageBpsChange,
  onAutoConsumeChange,
  submitError,
  submitErrorId,
  onGoBack,
  onSubmit,
  submitting = false
}) => {
  const { t } = useTranslation();
  const networkFeeDetails = useNetworkFeeEstimateDetails();
  const networkFee = formatNetworkFeeEstimate(networkFeeDetails);
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const offerLabel = midenTokenLabel(bridgeConfig, offerToken.faucetId, offerToken.symbol);
  const requestLabel = midenTokenLabel(bridgeConfig, requestToken.faucetId, requestToken.symbol);
  const divider = <div className="h-0.75 flex-1 bg-[#ECEBE8]" />;
  // The quote is re-fetched while this screen is open, so the rate counts to each new one. It is
  // the FILL price, the most the ask can name and still fill, with the solver's fee already in it.
  const rate = parseRate(quote?.price.fillPrice);
  const formatRateValue = rateFormatterFor(rate ?? 0);
  const verdict = quote === undefined ? undefined : swapVerdict(quote.eta);
  const blocksSubmit = quote !== undefined && swapEtaBlocksSubmit(quote.eta);
  const warningKey = fillWarningKey(quote);
  const expected =
    quote !== undefined && verdict === 'full' ? expectedOverAsk(quote, requestToken.decimals) : undefined;

  // The slippage draft: the typed percent is this screen's own until it reads
  // as a whole number of basis points inside the range, which is when it is pushed up.
  useUserVisibleError(submitError ? (submitErrorId ?? null) : null, 'review');
  const [slippageDraft, setSlippageDraft] = useState(() => slippageBpsToPercent(slippageBps));
  const slippageOutOfRange = slippagePercentToBps(slippageDraft) === undefined;
  const onSlippageChange = useCallback(
    (next: string) => {
      setSlippageDraft(next);
      const bps = slippagePercentToBps(next);
      if (bps !== undefined) onSlippageBpsChange(bps);
    },
    [onSlippageBpsChange]
  );

  // Seconds stay the value the flow owns (`expirySeconds` in, seconds out). A value that is not
  // one of the presets (none today: the flow starts at 2 minutes) snaps to the closest, so the
  // choice on screen is always the one that is submitted.
  const preset = presetForSeconds(Number(expirySeconds));
  useEffect(() => {
    if (String(preset.seconds) !== expirySeconds) onExpirySecondsChange(String(preset.seconds));
  }, [preset.seconds, expirySeconds, onExpirySecondsChange]);

  const presetItems = EXPIRY_PRESETS.map(candidate => ({
    id: candidate.id,
    label: t(candidate.labelKey),
    disabled: submitting,
    'data-testid': `swap-expiry-preset-${candidate.id}`
  }));
  const onPresetChange = (id: ExpiryPresetId) => {
    const next = EXPIRY_PRESETS.find(candidate => candidate.id === id);
    if (next) onExpirySecondsChange(String(next.seconds));
  };

  // A caption pill identifies which side of the swap each amount belongs to — Hero's own
  // slots are visual + value + a subtitle *below* the value, with no room for a heading
  // above it, so the pill sits beside Hero rather than inside it.
  const hero = (
    <div className="mt-1 flex w-full flex-col items-center">
      <Pill tone="neutral">{t('youSend')}</Pill>
      <Hero
        className="mt-2"
        visual={
          <TokenLogo
            symbol={offerToken.symbol}
            faucetId={offerToken.faucetId}
            fallbackSymbol={offerToken.logoSymbol}
            size="md"
          />
        }
        subtitle={
          <TokenUsdValue
            amount={offerAmount}
            decimals={offerToken.decimals}
            faucetId={offerToken.faucetId}
            symbol={offerToken.symbol}
          />
        }
        value={
          <span className="inline-flex items-center gap-1">
            {`${requestEdited ? t('swapApproxAmount', { amount: swapPayEstimate(offerAmount) }) : offerAmount} ${offerLabel}`}
            <SwapTokenInfoButton faucetId={offerToken.faucetId} label={offerLabel} />
          </span>
        }
      />

      <div className="my-4 flex w-full items-center gap-3">
        {divider}
        <SwapArrows />
        {divider}
      </div>

      <Pill tone="neutral">{t('youReceive')}</Pill>
      <Hero
        className="mt-2"
        visual={
          <TokenLogo
            symbol={requestToken.symbol}
            faucetId={requestToken.faucetId}
            fallbackSymbol={requestToken.logoSymbol}
            size="md"
          />
        }
        subtitle={
          <TokenUsdValue
            amount={requestAmount}
            decimals={requestToken.decimals}
            faucetId={requestToken.faucetId}
            symbol={requestToken.symbol}
          />
        }
        value={
          <span className="inline-flex items-center gap-1">
            {`${requestAmount} ${requestLabel}`}
            <SwapTokenInfoButton faucetId={requestToken.faucetId} label={requestLabel} />
          </span>
        }
      />
    </div>
  );

  return (
    <ReviewLayout
      hero={hero}
      accent="swap"
      dividers={false}
      primary={{
        label: t('swap'),
        onPress: onSubmit,
        disabled: slippageOutOfRange,
        loading: submitting,
        'data-testid': 'swap-submit'
      }}
      secondary={{ label: t('back'), onPress: onGoBack, disabled: submitting }}
      beforeActions={
        warningKey && (
          <Notice tone="warning" role="status" data-testid="swap-fill-warning">
            {t(warningKey)}
          </Notice>
        )
      }
    >
      {/* The card is its own block under the hero, not the next line of it: without this the
          receive amount and the first row read as one run of text. */}
      {requestEdited && <p className="mt-5 text-body-sm text-muted">{t('swapReceiveTargetNote')}</p>}
      <TxStory
        className="mt-6"
        hops={[
          {
            from: { role: 'you', name: '' },
            to: { role: 'recipient', name: '' },
            amount: `${offerAmount} ${offerToken.symbol}`.trim(),
            via: t('youSend')
          },
          {
            from: { role: 'sender', name: '' },
            to: { role: 'you', name: '' },
            amount: `${requestAmount} ${requestToken.symbol}`.trim(),
            via: t('youReceive')
          }
        ]}
      />
      <DetailCard surface="outline" face="heading" className="tx-stage-list mt-8">
        {/* The slippage and fee explain the rate figure, but it is a sentence: as a sub-line it
            wrapped over three lines and pushed the rows apart, so it waits behind the (i). */}
        <DetailRow
          label={t('rate')}
          info={
            rate !== undefined && quote !== undefined ? (
              <InfoHint label={t('moreInfoAbout', { label: t('rate') })} data-testid="swap-rate-info">
                {t('swapRateNote', {
                  slippage: `${slippageBpsToPercent(slippageBps)}%`,
                  fee: `${feePpmToPercent(quote.price.feePpm)}%`
                })}
              </InfoHint>
            ) : undefined
          }
          data-testid="swap-rate-row"
        >
          {rate !== undefined && (
            <AnimatedNumber
              value={rate}
              format={value => `1 ${offerLabel} ≈ ${formatRateValue(value)} ${requestLabel}`}
            />
          )}
        </DetailRow>
        {requestEdited && (
          <DetailRow label={t('swapExactPayAmount')} stacked data-testid="swap-exact-pay-row">
            <span className="break-all">
              {offerAmount} {offerLabel}
            </span>
          </DetailRow>
        )}
        {/* The solver's verdict on this exact ask, in the service's own priority order. A blocking
            one (no market, no price, off market) is what the Swap press refuses on; the rest, the
            testnet's usual "no orders yet" included, are advisory. */}
        {verdict !== undefined && (
          <DetailRow
            label={t('swapFillStatus')}
            sub={
              expected !== undefined ? (
                <>
                  {t('swapVerdictExpected', { amount: expected, symbol: requestLabel })}
                  <TokenUsdValue
                    amount={expected}
                    decimals={requestToken.decimals}
                    faucetId={requestToken.faucetId}
                    symbol={requestToken.symbol}
                    className="block"
                  />
                </>
              ) : undefined
            }
            className={blocksSubmit ? 'text-negative-ink' : undefined}
            data-testid="swap-verdict-row"
          >
            <span data-verdict={verdict}>{t(SWAP_VERDICT_LABEL_KEYS[verdict])}</span>
          </DetailRow>
        )}
        <DetailRow
          label={t('swapSlippage')}
          info={
            <InfoHint label={t('moreInfoAbout', { label: t('swapSlippage') })} data-testid="swap-slippage-info">
              {t(requestEdited ? 'swapReceiveSlippageNote' : 'swapSlippageNote')}
            </InfoHint>
          }
          stacked
          data-testid="swap-slippage-row"
        >
          {/* The shared field in its compact size, with the unit in its trailing slot and its own
              error line, so the row reads like every other field in the wallet. */}
          <TextField
            size="sm"
            containerClassName="w-32"
            inputMode="decimal"
            enterKeyHint="done"
            aria-label={t('swapSlippage')}
            value={slippageDraft}
            disabled={submitting}
            clearable={false}
            onChange={event => onSlippageChange(event.target.value)}
            trailing={<span className="text-body text-muted">{t('percentSign')}</span>}
            errorId="swapSlippageRange"
            error={slippageOutOfRange ? t('swapSlippageRange', SLIPPAGE_PERCENT_BOUNDS) : undefined}
            errorTestId="swap-slippage-range"
            data-testid="swap-slippage-percent"
          />
        </DetailRow>
        {networkFee && (
          // Kept as its own row so the solver spread noted above isn't read as the whole price
          // of the swap — the two are different costs.
          <DetailRow
            label={t('networkFeeMax')}
            sub={
              networkFeeDetails && (
                <TokenUsdValue {...networkFeeDetails} faucetId={networkFeeDetails.faucetId ?? undefined} />
              )
            }
            info={
              <InfoHint label={t('moreInfoAbout', { label: t('networkFeeMax') })} data-testid="swap-network-fee-info">
                {t('networkFeeEstimateNote')}
              </InfoHint>
            }
          >
            {networkFee}
          </DetailRow>
        )}
        <DetailRow label={t('usuallyFillsIn')} data-testid="swap-fills-in-row">
          {formatFillsIn(t, quote)}
        </DetailRow>
        {/* Stacked: four choices do not fit beside a label on a phone. */}
        <DetailRow label={t('swapExpiryLabel')} stacked data-testid="swap-expiry-row">
          <SegmentedControl
            items={presetItems}
            value={preset.id}
            onChange={onPresetChange}
            size="sm"
            layout="fill"
            aria-label={t('swapExpiryLabel')}
            data-testid="swap-expiry-preset"
            className="w-full"
          />
        </DetailRow>
        <DetailRow label={t('swapAutoConsume')}>
          <Toggle
            data-testid="swap-auto-consume"
            accent="swap"
            value={autoConsume}
            onChangeValue={onAutoConsumeChange}
            disabled={submitting}
            aria-label={t('swapAutoConsume')}
            className="!h-8 !w-16 !px-1.5 [&>div]:!h-5 [&>div]:!w-5"
          />
        </DetailRow>
      </DetailCard>
      <p className="mt-3 px-4 text-caption face-heading text-muted" data-testid="swap-expiry-note">
        {t('swapExpiryNote', { amount: `${offerAmount} ${offerLabel}` })}
      </p>
      {submitError && <p className="select-text pt-2 text-sm font-medium text-status-negative">{submitError}</p>}
    </ReviewLayout>
  );
};
