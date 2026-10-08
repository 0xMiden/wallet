import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { resetHiddenTokens } from 'app/hooks/useHiddenTokens';
import {
  publishMockBridgeSnapshot,
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import { normalizedFaucetId, TOKEN_IETH, TOKEN_IMIDEN } from 'lib/miden/swap/tokens';
import {
  getNativeAssetIdSync,
  getNativeAssetMetadataSync,
  getSdkSyncedNativeAssetIdSync
} from 'lib/miden-chain/native-asset';
import { hasUnquotedDefaultPrice } from 'lib/prices/unquoted-default';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

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
// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
// The build's network unless a case names another.
let mockTestNetworkKey: 'testnet' | 'devnet' | undefined;
jest.mock('lib/miden-chain/effective-endpoints', () => {
  const actual = jest.requireActual<typeof import('lib/miden-chain/effective-endpoints')>(
    'lib/miden-chain/effective-endpoints'
  );
  return { ...actual, getTestNetworkNameKey: () => mockTestNetworkKey ?? actual.getTestNetworkNameKey() };
});
afterEach(() => {
  mockBridgeSnapshot = undefined;
  mockTestNetworkKey = undefined;
});
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
  // For any module this page loads that branches on the platform. Without it,
  // a call to `isExtension` in such a module throws.
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
let mockTokenMetadataOverrides: Record<string, unknown> = {};
const mockSetTokenMetadataOverride = jest.fn();
const mockClearTokenMetadataOverride = jest.fn();
type MockStoreState = {
  tokenPrices: Record<string, unknown>;
  tokenMetadataOverrides: Record<string, unknown>;
  setTokenMetadataOverride: typeof mockSetTokenMetadataOverride;
  clearTokenMetadataOverride: typeof mockClearTokenMetadataOverride;
};
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: MockStoreState) => unknown) =>
    selector({
      tokenPrices: mockTokenPrices,
      tokenMetadataOverrides: mockTokenMetadataOverrides,
      setTokenMetadataOverride: mockSetTokenMetadataOverride,
      clearTokenMetadataOverride: mockClearTokenMetadataOverride
    })
}));

// The sheet's content stays mounted while it is closed, as the real sheet stays mounted through its
// 500ms exit, so a reopening within that window finds the previous body unless the host remounts it.
// `data-open` exposes the state.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)}>
      <button data-testid="drawer-dismiss" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2 data-testid="drawer-title">{children}</h2>
}));

// The kline fetch is stubbed; the price lookup is the real one, reading `mockTokenPrices`.
const mockFetchKlineData = jest.fn();
jest.mock('lib/prices', () => ({
  pricesLoaded: jest.requireActual('lib/prices/binance').pricesLoaded,
  quotedPrice: jest.requireActual('lib/prices/binance').quotedPrice,
  fetchKlineData: (...args: unknown[]) => mockFetchKlineData(...args)
}));

// The figures under test follow the default rule, no figure without a quote; pinned here against
// Developer Settings' nominal $1 switch (lib/prices/unquoted-default). The nominal case flips it.
jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));
const mockedHasUnquotedDefaultPrice = jest.mocked(hasUnquotedDefaultPrice);

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
const mockHapticMedium = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: (...args: unknown[]) => mockHapticSelection(...args),
  hapticLight: (...args: unknown[]) => mockHapticLight(...args),
  hapticMedium: (...args: unknown[]) => mockHapticMedium(...args)
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
  TokenLogo: ({
    symbol,
    faucetId,
    size,
    className,
    badge
  }: {
    symbol: string;
    faucetId?: string;
    size?: string;
    className?: string;
    badge?: React.ReactNode;
  }) => (
    <span
      data-testid="token-logo"
      data-symbol={symbol}
      data-faucet-id={faucetId}
      data-size={size}
      className={className}
    >
      {badge}
    </span>
  )
}));

// The sheet's drawer pulls in the dApp browser provider; here it only has to show whether the pill
// opened it, and hand back a way to close it.
jest.mock('components/UnverifiedTokenSheet', () => ({
  UnverifiedTokenSheet: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <button type="button" data-testid="unverified-token-sheet" onClick={() => onOpenChange(false)} /> : null
}));

// The History template is SWR/SDK-backed; stub it and surface the props
// TokenDetail forwards.
jest.mock('app/templates/history/History', () => ({
  __esModule: true,
  default: (props: { address: string; tokenId?: string; fullHistory?: boolean; dateStyle?: string }) => (
    <div
      data-testid="history"
      data-address={props.address}
      data-token-id={props.tokenId}
      data-full-history={String(props.fullHistory)}
      data-date-style={props.dateStyle ?? ''}
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

// A faucet the wallet prices (IETH, at ETH), and a realistic bech32 faucet id, long enough to
// exercise HashShortView's middle truncation (default trimAfter 20) the way a real Miden faucet id does.
const TOKEN_ID = TOKEN_IETH.faucetId;
// A token the wallet gives no name of its own, for the tests that read the symbol the metadata carries.
const PLAIN_ID = TOKEN_IMIDEN.faucetId;

const mockClipboardWrite = jest.fn();
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
}));

const mockGetExplorerAccountUrl = jest.fn();
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  getExplorerAccountUrl: (...args: unknown[]) => mockGetExplorerAccountUrl(...args)
}));

const mockVerifyToken = jest.fn();
jest.mock('lib/token-list/useTokenVerification', () => ({
  useTokenVerification: (id: string) => mockVerifyToken(id)
}));

let mockNativeFaucetId: string | null = 'mtst1native';
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => mockNativeFaucetId }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => null),
  getNativeAssetMetadataSync: jest.fn(() => null),
  getSdkSyncedNativeAssetIdSync: jest.fn(() => null)
}));

