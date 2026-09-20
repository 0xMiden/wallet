import React from 'react';

import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import { ReviewLayout } from 'components/review';
import { Toggle } from 'components/Toggle';
import { TokenLogo } from 'components/TokenLogo';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Pill } from 'components/ui/Pill';
import { SOLVER_MARGIN, SwapEta, SwapToken } from 'lib/miden/swap/tokens';

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
}

/** "1 {offer} ≈ {marketPrice} {request}" from the oracle rate, or undefined if unavailable. */
function formatRate(offerSymbol: string, requestSymbol: string, marketPrice?: string): string | undefined {
  const rate = Number(marketPrice);
  if (!rate || !Number.isFinite(rate)) return undefined;
  const formatted = Number(rate.toPrecision(4)).toString();
  return `1 ${offerSymbol} ≈ ${formatted} ${requestSymbol}`;
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
  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-swap text-pure-white">
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
  onSubmit
}) => {
  const { t } = useTranslation();
  const networkFee = useNetworkFeeEstimate();
  const divider = <div className="h-0.75 flex-1 bg-[#ECEBE8]" />;
  const rate = formatRate(offerToken.symbol, requestToken.symbol, swapEta?.marketPrice);

  // A caption pill identifies which side of the swap each amount belongs to — Hero's own
  // slots are visual + value + a subtitle *below* the value, with no room for a heading
  // above it, so the pill sits beside Hero rather than inside it.
  const hero = (
    <div className="mt-3 flex w-full flex-col items-center">
      <Pill tone="neutral">{t('youSend')}</Pill>
      <Hero
        className="mt-2"
        visual={<TokenLogo symbol={offerToken.logoSymbol ?? offerToken.symbol} size="md" />}
        value={`${offerAmount} ${offerToken.symbol}`}
      />

      <div className="my-4 flex w-full items-center gap-3">
        {divider}
        <SwapArrows />
        {divider}
      </div>

      <Pill tone="neutral">{t('youReceive')}</Pill>
      <Hero
        className="mt-2"
        visual={<TokenLogo symbol={requestToken.logoSymbol ?? requestToken.symbol} size="md" />}
        value={`${requestAmount} ${requestToken.symbol}`}
      />
    </div>
  );

  return (
    <ReviewLayout
      hero={hero}
      accent="swap"
      heroDivider={false}
      dividers={false}
      primary={{ label: t('swap'), onPress: onSubmit, 'data-testid': 'swap-submit' }}
      secondary={{ label: t('back'), onPress: onGoBack }}
    >
      <DetailCard>
        {/* The solver spread rides along as this row's own sub-line, since it explains the
            rate figure above it. */}
        <DetailRow
          label={t('rate')}
          sub={rate ? t('swapSolverFeeNote', { percent: `${Math.round(SOLVER_MARGIN * 100)}%` }) : undefined}
          data-testid="swap-rate-row"
        >
          {rate}
        </DetailRow>
        {networkFee && (
          // Kept as its own row so the solver spread noted above isn't read as the whole price
          // of the swap — the two are different costs.
          <DetailRow label={t('networkFeeMax')} sub={t('networkFeeEstimateNote')}>
            {networkFee}
          </DetailRow>
        )}
        <DetailRow label={t('usuallyFillsIn')} data-testid="swap-fills-in-row">
          {formatFillsIn(t, swapEta)}
        </DetailRow>
        <DetailRow label={t('expires')}>
          <label className="inline-flex items-center gap-2">
            <input
              data-testid="swap-expiry-seconds"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              enterKeyHint="done"
              value={expirySeconds}
              onChange={event => onExpirySecondsChange(event.target.value)}
              className="w-16 appearance-none rounded-lg border border-hairline bg-transparent px-2 py-1 text-right font-heading text-[15px] font-bold text-ink outline-none [appearance:textfield] focus:border-accent-swap [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span>{t('seconds')}</span>
          </label>
        </DetailRow>
        <DetailRow label={t('swapAutoConsume')}>
          <Toggle
            data-testid="swap-auto-consume"
            accent="swap"
            value={autoConsume}
            onChangeValue={onAutoConsumeChange}
            aria-label={t('swapAutoConsume')}
            className="!h-8 !w-16 !px-1.5 [&>div]:!h-5 [&>div]:!w-5"
          />
        </DetailRow>
      </DetailCard>
      {submitError && <p className="select-text pt-2 text-sm font-medium text-status-negative">{submitError}</p>}
    </ReviewLayout>
  );
};
