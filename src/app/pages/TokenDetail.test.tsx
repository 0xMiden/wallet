import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import TokenDetail from './TokenDetail';
import enMessages from '../../../public/_locales/en/en.json';

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
const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: (...args: unknown[]) => mockHapticSelection(...args),
  hapticLight: (...args: unknown[]) => mockHapticLight(...args)
}));

jest.mock('components/PageHeader', () => ({
  PageHeader: ({ title, onBack, className }: { title: string; onBack: () => void; className?: string }) => (
    <div data-testid="nav-header" className={className}>
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

// recharts: render `Tooltip.content` against a spread of arg shapes so every
// branch of TokenDetail's inline tooltip renderer (+ `formatTooltipTime`) is
// exercised on each render.
jest.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Line: () => <div data-testid="line" />,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Area: () => <div data-testid="line" />,
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

// framer-motion: `motion.<tag>` -> a plain <tag> with the framer-only props
// stripped (so React doesn't warn), keeping the element a real `button` for the
// pill `Button`. The timeframe control's bubble `layoutId` is surfaced as a data
// attribute so the test can find the one bubble that slides between timeframes,
// and AnimatePresence renders its children as they are.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  // Cached per tag: a fresh component type on every access would remount the element each render.
  const cache: Record<string, unknown> = {};
  const build = (tag: string) =>
    ReactActual.forwardRef(
      (
        {
          children,
          layoutId,
          layoutScroll: _layoutScroll,
          transition: _transition,
          whileTap: _whileTap,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          onAnimationComplete: _onAnimationComplete,
          ...rest
        }: {
          children?: React.ReactNode;
          layoutId?: string;
          layoutScroll?: unknown;
          transition?: unknown;
          whileTap?: unknown;
          initial?: unknown;
          animate?: unknown;
          exit?: unknown;
          onAnimationComplete?: unknown;
        },
        ref: unknown
      ) => ReactActual.createElement(tag, { ...rest, ref, 'data-layout-id': layoutId }, children)
    );
  return {
    // The real module underneath, so the value helpers `AnimatedNumber` uses (`useMotionValue`,
    // `animate`) are the real ones; only the element factories below are stubbed.
    ...jest.requireActual('framer-motion'),
    __esModule: true,
    motion: new Proxy({}, { get: (_target, tag: string) => (cache[tag] ??= build(tag)) }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    useReducedMotion: () => false
  };
});

// A realistic bech32 faucet id, long enough to exercise HashShortView's middle truncation
// (default trimAfter 20) the way a real Miden faucet id does.
const TOKEN_ID = 'mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec_qr7qqq9wr6w';

const mockClipboardWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

const mockGetExplorerAccountUrl = jest.fn();
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  getExplorerAccountUrl: (...args: unknown[]) => mockGetExplorerAccountUrl(...args)
}));

const mockOpenExternalUrl = jest.fn();
jest.mock('lib/mobile/external-browser', () => ({
  openExternalUrl: (...args: unknown[]) => mockOpenExternalUrl(...args)
}));