// The hidden-token set is the real module store (`useHiddenTokens`); only its storage is stubbed.
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: jest.fn(),
  putToStorage: jest.fn(),
  inStorageTurn: jest.requireActual('lib/miden/front/storage').inStorageTurn,
  onStorageChanged: jest.fn(() => () => {}),
  registerStorageReread: jest.fn()
}));
const mockReadStorage = jest.mocked(fetchFromStorage);
const mockWriteStorage = jest.mocked(putToStorage);

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
  tokenPrices?: Record<string, unknown>;
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
  // The default token is ETH, so `priceInfo` is ETH's quote; `tokenPrices` replaces the whole feed.
  mockTokenPrices = o.tokenPrices ?? {
    ETH: { percentageChange24h: 0, ...(o.priceInfo ?? { price: 2000, change24h: 3.2, percentageChange24h: 0.1 }) }
  };
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

const renderPage = (o?: Overrides, tokenId: string = TOKEN_ID) => {
  configure(o);
  return render(<TokenDetail tokenId={tokenId} />);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTokenPrices = {};
  mockTokenMetadataOverrides = {};
  mockSetTokenMetadataOverride.mockReset().mockResolvedValue(undefined);
  mockClearTokenMetadataOverride.mockReset().mockResolvedValue(undefined);
  mockNativeFaucetId = 'mtst1native';
  jest.mocked(getNativeAssetIdSync).mockReturnValue(null);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(null);
  resetHiddenTokens();
  mockReadStorage.mockReset();
  // Unread by default: most cases never look at the row, and a read settling after a synchronous
  // case ends would update the page outside act().
  mockReadStorage.mockImplementation(() => new Promise(() => {}));
  mockWriteStorage.mockReset();
  mockWriteStorage.mockResolvedValue(undefined);
});

