import React, { FC } from 'react';

import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber, AssetListItem, Sparkline } from 'components/ui';
import { adaptiveFormatterFor } from 'lib/i18n/numbers';
import type { TokenBalanceData } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { getTokenPrice, useTokenSparkline } from 'lib/prices';
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
  const priceInfo = getTokenPrice(tokenPrices, metadata.symbol);
  const isPositive = priceInfo.percentageChange24h >= 0;
  const direction: 'positive' | 'negative' = isPositive ? 'positive' : 'negative';
  // Each figure's precision is pinned to the value it is heading for, so a quantity does not
  // change how many decimals it shows on the way there (`adaptiveFormatterFor`).
  const fiatValue = balance * priceInfo.price;
  const formatQuantity = adaptiveFormatterFor(balance);
  const formatFiat = adaptiveFormatterFor(fiatValue);

  const points = useTokenSparkline(metadata.symbol, '1D');
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
      price={scaleIsKnown ? <AnimatedNumber value={fiatValue} format={value => `$${formatFiat(value)}`} /> : undefined}
      delta={{ value: <AnimatedNumber value={priceInfo.percentageChange24h} format={formatPercent} />, direction }}
      onClick={onClick}
      data-testid={dataTestId}
    />
  );
};

export default AssetRow;
