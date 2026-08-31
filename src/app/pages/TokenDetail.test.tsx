import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import TokenDetail from './TokenDetail';

// ---------------------------------------------------------------------------
// Mocks
//
// `TokenDetail.tsx` is a leaf page that wires together a pile of hooks (env,
// account/balances/network, prices, SWR) and heavy presentational children
// (recharts line chart, framer-motion pill, the SDK-backed History template).
// We stub every boundary so the test exercises *this file's* branching — the
// container-class logic, the metadata/symbol/balance fallbacks, the price
// chart's domain math + tooltip renderer, and the copy button — without
// dragging in the real widgets. This mirrors how the sibling `Earn.test.tsx`
// and `AllHistory.test.tsx` stub their children.
// ---------------------------------------------------------------------------

// react-i18next: echo the key back, and fold interpolation options into the
// returned string so the price-change test can assert that the +/- sign and
// value flowed through `tokenDetailChange24h`'s `{{change}}` (mirrors the
// sibling ReviewSwap.test.tsx mock).
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const values = opts ? Object.values(opts) : [];
      return values.length > 0 ? `${key}_${values.join('_')}` : key;
    }
  })
}));

const mockUseAppEnv = jest.fn();
jest.mock('app/env', () => ({
  useAppEnv: () => mockUseAppEnv()
}));

const mockIsMobile = jest.fn();
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile(),
  // Reached through `hasKnownScale` -> `metadata/defaults` -> `getAssetUrl`,
  // which branches on the platform to build the placeholder's logo URL.
  isExtension: () => false
}));

const mockUseAccount = jest.fn();
const mockUseAllBalances = jest.fn();
const mockUseAllTokensBaseMetadata = jest.fn();
const mockUseNetwork = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount(),
  useAllBalances: (...args: unknown[]) => mockUseAllBalances(...args),
  useAllTokensBaseMetadata: () => mockUseAllTokensBaseMetadata(),
  useNetwork: () => mockUseNetwork()
}));

// `useWalletStore(s => s.tokenPrices)` — apply the selector to a controllable
// state object, matching the sibling KeysSettings.test.tsx pattern.
let mockTokenPrices: Record<string, unknown> = {};
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: { tokenPrices: Record<string, unknown> }) => unknown) =>
    selector({ tokenPrices: mockTokenPrices })
}));

const mockGetTokenPrice = jest.fn();
const mockFetchKlineData = jest.fn();
jest.mock('lib/prices', () => ({
  getTokenPrice: (...args: unknown[]) => mockGetTokenPrice(...args),
  fetchKlineData: (...args: unknown[]) => mockFetchKlineData(...args)
}));

// `useRetryableSWR(key, fetcher, opts)` — invoke the fetcher (so the inline
// `() => fetchKlineData(symbol, timeframe)` closure is covered) then return the
// configured payload.
const mockUseRetryableSWR = jest.fn();
jest.mock('lib/swr', () => ({
  useRetryableSWR: (...args: unknown[]) => mockUseRetryableSWR(...args)
}));

// Collapse the chart container to a passthrough so recharts' ResponsiveContainer
// (which needs real layout) never mounts.
jest.mock('lib/ui/charts', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="chart-container">{children}</div>
}));

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('lib/woozie', () => ({
  goBack: (...args: unknown[]) => mockGoBack(...args),
  navigate: (...args: unknown[]) => mockNavigate(...args)
}));

const mockHapticSelection = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: (...args: unknown[]) => mockHapticSelection(...args)
}));

jest.mock('components/NavigationHeader', () => ({
  NavigationHeader: ({ title, onBack }: { title: string; onBack: () => void }) => (
    <div data-testid="nav-header">
      <span data-testid="nav-title">{title}</span>
      <button data-testid="nav-back" onClick={onBack}>
        back
      </button>
    </div>
  )
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size, className }: { symbol: string; size?: string; className?: string }) => (
    <span data-testid="token-logo" data-symbol={symbol} data-size={size} className={className} />
  )
}));

// The History template is SWR/SDK-backed; stub it and surface the props
// TokenDetail forwards.
jest.mock('app/templates/history/History', () => ({
  __esModule: true,
  default: (props: { address: string; tokenId?: string; fullHistory?: boolean }) => (
    <div
      data-testid="history"
      data-address={props.address}
      data-token-id={props.tokenId}
      data-full-history={String(props.fullHistory)}
    />
  )
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="copy-icon" data-name={name} />,
  IconName: { Copy: 'Copy' }
}));

