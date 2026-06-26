import React from 'react';

import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';
import { SwapToken } from 'lib/miden/swap/tokens';

export interface ReviewSwapProps {
  offerToken: SwapToken;
  offerAmount: string;
  requestToken: SwapToken;
  requestAmount: string;
  /** USD price per whole token, used to render the (wired) Rate row. */
  offerPrice?: number;
  requestPrice?: number;
  submitError?: string | null;
  onGoBack: () => void;
  onSubmit: () => void;
}

/** "1 {offer} ≈ {ratio} {request}" from the two USD prices, or undefined if unavailable. */
function formatRate(
  offerSymbol: string,
  requestSymbol: string,
  offerPrice?: number,
  requestPrice?: number
): string | undefined {
  if (!offerPrice || !requestPrice) return undefined;
  const ratio = offerPrice / requestPrice;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  const formatted = Number(ratio.toPrecision(4)).toString();
  return `1 ${offerSymbol} ≈ ${formatted} ${requestSymbol}`;
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

/**
 * Swap review screen: a two-amount hero (You Send / You Receive) with a swap
 * glyph between them, then the swap detail rows. Only Rate is wired today; the
 * remaining rows are static placeholders pending backend swap-quote metadata.
 */
export const ReviewSwap: React.FC<ReviewSwapProps> = ({
  offerToken,
  offerAmount,
  requestToken,
  requestAmount,
  offerPrice,
  requestPrice,
  submitError,
  onGoBack,
  onSubmit
}) => {
  const { t } = useTranslation();
  const today = format(new Date(), 'dd.MM.yy');
  const rate = formatRate(offerToken.symbol, requestToken.symbol, offerPrice, requestPrice);

  const hero = (
    <div className="mt-3">
      <ReviewAmount
        label={t('youSend')}
        symbol={offerToken.symbol}
        logoSymbol={offerToken.logoSymbol}
        amount={offerAmount}
      />

      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-border-light" />
        <SwapArrows />
        <div className="h-px flex-1 bg-border-light" />
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
      title={t('reviewSwapDetails')}
      date={today}
      onBack={onGoBack}
      backLabel={t('back')}
      hero={hero}
      heroDivider={false}
      dividers={false}
      primary={{ label: t('sendPayment'), onPress: onSubmit }}
      secondary={{ label: t('back'), onPress: onGoBack }}
    >
      <ReviewRow label={t('rate')} value={rate ?? '—'} />
      <ReviewRow label={t('usuallyFillsIn')} value={t('swapUsuallyFillsInValue')} />
      <ReviewRow label={t('expires')} value={t('swapExpiresValue')} />
      <ReviewRow label={t('networkFee')} value={t('swapNetworkFeeValue')} />
      {submitError && <p className="select-text pt-2 text-sm font-medium text-status-negative">{submitError}</p>}
    </ReviewLayout>
  );
};
