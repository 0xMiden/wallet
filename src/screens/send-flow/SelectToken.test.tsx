import React from 'react';

import { act, render, screen, fireEvent, within } from '@testing-library/react';

import {
  publishMockBridgeSnapshot,
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_MIDEN_USDC_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { TEST_SWAP_TOKENS, TEST_TOKEN_IBTC, TEST_TOKEN_IETH } from 'lib/miden/swap/testing/registry';
import { _setSwapTokensForTest } from 'lib/miden/swap/tokens';
import { hasUnquotedDefaultPrice } from 'lib/prices/unquoted-default';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { isUsdcxWithdrawalAvailable } from 'lib/usdcx/withdrawal';

import { SelectTokenDrawer } from './SelectToken';
import { UIToken } from './types';

// This verified-list fixture assigns explicit price assets to the test faucets.
const mockVerifiedPriceAssets = new Map<string, string>();
jest.mock('lib/token-list/runtime', () => ({
  ...jest.requireActual<typeof import('lib/token-list/runtime')>('lib/token-list/runtime'),
  peekTokenPriceAssets: () => mockVerifiedPriceAssets
}));
beforeEach(() => {
  mockVerifiedPriceAssets.clear();
  for (const token of TEST_SWAP_TOKENS) {
    if (token.priceSymbol) mockVerifiedPriceAssets.set(token.faucetId, token.priceSymbol);
  }
});

// Install swap fixtures for tests that also read swap metadata.
beforeAll(() => _setSwapTokensForTest(TEST_SWAP_TOKENS));
afterAll(() => _setSwapTokensForTest(undefined));

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

jest.mock('lib/usdcx/withdrawal', () => ({ isUsdcxWithdrawalAvailable: jest.fn(() => false) }));

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert against the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));
// The fiat values under test follow the default rule, no figure without a quote; pinned here against
// Developer Settings' nominal $1 switch (lib/prices/unquoted-default). The nominal case flips it.
jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));
const mockedHasUnquotedDefaultPrice = jest.mocked(hasUnquotedDefaultPrice);

// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
});

// The discovered native asset; none until a case discovers one.
let mockNativeFaucetId: string | null = null;
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => mockNativeFaucetId }));

// `lib/miden/front` is the WASM-backed data barrel. Stub the three hooks the
// component consumes so we can drive account / balances / metadata by hand.
const mockUseAccount = jest.fn(() => ({ publicKey: 'pk-abc' }) as { publicKey: string });
const mockUseAllTokensBaseMetadata = jest.fn(() => ({}) as Record<string, unknown>);
const mockUseAllBalances = jest.fn(
  (_publicKey: string, _metadata: Record<string, unknown>) => ({ data: [] as unknown[] }) as { data?: unknown[] }
);

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount(),
  useAllTokensBaseMetadata: () => mockUseAllTokensBaseMetadata(),
  useAllBalances: (publicKey: string, metadata: Record<string, unknown>) => mockUseAllBalances(publicKey, metadata)
}));

// `lib/store` is the zustand wallet store; the component only reads
// `tokenPrices` via a selector, so run the selector against a controllable slice.
let mockStoreState: { tokenPrices: Record<string, unknown> } = { tokenPrices: {} };
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState)
}));

// The hidden set is `useHiddenTokens`'s, tested there; here it is whatever each case says. One `isHidden` across
// renders, as the hook gives while the set holds, so the search memo recomputes only when its other inputs move.
const mockHiddenIds = new Set<string>();
const mockIsHidden = (id: string) => mockHiddenIds.has(id);
const mockUseHiddenTokens = jest.fn((_address: string) => ({ isHidden: mockIsHidden }));
jest.mock('app/hooks/useHiddenTokens', () => ({
  useHiddenTokens: (address: string) => mockUseHiddenTokens(address)
}));

// vaul drawer — render children plus a probe button so we can fire the
// `onOpenChange` the component wires to the sheet, and surface `open`.
// The sheet's closeOnBack, captured so a test can see which tier owns its mobile back.
let mockDrawerCloseOnBack: boolean | undefined;
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    closeOnBack,
    children
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    closeOnBack?: boolean;
    children: React.ReactNode;
  }) => (
    <div data-testid="drawer" data-open={String(open)} ref={() => (mockDrawerCloseOnBack = closeOnBack)}>
      <button data-testid="drawer-openchange" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2 data-testid="drawer-title">{children}</h2>
}));