// recharts: render `Tooltip.content` against a spread of arg shapes so every
// branch of TokenDetail's inline tooltip renderer (+ `formatTooltipTime`) is
// exercised on each render.
jest.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Line: () => <div data-testid="line" />,
  YAxis: (props: { domain?: [number, number] }) => (
    <div data-testid="yaxis" data-domain={JSON.stringify(props.domain)} />
  ),
  Tooltip: ({
    content
  }: {
    content: (arg: {
      active?: boolean;
      payload?: Array<{ payload: { value: number; time?: number } }>;
    }) => React.ReactNode;
  }) => (
    <div data-testid="tooltip">
      <div data-testid="tt-active-time">
        {content({ active: true, payload: [{ payload: { value: 1.2345, time: 1_700_000_000_000 } }] })}
      </div>
      <div data-testid="tt-active-notime">{content({ active: true, payload: [{ payload: { value: 2.5 } }] })}</div>
      <div data-testid="tt-inactive">{content({ active: false, payload: [{ payload: { value: 3 } }] })}</div>
      <div data-testid="tt-empty">{content({ active: true, payload: [] })}</div>
      <div data-testid="tt-nopayload">{content({})}</div>
    </div>
  )
}));

// framer-motion: `motion.div` -> passthrough div (framer-only props stripped so
// React doesn't warn), mirroring HomeSwipeContainer.test.tsx.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const passthrough = ({
    children,
    layoutId,
    transition,
    ...rest
  }: {
    children?: React.ReactNode;
    layoutId?: string;
    transition?: unknown;
  }) => ReactActual.createElement('div', rest, children);
  return { __esModule: true, motion: new Proxy({}, { get: () => passthrough }) };
});

const TOKEN_ID = '0xabcdef1234567890';

const mockWriteText = jest.fn();
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mockWriteText },
  configurable: true
});

type Overrides = {
  appEnv?: { fullPage: boolean; sidePanel: boolean };
  isMobile?: boolean;
  balances?: unknown;
  metadata?: Record<string, unknown>;
  network?: { name: string };
  priceInfo?: { price: number; change24h: number; percentageChange24h?: number };
  klineData?: unknown;
};

function configure(o: Overrides = {}) {
  mockUseAppEnv.mockReturnValue(o.appEnv ?? { fullPage: false, sidePanel: false });
  mockIsMobile.mockReturnValue(o.isMobile ?? false);
  mockUseAccount.mockReturnValue({ publicKey: 'pk-123' });
  mockUseAllBalances.mockReturnValue({
    data: o.balances === undefined ? [{ tokenId: TOKEN_ID, balance: 12.5, metadata: { symbol: 'ETH' } }] : o.balances
  });
  mockUseAllTokensBaseMetadata.mockReturnValue(o.metadata ?? {});
  mockUseNetwork.mockReturnValue(o.network ?? { name: 'Testnet' });
  mockGetTokenPrice.mockReturnValue(o.priceInfo ?? { price: 2000, change24h: 3.2, percentageChange24h: 0.1 });
  mockFetchKlineData.mockResolvedValue([]);
  const data =
    o.klineData === undefined
      ? [
          { time: 1_700_000_000_000, value: 1 },
          { time: 1_700_000_060_000, value: 2 },
          { time: 1_700_000_120_000, value: 3 }
        ]
      : o.klineData;
  mockUseRetryableSWR.mockImplementation((_key: unknown, fetcher: () => unknown) => {
    // Cover the inline `() => fetchKlineData(symbol, timeframe)` closure.
    fetcher();
    return { data };
  });
}

const renderPage = (o?: Overrides) => {
  configure(o);
  return render(<TokenDetail tokenId={TOKEN_ID} />);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTokenPrices = {};
});