describe('TokenDetail', () => {
  it('renders the hero with the resolved symbol, balance and fiat value', () => {
    renderPage();

    expect(screen.getByTestId('nav-title')).toHaveTextContent('ETH');
    // PageHeader has no horizontal padding of its own — the page supplies it,
    // or the back button's hit area is clipped by an overflow-hidden ancestor.
    expect(screen.getByTestId('nav-header')).toHaveClass('px-4');
    // Standard 2dp balance formatting and fiatValue = 12.5 * 2000.
    expect(screen.getByText('12.50')).toBeInTheDocument();
    expect(screen.getByText('$25000.00')).toBeInTheDocument();
  });

  it('values IETH and charts it at ETH, the symbol the feed quotes it under', () => {
    configure({
      balances: [{ tokenId: TOKEN_IETH.faucetId, balance: 0.38, metadata: { symbol: 'IETH' } }],
      tokenPrices: { ETH: { price: 3000, change24h: 1.5, percentageChange24h: 0.05 } }
    });
    render(<TokenDetail tokenId={TOKEN_IETH.faucetId} />);

    // 0.38 * 3000, never 0.38 * $1.
    expect(within(screen.getByTestId('token-detail-hero')).getByText('$1140.00')).toBeInTheDocument();
    expect(screen.getByTestId('token-detail-price')).toBeInTheDocument();
    expect(screen.getByTestId('token-detail-price-change')).toHaveTextContent('tokenDetailChange24h_+1.5');
    expect(screen.getByRole('radiogroup', { name: 'chartTimeframe' })).toBeInTheDocument();
    expect(mockFetchKlineData).toHaveBeenCalledWith('ETH', '1D');
  });

  it('values SDK-authenticated native USDCX at $1 without a feed or a market chart', () => {
    const nativeId = 'mtst1native-usdcx';
    mockNativeFaucetId = nativeId;
    jest.mocked(getNativeAssetIdSync).mockReturnValue(nativeId);
    jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
    jest.mocked(getSdkSyncedNativeAssetIdSync).mockReturnValue(nativeId);
    renderPage(
      {
        balances: [{ tokenId: nativeId, balance: 1, metadata: { symbol: 'USDCX', name: 'USDCX', decimals: 6 } }],
        tokenPrices: {}
      },
      nativeId
    );

    expect(within(screen.getByTestId('token-detail-hero')).getByText('$1.00')).toBeInTheDocument();
    expect(screen.queryByTestId('token-detail-price')).not.toBeInTheDocument();
    expect(screen.queryByTestId('token-detail-price-change')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'chartTimeframe' })).not.toBeInTheDocument();
    expect(mockFetchKlineData).not.toHaveBeenCalled();
  });

  it('shows no fiat line and no price section for a token the feed does not quote', () => {
    // Prices have loaded, and ETH is not among them.
    renderPage({ tokenPrices: { BTC: { price: 60000, change24h: 0, percentageChange24h: 0 } } });

    const hero = screen.getByTestId('token-detail-hero');
    expect(within(hero).getByText('12.50')).toBeInTheDocument();
    // No fiat line at all, not even the dash that means "not priced yet".
    expect(hero.querySelector('p')).toBeNull();
    expect(screen.queryByTestId('token-detail-price')).not.toBeInTheDocument();
  });

  it('shows the placeholder dash in the fiat line while prices have not loaded, not a missing line', () => {
    renderPage({ tokenPrices: {} });

    const hero = screen.getByTestId('token-detail-hero');
    expect(within(hero).getByText('12.50')).toBeInTheDocument();
    expect(hero.querySelector('p')).toHaveTextContent('\u2014');
  });

  // IETH is priced at ETH, which never takes the nominal rate, so its line waits on the feed.
  it('shows the placeholder dash in the fiat line off mainnet while prices have not loaded, for a listed token', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    try {
      renderPage({
        balances: [{ tokenId: TOKEN_IETH.faucetId, balance: 0.38, metadata: { symbol: 'IETH' } }],
        tokenPrices: {}
      });

      const hero = screen.getByTestId('token-detail-hero');
      expect(within(hero).getByText('0.38')).toBeInTheDocument();
      expect(hero.querySelector('p')).toHaveTextContent('\u2014');
    } finally {
      mockedHasUnquotedDefaultPrice.mockReturnValue(false);
    }
  });

  // E2E builds price the fixture symbol TST by symbol, and the feed never lists it, so with the
  // switch on it takes the nominal rate: a dollar figure, with no market to chart.
  it('shows the nominal fiat line and no price section off mainnet for the E2E fixture token', () => {
    const previousE2e = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    try {
      renderPage(
        {
          balances: [{ tokenId: 'mtst1fixture', balance: 12.5, metadata: { symbol: 'TST' } }],
          tokenPrices: { ETH: { price: 2000, change24h: 0, percentageChange24h: 0 } }
        },
        'mtst1fixture'
      );

      expect(within(screen.getByTestId('token-detail-hero')).getByText('$12.50')).toBeInTheDocument();
      expect(screen.queryByTestId('token-detail-price')).not.toBeInTheDocument();
    } finally {
      mockedHasUnquotedDefaultPrice.mockReturnValue(false);
      if (previousE2e === undefined) delete process.env.MIDEN_E2E_TEST;
      else process.env.MIDEN_E2E_TEST = previousE2e;
    }
  });

  it('draws the shared Hero: the 88px logo circle, the amount as the value and the fiat line muted', () => {
    renderPage();

    const hero = screen.getByTestId('token-detail-hero');
    const logo = within(hero).getByTestId('token-logo');
    expect(logo).toHaveAttribute('data-symbol', 'ETH');
    expect(logo).toHaveAttribute('data-faucet-id', TOKEN_ID);
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

  // The caption list starts flush under the heading on its own; a margin pulling it up would also
  // pull up History's empty, error and loading branches, which keep their own spacing.
  it('hands History the caption style without a negative margin', () => {
    renderPage();

    const section = screen.getByTestId('token-detail-activity');
    const history = within(section).getByTestId('history');
    expect(history).toHaveAttribute('data-date-style', 'caption');
    const negativeMargins: string[] = [];
    for (let node = history.parentElement; node && node !== section; node = node.parentElement) {
      negativeMargins.push(...Array.from(node.classList).filter(name => name.startsWith('-m')));
    }
    expect(negativeMargins).toEqual([]);
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
      expect(heading).toHaveClass('text-hero-name', 'font-extrabold', 'text-muted');
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
      renderPage({ balances: [], metadata: { [PLAIN_ID]: { symbol: 'BTC' } } }, PLAIN_ID);

      expect(screen.getByTestId('nav-title')).toHaveTextContent('BTC');
      // token undefined -> balance defaults to 0.
      expect(screen.getByText('0.00')).toBeInTheDocument();
    });

    it('shows the "unknown" symbol and zero balance when nothing resolves', () => {
      // balances undefined path (optional chaining short-circuits) + empty
      // metadata map -> metadata undefined -> symbol falls back to t('unknown').
      renderPage({ balances: null, metadata: {} }, PLAIN_ID);

      expect(screen.getByTestId('nav-title')).toHaveTextContent('unknown');
      expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'unknown');
    });

    it('handles a matched token whose balance is nullish', () => {
      renderPage({ balances: [{ tokenId: PLAIN_ID, metadata: { symbol: 'USDC' } }] }, PLAIN_ID);

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

    it('shows the placeholder while balances load, then lands on the first balance and its fiat value', () => {
      configure({ metadata: { [TOKEN_ID]: { symbol: 'ETH', name: 'Ether', decimals: 18 } } });
      mockUseAllBalances.mockReturnValue({ data: undefined });
      const { rerender } = render(<TokenDetail tokenId={TOKEN_ID} />);

      const hero = screen.getByTestId('token-detail-hero');
      // The hero's placeholder, an em dash.
      expect(hero).toHaveTextContent('\u2014');
      expect(within(hero).queryByText('0.00')).not.toBeInTheDocument();

      // The subtitle (fiat) line waits with the same dash, never a fabricated $0.00.
      const subtitle = hero.querySelector('p');
      expect(subtitle).toHaveTextContent('\u2014');
      expect(subtitle).not.toHaveTextContent('$0.00');

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
        tokenPrices: { ETH: { price: 2000, change24h: 0, percentageChange24h: 0 } }
      });

      // The market price elsewhere on the page is a price PER token and does not
      // depend on the scale, so it stays. What goes is 12.5 × $2000, the value
      // of a holding the wallet cannot size.
      expect(screen.getByTestId('token-detail-price')).toBeInTheDocument();
      expect(screen.queryByText('$25000.00')).not.toBeInTheDocument();
    });

    it('still names the token in the header and the logo', () => {
      renderPage({ balances: [{ tokenId: PLAIN_ID, balance: 12.5, metadata: unresolved }] }, PLAIN_ID);

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
    it.each([
      [1.0001, '$1.000100'],
      [0.99999, '$0.999990'],
      [0.9999995, '$1.000000'],
      [0.0000001234, '$0.00000012']
    ])('shows the USDC unit price %p with six decimals', (price, display) => {
      renderPage(
        {
          balances: [{ tokenId: MIDEN_USDC_FAUCET, balance: 1, metadata: { symbol: 'USDC', decimals: 6 } }],
          tokenPrices: { USDC: { price, change24h: 0, percentageChange24h: 0 } }
        },
        MIDEN_USDC_FAUCET
      );

      expect(within(screen.getByTestId('token-detail-price')).getByText(display)).toBeInTheDocument();
      expect(within(screen.getByTestId('tt-active-time')).getByText('$1.234500')).toBeInTheDocument();
    });

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
      expect(within(screen.getByTestId('tt-active-time')).getByText('$1.235')).toBeInTheDocument();
      // active + payload without a time -> value only, no time node.
      expect(within(screen.getByTestId('tt-active-notime')).getByText('$2.500')).toBeInTheDocument();
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

    it('renders the timeframes as the shared segmented control, the selected one on the accent-tint bubble', () => {
      renderPage();

      const option = (tf: string) => screen.getByTestId(`token-detail-timeframe-${tf}`);
      const bubbleIn = (tf: string) => option(tf).querySelector('[data-slot="motion-highlight"]');

      // Equal-width segments across the chart: the columns of the group's grid, 40px tall.
      expect(screen.getByRole('radiogroup', { name: 'chartTimeframe' })).toHaveClass(
        'grid',
        'w-full',
        'grid-flow-col',
        'auto-cols-fr'
      );
      expect(option('1D')).toHaveClass('min-w-0', 'h-10');

      expect(option('1D')).toHaveAttribute('role', 'radio');
      expect(option('1D')).toHaveAttribute('aria-checked', 'true');
      expect(option('1W')).toHaveAttribute('aria-checked', 'false');
      expect(bubbleIn('1D')).toHaveClass('bg-accent-tint', 'shadow-raised');
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
    it('renders the faucet id under the name the transaction page uses, trimmed and copyable', () => {
      renderPage({ network: { name: 'Devnet' } });

      const info = screen.getByTestId('token-detail-info');
      const contract = within(info).getByTestId('token-detail-contract');
      // The shared DetailCard: `fill`, 16px radius, hairlines between rows.
      expect(contract.parentElement).toHaveClass(
        'bg-page',
        'border',
        'border-hairline',
        'rounded-2xl',
        'divide-hairline'
      );
      // One name for one thing: "Faucet ID", as the transaction detail page says it.
      expect(within(contract).getByText('faucetId')).toBeInTheDocument();

      // A bare copy control in the row's value style, named by its action (its visible label is a
      // value), showing the id cut to its first 8 and last 4 characters.
      const copy = within(contract).getByRole('button', { name: 'copyToClipboard' });
      expect(copy).toHaveAttribute('data-testid', 'token-detail-copy-contract');
      expect(copy).toHaveClass('text-ink');
      expect(copy).toHaveTextContent(`${TOKEN_ID.slice(0, 8)}…${TOKEN_ID.slice(-4)}`);
      expect(copy).not.toHaveTextContent(TOKEN_ID);

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
      // Its name follows the action through: after the copy it announces that it copied.
      expect(copy).toHaveAccessibleName('copied');
    });

    it('opens the MidenScan explorer for this faucet in the in-app browser', () => {
      const explorerUrl = `https://devnet.midenscan.com/account/${TOKEN_ID}`;
      renderPage({ explorerUrl });

      expect(mockGetExplorerAccountUrl).toHaveBeenCalledWith(TOKEN_ID);

      const explorerRow = screen.getByTestId('token-detail-explorer');
      expect(explorerRow).toHaveTextContent('viewOnMidenscan');
      // The arrow svg ships with fill="none", so it draws only with a fill of its own, like the glyph it
      // replaced; it is decoration beside the label.
      const arrow = explorerRow.querySelector('svg');
      expect(arrow).toHaveAttribute('fill', 'currentColor');
      expect(arrow).toHaveAttribute('aria-hidden', 'true');

      fireEvent.click(explorerRow);

      expect(mockOpenExternalUrl).toHaveBeenCalledWith({ url: explorerUrl, title: 'Midenscan' });
      expect(mockHapticLight).toHaveBeenCalled();
    });

    it('hides the MidenScan row on a build with no explorer configured', () => {
      renderPage({ explorerUrl: null });

      expect(screen.queryByTestId('token-detail-explorer')).not.toBeInTheDocument();
      expect(mockOpenExternalUrl).not.toHaveBeenCalled();
    });

    it("shows the faucet's description first, stacked under its label", () => {
      const description = 'A bridged stablecoin that the Miden faucet mints one to one against USDC.';
      renderPage({ balances: [{ tokenId: PLAIN_ID, balance: 1, metadata: { symbol: 'ETH', description } }] }, PLAIN_ID);

      const info = screen.getByTestId('token-detail-info');
      const row = within(info).getByTestId('token-detail-description');
      expect(within(row).getByText('tokenDescription')).toBeInTheDocument();
      expect(within(row).getByText(description)).toBeInTheDocument();
      // Stacked, so the long text wraps under the label instead of being cut beside it.
      expect(row).toHaveClass('flex-col');
      // It describes the token, so it comes before the identifier rows.
      expect(row.nextElementSibling).toBe(within(info).getByTestId('token-detail-contract'));
    });

    it('reads the description from the base metadata when the balances do not list the token', () => {
      renderPage(
        { balances: [], metadata: { [PLAIN_ID]: { symbol: 'ETH', description: 'From the faucet.' } } },
        PLAIN_ID
      );

      expect(screen.getByTestId('token-detail-description')).toHaveTextContent('From the faucet.');
    });

    it.each([
      ['undefined', undefined],
      ['empty', '']
    ])('shows no description row when the description is %s', (_case, description) => {
      renderPage({ balances: [{ tokenId: PLAIN_ID, balance: 1, metadata: { symbol: 'ETH', description } }] }, PLAIN_ID);

      expect(screen.getByTestId('token-detail-contract')).toBeInTheDocument();
      expect(screen.queryByTestId('token-detail-description')).not.toBeInTheDocument();
      expect(screen.queryByText('tokenDescription')).not.toBeInTheDocument();
    });

    it.each([
      ['another', 'From the faucet.'],
      ['no', undefined]
    ])(
      "describes testnet iETH in the wallet's words when the faucet carries %s description (#477)",
      (_case, description) => {
        mockTestNetworkKey = 'testnet';
        renderPage({ balances: [{ tokenId: TOKEN_ID, balance: 1, metadata: { symbol: 'IETH', description } }] });

        const row = screen.getByTestId('token-detail-description');
        expect(row).toHaveTextContent('testIethDescription');
        expect(row).not.toHaveTextContent('From the faucet.');
      }
    );

    it("shows the faucet's own description for iETH off testnet", () => {
      mockTestNetworkKey = 'devnet';
      renderPage({
        balances: [{ tokenId: TOKEN_ID, balance: 1, metadata: { symbol: 'IETH', description: 'From the faucet.' } }]
      });

      const row = screen.getByTestId('token-detail-description');
      expect(row).toHaveTextContent('From the faucet.');
      expect(row).not.toHaveTextContent('testIethDescription');
    });
  });

  describe('the Unverified mark', () => {
    it.each(['verified', 'unknown'] as const)('hides the Unverified mark for a %s token', verification => {
      mockVerifyToken.mockReturnValue(verification);
      renderPage();

      expect(screen.queryByTestId('token-detail-unverified')).not.toBeInTheDocument();
      expect(mockVerifyToken).toHaveBeenCalledWith(TOKEN_ID);
    });

    it('marks an unverified token with a badge on its logo and a pill that opens the explanation', () => {
      mockVerifyToken.mockReturnValue('unverified');
      renderPage();

      // The warning badge rides on the token's own mark.
      expect(within(screen.getByTestId('token-logo')).getByTestId('token-detail-unverified-badge')).toBeInTheDocument();

      const mark = screen.getByTestId('token-detail-unverified');
      // Directly under the Hero, not buried further down the page.
      expect(screen.getByTestId('token-detail-hero').nextElementSibling).toBe(mark);

      // One tinted pill: the warning glyph, "Unverified token", an info glyph; no paragraph on the page.
      const pill = screen.getByTestId('token-detail-unverified-pill');
      expect(pill).toHaveTextContent('unverifiedTokenTitle');
      expect(pill).toHaveClass('text-pending-tint-ink');
      expect(within(mark).queryByRole('note')).not.toBeInTheDocument();

      // Tapping it opens the sheet and reports it expanded; closing the sheet collapses it.
      expect(screen.queryByTestId('unverified-token-sheet')).not.toBeInTheDocument();
      expect(pill).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(pill);
      expect(screen.getByTestId('unverified-token-sheet')).toBeInTheDocument();
      expect(pill).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(screen.getByTestId('unverified-token-sheet'));
      expect(screen.queryByTestId('unverified-token-sheet')).not.toBeInTheDocument();
    });

    it('draws no badge on the logo of a verified token', () => {
      mockVerifyToken.mockReturnValue('verified');
      renderPage();

      expect(screen.queryByTestId('token-detail-unverified-badge')).not.toBeInTheDocument();
    });
  });

  describe('hiding the token', () => {
    const KEY = 'hidden-tokens:v1:testnet:pk-123';
    const toggle = () => screen.getByTestId('token-detail-hide-toggle');
    const renderReady = async (stored: string[] = []) => {
      mockReadStorage.mockResolvedValue(stored);
      renderPage();
      await waitFor(() => expect(toggle()).toBeEnabled());
    };

    it("offers Hide token with the eye-off glyph, in the explorer row's text-action style", async () => {
      await renderReady();

      expect(within(screen.getByTestId('token-detail-info')).getByTestId('token-detail-hide-toggle')).toBe(toggle());
      expect(toggle()).toHaveTextContent('hideToken');
      expect(toggle()).toHaveClass('text-action', 'text-accent-tint-ink');
      const glyph = toggle().querySelector('svg');
      expect(glyph).toHaveAttribute('name', 'eye-off');
      expect(glyph).toHaveAttribute('aria-hidden', 'true');
      expect(screen.queryByTestId('token-detail-hidden-notice')).toBeNull();
      expect(screen.queryByTestId('token-detail-hidden-unreadable')).toBeNull();
    });

    it('hides the token on tap, stays on the page, and flips the row to Unhide with a note', async () => {
      await renderReady();

      fireEvent.click(toggle());

      await waitFor(() => expect(toggle()).toHaveTextContent('unhideToken'));
      expect(mockWriteStorage).toHaveBeenCalledWith(KEY, [normalizedFaucetId(TOKEN_ID)]);
      expect(mockHapticMedium).toHaveBeenCalledTimes(1);
      expect(toggle().querySelector('svg')).toHaveAttribute('name', 'eye');
      const notice = screen.getByTestId('token-detail-hidden-notice');
      expect(notice).toHaveTextContent('tokenHiddenNotice');
      expect(notice).toHaveAttribute('data-variant', 'inline');
      expect(notice).toHaveAttribute('role', 'status');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockGoBack).not.toHaveBeenCalled();
    });

    it('unhides a hidden token from the same row and drops the note', async () => {
      await renderReady([TOKEN_ID]);
      expect(toggle()).toHaveTextContent('unhideToken');
      expect(screen.getByTestId('token-detail-hidden-notice')).toBeInTheDocument();

      fireEvent.click(toggle());

      await waitFor(() => expect(toggle()).toHaveTextContent('hideToken'));
      expect(mockWriteStorage).toHaveBeenCalledWith(KEY, []);
      expect(screen.queryByTestId('token-detail-hidden-notice')).toBeNull();
    });

    it('offers no row for the native token', () => {
      mockNativeFaucetId = TOKEN_ID;
      renderPage();

      expect(screen.queryByTestId('token-detail-hide-toggle')).toBeNull();
      expect(screen.getByTestId('token-detail-explorer')).toBeInTheDocument();
    });

    it('offers no row before the native token is known', () => {
      mockNativeFaucetId = null;
      renderPage();

      expect(screen.queryByTestId('token-detail-hide-toggle')).toBeNull();
    });

    it.each([
      ['the native token', () => TOKEN_ID],
      ['a page before the native token is known', () => null]
    ])('shows no unreadable note for %s, which offers no row', async (_label, nativeId) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockNativeFaucetId = nativeId();
        mockReadStorage.mockRejectedValue(new Error('Read unavailable'));
        renderPage();

        // The store marks the set unreadable right after this warning.
        await waitFor(() => expect(warn).toHaveBeenCalled());
        expect(screen.queryByTestId('token-detail-hidden-unreadable')).toBeNull();
        expect(screen.queryByTestId('token-detail-hide-toggle')).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps the row disabled while the hidden set is being read', () => {
      renderPage();

      expect(toggle()).toBeDisabled();
      expect(toggle()).toHaveTextContent('hideToken');
      expect(screen.queryByTestId('token-detail-hidden-unreadable')).toBeNull();
      expect(screen.queryByTestId('token-detail-hidden-error')).toBeNull();
    });

    it('keeps the row disabled and shows a note, not the alert, when the hidden set cannot be read', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockReadStorage.mockRejectedValue(new Error('Read unavailable'));
      renderPage();

      const note = await screen.findByTestId('token-detail-hidden-unreadable');
      expect(note).toHaveTextContent('hiddenTokensUnreadable');
      expect(note).toHaveAttribute('role', 'note');
      expect(screen.queryByTestId('token-detail-hidden-error')).toBeNull();
      expect(toggle()).toBeDisabled();
      warn.mockRestore();
    });

    it('keeps the row usable after a failed save, so a retry stores it', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockWriteStorage.mockRejectedValueOnce(new Error('Storage unavailable'));
      await renderReady();

      fireEvent.click(toggle());
      expect(await screen.findByTestId('token-detail-hidden-error')).toHaveTextContent('hiddenTokensError');
      expect(screen.queryByTestId('token-detail-hidden-unreadable')).toBeNull();
      expect(toggle()).toHaveTextContent('hideToken');
      expect(toggle()).toBeEnabled();

      fireEvent.click(toggle());
      await waitFor(() => expect(toggle()).toHaveTextContent('unhideToken'));
      expect(screen.queryByTestId('token-detail-hidden-error')).toBeNull();
      warn.mockRestore();
    });

    // The page stays mounted across an account switch; only TokenInfo's key keeps a save result on its own account.
    const switchAccount = (view: ReturnType<typeof render>) => {
      mockUseAccount.mockReturnValue({ publicKey: 'pk-456' });
      view.rerender(<TokenDetail tokenId={TOKEN_ID} />);
    };

    it("does not show one account's failed save on the next account's page", async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockReadStorage.mockResolvedValue([]);
        const view = renderPage();
        await waitFor(() => expect(toggle()).toBeEnabled());
        mockWriteStorage.mockRejectedValueOnce(new Error('Storage unavailable'));
        fireEvent.click(toggle());
        expect(await screen.findByTestId('token-detail-hidden-error')).toBeInTheDocument();

        switchAccount(view);

        await waitFor(() => expect(toggle()).toBeEnabled());
        expect(screen.queryByTestId('token-detail-hidden-error')).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });

    it('lands a save still pending at an account switch on no page', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockReadStorage.mockResolvedValue([]);
        const view = renderPage();
        await waitFor(() => expect(toggle()).toBeEnabled());
        let failWrite!: (error: Error) => void;
        mockWriteStorage.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              failWrite = reject;
            })
        );
        fireEvent.click(toggle());
        await waitFor(() => expect(mockWriteStorage).toHaveBeenCalledTimes(1));

        switchAccount(view);
        await waitFor(() => expect(toggle()).toBeEnabled());
        await act(async () => {
          failWrite(new Error('Storage unavailable'));
        });

        expect(screen.queryByTestId('token-detail-hidden-error')).toBeNull();
        expect(toggle()).toHaveTextContent('hideToken');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('editing the token details', () => {
    const shownMetadata = { name: 'Ether', symbol: 'ETH', decimals: 8 };
    const unknownScaleMetadata = { name: 'Unknown', symbol: 'Unknown', decimals: 6, scaleIsUnknown: true };
    // A token whose faucet scale is unknown, with the decimals the user stated.
    const userScaleMetadata = { ...shownMetadata, scaleIsUnknown: false, scaleFromOverride: true };
    const renderEditable = (o: Overrides = {}) =>
      renderPage({ balances: [{ tokenId: PLAIN_ID, balance: 12.5, metadata: shownMetadata }], ...o }, PLAIN_ID);
    const renderWithMetadata = (metadata: Record<string, unknown>) =>
      renderEditable({ balances: [{ tokenId: PLAIN_ID, balance: 1, metadata }] });
    const action = () => screen.getByTestId('token-detail-edit');
    const field = (name: 'name' | 'symbol' | 'decimals') => screen.getByTestId(`edit-token-${name}`);
    const sheetOpen = () => screen.getByTestId('drawer').getAttribute('data-open');

    it('offers the action in the token info card, styled like the other text actions', () => {
      renderEditable();

      expect(within(screen.getByTestId('token-detail-info')).getByTestId('token-detail-edit')).toBe(action());
      expect(action()).toHaveTextContent('editTokenDetails');
      expect(action()).toHaveClass('text-action', 'text-accent-tint-ink');
      expect(action()).toHaveAttribute('aria-haspopup', 'dialog');
      expect(action()).toHaveAttribute('aria-expanded', 'false');
    });

    it('offers no action for the native token', () => {
      mockNativeFaucetId = PLAIN_ID;
      renderEditable();

      expect(screen.queryByTestId('token-detail-edit')).toBeNull();
      expect(screen.queryByTestId('drawer')).toBeNull();
    });

    it('offers no action before the native token is known', () => {
      mockNativeFaucetId = null;
      renderEditable();

      expect(screen.queryByTestId('token-detail-edit')).toBeNull();
    });

    it('opens the sheet with the values the page shows, and a light haptic', () => {
      renderWithMetadata(userScaleMetadata);
      expect(sheetOpen()).toBe('false');

      fireEvent.click(action());

      expect(mockHapticLight).toHaveBeenCalled();
      expect(sheetOpen()).toBe('true');
      expect(action()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('drawer-title')).toHaveTextContent('editTokenDetailsTitle');
      expect(field('name')).toHaveValue('Ether');
      expect(field('symbol')).toHaveValue('ETH');
      expect(field('decimals')).toHaveValue('8');
      expect(screen.getByTestId('edit-token-notice')).toHaveTextContent('tokenMetadataOverrideNotice');
    });

    it('leaves the decimals empty for a token whose scale is a guess, so the user must state it', () => {
      renderWithMetadata(unknownScaleMetadata);

      fireEvent.click(action());

      expect(field('decimals')).toHaveValue('');
    });

    it('hides the decimals field and the notice for a token whose faucet scale is known', () => {
      renderEditable();

      fireEvent.click(action());

      expect(screen.queryByTestId('edit-token-decimals')).toBeNull();
      expect(screen.queryByTestId('edit-token-notice')).toBeNull();
      expect(field('name')).toHaveValue('Ether');
    });

    it.each([
      ['an unknown-scale token', unknownScaleMetadata],
      ['a token whose decimals the user set', userScaleMetadata]
    ])('shows the decimals field and the notice for %s', (_label, metadata) => {
      renderWithMetadata(metadata);

      fireEvent.click(action());

      expect(field('decimals')).toBeInTheDocument();
      expect(screen.getByTestId('edit-token-notice')).toHaveTextContent('tokenMetadataOverrideNotice');
    });

    it('shows an error under each field that is not valid, and saves nothing', () => {
      renderWithMetadata(unknownScaleMetadata);
      fireEvent.click(action());

      fireEvent.change(field('name'), { target: { value: '   ' } });
      fireEvent.change(field('symbol'), { target: { value: 'A-SYMBOL-TOO-LONG' } });
      fireEvent.change(field('decimals'), { target: { value: '19' } });
      fireEvent.click(screen.getByTestId('edit-token-save'));

      expect(screen.getByTestId('edit-token-name-error')).toHaveTextContent('tokenNameInvalid_32');
      expect(screen.getByTestId('edit-token-symbol-error')).toHaveTextContent('tokenSymbolInvalid_12');
      expect(screen.getByTestId('edit-token-decimals-error')).toHaveTextContent('tokenDecimalsInvalid_18');
      expect(field('name')).toHaveAttribute('aria-invalid', 'true');
      expect(mockSetTokenMetadataOverride).not.toHaveBeenCalled();
      expect(sheetOpen()).toBe('true');
    });

    it.each(['1.5', '-1', 'abc', ''])('refuses %p as decimals', decimals => {
      renderWithMetadata(unknownScaleMetadata);
      fireEvent.click(action());

      fireEvent.change(field('decimals'), { target: { value: decimals } });
      fireEvent.click(screen.getByTestId('edit-token-save'));

      expect(screen.getByTestId('edit-token-decimals-error')).toBeInTheDocument();
      expect(screen.queryByTestId('edit-token-name-error')).toBeNull();
      expect(mockSetTokenMetadataOverride).not.toHaveBeenCalled();
    });

    it('clears a field error when the user edits the field', () => {
      renderEditable();
      fireEvent.click(action());
      fireEvent.change(field('name'), { target: { value: '' } });
      fireEvent.click(screen.getByTestId('edit-token-save'));
      expect(screen.getByTestId('edit-token-name-error')).toBeInTheDocument();

      fireEvent.change(field('name'), { target: { value: 'E' } });

      expect(screen.queryByTestId('edit-token-name-error')).toBeNull();
    });

    it('saves the trimmed values with the symbol upper-cased, then closes the sheet', async () => {
      renderWithMetadata(unknownScaleMetadata);
      fireEvent.click(action());

      fireEvent.change(field('name'), { target: { value: '  My Ether  ' } });
      fireEvent.change(field('symbol'), { target: { value: ' meth ' } });
      fireEvent.change(field('decimals'), { target: { value: ' 18 ' } });
      fireEvent.click(screen.getByTestId('edit-token-save'));

      expect(mockSetTokenMetadataOverride).toHaveBeenCalledWith(PLAIN_ID, {
        name: 'My Ether',
        symbol: 'METH',
        decimals: 18
      });
      await waitFor(() => expect(sheetOpen()).toBe('false'));
    });

    it("saves a known-scale token's name and symbol only, so no stored decimals outlive the save", async () => {
      mockTokenMetadataOverrides = { [PLAIN_ID]: { name: 'Ether', symbol: 'ETH', decimals: 2 } };
      renderEditable();
      fireEvent.click(action());

      fireEvent.change(field('name'), { target: { value: 'My Ether' } });
      fireEvent.click(screen.getByTestId('edit-token-save'));

      expect(mockSetTokenMetadataOverride).toHaveBeenCalledTimes(1);
      expect(mockSetTokenMetadataOverride.mock.calls[0]).toStrictEqual([PLAIN_ID, { name: 'My Ether', symbol: 'ETH' }]);
      await waitFor(() => expect(sheetOpen()).toBe('false'));
    });

    it('keeps the sheet open with an error when the save fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockSetTokenMetadataOverride.mockRejectedValue(new Error('Storage unavailable'));
        renderEditable();
        fireEvent.click(action());

        fireEvent.click(screen.getByTestId('edit-token-save'));

        expect(await screen.findByTestId('edit-token-save-error')).toHaveTextContent('tokenMetadataSaveError');
        expect(sheetOpen()).toBe('true');
        expect(screen.getByTestId('edit-token-save')).toBeEnabled();
      } finally {
        warn.mockRestore();
      }
    });

    it('does not close while the save is in flight', async () => {
      let finishSave: () => void = () => {};
      mockSetTokenMetadataOverride.mockImplementation(
        () =>
          new Promise<void>(resolve => {
            finishSave = resolve;
          })
      );
      renderEditable();
      fireEvent.click(action());
      fireEvent.click(screen.getByTestId('edit-token-save'));

      fireEvent.click(screen.getByTestId('drawer-dismiss'));
      expect(sheetOpen()).toBe('true');

      await act(async () => {
        finishSave();
      });
      expect(sheetOpen()).toBe('false');
    });

    it('starts each opening from the values on the page, not from an earlier draft', () => {
      renderEditable();
      fireEvent.click(action());
      fireEvent.change(field('name'), { target: { value: 'Draft' } });
      fireEvent.click(screen.getByTestId('drawer-dismiss'));

      // Closed, and the body is still mounted with the draft, as through the real sheet's exit.
      expect(sheetOpen()).toBe('false');
      expect(field('name')).toHaveValue('Draft');

      fireEvent.click(action());

      expect(sheetOpen()).toBe('true');
      expect(field('name')).toHaveValue('Ether');
    });

    it('offers the reset only when the token has an override', () => {
      renderEditable();
      fireEvent.click(action());

      expect(screen.queryByTestId('edit-token-reset')).toBeNull();
    });

    it('resets to the faucet values with a medium haptic, then closes the sheet', async () => {
      mockTokenMetadataOverrides = { [PLAIN_ID]: { symbol: 'ETH' } };
      renderEditable();
      fireEvent.click(action());

      fireEvent.click(screen.getByTestId('edit-token-reset'));

      expect(screen.getByTestId('edit-token-reset')).toHaveTextContent('resetToFaucetValues');
      expect(mockHapticMedium).toHaveBeenCalled();
      expect(mockClearTokenMetadataOverride).toHaveBeenCalledWith(PLAIN_ID);
      expect(mockSetTokenMetadataOverride).not.toHaveBeenCalled();
      await waitFor(() => expect(sheetOpen()).toBe('false'));
    });

    it('marks an edited token with a neutral pill beside the card title', () => {
      mockTokenMetadataOverrides = { [PLAIN_ID]: { name: 'Mine' } };
      renderEditable();

      const pill = screen.getByTestId('token-detail-edited');
      expect(pill).toHaveTextContent('tokenMetadataEdited');
      expect(within(screen.getByTestId('token-detail-info')).getByTestId('token-detail-edited')).toBe(pill);
    });

    it('shows no Edited pill without an override', () => {
      mockTokenMetadataOverrides = { 'mtst1another-faucet': { name: 'Mine' } };
      renderEditable();

      expect(screen.queryByTestId('token-detail-edited')).toBeNull();
    });

    it('shows no Edited pill for the native token, whose override is never applied', () => {
      mockNativeFaucetId = PLAIN_ID;
      mockTokenMetadataOverrides = { [PLAIN_ID]: { name: 'Mine' } };
      renderEditable();

      expect(screen.queryByTestId('token-detail-edited')).toBeNull();
    });

    it('offers no edit for testnet iETH, which the wallet names itself, and no Edited pill for an override stored before (#477)', () => {
      mockTokenMetadataOverrides = { [TOKEN_ID]: { name: 'Mine', symbol: 'MINE' } };
      renderPage({
        balances: [{ tokenId: TOKEN_ID, balance: 1, metadata: { name: 'iETH', symbol: 'IETH', decimals: 8 } }]
      });

      expect(screen.getByTestId('nav-title')).toHaveTextContent('Test iETH');
      expect(screen.queryByTestId('token-detail-edit')).toBeNull();
      expect(screen.queryByTestId('token-detail-edited')).toBeNull();
    });

    it('offers the edit for iETH off testnet, where the wallet gives it no name', () => {
      mockTestNetworkKey = 'devnet';
      renderPage({
        balances: [{ tokenId: TOKEN_ID, balance: 1, metadata: { name: 'iETH', symbol: 'IETH', decimals: 8 } }]
      });

      expect(screen.getByTestId('token-detail-edit')).toBeInTheDocument();
    });
  });
});

describe('TokenDetail testnet bridge USDC label', () => {
  it('titles the bridge faucet by the testnet label and keeps its USDC logo', () => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderPage(
      {
        balances: [{ tokenId: MIDEN_USDC_FAUCET, balance: 1, metadata: { symbol: 'USDC', decimals: 6 } }],
        tokenPrices: {}
      },
      MIDEN_USDC_FAUCET
    );

    expect(screen.getByTestId('nav-title')).toHaveTextContent('Test Epoch USDC');
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
  });

  it('retitles the bridge faucet by the label once the bridge config publishes, with no new props', () => {
    renderPage(
      {
        balances: [{ tokenId: MIDEN_USDC_FAUCET, balance: 1, metadata: { symbol: 'USDC', decimals: 6 } }],
        tokenPrices: {}
      },
      MIDEN_USDC_FAUCET
    );
    expect(screen.getByTestId('nav-title')).toHaveTextContent(/^USDC$/);

    act(() => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      publishMockBridgeSnapshot();
    });

    expect(screen.getByTestId('nav-title')).toHaveTextContent('Test Epoch USDC');
  });
});
