import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import type { TokenBalanceData } from 'lib/miden/front';
import { getTokenPrice, useTokenSparkline } from 'lib/prices';
import type { TokenPriceInfo, TokenPrices } from 'lib/prices';

import AssetRowDefault, { AssetRow } from './AssetRow';

// --- Mock the leaf UI dependencies so we can assert the exact props AssetRow
// wires through to them, keeping the test focused on AssetRow's own logic.

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol }: { symbol: string }) => <span data-testid="token-logo" data-symbol={symbol} />
}));

jest.mock('components/ui', () => ({
  AssetListItem: ({ icon, name, amount, chart, price, delta, onClick, 'data-testid': dataTestId }: any) => (
    <div
      data-testid={dataTestId ?? 'asset-list-item'}
      data-name={name}
      data-amount={amount}
      data-price={price}
      data-delta-value={delta?.value}
      data-delta-direction={delta?.direction}
      data-has-onclick={onClick ? 'yes' : 'no'}
      onClick={onClick}
    >
      {icon}
      {chart}
    </div>
  ),
  Sparkline: ({ points, color, width, height }: any) => (
    <span
      data-testid="sparkline"
      data-points={JSON.stringify(points)}
      data-color={color}
      data-width={width}
      data-height={height}
    />
  )
}));

jest.mock('lib/prices', () => ({
  getTokenPrice: jest.fn(),
  useTokenSparkline: jest.fn()
}));

const mockGetTokenPrice = getTokenPrice as jest.MockedFunction<typeof getTokenPrice>;
const mockUseTokenSparkline = useTokenSparkline as jest.MockedFunction<typeof useTokenSparkline>;

const TOKEN_PRICES = {} as TokenPrices;

function makeAsset(overrides: Partial<{ symbol: string; name: string; balance: number }> = {}): TokenBalanceData {
  const { symbol = 'BTC', name = 'Bitcoin', balance = 2 } = overrides;
  return {
    tokenId: 'tok-1',
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
  // Sensible defaults; individual tests override as needed.
  mockGetTokenPrice.mockReturnValue(priceInfo());
  mockUseTokenSparkline.mockReturnValue([10, 20, 30]);
});

