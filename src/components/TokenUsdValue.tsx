import React from 'react';

import { useTranslation } from 'react-i18next';

import { tokenQuote } from 'lib/miden/swap/tokens';
import { quoteExpiryMs, usdEstimateText } from 'lib/prices/amount';
import type { TokenPriceInfo } from 'lib/prices/binance';
import { useQuoteClock } from 'lib/prices/use-quote-clock';
import { useWalletStore } from 'lib/store';

export interface UsdValueProps {
  amount: string | number | bigint;
  /** Required for bigint base units. String and number amounts are human token units. */
  decimals?: number;
  quote?: TokenPriceInfo;
  className?: string;
}

export const UsdValue: React.FC<UsdValueProps> = ({ amount, decimals, quote, className }) => {
  const { t } = useTranslation();
  useQuoteClock(quoteExpiryMs(quote));
  const value = usdEstimateText(amount, quote, decimals);
  return value ? (
    <span className={className ?? 'text-caption text-muted'}>{t('approxFiatValue', { value })}</span>
  ) : null;
};

export interface TokenUsdValueProps extends Omit<UsdValueProps, 'quote'> {
  faucetId?: string;
  symbol: string;
}

export const TokenUsdValue: React.FC<TokenUsdValueProps> = ({ faucetId, symbol, ...props }) => {
  const prices = useWalletStore(state => state.tokenPrices);
  return <UsdValue {...props} quote={tokenQuote(prices, faucetId, symbol)} />;
};
