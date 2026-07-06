import React from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';

export interface ReviewAmountProps {
  symbol: string;
  amount: string;
  /** Optional ≈USD line under the amount. Omit for swap-style heroes. */
  fiat?: number;
  /** Optional caption above the amount, e.g. "You Send" / "You Receive". */
  label?: string;
}

/**
 * Hero amount block for a review screen: token logo + "{amount} {symbol}", with
 * an optional caption and an optional ≈USD line. Compose two of these (plus a
 * swap arrow) for a swap review hero.
 */
export const ReviewAmount: React.FC<ReviewAmountProps> = ({ symbol, amount, fiat, label }) => {
  const { t } = useTranslation();

  return (
    <div>
      {label && (
        <div className="text-2xl text-gray font-heading p-2 bg-[#F9F9F9] rounded-full font-bold w-fit">
          {label}
        </div>
      )}
      <div className="flex items-center gap-2 mt-3">
        <TokenLogo symbol={symbol} size="md" />
        <span className="font-heading text-[40px] font-extrabold text-heading-gray leading-none">
          {amount} {symbol}
        </span>
      </div>
      {fiat != null && (
        <p className="text-center font-heading text-sm text-gray">
          {t('approxFiatValue', { value: `$${fiat.toFixed(2)}` })}
        </p>
      )}
    </div>
  );
};
