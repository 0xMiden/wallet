import React from 'react';

import { render, screen, fireEvent, within } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front';
import { TOKEN_IBTC, TOKEN_IETH } from 'lib/miden/swap/tokens';
import {
  getNativeAssetIdSync,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync
} from 'lib/miden-chain/native-asset';
import { useTokenSparkline } from 'lib/prices';
import type { TokenPriceInfo, TokenPrices } from 'lib/prices';
import { hasUnquotedDefaultPrice } from 'lib/prices/unquoted-default';

import AssetRowDefault, { AssetRow } from './AssetRow';

// --- Mock the leaf UI dependencies so we can assert the exact props AssetRow
// wires through to them, keeping the test focused on AssetRow's own logic.

jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => null),
  getNativeAssetMetadataSync: jest.fn(() => null),
  getSdkSyncedNativeAssetIdSync: jest.fn(() => null)
}));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, faucetId }: { symbol: string; faucetId?: string }) => (
    <span data-testid="token-logo" data-symbol={symbol} data-faucet-id={faucetId} />
  )
}));
// The figures under test follow the default rule, no figure without a quote; pinned here against
// Developer Settings' nominal $1 switch (lib/prices/unquoted-default). The nominal case flips it.
jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));
const mockedHasUnquotedDefaultPrice = jest.mocked(hasUnquotedDefaultPrice);

jest.mock('components/ui', () => ({
  // The three figures are nodes now, not strings, so the stub renders them instead of stringifying
  // them into attributes. `AnimatedNumber` stands in for the real one at its contract: a finite
  // number goes through the caller's own formatter, anything else renders nothing.
  AnimatedNumber: ({ value, format }: any) =>
    typeof value === 'number' && Number.isFinite(value) ? <span>{format(value)}</span> : null,
  AssetListItem: ({ icon, name, amount, chart, price, delta, badge, onClick, 'data-testid': dataTestId }: any) => (
    <div
      data-testid={dataTestId ?? 'asset-list-item'}
      data-name={name}
      data-delta-direction={delta?.direction}
      data-has-onclick={onClick ? 'yes' : 'no'}
      onClick={onClick}
    >
      <span data-testid="row-amount">{amount}</span>
      {price !== undefined && <span data-testid="row-price">{price}</span>}
      {delta && <span data-testid="row-delta">{delta.value}</span>}
      {badge}
      {icon}
      {chart}
    </div>
  ),
  Pill: ({ size, tone, className, children }: any) => (
    <span data-testid="pill" data-size={size} data-tone={tone} className={className}>
      {children}
    </span>
  ),
  Sparkline: ({ points, color, width, height, minRange }: any) => {
    mockSparklinePointsRenders.push(points);
    return (
      <span
        data-testid="sparkline"
        data-points={JSON.stringify(points)}
        data-color={color}
        data-width={width}
        data-height={height}
        data-min-range={minRange}
      />
    );
  }
}));

// Every `points` prop the Sparkline double was rendered with, in order: its path memo keys on that identity.
const mockSparklinePointsRenders: number[][] = [];

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const mockVerify = jest.fn();
jest.mock('lib/token-list/useTokenVerification', () => ({ useTokenVerification: (id: string) => mockVerify(id) }));

// The sparkline hook fetches, so it is stubbed; the price lookup is the real one.
jest.mock('lib/prices', () => ({
  quotedPrice: jest.requireActual('lib/prices/binance').quotedPrice,
  useTokenSparkline: jest.fn()
}));

const mockUseTokenSparkline = useTokenSparkline as jest.MockedFunction<typeof useTokenSparkline>;

let tokenPrices: TokenPrices;

function makeAsset(overrides: Partial<{ symbol: string; name: string; balance: number }> = {}): TokenBalanceData {
  const { symbol = 'BTC', name = 'Bitcoin', balance = 2 } = overrides;
  return {
    tokenId: TOKEN_IBTC.faucetId,
    tokenSlug: 'slug-1',
    metadata: { symbol, name } as TokenBalanceData['metadata'],
    balance,
    fiatPrice: 0,
    change24h: 0
  };
}