// Stub SearchInput to a controlled input so typing drives the component's
// `onChange(value)` contract directly.
jest.mock('components/ui/SearchInput', () => ({
  SearchInput: ({
    value,
    onChange,
    placeholder,
    'data-testid': dataTestId
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    'data-testid'?: string;
  }) => (
    <input data-testid={dataTestId} aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} />
  )
}));

// `components/TokenLogo` renders inline SVG logos; stub it to a probe that
// surfaces the `faucetId`/`size` props the row passes through.
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId, size }: { faucetId: string | undefined; size?: string }) => (
    <span data-testid="token-logo" data-faucet-id={faucetId} data-size={size} />
  )
}));

// `lib/prices` reaches for the live price feed; the fiat column uses the real pure lookups.
jest.mock('lib/prices', () => ({
  listedFiatValue: jest.requireActual('lib/prices/binance').listedFiatValue,
  listedPrice: jest.requireActual('lib/prices/binance').listedPrice
}));

type Balance = {
  tokenId: string;
  metadata: { symbol: string; name?: string; decimals: number };
  balance: number;
  fiatPrice: number;
};

const BTC: Balance = {
  tokenId: TEST_TOKEN_IBTC.faucetId,
  metadata: { symbol: 'BTC', name: 'Bitcoin', decimals: 8 },
  balance: 1.5,
  fiatPrice: 50000
};
const ETH: Balance = {
  tokenId: 't-eth',
  metadata: { symbol: 'ETH', name: 'Ethereum', decimals: 18 },
  balance: 2,
  fiatPrice: 3000
};
// No `name` — exercises the `metadata.name?.` optional-chaining branch.
const XYZ: Balance = {
  tokenId: 't-xyz',
  metadata: { symbol: 'XYZ', decimals: 6 },
  balance: 5,
  fiatPrice: 1
};

// The native token: it stands for nothing the feed quotes, so it has no price symbol.
const MIDEN: Balance = {
  tokenId: 't-miden',
  metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6 },
  balance: 4,
  fiatPrice: 0
};

// A swap test token that stands for ETH, held under its registry faucet id.
const IETH: Balance = {
  tokenId: TEST_TOKEN_IETH.faucetId,
  metadata: { symbol: 'IETH', decimals: 8 },
  balance: 2,
  fiatPrice: 0
};

const setBalances = (balances: Balance[]) => {
  mockUseAllBalances.mockReturnValue({ data: balances });
};

const renderDrawer = (overrides: Partial<React.ComponentProps<typeof SelectTokenDrawer>> = {}) => {
  const onOpenChange = jest.fn();
  const onSelect = jest.fn();
  const utils = render(<SelectTokenDrawer open onOpenChange={onOpenChange} onSelect={onSelect} {...overrides} />);
  return { onOpenChange, onSelect, ...utils };
};

const search = () => screen.getByTestId('send-token-search') as HTMLInputElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
  mockNativeFaucetId = null;
  mockUseAccount.mockReturnValue({ publicKey: 'pk-abc' });
  mockUseAllTokensBaseMetadata.mockReturnValue({});
  mockUseAllBalances.mockReturnValue({ data: [] });
  mockStoreState = { tokenPrices: {} };
  mockHiddenIds.clear();
});

afterEach(() => {
  mockedHasUnquotedDefaultPrice.mockReturnValue(false);
});

