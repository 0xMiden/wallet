import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber, AssetListItem, Pill, Sparkline } from 'components/ui';
import { adaptiveFormatterFor } from 'lib/i18n/numbers';
import type { TokenBalanceData } from 'lib/miden/front';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { quotedPrice, useTokenSparkline } from 'lib/prices';
import type { TokenPrices } from 'lib/prices';
import { isNominalQuote } from 'lib/prices/binance';
import { isFixedQuote } from 'lib/prices/fixed';
import { useTokenVerification } from 'lib/token-list/useTokenVerification';

export interface AssetRowProps {
  asset: TokenBalanceData;
  tokenPrices: TokenPrices;
  onClick?: () => void;
  /** Draws the 1D sparkline (the default). Off, the row fetches none and gives its width to the name. */
  sparkline?: boolean;
  'data-testid'?: string;
}

const FLAT_SPARKLINE_POINTS = [1, 1];

/** The 24h move, signed. The sign follows the figure shown, so it is right on every frame. */
const formatPercent = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

/** A 24h move smaller than this either way reads as flat: grey, not green or red. A stablecoin's
 *  ±0.02% is noise, and colouring it made a steady token look like it was falling. */
const FLAT_MOVE_PERCENT = 0.1;

/** How many points the row's sparkline is drawn from. The 1D feed is far denser than a 64px line
 *  can show; averaging it into buckets keeps its shape and drops the tick-level jitter. */
const SPARKLINE_BUCKETS = 10;

/** The line's box always spans at least this share of the price (0.2%), so a token that barely
 *  moved draws a gentle wave through the middle instead of a swing stretched to the full height.
 *  Anything that moves more than that (any non-stable token on most days) fills the box as before. */
const SPARKLINE_MIN_RANGE_SHARE = 0.002;

const downsample = (values: number[], buckets: number): number[] => {
  if (values.length <= buckets) return values;
  const size = values.length / buckets;
  return Array.from({ length: buckets }, (_, b) => {
    const slice = values.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    return slice.reduce((sum, v) => sum + v, 0) / slice.length;
  });
};

/**
 * Wallet-aware row used in Explore + SelectToken — wraps AssetListItem with
 * the standard data plumbing: TokenLogo for the icon, 1D sparkline from
 * Binance (flat-grey fallback for unindexed symbols), fiat price, and
 * coloured 24h delta.
 */
export const AssetRow: FC<AssetRowProps> = ({
  asset,
  tokenPrices,
  onClick,
  sparkline = true,
  'data-testid': dataTestId
}) => {
  const { t } = useTranslation();
  const verification = useTokenVerification(asset.tokenId);
  const { metadata, balance } = asset;
  // `balance` was divided by `metadata.decimals` upstream, so when those
  // decimals are the unknown-token placeholder's guess the number is not the
  // user's balance — an 18-decimal token reads a trillion times too high. Name
  // the token and show no quantity, and drop the fiat line with it: a dollar
  // figure derived from that balance is the same fiction, one step further on.
  const scaleIsKnown = hasKnownScale(metadata);
  // The quote of the symbol the feed prices this token under (IETH at ETH), or the nominal $1 a
  // unit `quotedPrice` gives a token the feed does not quote while the switch is on. Without one
  // there is no dollar figure and no 24h move to show.
  const priceSymbol = priceSymbolFor(asset.tokenId, metadata.symbol);
  const quote = quotedPrice(tokenPrices, priceSymbol);
  // Only a feed quote has a 24h move. The nominal rate is a dollar figure with no market behind it,
  // so it has no direction to colour anything by, like no quote at all.
  const feedQuote = quote && !isNominalQuote(quote) && !isFixedQuote(quote) ? quote : undefined;
  const direction: 'positive' | 'negative' | 'neutral' | null = feedQuote
    ? Math.abs(feedQuote.percentageChange24h) < FLAT_MOVE_PERCENT
      ? 'neutral'
      : feedQuote.percentageChange24h >= 0
        ? 'positive'
        : 'negative'
    : null;
  // Each figure's precision is pinned to the value it is heading for, so a quantity does not
  // change how many decimals it shows on the way there (`adaptiveFormatterFor`).
  const fiatValue = quote ? balance * quote.price : 0;
  const formatQuantity = adaptiveFormatterFor(balance);
  const formatFiat = adaptiveFormatterFor(fiatValue);

  // An empty symbol is the hook's "fetch nothing".
  const points = useTokenSparkline(sparkline && !isFixedQuote(quote) ? priceSymbol : '', '1D');
  const hasRealPoints = points.length > 1;
  // Keyed on the hook's array so a re-render with the same series keeps Sparkline's path memo.
  const sparkPoints = useMemo(
    () => (hasRealPoints ? downsample(points, SPARKLINE_BUCKETS) : FLAT_SPARKLINE_POINTS),
    [hasRealPoints, points]
  );
  const sparkMinRange = useMemo(
    () => (sparkPoints.reduce((sum, v) => sum + v, 0) / sparkPoints.length) * SPARKLINE_MIN_RANGE_SHARE,
    [sparkPoints]
  );
  // The line takes the move's colour, grey when the move is flat, so it never argues with the pill.
  const sparkColor =
    hasRealPoints && (direction === 'positive' || direction === 'negative')
      ? direction === 'positive'
        ? 'var(--status-positive)'
        : 'var(--status-negative)'
      : 'var(--color-text-tertiary)';

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
      chart={
        sparkline && !isFixedQuote(quote) ? (
          <Sparkline
            points={sparkPoints}
            color={sparkColor}
            width={64}
            height={28}
            strokeWidth={1.8}
            smooth
            // Breathing room before the price column, so the line never runs into the pill.
            className="mr-5"
            minRange={sparkMinRange}
          />
        ) : undefined
      }
      price={
        scaleIsKnown && quote ? (
          <AnimatedNumber value={fiatValue} format={value => `$${formatFiat(value)}`} />
        ) : undefined
      }
      delta={
        feedQuote && direction
          ? { value: <AnimatedNumber value={feedQuote.percentageChange24h} format={formatPercent} />, direction }
          : undefined
      }
      // A soft grey tag rather than the warning tint, which read like a button.
      badge={
        verification === 'unverified' ? (
          // Nunito draws the name's capitals low in its line, so the tag rises 3px to centre on them.
          <Pill size="tag" tone="muted" className="-translate-y-[3px]">
            {t('unverifiedToken')}
          </Pill>
        ) : undefined
      }
      onClick={onClick}
      data-testid={dataTestId}
    />
  );
};

export default AssetRow;
