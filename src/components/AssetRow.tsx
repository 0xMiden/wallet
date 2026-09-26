import React, { FC } from 'react';

import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber, AssetListItem, Sparkline } from 'components/ui';
import { adaptiveFormatterFor } from 'lib/i18n/numbers';
import type { TokenBalanceData } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { quotedPrice, useTokenSparkline } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';

export interface AssetRowProps {
  asset: TokenBalanceData;
  tokenPrices: TokenPrices;
  onClick?: () => void;
  'data-testid'?: string;
}

const FLAT_SPARKLINE_POINTS = [1, 1];

/** The 24h move, signed. The sign follows the figure shown, so it is right on every frame. */
const formatPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

/**
 * Wallet-aware row used in Explore + SelectToken — wraps AssetListItem with
 * the standard data plumbing: TokenLogo for the icon, 1D sparkline from
 * Binance (flat-grey fallback for unindexed symbols), fiat price, and
 * coloured 24h delta.
 */
export const AssetRow: FC<AssetRowProps> = ({ asset, tokenPrices, onClick, 'data-testid': dataTestId }) => {
  const { metadata, balance } = asset;
  // `balance` was divided by `metadata.decimals` upstream, so when those
  // decimals are the unknown-token placeholder's guess the number is not the
  // user's balance — an 18-decimal token reads a trillion times too high. Name
  // the token and show no quantity, and drop the fiat line with it: a dollar
  // figure derived from that balance is the same fiction, one step further on.
  const scaleIsKnown = hasKnownScale(metadata);
  // The quote of the symbol the feed prices this token under (IETH at ETH). Without one there is
  // no dollar figure and no 24h move to show, rather than the token count at $1 a unit.
  const priceSymbol = priceSymbolFor(asset.tokenId, metadata.symbol);
  const quote = quotedPrice(tokenPrices, priceSymbol);
  const isPositive = (quote?.percentageChange24h ?? 0) >= 0;
  const direction: 'positive' | 'negative' = isPositive ? 'positive' : 'negative';
  // Each figure's precision is pinned to the value it is heading for, so a quantity does not
  // change how many decimals it shows on the way there (`adaptiveFormatterFor`).
  const fiatValue = quote ? balance * quote.price : 0;
  const formatQuantity = adaptiveFormatterFor(balance);
  const formatFiat = adaptiveFormatterFor(fiatValue);

  const points = useTokenSparkline(priceSymbol, '1D');
  const hasRealPoints = points.length > 1;
  const sparkPoints = hasRealPoints ? points : FLAT_SPARKLINE_POINTS;
  const sparkColor = hasRealPoints
    ? isPositive
      ? 'var(--status-positive)'
      : 'var(--status-negative)'
    : 'var(--text-tertiary)';

  return (
    <AssetListItem
      icon={<TokenLogo symbol={metadata.symbol} />}
      name={metadata.name || metadata.symbol}
      amount={
        scaleIsKnown ? (
          <AnimatedNumber value={balance} format={value => `${formatQuantity(value)} ${metadata.symbol}`} />
        ) : (
          metadata.symbol
        )
      }
      chart={<Sparkline points={sparkPoints} color={sparkColor} width={120} height={32} />}
      price={
        scaleIsKnown && quote ? (
          <AnimatedNumber value={fiatValue} format={value => `$${formatFiat(value)}`} />
        ) : undefined
      }
      delta={
        quote
          ? { value: <AnimatedNumber value={quote.percentageChange24h} format={formatPercent} />, direction }
          : undefined
      }
      onClick={onClick}
      data-testid={dataTestId}
    />
  );
};

export default AssetRow;