describe('SelectTokenDrawer', () => {
  it('disables other tokens when the destination requires USDCx', () => {
    const usdcx = { ...MIDEN, metadata: { ...MIDEN.metadata, symbol: 'USDCx' } };
    jest.mocked(isUsdcxWithdrawalAvailable).mockImplementation(id => id === usdcx.tokenId);
    setBalances([BTC, usdcx]);
    const { onSelect, onOpenChange, rerender } = renderDrawer({ usdcxOnly: true });
    expect(screen.getByTestId('send-token-BTC')).toBeDisabled();
    fireEvent.click(screen.getByTestId('send-token-BTC'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-token-USDCx')).toBeEnabled();
    fireEvent.click(screen.getByTestId('send-token-USDCx'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: usdcx.tokenId }));
    rerender(<SelectTokenDrawer open onOpenChange={onOpenChange} onSelect={onSelect} usdcxOnly={false} />);
    expect(screen.getByTestId('send-token-BTC')).toBeEnabled();
  });

  it('says why the other tokens are disabled when the destination requires USDCx', () => {
    setBalances([BTC]);
    const { onOpenChange, onSelect, rerender } = renderDrawer({ usdcxOnly: true });
    expect(screen.getByText('sendUsdcxOnlyDestination')).toBeInTheDocument();

    rerender(<SelectTokenDrawer open onOpenChange={onOpenChange} onSelect={onSelect} usdcxOnly={false} />);
    expect(screen.queryByText('sendUsdcxOnlyDestination')).not.toBeInTheDocument();
  });

  it("leaves mobile back to SendManager's handler, which closes the sheet", () => {
    renderDrawer();
    expect(mockDrawerCloseOnBack).toBe(false);
  });

  it('renders the localized title, search box and one row per balance when there is no query', () => {
    setBalances([BTC, ETH, XYZ]);
    renderDrawer();

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('selectAToken');
    expect(search()).toHaveAttribute('aria-label', 'searchForTokens');

    expect(screen.getByTestId('send-token-BTC')).toBeInTheDocument();
    expect(screen.getByTestId('send-token-ETH')).toBeInTheDocument();
    expect(screen.getByTestId('send-token-XYZ')).toBeInTheDocument();
  });

  it('exposes the exact token id for duplicate-symbol rows', () => {
    const duplicateBtc = { ...BTC, tokenId: 't-btc-duplicate', balance: 2 };
    setBalances([BTC, duplicateBtc]);
    renderDrawer();

    const rows = screen.getAllByTestId('send-token-BTC');
    expect(rows).toHaveLength(2);
    // The row itself carries both ids: the E2E harness clicks the matched [data-token-id] row, so the
    // id must not move to a wrapper or a child of it.
    expect(rows[0]).toHaveAttribute('data-token-id', BTC.tokenId);
    expect(rows[1]).toHaveAttribute('data-token-id', duplicateBtc.tokenId);
  });

  it('passes the account public key and base metadata through to useAllBalances', () => {
    mockUseAccount.mockReturnValue({ publicKey: 'pk-999' });
    const metadata = { faucet: { symbol: 'M' } };
    mockUseAllTokensBaseMetadata.mockReturnValue(metadata);
    setBalances([BTC]);
    renderDrawer();

    expect(mockUseAllBalances).toHaveBeenCalledWith('pk-999', metadata);
  });

  it('defaults balance data to an empty list when useAllBalances yields no data', () => {
    mockUseAllBalances.mockReturnValue({});
    renderDrawer();

    expect(screen.queryByTestId(/^send-token-(?!search$)/)).not.toBeInTheDocument();
    // Drawer chrome still renders even with no rows.
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('selectAToken');
  });

  it('filters by symbol substring (case-insensitive)', () => {
    setBalances([BTC, ETH, XYZ]);
    renderDrawer();

    fireEvent.change(search(), { target: { value: 'eth' } });

    expect(screen.getByTestId('send-token-ETH')).toBeInTheDocument();
    expect(screen.queryByTestId('send-token-BTC')).not.toBeInTheDocument();
    expect(screen.queryByTestId('send-token-XYZ')).not.toBeInTheDocument();
  });

  it('filters by token name when the symbol does not match the query', () => {
    setBalances([BTC, ETH, XYZ]);
    renderDrawer();

    // 'bitcoin' is not in the symbol 'BTC' but is in the name 'Bitcoin'.
    fireEvent.change(search(), { target: { value: 'bitcoin' } });

    expect(screen.getByTestId('send-token-BTC')).toBeInTheDocument();
    expect(screen.queryByTestId('send-token-ETH')).not.toBeInTheDocument();
    expect(screen.queryByTestId('send-token-XYZ')).not.toBeInTheDocument();
  });

  it('excludes a nameless token when neither symbol nor (absent) name matches', () => {
    setBalances([BTC, ETH, XYZ]);
    renderDrawer();

    // Matches nothing: BTC/ETH symbols and names lack 'qqq', XYZ has no name.
    fireEvent.change(search(), { target: { value: 'qqq' } });

    expect(screen.queryByTestId(/^send-token-(?!search$)/)).not.toBeInTheDocument();
  });

  it('treats a whitespace-only query as no filter (trim short-circuit)', () => {
    setBalances([BTC, ETH]);
    renderDrawer();

    fireEvent.change(search(), { target: { value: '   ' } });

    expect(screen.getByTestId('send-token-BTC')).toBeInTheDocument();
    expect(screen.getByTestId('send-token-ETH')).toBeInTheDocument();
  });

  it('leaves a hidden token out of the picker, and a search does not bring it back', () => {
    setBalances([BTC, ETH]);
    mockHiddenIds.add(ETH.tokenId);
    renderDrawer();

    expect(mockUseHiddenTokens).toHaveBeenCalledWith('pk-abc');
    expect(screen.getByTestId('send-token-BTC')).toBeInTheDocument();
    expect(screen.queryByTestId('send-token-ETH')).toBeNull();

    fireEvent.change(search(), { target: { value: 'eth' } });

    expect(screen.queryByTestId('send-token-ETH')).toBeNull();
  });

  it('builds the UIToken, resets the search and closes the drawer on select', () => {
    mockStoreState = { tokenPrices: { BTC: { price: 50000 } } };
    setBalances([BTC, ETH]);
    const { onSelect, onOpenChange } = renderDrawer();

    // Narrow the list first so we can prove the query is cleared afterwards.
    fireEvent.change(search(), { target: { value: 'btc' } });
    expect(search()).toHaveValue('btc');
    expect(screen.queryByTestId('send-token-ETH')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('send-token-BTC'));

    const expected: UIToken = {
      id: TEST_TOKEN_IBTC.faucetId,
      name: 'BTC',
      decimals: 8,
      balance: 1.5,
      fiatPrice: 50000,
      scaleIsKnown: true
    };
    expect(onSelect).toHaveBeenCalledWith(expected);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Search reset back to empty, so both tokens are visible again.
    expect(search()).toHaveValue('');
    expect(screen.getByTestId('send-token-BTC')).toBeInTheDocument();
    expect(screen.getByTestId('send-token-ETH')).toBeInTheDocument();
  });

  it('hands the amount step no price for a token the feed does not list, not the store $1 default', () => {
    mockStoreState = { tokenPrices: { BTC: { price: 50000 } } };
    setBalances([XYZ]);
    const { onSelect } = renderDrawer();

    fireEvent.click(screen.getByTestId('send-token-XYZ'));

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 't-xyz', fiatPrice: 0 }));
  });

  it('forwards the sheet onOpenChange handler to the drawer', () => {
    setBalances([BTC]);
    const { onOpenChange } = renderDrawer();

    fireEvent.click(screen.getByTestId('drawer-openchange'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reads tokenPrices from the wallet store and hands them to each row', () => {
    // The store selector runs against our slice; a non-empty prices map must
    // not change filtering/rendering, but exercises the selector path.
    mockStoreState = { tokenPrices: { BTC: { price: 1 } } };
    setBalances([BTC]);
    renderDrawer();

    const row = within(screen.getByTestId('drawer-content')).getByTestId('send-token-BTC');
    expect(row).toBeInTheDocument();
  });

  it('draws each row like the home assets list: 36px logo, name, balance and fiat value', () => {
    mockStoreState = { tokenPrices: { BTC: { price: 2 } } };
    setBalances([BTC]);
    renderDrawer();

    const row = screen.getByTestId('send-token-BTC');
    // No explicit size: the home asset row's 36px default.
    expect(within(row).getByTestId('token-logo')).not.toHaveAttribute('data-size');
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-faucet-id', BTC.tokenId);
    expect(within(row).getByText('Bitcoin')).toBeInTheDocument();
    expect(within(row).getByText('1.50 BTC')).toBeInTheDocument();
    expect(within(row).getByText('$3.00')).toBeInTheDocument();
  });

  it('shows no fiat for a token the price feed does not list, rather than a $1-default figure', () => {
    mockStoreState = { tokenPrices: { BTC: { price: 2 } } };
    setBalances([ETH]);
    renderDrawer();

    expect(within(screen.getByTestId('send-token-ETH')).queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it('values the native token at the nominal $1 with the nominal rate on, and hands the amount step that price', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    mockStoreState = { tokenPrices: { BTC: { price: 2 } } };
    setBalances([MIDEN]);
    const { onSelect } = renderDrawer();

    const row = screen.getByTestId('send-token-MIDEN');
    expect(within(row).getByText('$4.00')).toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 't-miden', fiatPrice: 1 }));
  });

  it('values a swap token at the asset it stands for and hands the amount step that price', () => {
    mockStoreState = { tokenPrices: { ETH: { price: 3 } } };
    setBalances([IETH]);
    const { onSelect } = renderDrawer();

    const row = screen.getByTestId('send-token-IETH');
    expect(within(row).getByText('$6.00')).toBeInTheDocument();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: TEST_TOKEN_IETH.faucetId, fiatPrice: 3 }));
  });

  it('stacks the rows unboxed at 72px, divided by a hairline like the home assets list', () => {
    setBalances([BTC, ETH]);
    renderDrawer();

    const list = screen.getByTestId('send-token-BTC').parentElement!;
    expect(list.className).toContain('divide-y');
    expect(list.className).toContain('divide-rule-default');
    expect(list.className).not.toContain('bg-fill');
    expect(list.className).not.toContain('rounded-2xl');
    expect(screen.getByTestId('send-token-ETH').className).toContain('h-18');
  });
});