describe('TokenDetail', () => {
  it('renders the hero with the resolved symbol, balance and fiat value', () => {
    renderPage();

    expect(screen.getByTestId('nav-title')).toHaveTextContent('ETH');
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'ETH');
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-size', 'xl');
    // Standard 2dp balance formatting and fiatValue = 12.5 * 2000.
    expect(screen.getByText('12.50')).toBeInTheDocument();
    expect(screen.getByText('$25000.00')).toBeInTheDocument();
  });

  it('expands precision for a small non-zero hero balance and fiat value', () => {
    renderPage({
      balances: [{ tokenId: TOKEN_ID, balance: 0.001234, metadata: { symbol: 'ETH' } }],
      priceInfo: { price: 2, change24h: 0 }
    });

    expect(screen.getByText('0.0012')).toBeInTheDocument();
    expect(screen.getByText('$0.0025')).toBeInTheDocument();
  });

  it('forwards account address, tokenId and fullHistory to the History template', () => {
    renderPage();

    const history = screen.getByTestId('history');
    expect(history).toHaveAttribute('data-address', 'pk-123');
    expect(history).toHaveAttribute('data-token-id', TOKEN_ID);
    expect(history).toHaveAttribute('data-full-history', 'true');
  });

  it('calls goBack from the navigation header', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('nav-back'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('navigates to /send with the tokenId and to /receive from the action buttons', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/send', search: `?tokenId=${TOKEN_ID}` });

    fireEvent.click(screen.getByRole('button', { name: 'receive' }));
    expect(mockNavigate).toHaveBeenCalledWith('/receive');
  });

  describe('symbol / metadata / balance fallbacks', () => {
    it('falls back to allTokensMetadata when the token is absent from balances', () => {
      // Empty balances -> no matching token -> metadata comes from the
      // allTokensMetadata map keyed by tokenId.
      renderPage({ balances: [], metadata: { [TOKEN_ID]: { symbol: 'BTC' } } });

      expect(screen.getByTestId('nav-title')).toHaveTextContent('BTC');
      // token undefined -> balance defaults to 0.
      expect(screen.getByText('0.00')).toBeInTheDocument();
    });

    it('shows the "unknown" symbol and zero balance when nothing resolves', () => {
      // balances undefined path (optional chaining short-circuits) + empty
      // metadata map -> metadata undefined -> symbol falls back to t('unknown').
      renderPage({ balances: null, metadata: {} });

      expect(screen.getByTestId('nav-title')).toHaveTextContent('unknown');
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'unknown');
    });

    it('handles a matched token whose balance is nullish', () => {
      renderPage({ balances: [{ tokenId: TOKEN_ID, metadata: { symbol: 'USDC' } }] });

      expect(screen.getByTestId('nav-title')).toHaveTextContent('USDC');
      // balance ?? 0 -> "0.00".
      expect(screen.getByText('0.00')).toBeInTheDocument();
    });
  });

  // The hero is the most emphatic number in the wallet. For a faucet whose
  // decimals never resolved, `balance` was divided by the placeholder's guessed
  // 6 upstream, so it is not this user's holding — and the fiat line under it is
  // that same wrong number multiplied by a price.
  describe('a token whose scale never resolved', () => {
    const unresolved = { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true };

    it('shows an em dash instead of a quantity', () => {
      renderPage({
        balances: [{ tokenId: TOKEN_ID, balance: 12.5, metadata: unresolved }],
        priceInfo: { price: 2000, change24h: 0 }
      });

      expect(screen.getByText('—')).toBeInTheDocument();
      expect(screen.queryByText('12.50')).not.toBeInTheDocument();
    });

    it('omits the fiat line rather than pricing a quantity it does not have', () => {
      renderPage({
        balances: [{ tokenId: TOKEN_ID, balance: 12.5, metadata: unresolved }],
        priceInfo: { price: 2000, change24h: 0 }
      });

      // The market price elsewhere on the page is a price PER token and does not
      // depend on the scale, so it stays. What goes is 12.5 × $2000, the value
      // of a holding the wallet cannot size.
      expect(screen.queryByText('$25000.00')).not.toBeInTheDocument();
    });

    it('still names the token in the header and the logo', () => {
      renderPage({ balances: [{ tokenId: TOKEN_ID, balance: 12.5, metadata: unresolved }] });

      expect(screen.getByTestId('nav-title')).toHaveTextContent('Unknown');
    });
  });

  describe('container sizing', () => {
    it('uses the full-size class on mobile', () => {
      const { container } = renderPage({ isMobile: true });
      expect((container.firstChild as HTMLElement).className).toContain('h-full w-full');
    });

    it('uses the full-size class in the side panel', () => {
      const { container } = renderPage({ isMobile: false, appEnv: { fullPage: false, sidePanel: true } });
      expect((container.firstChild as HTMLElement).className).toContain('h-full w-full');
    });

    it('uses the wide class on the full page', () => {
      const { container } = renderPage({ isMobile: false, appEnv: { fullPage: true, sidePanel: false } });
      expect((container.firstChild as HTMLElement).className).toContain('w-[600px]');
    });

    it('uses the popup class otherwise', () => {
      const { container } = renderPage({ isMobile: false, appEnv: { fullPage: false, sidePanel: false } });
      expect((container.firstChild as HTMLElement).className).toContain('w-[360px]');
    });
  });

  describe('price chart', () => {
    it('renders a positive 24h change with a plus sign and the formatted price', () => {
      renderPage({ priceInfo: { price: 12.3456, change24h: 3.2 } });

      // `tokenDetailChange24h` interpolates `{{change}}` = sign + toFixed(1).
      expect(screen.getByText('tokenDetailChange24h_+3.2')).toBeInTheDocument();
      // price.toFixed(3).
      expect(screen.getByText('$12.346')).toBeInTheDocument();
    });

    it('renders a negative 24h change without a plus sign', () => {
      renderPage({ priceInfo: { price: 2000, change24h: -1.5 } });

      expect(screen.getByText('tokenDetailChange24h_-1.5')).toBeInTheDocument();
    });

    it('renders the flat-line fallback when kline data is empty (padding fallback branch)', () => {
      renderPage({ klineData: [] });

      // FLAT_LINE_DATA (all values 1) => maxVal === minVal => padding falls back
      // to maxVal * 0.01. The YAxis domain reflects that.
      const domain = JSON.parse(screen.getByTestId('yaxis').getAttribute('data-domain') as string);
      expect(domain).toEqual([1 - 0.01, 1 + 0.01]);
    });

    it('renders the flat-line fallback when kline data is nullish (short-circuit branch)', () => {
      renderPage({ klineData: null });

      expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    });

    it('computes a padded y-domain from real kline data', () => {
      renderPage(); // default kline [1,2,3]

      const domain = JSON.parse(screen.getByTestId('yaxis').getAttribute('data-domain') as string);
      const padding = (3 - 1) * 0.05;
      expect(domain).toEqual([1 - padding, 3 + padding]);
    });

    it('renders the tooltip value and time only when active with a payload', () => {
      renderPage();

      // active + payload with a time -> value + formatted time rendered.
      expect(within(screen.getByTestId('tt-active-time')).getByText('$1.23')).toBeInTheDocument();
      // active + payload without a time -> value only, no time node.
      expect(within(screen.getByTestId('tt-active-notime')).getByText('$2.50')).toBeInTheDocument();
      // inactive / empty payload / no payload -> null (nothing rendered).
      expect(screen.getByTestId('tt-inactive')).toBeEmptyDOMElement();
      expect(screen.getByTestId('tt-empty')).toBeEmptyDOMElement();
      expect(screen.getByTestId('tt-nopayload')).toBeEmptyDOMElement();
    });

    it('switches timeframes, firing haptics and re-running the kline query', () => {
      renderPage();

      // Default active timeframe is 1D.
      expect(mockUseRetryableSWR).toHaveBeenLastCalledWith(
        ['kline', 'ETH', '1D'],
        expect.any(Function),
        expect.objectContaining({ dedupingInterval: 30_000 })
      );

      // 1H -> covers the `tf === '1H'` branch of formatTooltipTime on re-render.
      fireEvent.click(screen.getByRole('button', { name: '1H' }));
      expect(mockHapticSelection).toHaveBeenCalledTimes(1);
      expect(mockUseRetryableSWR).toHaveBeenLastCalledWith(
        ['kline', 'ETH', '1H'],
        expect.any(Function),
        expect.anything()
      );

      // 1W -> covers the else branch of formatTooltipTime (dd MMM).
      fireEvent.click(screen.getByRole('button', { name: '1W' }));
      expect(mockHapticSelection).toHaveBeenCalledTimes(2);
      expect(mockUseRetryableSWR).toHaveBeenLastCalledWith(
        ['kline', 'ETH', '1W'],
        expect.any(Function),
        expect.anything()
      );

      // Every timeframe chip is present.
      for (const tf of ['1H', '1D', '1W', '1M', 'YTD']) {
        expect(screen.getByRole('button', { name: tf })).toBeInTheDocument();
      }
    });
  });

  describe('token info card', () => {
    it('renders the truncated contract, type, network and copies the address', () => {
      renderPage({ network: { name: 'Devnet' } });

      expect(screen.getByText('Devnet')).toBeInTheDocument();
      expect(screen.getByText('fungible')).toBeInTheDocument();

      const copyBtn = screen.getByTestId('copy-icon').closest('button') as HTMLButtonElement;
      fireEvent.click(copyBtn);
      expect(mockWriteText).toHaveBeenCalledWith(TOKEN_ID);
    });
  });
});