describe('AssetRow', () => {
  it('renders a positive 24h delta with a "+" prefix, positive direction, and status-positive sparkline color', () => {
    mockGetTokenPrice.mockReturnValue(priceInfo({ price: 100, percentageChange24h: 5.256 }));
    mockUseTokenSparkline.mockReturnValue([10, 20, 30]);

    render(<AssetRow asset={makeAsset({ balance: 2 })} tokenPrices={TOKEN_PRICES} />);

    const item = screen.getByTestId('asset-list-item');
    // Delta formatting: "+" prefix + two decimals + "%".
    expect(item).toHaveAttribute('data-delta-value', '+5.26%');
    expect(item).toHaveAttribute('data-delta-direction', 'positive');

    // Real points (length > 1) => the actual points and the positive color.
    const spark = screen.getByTestId('sparkline');
    expect(spark).toHaveAttribute('data-points', JSON.stringify([10, 20, 30]));
    expect(spark).toHaveAttribute('data-color', 'var(--status-positive)');
    expect(spark).toHaveAttribute('data-width', '120');
    expect(spark).toHaveAttribute('data-height', '32');

    // Amount + price plumbing: standard 2dp formatting + symbol; balance * price.
    expect(item).toHaveAttribute('data-amount', '2.00 BTC');
    expect(item).toHaveAttribute('data-price', '$200.00');

    // getTokenPrice / useTokenSparkline called with the symbol.
    expect(mockGetTokenPrice).toHaveBeenCalledWith(TOKEN_PRICES, 'BTC');
    expect(mockUseTokenSparkline).toHaveBeenCalledWith('BTC', '1D');
  });

  it('expands precision for a small non-zero balance and fiat value', () => {
    mockGetTokenPrice.mockReturnValue(priceInfo({ price: 2 }));

    render(<AssetRow asset={makeAsset({ balance: 0.001234 })} tokenPrices={TOKEN_PRICES} />);

    const item = screen.getByTestId('asset-list-item');
    expect(item).toHaveAttribute('data-amount', '0.0012 BTC');
    expect(item).toHaveAttribute('data-price', '$0.0025');
  });

  it('treats an exactly-zero change as positive', () => {
    mockGetTokenPrice.mockReturnValue(priceInfo({ percentageChange24h: 0 }));

    render(<AssetRow asset={makeAsset()} tokenPrices={TOKEN_PRICES} />);

    const item = screen.getByTestId('asset-list-item');
    expect(item).toHaveAttribute('data-delta-value', '+0.00%');
    expect(item).toHaveAttribute('data-delta-direction', 'positive');
    expect(screen.getByTestId('sparkline')).toHaveAttribute('data-color', 'var(--status-positive)');
  });

  it('renders a negative 24h delta without a prefix, negative direction, and status-negative sparkline color', () => {
    mockGetTokenPrice.mockReturnValue(priceInfo({ price: 50, percentageChange24h: -3.1 }));
    mockUseTokenSparkline.mockReturnValue([5, 4, 3]);

    render(<AssetRow asset={makeAsset({ balance: 4 })} tokenPrices={TOKEN_PRICES} />);

    const item = screen.getByTestId('asset-list-item');
    expect(item).toHaveAttribute('data-delta-value', '-3.10%');
    expect(item).toHaveAttribute('data-delta-direction', 'negative');
    expect(item).toHaveAttribute('data-price', '$200.00');

    expect(screen.getByTestId('sparkline')).toHaveAttribute('data-color', 'var(--status-negative)');
  });

  it('falls back to a flat grey sparkline when there are no real points (length <= 1)', () => {
    // Positive change, but no real sparkline data => tertiary color wins.
    mockGetTokenPrice.mockReturnValue(priceInfo({ percentageChange24h: 8 }));
    mockUseTokenSparkline.mockReturnValue([]);

    render(<AssetRow asset={makeAsset()} tokenPrices={TOKEN_PRICES} />);

    const spark = screen.getByTestId('sparkline');
    // FLAT_SPARKLINE_POINTS fallback.
    expect(spark).toHaveAttribute('data-points', JSON.stringify([1, 1]));
    expect(spark).toHaveAttribute('data-color', 'var(--text-tertiary)');
  });

  it('treats a single-point series as "no real points" (boundary: length === 1)', () => {
    mockUseTokenSparkline.mockReturnValue([42]);

    render(<AssetRow asset={makeAsset()} tokenPrices={TOKEN_PRICES} />);

    const spark = screen.getByTestId('sparkline');
    expect(spark).toHaveAttribute('data-points', JSON.stringify([1, 1]));
    expect(spark).toHaveAttribute('data-color', 'var(--text-tertiary)');
  });

  it('uses metadata.name for the displayed name and passes the symbol to TokenLogo', () => {
    render(<AssetRow asset={makeAsset({ symbol: 'ETH', name: 'Ethereum' })} tokenPrices={TOKEN_PRICES} />);

    expect(screen.getByTestId('asset-list-item')).toHaveAttribute('data-name', 'Ethereum');
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'ETH');
  });

  it('falls back to the symbol when metadata.name is empty', () => {
    render(<AssetRow asset={makeAsset({ symbol: 'USDC', name: '' })} tokenPrices={TOKEN_PRICES} />);

    expect(screen.getByTestId('asset-list-item')).toHaveAttribute('data-name', 'USDC');
  });

  it('wires the onClick handler through to AssetListItem', () => {
    const onClick = jest.fn();

    render(<AssetRow asset={makeAsset()} tokenPrices={TOKEN_PRICES} onClick={onClick} />);

    const item = screen.getByTestId('asset-list-item');
    expect(item).toHaveAttribute('data-has-onclick', 'yes');

    fireEvent.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders without an onClick handler', () => {
    render(<AssetRow asset={makeAsset()} tokenPrices={TOKEN_PRICES} />);

    const item = screen.getByTestId('asset-list-item');
    expect(item).toHaveAttribute('data-has-onclick', 'no');
    // Clicking is a no-op and must not throw.
    fireEvent.click(item);
  });

  it('forwards the data-testid prop to AssetListItem', () => {
    render(<AssetRow asset={makeAsset()} tokenPrices={TOKEN_PRICES} data-testid="my-row" />);

    expect(screen.getByTestId('my-row')).toBeInTheDocument();
  });

  it('exposes the component as the default export', () => {
    expect(AssetRowDefault).toBe(AssetRow);

    render(<AssetRowDefault asset={makeAsset()} tokenPrices={TOKEN_PRICES} data-testid="default-row" />);
    expect(screen.getByTestId('default-row')).toBeInTheDocument();
  });
});