describe('SelectTokenDrawer Testnet Epoch USDC sunset', () => {
  const LEGACY = {
    tokenId: TEST_MIDEN_USDC_FAUCET,
    metadata: { symbol: 'USDC', name: 'USDC', decimals: 6 },
    balance: 3,
    fiatPrice: 1
  };
  it('removes the legacy faucet from new send choices while keeping other assets', () => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    setBalances([LEGACY, BTC]);
    renderDrawer();
    expect(screen.queryByTestId('send-token-USDC')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-token-BTC')).toBeInTheDocument();
  });
  it('cannot bring the retired faucet back through search', () => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    setBalances([LEGACY]);
    renderDrawer();
    fireEvent.change(search(), { target: { value: 'epoch' } });
    expect(screen.queryByTestId('send-token-USDC')).not.toBeInTheDocument();
  });
  it('holds legacy choices while config loads and after it arrives', () => {
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null, status: 'loading' };
    setBalances([LEGACY]);
    renderDrawer();
    expect(screen.queryByTestId('send-token-USDC')).not.toBeInTheDocument();
    act(() => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      publishMockBridgeSnapshot();
    });
    expect(screen.queryByTestId('send-token-USDC')).not.toBeInTheDocument();
  });
  it('lists the native USDCx and holds the legacy row while no document has arrived', () => {
    const native = {
      tokenId: '0x4cbdcaffe75f0a317482224dae6436',
      metadata: { symbol: 'USDCX', name: 'USDCx', decimals: 6 },
      balance: 7,
      fiatPrice: 1
    };
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null, status: 'loading' };
    mockNativeFaucetId = native.tokenId;
    setBalances([LEGACY, native]);
    renderDrawer();
    expect(screen.getByTestId('send-token-USDCX')).toBeInTheDocument();
    expect(screen.queryByTestId('send-token-USDC')).not.toBeInTheDocument();
  });
  it('says why it holds a token back until the document arrives, and drops a retired one silently', () => {
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null, status: 'loading' };
    mockNativeFaucetId = MIDEN.tokenId;
    setBalances([LEGACY]);
    renderDrawer();
    expect(screen.getByTestId('send-picker-held-notice')).toHaveTextContent('sendTokenAvailabilityChecking');
    expect(screen.queryByTestId('send-token-USDC')).not.toBeInTheDocument();

    act(() => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      publishMockBridgeSnapshot();
    });

    expect(screen.queryByTestId('send-picker-held-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('send-token-USDC')).not.toBeInTheDocument();
  });
  it('leaves the same asset available off Testnet', () => {
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, network: 'devnet' };
    setBalances([LEGACY]);
    renderDrawer();
    expect(screen.getByTestId('send-token-USDC')).toBeInTheDocument();
  });
});

it('does not report the pending token availability warning as a user-visible error', async () => {
  jest.useFakeTimers();
  try {
    jest.mocked(reportUserVisibleError).mockClear();
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null, status: 'loading' };
    mockNativeFaucetId = MIDEN.tokenId;
    setBalances([{ ...BTC, tokenId: TEST_TOKEN_IETH.faucetId }]);
    renderDrawer();
    expect(screen.getByTestId('send-picker-held-notice')).toHaveTextContent('sendTokenAvailabilityChecking');
    expect(screen.getByTestId('send-picker-held-notice')).toHaveAttribute('data-tone', 'warning');

    await act(async () => jest.advanceTimersByTimeAsync(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