type Overrides = {
  appEnv?: { fullPage: boolean; sidePanel: boolean };
  isMobile?: boolean;
  balances?: unknown;
  metadata?: Record<string, unknown>;
  network?: { name: string };
  priceInfo?: { price: number; change24h: number; percentageChange24h?: number };
  klineData?: unknown;
  /** The first kline load still in flight: SWR reports `data: undefined`. */
  klineLoading?: boolean;
  /** `null` simulates a build with no explorer configured; omitted uses a default URL. */
  explorerUrl?: string | null;
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
  mockGetExplorerAccountUrl.mockReturnValue(
    o.explorerUrl === null ? undefined : (o.explorerUrl ?? `https://testnet.midenscan.com/account/${TOKEN_ID}`)
  );
  mockFetchKlineData.mockResolvedValue([]);
  const data = o.klineLoading
    ? undefined
    : o.klineData === undefined
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
    // PageHeader has no horizontal padding of its own — the page supplies it,
    // or the back chevron's hit area is clipped by an overflow-hidden ancestor.
    expect(screen.getByTestId('nav-header')).toHaveClass('px-4');
    // Standard 2dp balance formatting and fiatValue = 12.5 * 2000.
    expect(screen.getByText('12.50')).toBeInTheDocument();
    expect(screen.getByText('$25000.00')).toBeInTheDocument();
  });

  it('draws the shared Hero: the 88px logo circle, the amount as the value and the fiat line muted', () => {
    renderPage();

    const hero = screen.getByTestId('token-detail-hero');
    const logo = within(hero).getByTestId('token-logo');
    expect(logo).toHaveAttribute('data-symbol', 'ETH');
    // `2xl` is TokenLogo's step for the design system's 88px hero avatar.
    expect(logo).toHaveAttribute('data-size', '2xl');
    // Hero value: 32px Nunito black.
    // Both figures are `AnimatedNumber`s now, so the type is on the slot Hero renders around them.
    expect(within(hero).getByText('12.50').closest('div')).toHaveClass('text-hero-value', 'text-ink');
    expect(within(hero).getByText('$25000.00').closest('p')).toHaveClass('text-muted');
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

    // Under its own section header. `fullHistory` is what selects the Activity tab's shared rows
    // (`Card` + `ActivityRow`) and the shared `EmptyState` (covered in HistoryView.test.tsx).
    const history = within(screen.getByTestId('token-detail-activity')).getByTestId('history');
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

  it('draws Send and Receive as a pill pair, each in the colour of the flow it opens', () => {
    renderPage();

    const send = screen.getByTestId('token-detail-send');
    const receive = screen.getByTestId('token-detail-receive');
    expect(send).toBe(screen.getByRole('button', { name: 'send' }));
    expect(receive).toBe(screen.getByRole('button', { name: 'receive' }));
    // The 48px pill, each filled with its own flow's action colour — the tab bar's pairing.
    expect(send).toHaveClass('rounded-full', 'h-12', 'bg-accent-send', 'flex-1');
    expect(receive).toHaveClass('rounded-full', 'h-12', 'bg-accent-receive', 'flex-1');
    expect(send.className).not.toContain('bg-accent-primary');
    expect(receive.className).not.toContain('bg-fill');
    // 10px apart, each taking half the row.
    expect(send.parentElement).toBe(receive.parentElement);
    expect(send.parentElement).toHaveClass('flex', 'gap-2.5');
    // The tap haptic comes from Button itself.
    fireEvent.click(send);
    expect(mockHapticLight).toHaveBeenCalled();
  });

  it('separates sections with spacing, not full-width rules', () => {
    const { container } = renderPage();

    expect(container.querySelector('hr')).toBeNull();
    expect(screen.getByTestId('token-detail-price').parentElement).toHaveClass('gap-5', 'px-4');
  });

  it('labels every section with a left-aligned, sentence-case SectionHeader', () => {
    renderPage();

    for (const [section, key] of [
      ['token-detail-price', 'tokenPrice'],
      ['token-detail-info', 'tokenInfo'],
      ['token-detail-activity', 'recentActivity']
    ] as const) {
      const heading = within(screen.getByTestId(section)).getByRole('heading', { level: 2, name: key });
      expect(heading).toHaveClass('text-muted', 'text-title-section');
      expect(heading).not.toHaveClass('uppercase');
      expect(heading).not.toHaveClass('text-center');
      // The English copy itself is sentence case: only the first word is capitalised.
      const english = enMessages[key];
      expect(english).toBe(english.charAt(0) + english.slice(1).toLowerCase());
    }
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

  // jsdom has no `matchMedia`, so AnimatedNumber only travels once a test installs one.
  describe('a balance still loading', () => {
    beforeEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(window, 'matchMedia');
    });

    it('lands on the first balance and its fiat value instead of counting up from zero', () => {
      configure({ metadata: { [TOKEN_ID]: { symbol: 'ETH', name: 'Ether', decimals: 18 } } });
      mockUseAllBalances.mockReturnValue({ data: undefined });
      const { rerender } = render(<TokenDetail tokenId={TOKEN_ID} />);

      const hero = screen.getByTestId('token-detail-hero');
      expect(hero).toHaveTextContent('—');
      expect(within(hero).queryByText('0.00')).not.toBeInTheDocument();

      mockUseAllBalances.mockReturnValue({
        data: [{ tokenId: TOKEN_ID, balance: 12.5, metadata: { symbol: 'ETH' } }]
      });
      rerender(<TokenDetail tokenId={TOKEN_ID} />);

      expect(within(hero).getByText('12.50')).toBeInTheDocument();
      expect(within(hero).getByText('$25000.00')).toBeInTheDocument();
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

    it.each([
      [3.2, 'text-positive-tint-ink', '+3.2'],
      [-1.5, 'text-negative-tint-ink', '-1.5'],
      // Rounds to 0.0 as shown, so neutral and unsigned rather than a red "-0.0%".
      [-0.04, 'text-ink', '0.0'],
      [0, 'text-ink', '0.0']
    ])('tones a %p change as a status pill (%s)', (change24h, inkClass, label) => {
      renderPage({ priceInfo: { price: 2000, change24h } });

      const pill = screen.getByTestId('token-detail-price-change');
      expect(pill).toHaveTextContent(`tokenDetailChange24h_${label}`);
      expect(pill).toHaveClass('rounded-full', 'h-8', inkClass);
    });

    it('shows a skeleton in the chart slot until the first kline load resolves', () => {
      renderPage({ klineLoading: true });

      const price = screen.getByTestId('token-detail-price');
      expect(price.querySelector('[data-slot="skeleton"]')).not.toBeNull();
      expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
      // The price and its change do not wait on the chart.
      expect(screen.getByTestId('token-detail-price-change')).toBeInTheDocument();
    });

    it('keeps the previous line while another timeframe loads', () => {
      renderPage();

      expect(mockUseRetryableSWR).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.any(Function),
        expect.objectContaining({ keepPreviousData: true })
      );
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
      fireEvent.click(screen.getByRole('radio', { name: '1H' }));
      expect(mockHapticSelection).toHaveBeenCalledTimes(1);
      expect(mockUseRetryableSWR).toHaveBeenLastCalledWith(
        ['kline', 'ETH', '1H'],
        expect.any(Function),
        expect.anything()
      );

      // 1W -> covers the else branch of formatTooltipTime (dd MMM).
      fireEvent.click(screen.getByRole('radio', { name: '1W' }));
      expect(mockHapticSelection).toHaveBeenCalledTimes(2);
      expect(mockUseRetryableSWR).toHaveBeenLastCalledWith(
        ['kline', 'ETH', '1W'],
        expect.any(Function),
        expect.anything()
      );

      // Every timeframe chip is present.
      for (const tf of ['1H', '1D', '1W', '1M', 'YTD']) {
        expect(screen.getByRole('radio', { name: tf })).toBeInTheDocument();
      }
    });

    it('renders the timeframes as the shared segmented control, the selected one on the accent bubble', () => {
      renderPage();

      const option = (tf: string) => screen.getByTestId(`token-detail-timeframe-${tf}`);
      const bubbleIn = (tf: string) => option(tf).querySelector('[data-slot="motion-highlight"]');

      // Equal-width segments across the chart, 32px tall.
      expect(screen.getByRole('radiogroup', { name: 'chartTimeframe' })).toHaveClass('w-full');
      expect(option('1D')).toHaveClass('flex-1', 'h-10');

      expect(option('1D')).toHaveAttribute('role', 'radio');
      expect(option('1D')).toHaveAttribute('aria-checked', 'true');
      expect(option('1W')).toHaveAttribute('aria-checked', 'false');
      expect(bubbleIn('1D')).toHaveClass('bg-accent-primary', 'shadow-raised');
      expect(bubbleIn('1W')).toBeNull();

      fireEvent.click(option('1W'));

      expect(mockHapticSelection).toHaveBeenCalledTimes(1);
      expect(option('1W')).toHaveAttribute('aria-checked', 'true');
      expect(option('1D')).toHaveAttribute('aria-checked', 'false');
      expect(bubbleIn('1W')).not.toBeNull();
      expect(bubbleIn('1D')).toBeNull();
      // One bubble, carried over on the same layoutId, so it slides rather than cross-fading.
      expect(document.querySelectorAll('[data-slot="motion-highlight"]')).toHaveLength(1);
    });

    it('stays silent when the active timeframe is tapped again', () => {
      renderPage();

      fireEvent.click(screen.getByTestId('token-detail-timeframe-1D'));

      expect(mockHapticSelection).not.toHaveBeenCalled();
    });
  });

  describe('token info card', () => {
    it('renders the faucet id as the same trimmed, copyable chip the transaction page uses', () => {
      renderPage({ network: { name: 'Devnet' } });

      const info = screen.getByTestId('token-detail-info');
      const contract = within(info).getByTestId('token-detail-contract');
      // The shared DetailCard: `fill`, 16px radius, hairlines between rows.
      expect(contract.parentElement).toHaveClass('bg-fill', 'rounded-2xl', 'divide-hairline');
      // One name for one thing: "Faucet ID", as the transaction detail page says it.
      expect(within(contract).getByText('faucetId')).toBeInTheDocument();

      const copy = within(contract).getByTestId('token-detail-copy-contract');
      // The shared `HashChip`, so the id is trimmed by the app's one truncation helper
      // rather than a page-local copy of it - never the full 49-char id.
      expect(copy).toHaveClass('text-ink');
      expect(copy).not.toHaveTextContent(TOKEN_ID);
      expect(copy).toHaveTextContent(TOKEN_ID.slice(0, 7));
      expect(copy).toHaveTextContent(TOKEN_ID.slice(-4));

      expect(within(info).getByText('fungible')).toBeInTheDocument();
      expect(within(info).getByText('Devnet')).toBeInTheDocument();
    });

    it('copies the full faucet id, not the truncated display value', async () => {
      mockClipboardWrite.mockResolvedValue(undefined);
      renderPage();

      const copy = screen.getByTestId('token-detail-copy-contract');

      await act(async () => {
        fireEvent.click(copy);
      });

      expect(mockClipboardWrite).toHaveBeenCalledWith({ string: TOKEN_ID });
      expect(mockHapticLight).toHaveBeenCalled();
    });

    it('opens the MidenScan explorer for this faucet in the in-app browser', () => {
      const explorerUrl = `https://devnet.midenscan.com/account/${TOKEN_ID}`;
      renderPage({ explorerUrl });

      expect(mockGetExplorerAccountUrl).toHaveBeenCalledWith(TOKEN_ID);

      const explorerRow = screen.getByTestId('token-detail-explorer');
      expect(explorerRow).toHaveTextContent('viewOnMidenscan');

      fireEvent.click(explorerRow);

      expect(mockOpenExternalUrl).toHaveBeenCalledWith({ url: explorerUrl, title: 'Midenscan' });
      expect(mockHapticLight).toHaveBeenCalled();
    });

    it('hides the MidenScan row on a build with no explorer configured', () => {
      renderPage({ explorerUrl: null });

      expect(screen.queryByTestId('token-detail-explorer')).not.toBeInTheDocument();
      expect(mockOpenExternalUrl).not.toHaveBeenCalled();
    });
  });
});
