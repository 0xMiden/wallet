import React from 'react';

import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { ReviewAmount, ReviewLabel, ReviewLayout, ReviewRow } from 'components/review';
import { Toggle } from 'components/Toggle';
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
  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500 text-pure-white">
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

const ReviewControlRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-4 py-6">
    <ReviewLabel className="shrink-0">{label}</ReviewLabel>
    <div className="flex min-w-0 items-center justify-end">{children}</div>
  </div>
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
  const divider = <div className="h-0.75 flex-1 bg-[#ECEBE8]" />;
  const rate = formatRate(offerToken.symbol, requestToken.symbol, swapEta?.marketPrice);

  const hero = (
    <div className="mt-3">
      <ReviewAmount
        label={t('youSend')}
        symbol={offerToken.symbol}
        logoSymbol={offerToken.logoSymbol}
        amount={offerAmount}
      />

      <div className="my-4 flex items-center gap-3">
        {divider}
        <SwapArrows />
        {divider}
      </div>

      <ReviewAmount
        label={t('youReceive')}
        symbol={requestToken.symbol}
        logoSymbol={requestToken.logoSymbol}
        amount={requestAmount}
      />
    </div>
  );

  return (
    <ReviewLayout
      hero={hero}
      heroDivider={false}
      dividers={false}
      primary={{ label: t('swap'), onPress: onSubmit, 'data-testid': 'swap-submit' }}
      secondary={{ label: t('back'), onPress: onGoBack }}
    >
      <ReviewRow label={t('rate')} value={rate} />
      {rate && (
        <p className="pt-1 text-xs text-heading-gray">
          {t('swapSolverFeeNote', { percent: `${Math.round(SOLVER_MARGIN * 100)}%` })}
        </p>
      )}
      <ReviewRow label={t('usuallyFillsIn')} value={formatFillsIn(t, swapEta)} />
      <ReviewControlRow label={t('expires')}>
        <label className="inline-flex items-center justify-end gap-2 font-heading text-2xl font-bold text-heading-gray">
          <input
            data-testid="swap-expiry-seconds"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={expirySeconds}
            onChange={event => onExpirySecondsChange(event.target.value)}
            className="w-24 appearance-none rounded-lg border border-border-light bg-transparent px-3 py-2 text-right outline-none [appearance:textfield] focus:border-primary-500 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span>{t('seconds')}</span>
        </label>
      </ReviewControlRow>
      <ReviewControlRow label={t('swapAutoConsume')}>
        <Toggle
          data-testid="swap-auto-consume"
          value={autoConsume}
          onChangeValue={onAutoConsumeChange}
          aria-label={t('swapAutoConsume')}
          className="!h-8 !w-16 !px-1.5 [&>div]:!h-5 [&>div]:!w-5"
        />
      </ReviewControlRow>
      {submitError && <p className="select-text pt-2 text-sm font-medium text-status-negative">{submitError}</p>}
    </ReviewLayout>
  );
};
