import React, { useEffect } from 'react';

import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import { ReviewLayout } from 'components/review';
import { SwapTokenInfoButton } from 'components/SwapTokenInfoSheet';
import { Toggle } from 'components/Toggle';
import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { InfoHint } from 'components/ui/InfoHint';
import { Pill } from 'components/ui/Pill';
import { SegmentedControl } from 'components/ui/SegmentedControl';
import { SOLVER_MARGIN, SwapEta, SwapToken } from 'lib/miden/swap/tokens';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';

import { EXPIRY_PRESETS, ExpiryPresetId, presetForSeconds } from './expiry';

export interface ReviewSwapProps {
  offerToken: SwapToken;
  offerAmount: string;
  requestToken: SwapToken;
  requestAmount: string;
  /** Latest quote for the pair; drives the Rate and "Usually fills in" rows. */
  swapEta?: SwapEta;
  expirySeconds: string;
  autoConsume: boolean;
  onExpirySecondsChange: (seconds: string) => void;
  onAutoConsumeChange: (enabled: boolean) => void;
  submitError?: string | null;
  onGoBack: () => void;
  onSubmit: () => void;
  /** A submission is in flight: the expiry holds still until it settles. */
  submitting?: boolean;
}

/** The oracle rate as a number, or `undefined` when there isn't one to show. */
function parseRate(marketPrice?: string | null): number | undefined {
  const rate = Number(marketPrice);
  if (!rate || !Number.isFinite(rate)) return undefined;
  return rate;
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
 * Human "usually fills in" estimate. Prefers the live next-batch ETA when the
 * order crosses resting liquidity, then the pair's 24h median, then a static
 * fallback (both live signals are often null on the current testnet book).
 */
function formatFillsIn(t: TFunction, swapEta?: SwapEta): string {
  const seconds =
    swapEta?.canFill && swapEta.estimatedSeconds != null ? swapEta.estimatedSeconds : swapEta?.median24hSeconds;
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
  swapEta,
  expirySeconds,
  autoConsume,
  onExpirySecondsChange,
  onAutoConsumeChange,
  submitError,
  onGoBack,
  onSubmit,
  submitting = false
}) => {
  const { t } = useTranslation();
  const networkFee = useNetworkFeeEstimate();
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const offerLabel = midenTokenLabel(bridgeConfig, offerToken.faucetId, offerToken.symbol);
  const requestLabel = midenTokenLabel(bridgeConfig, requestToken.faucetId, requestToken.symbol);
  const divider = <div className="h-0.75 flex-1 bg-[#ECEBE8]" />;
  // The quote is re-fetched while this screen is open, so the rate counts to each new one.
  const rate = parseRate(swapEta?.marketPrice);
  const formatRateValue = rateFormatterFor(rate ?? 0);

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
        value={
          <span className="inline-flex items-center gap-1">
            {`${offerAmount} ${offerLabel}`}
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
        loading: submitting,
        'data-testid': 'swap-submit'
      }}
      secondary={{ label: t('back'), onPress: onGoBack, disabled: submitting }}
    >
      {/* The card is its own block under the hero, not the next line of it: without this the
          receive amount and the first row read as one run of text. */}
      <DetailCard surface="outline" face="heading" className="mt-8">
        {/* The solver spread explains the rate figure, but it is a sentence: as a sub-line it
            wrapped over three lines and pushed the rows apart, so it waits behind the (i). */}
        <DetailRow
          label={t('rate')}
          info={
            rate !== undefined ? (
              <InfoHint label={t('moreInfoAbout', { label: t('rate') })} data-testid="swap-rate-info">
                {t('swapSolverFeeNote', { percent: `${Math.round(SOLVER_MARGIN * 100)}%` })}
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
        {networkFee && (
          // Kept as its own row so the solver spread noted above isn't read as the whole price
          // of the swap — the two are different costs.
          <DetailRow
            label={t('networkFeeMax')}
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
          {formatFillsIn(t, swapEta)}
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