function priceInfo(overrides: Partial<TokenPriceInfo> = {}): TokenPriceInfo {
  return { price: 100, change24h: 0, percentageChange24h: 5, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSparklinePointsRenders.length = 0;
  // Sensible defaults; individual tests override as needed.
  tokenPrices = { BTC: priceInfo() };
  mockUseTokenSparkline.mockReturnValue([10, 20, 30]);
  mockVerify.mockReturnValue('unknown');
});

describe('AssetRow', () => {
  it("passes the row's faucet id to its logo", () => {
    const asset = makeAsset();
    render(<AssetRow asset={asset} tokenPrices={tokenPrices} />);

    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-faucet-id', asset.tokenId);
  });

  it.each(['verified', 'unknown'])('hides the Unverified mark for a %s token', verification => {
    mockVerify.mockReturnValue(verification);

    const asset = makeAsset();
    render(<AssetRow asset={asset} tokenPrices={tokenPrices} />);

    expect(screen.queryByText('unverifiedToken')).toBeNull();
    expect(mockVerify).toHaveBeenCalledWith(asset.tokenId);
  });

  it('tags an unverified token at the tag size', () => {
    mockVerify.mockReturnValue('unverified');

    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

    const pill = screen.getAllByTestId('pill').find(node => node.textContent === 'unverifiedToken')!;
    expect(pill).toBeDefined();
    expect(pill).toHaveAttribute('data-size', 'tag');
    expect(pill).toHaveAttribute('data-tone', 'muted');
    // The size brings the height, padding and type; the row adds only the nudge onto the name's capitals.
    expect(pill).toHaveAttribute('class', '-translate-y-[3px]');
  });

  it('renders a positive 24h delta with a "+" prefix, positive direction, and status-positive sparkline color', () => {
    tokenPrices = { BTC: priceInfo({ price: 100, percentageChange24h: 5.256 }) };

    render(<AssetRow asset={makeAsset({ balance: 2 })} tokenPrices={tokenPrices} />);

    const item = screen.getByTestId('asset-list-item');
    // Delta formatting: "+" prefix + two decimals + "%".
    expect(screen.getByTestId('row-delta')).toHaveTextContent('+5.26%');
    expect(item).toHaveAttribute('data-delta-direction', 'positive');
    // The bare figure: AssetListItem draws the pill and tints it by the direction.
    expect(within(screen.getByTestId('row-delta')).queryByTestId('pill')).toBeNull();

    // Real points (length > 1) => the actual points and the positive color; the beforeEach series.
    const spark = screen.getByTestId('sparkline');
    expect(spark).toHaveAttribute('data-points', JSON.stringify([10, 20, 30]));
    expect(spark).toHaveAttribute('data-color', 'var(--status-positive)');
    expect(spark).toHaveAttribute('data-width', '64');
    expect(spark).toHaveAttribute('data-height', '28');

    // Amount + price plumbing: standard 2dp formatting + symbol; balance * price.
    expect(screen.getByTestId('row-amount')).toHaveTextContent('2.00 BTC');
    expect(screen.getByTestId('row-price')).toHaveTextContent('$200.00');

    expect(mockUseTokenSparkline).toHaveBeenCalledWith('BTC', '1D');
  });

  it('expands precision for a small non-zero balance and fiat value', () => {
    tokenPrices = { BTC: priceInfo({ price: 2 }) };

    render(<AssetRow asset={makeAsset({ balance: 0.001234 })} tokenPrices={tokenPrices} />);

    expect(screen.getByTestId('row-amount')).toHaveTextContent('0.0012 BTC');
    expect(screen.getByTestId('row-price')).toHaveTextContent('$0.0025');
  });

  it('treats a move under 0.1% either way as flat: a grey pill and a grey line', () => {
    for (const change of [0, -0.02, 0.09]) {
      tokenPrices = { BTC: priceInfo({ percentageChange24h: change }) };

      const { unmount } = render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

      expect(screen.getByTestId('asset-list-item')).toHaveAttribute('data-delta-direction', 'neutral');
      expect(within(screen.getByTestId('row-delta')).queryByTestId('pill')).toBeNull();
      expect(screen.getByTestId('sparkline')).toHaveAttribute('data-color', 'var(--color-text-tertiary)');
      unmount();
    }
  });

  it('colours a move of 0.1% either way, the flat cutoff being strict', () => {
    for (const [change, direction, color] of [
      [0.0999, 'neutral', 'var(--color-text-tertiary)'],
      [0.1, 'positive', 'var(--status-positive)'],
      [-0.1, 'negative', 'var(--status-negative)']
    ] as const) {
      tokenPrices = { BTC: priceInfo({ percentageChange24h: change }) };

      const { unmount } = render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

      expect(screen.getByTestId('asset-list-item')).toHaveAttribute('data-delta-direction', direction);
      expect(screen.getByTestId('sparkline')).toHaveAttribute('data-color', color);
      unmount();
    }
  });

  it('renders a negative 24h delta without a prefix, negative direction, and status-negative sparkline color', () => {
    tokenPrices = { BTC: priceInfo({ price: 50, percentageChange24h: -3.1 }) };
    mockUseTokenSparkline.mockReturnValue([5, 4, 3]);

    render(<AssetRow asset={makeAsset({ balance: 4 })} tokenPrices={tokenPrices} />);

    const item = screen.getByTestId('asset-list-item');
    expect(screen.getByTestId('row-delta')).toHaveTextContent('-3.10%');
    expect(item).toHaveAttribute('data-delta-direction', 'negative');
    expect(screen.getByTestId('row-price')).toHaveTextContent('$200.00');

    expect(screen.getByTestId('sparkline')).toHaveAttribute('data-color', 'var(--status-negative)');
  });

  it('values IETH, its 24h move and its sparkline at ETH, the symbol the feed quotes it under', () => {
    tokenPrices = { ETH: priceInfo({ price: 3000, percentageChange24h: 1.5 }) };
    const ieth = { ...makeAsset({ symbol: 'IETH', name: 'IETH', balance: 0.3 }), tokenId: TOKEN_IETH.faucetId };

    render(<AssetRow asset={ieth} tokenPrices={tokenPrices} />);

    expect(screen.getByTestId('row-price')).toHaveTextContent('$900.00');
    expect(screen.getByTestId('row-delta')).toHaveTextContent('+1.50%');
    expect(mockUseTokenSparkline).toHaveBeenCalledWith('ETH', '1D');
  });

  it('shows no fiat value and no 24h move for a token the feed does not quote, never a $1 figure', () => {
    tokenPrices = {};

    render(<AssetRow asset={makeAsset({ balance: 7 })} tokenPrices={tokenPrices} />);

    expect(screen.getByTestId('row-amount')).toHaveTextContent('7.00 BTC');
    expect(screen.queryByTestId('row-price')).toBeNull();
    expect(screen.queryByTestId('row-delta')).toBeNull();
    // No move is known either, so real points are drawn neutral, not in a stand-in 0%'s green.
    expect(screen.getByTestId('sparkline')).toHaveAttribute('data-color', 'var(--color-text-tertiary)');
  });

  // The nominal rate is a dollar figure, not a market, so it has no 24h move to show.
  it('values the native token at the nominal rate, with no 24h move, when the feed does not quote it', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    tokenPrices = {};
    const native = { ...makeAsset({ symbol: 'MIDEN', name: 'Miden', balance: 7 }), tokenId: 'mtst1native' };

    try {
      render(<AssetRow asset={native} tokenPrices={tokenPrices} />);

      expect(screen.getByTestId('row-price')).toHaveTextContent('$7.00');
      expect(screen.queryByTestId('row-delta')).toBeNull();
    } finally {
      mockedHasUnquotedDefaultPrice.mockReturnValue(false);
    }
  });

  it('gives no price to a faucet outside the allowlist that names itself BTC', () => {
    const asset = { ...makeAsset({ balance: 7 }), tokenId: 'mtst1other' };

    render(<AssetRow asset={asset} tokenPrices={tokenPrices} />);

    expect(screen.queryByTestId('row-price')).toBeNull();
    expect(screen.queryByTestId('row-delta')).toBeNull();
    expect(screen.getByTestId('sparkline')).toHaveAttribute('data-color', 'var(--color-text-tertiary)');
    expect(mockUseTokenSparkline).toHaveBeenCalledWith(undefined, '1D');
  });

  it('falls back to a flat grey sparkline when there are no real points (length <= 1)', () => {
    // Positive change, but no real sparkline data => tertiary color wins.
    tokenPrices = { BTC: priceInfo({ percentageChange24h: 8 }) };
    mockUseTokenSparkline.mockReturnValue([]);

    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

    const spark = screen.getByTestId('sparkline');
    // FLAT_SPARKLINE_POINTS fallback.
    expect(spark).toHaveAttribute('data-points', JSON.stringify([1, 1]));
    expect(spark).toHaveAttribute('data-color', 'var(--color-text-tertiary)');
  });

  it('treats a single-point series as "no real points" (boundary: length === 1)', () => {
    mockUseTokenSparkline.mockReturnValue([42]);

    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

    const spark = screen.getByTestId('sparkline');
    expect(spark).toHaveAttribute('data-points', JSON.stringify([1, 1]));
    expect(spark).toHaveAttribute('data-color', 'var(--color-text-tertiary)');
  });

  it('draws a dense series as 10 bucket means, its box floored at 0.2% of their mean', () => {
    mockUseTokenSparkline.mockReturnValue(Array.from({ length: 20 }, (_, i) => 100 + i));

    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

    const means = [100.5, 102.5, 104.5, 106.5, 108.5, 110.5, 112.5, 114.5, 116.5, 118.5];
    const spark = screen.getByTestId('sparkline');
    expect(spark).toHaveAttribute('data-points', JSON.stringify(means));
    const meanOfMeans = means.reduce((sum, v) => sum + v, 0) / means.length;
    expect(Number(spark.getAttribute('data-min-range'))).toBeCloseTo(meanOfMeans * 0.002, 12);
  });

  // A price tick re-renders the row with the hook's same array; a fresh one would redraw the path.
  it('hands Sparkline the same points array when re-rendered with the same series', () => {
    mockUseTokenSparkline.mockReturnValue(Array.from({ length: 20 }, (_, i) => 100 + i));

    const { rerender } = render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);
    rerender(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

    expect(mockSparklinePointsRenders).toHaveLength(2);
    expect(mockSparklinePointsRenders[1]).toBe(mockSparklinePointsRenders[0]);
  });

  it('uses metadata.name for the displayed name and passes the symbol to TokenLogo', () => {
    render(<AssetRow asset={makeAsset({ symbol: 'ETH', name: 'Ethereum' })} tokenPrices={tokenPrices} />);

    expect(screen.getByTestId('asset-list-item')).toHaveAttribute('data-name', 'Ethereum');
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'ETH');
  });

  it('falls back to the symbol when metadata.name is empty', () => {
    render(<AssetRow asset={makeAsset({ symbol: 'USDC', name: '' })} tokenPrices={tokenPrices} />);

    expect(screen.getByTestId('asset-list-item')).toHaveAttribute('data-name', 'USDC');
  });

  it('wires the onClick handler through to AssetListItem', () => {
    const onClick = jest.fn();

    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} onClick={onClick} />);

    const item = screen.getByTestId('asset-list-item');
    expect(item).toHaveAttribute('data-has-onclick', 'yes');

    fireEvent.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders without an onClick handler', () => {
    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

    const item = screen.getByTestId('asset-list-item');
    expect(item).toHaveAttribute('data-has-onclick', 'no');
    // Clicking is a no-op and must not throw.
    fireEvent.click(item);
  });

  it('draws the sparkline by default, fetched for the price symbol', () => {
    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} />);

    expect(screen.getByTestId('sparkline')).toBeInTheDocument();
    expect(mockUseTokenSparkline).toHaveBeenCalledWith('BTC', '1D');
  });

  it('draws no sparkline, and fetches none, when drawn without one', () => {
    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} sparkline={false} />);

    expect(screen.queryByTestId('sparkline')).toBeNull();
    expect(mockUseTokenSparkline).toHaveBeenCalledWith('', '1D');
    expect(mockUseTokenSparkline).not.toHaveBeenCalledWith('BTC', '1D');
  });

  it('forwards the data-testid prop to AssetListItem', () => {
    render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} data-testid="my-row" />);

    expect(screen.getByTestId('my-row')).toBeInTheDocument();
  });

  it('exposes the component as the default export', () => {
    expect(AssetRowDefault).toBe(AssetRow);

    render(<AssetRowDefault asset={makeAsset()} tokenPrices={tokenPrices} data-testid="default-row" />);
    expect(screen.getByTestId('default-row')).toBeInTheDocument();
  });
  // An unresolved faucet's `decimals` are the placeholder's guess, so `balance`
  // was divided by the wrong power of ten before it ever reached this row. The
  // token is still named; the number and the dollar figure derived from it are
  // withheld rather than shown as fact.
  describe('a token whose scale is unknown', () => {
    function unknownAsset(): TokenBalanceData {
      return {
        ...makeAsset(),
        tokenSlug: 'slug-unknown',
        metadata: {
          symbol: 'Unknown',
          name: 'Unknown',
          decimals: 6,
          scaleIsUnknown: true
        } as TokenBalanceData['metadata'],
        balance: 1234.5
      };
    }

    it('shows the symbol alone instead of a quantity', () => {
      const asset = unknownAsset();
      render(<AssetRow asset={asset} tokenPrices={tokenPrices} data-testid="row" />);

      expect(screen.getByTestId('row-amount').textContent).toBe(asset.metadata.symbol);
    });

    it('omits the fiat value, which is derived from the same wrong balance', () => {
      render(<AssetRow asset={unknownAsset()} tokenPrices={tokenPrices} data-testid="row" />);

      // The beforeEach BTC quote is what makes the row quoted, so the unknown scale is the only
      // thing that can withhold the figure.
      expect(screen.getByTestId('row-delta')).toBeInTheDocument();
      expect(screen.queryByTestId('row-price')).toBeNull();
    });

    it('still quantifies a token that reported its own decimals', () => {
      render(<AssetRow asset={makeAsset()} tokenPrices={tokenPrices} data-testid="row" />);

      expect(screen.getByTestId('row-amount')).toHaveTextContent('2.00 BTC');
    });
  });
});

it('shows a native fixed quote without rendering market movement or a chart', () => {
  jest.mocked(getNativeAssetIdSync).mockReturnValue('native-stable');
  jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue('native-stable');
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
  const asset = { ...makeAsset({ symbol: 'USDCX', name: 'USDCX', balance: 2 }), tokenId: 'native-stable' };
  render(<AssetRow asset={asset} tokenPrices={{}} />);
  expect(screen.getByTestId('row-price')).toHaveTextContent('$2.00');
  expect(screen.queryByTestId('row-delta')).toBeNull();
  expect(screen.queryByTestId('sparkline')).toBeNull();
  expect(mockUseTokenSparkline).toHaveBeenCalledWith('', '1D');
});
