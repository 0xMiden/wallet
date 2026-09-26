import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { SelectSwapTokenDrawer } from './SelectSwapToken';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert against the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `lib/mobile/haptics` reaches for the Capacitor Haptics plugin; stub the one
// helper the row fires so we can assert selection triggers feedback.
const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: () => mockHapticLight()
}));

// `lib/miden/swap/tokens` transitively imports the WASM-backed SDK helpers;
// stub the live registry read so the token list is fully under test control.
type SwapToken = {
  symbol: string;
  faucetId: string;
  decimals: number;
  logoSymbol: string;
  priceSymbol?: string;
};
const mockGetSwapTokens = jest.fn<SwapToken[], []>(() => []);
jest.mock('lib/miden/swap/tokens', () => ({
  getSwapTokens: () => mockGetSwapTokens(),
  normalizedFaucetId: jest.requireActual('lib/miden/swap/tokens').normalizedFaucetId
}));

// `lib/miden/front` is the WASM-backed data barrel. Stub the three hooks the
// sheet consumes so we can drive account / balances / metadata by hand.
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

// `lib/store` is the zustand wallet store; the sheet only reads `tokenPrices`
// through a selector, so run the selector against a controllable slice.
let mockStoreState: { tokenPrices: Record<string, { price: number }> } = { tokenPrices: {} };
// Balances are keyed by the SDK's bech32 form of a faucet id; make that form visibly different.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => id,
  getBech32AddressFromAccountId: (id: string) => `bech32:${id}`
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState)
}));

// `components/TokenLogo` renders inline SVG logos; stub it to a probe that
// surfaces the `symbol`/`size` props the row passes through.
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size }: { symbol: string; size?: string }) => (
    <span data-testid="token-logo" data-symbol={symbol} data-size={size} />
  )
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

const IMIDEN: SwapToken = { symbol: 'IMIDEN', faucetId: 'fid-miden', decimals: 8, logoSymbol: 'MIDEN' };
const IETH: SwapToken = { symbol: 'IETH', faucetId: 'fid-eth', decimals: 8, logoSymbol: 'ETH', priceSymbol: 'ETH' };
const IBTC: SwapToken = { symbol: 'IBTC', faucetId: 'fid-btc', decimals: 8, logoSymbol: 'BTC', priceSymbol: 'BTC' };
// Drawn with the USDC logo, but the feed has no USDT price: its logo is no price.
const IUSDT: SwapToken = { symbol: 'IUSDT', faucetId: 'fid-usdt', decimals: 8, logoSymbol: 'USDC' };

type Balance = {
  tokenId: string;
  metadata: { symbol: string; decimals: number; scaleIsUnknown?: boolean };
  balance: number;
};

const setTokens = (tokens: SwapToken[]) => {
  mockGetSwapTokens.mockReturnValue(tokens);
};

const setBalances = (balances: Balance[]) => {
  mockUseAllBalances.mockReturnValue({ data: balances });
};

const renderDrawer = (overrides: Partial<React.ComponentProps<typeof SelectSwapTokenDrawer>> = {}) => {
  const onOpenChange = jest.fn();
  const onSelect = jest.fn();
  const utils = render(<SelectSwapTokenDrawer open onOpenChange={onOpenChange} onSelect={onSelect} {...overrides} />);
  return { onOpenChange, onSelect, ...utils };
};

const tokenButton = (symbol: string) => screen.getByTestId(`swap-token-${symbol}`);
// The selected side is the design system's round check (as `AssetListItem` draws it), not a loose
// dot, and the swap flow's own colour fills it (design-system.md, "Action colours").
const selectedCheck = (symbol: string) => tokenButton(symbol).querySelector('[data-slot="check"]');

beforeEach(() => {
  jest.clearAllMocks();
  setTokens([IMIDEN, IETH, IBTC]);
  mockUseAccount.mockReturnValue({ publicKey: 'pk-abc' });
  mockUseAllTokensBaseMetadata.mockReturnValue({});
  mockUseAllBalances.mockReturnValue({ data: [] });
  mockStoreState = { tokenPrices: {} };
});

describe('SelectSwapTokenDrawer', () => {
  it("leaves mobile back to SwapManager's handler, which closes the sheet", () => {
    renderDrawer();
    expect(mockDrawerCloseOnBack).toBe(false);
  });

  it('renders the open drawer with the localized title and one row per swap token', () => {
    renderDrawer();

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('drawer-title')).toHaveTextContent('selectAToken');

    expect(tokenButton('IMIDEN')).toBeInTheDocument();
    expect(tokenButton('IETH')).toBeInTheDocument();
    expect(tokenButton('IBTC')).toBeInTheDocument();
  });

  it('forwards `open={false}` through to the drawer', () => {
    renderDrawer({ open: false });

    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
  });

  it('renders each row with its logo symbol and label', () => {
    renderDrawer();

    const row = tokenButton('IETH');
    expect(within(row).getByText('IETH')).toBeInTheDocument();
    const logo = within(row).getByTestId('token-logo');
    // `logoSymbol` (not `symbol`) drives the logo, at the home asset row's 36px default size.
    expect(logo).toHaveAttribute('data-symbol', 'ETH');
    expect(logo).not.toHaveAttribute('data-size');
  });

  describe('balances', () => {
    it('passes the account public key and base metadata through to useAllBalances', () => {
      mockUseAccount.mockReturnValue({ publicKey: 'pk-999' });
      const metadata = { faucet: { symbol: 'M' } };
      mockUseAllTokensBaseMetadata.mockReturnValue(metadata);
      renderDrawer();

      expect(mockUseAllBalances).toHaveBeenCalledWith('pk-999', metadata);
    });

    it('shows the held balance of each token under its symbol', () => {
      setBalances([
        { tokenId: 'fid-eth', metadata: { symbol: 'IETH', decimals: 8 }, balance: 1.25 },
        { tokenId: 'fid-miden', metadata: { symbol: 'IMIDEN', decimals: 8 }, balance: 40 }
      ]);
      renderDrawer();

      expect(within(tokenButton('IETH')).getByText('1.25 IETH')).toBeInTheDocument();
      expect(within(tokenButton('IMIDEN')).getByText('40.00 IMIDEN')).toBeInTheDocument();
    });

    it('still lists a token the account holds nothing of, at zero', () => {
      setBalances([{ tokenId: 'fid-eth', metadata: { symbol: 'IETH', decimals: 8 }, balance: 1.25 }]);
      renderDrawer();

      expect(within(tokenButton('IBTC')).getByText('0.00 IBTC')).toBeInTheDocument();
    });

    it('defaults to zero balances when useAllBalances yields no data', () => {
      mockUseAllBalances.mockReturnValue({});
      renderDrawer();

      expect(within(tokenButton('IETH')).getByText('0.00 IETH')).toBeInTheDocument();
    });

    it('withholds the quantity of a held token whose decimals are the unknown placeholder', () => {
      setBalances([
        { tokenId: 'fid-eth', metadata: { symbol: 'IETH', decimals: 6, scaleIsUnknown: true }, balance: 1.25 }
      ]);
      renderDrawer();

      const row = tokenButton('IETH');
      expect(within(row).queryByText('1.25 IETH')).not.toBeInTheDocument();
      // Symbol twice: the row title and the amount line that stands in for the quantity.
      expect(within(row).getAllByText('IETH')).toHaveLength(2);
    });
  });

  it('finds a held balance keyed by the normalized faucet id', () => {
    setBalances([{ tokenId: 'bech32:fid-eth', metadata: { symbol: 'IETH', decimals: 8 }, balance: 1.25 }]);
    renderDrawer();

    expect(within(tokenButton('IETH')).getByText('1.25 IETH')).toBeInTheDocument();
  });

  describe('fiat value', () => {
    it('prices a swap token by the asset it stands for: IETH at the ETH price', () => {
      mockStoreState = { tokenPrices: { ETH: { price: 2 } } };
      setBalances([{ tokenId: 'fid-eth', metadata: { symbol: 'IETH', decimals: 8 }, balance: 1.25 }]);
      renderDrawer();

      expect(within(tokenButton('IETH')).getByText('$2.50')).toBeInTheDocument();
    });

    it('renders no fiat value for an unpriced DEX token rather than a $1-default figure', () => {
      setBalances([{ tokenId: 'fid-eth', metadata: { symbol: 'IETH', decimals: 8 }, balance: 1.25 }]);
      renderDrawer();

      expect(within(tokenButton('IETH')).queryByText(/^\$/)).not.toBeInTheDocument();
    });

    it('prices by the asset a token stands for, never by its logo: IUSDT shows no USDC value', () => {
      mockStoreState = { tokenPrices: { USDC: { price: 1 }, ETH: { price: 3000 } } };
      setTokens([IMIDEN, IETH, IUSDT, IBTC]);
      setBalances([
        { tokenId: 'fid-usdt', metadata: { symbol: 'IUSDT', decimals: 8 }, balance: 5 },
        { tokenId: 'fid-eth', metadata: { symbol: 'IETH', decimals: 8 }, balance: 2 }
      ]);
      renderDrawer();

      expect(within(tokenButton('IUSDT')).getByText('5.00 IUSDT')).toBeInTheDocument();
      expect(within(tokenButton('IUSDT')).queryByText(/^\$/)).not.toBeInTheDocument();
      expect(within(tokenButton('IETH')).getByText('$6000.00')).toBeInTheDocument();
    });

    it('renders no fiat for IMIDEN, whose asset the feed does not list', () => {
      mockStoreState = { tokenPrices: { ETH: { price: 2 }, MIDEN: undefined as unknown as { price: number } } };
      setBalances([{ tokenId: 'fid-miden', metadata: { symbol: 'IMIDEN', decimals: 8 }, balance: 3 }]);
      renderDrawer();

      expect(within(tokenButton('IMIDEN')).queryByText(/^\$/)).not.toBeInTheDocument();
    });

    it('never renders $0.00 for a priced token the account holds none of', () => {
      mockStoreState = { tokenPrices: { BTC: { price: 2 } } };
      renderDrawer();

      expect(within(tokenButton('IBTC')).queryByText('$0.00')).not.toBeInTheDocument();
    });
  });

  it('marks only the row matching currentFaucetId as selected', () => {
    renderDrawer({ currentFaucetId: 'fid-eth' });

    expect(selectedCheck('IETH')).toBeInTheDocument();
    expect(selectedCheck('IETH')).toHaveClass('bg-accent-swap');
    expect(tokenButton('IETH')).toHaveAttribute('aria-pressed', 'true');
    expect(selectedCheck('IMIDEN')).toBeNull();
    expect(selectedCheck('IBTC')).toBeNull();
  });

  it('renders no selected indicator when currentFaucetId is undefined', () => {
    renderDrawer();

    expect(selectedCheck('IMIDEN')).toBeNull();
    expect(selectedCheck('IETH')).toBeNull();
    expect(selectedCheck('IBTC')).toBeNull();
  });

  it('renders no selected indicator when currentFaucetId matches no token', () => {
    renderDrawer({ currentFaucetId: 'fid-unknown' });

    expect(document.querySelector('[data-slot="check"]')).toBeNull();
  });

  it('draws the rows like the home assets list: unboxed, 72px, divided by a hairline', () => {
    renderDrawer();

    const list = tokenButton('IMIDEN').parentElement!;
    expect(list.className).toContain('divide-y');
    expect(list.className).toContain('divide-rule-default');
    // Not the boxed list group: no fill card, no 16px radius around the rows.
    expect(list.className).not.toContain('bg-fill');
    expect(list.className).not.toContain('rounded-2xl');
    expect(tokenButton('IETH').className).toContain('h-18');
  });

  it('fires haptics, forwards the token and closes the drawer on select', () => {
    const { onSelect, onOpenChange } = renderDrawer({ currentFaucetId: 'fid-miden' });

    fireEvent.click(tokenButton('IBTC'));

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(IBTC);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('forwards the sheet onOpenChange handler to the drawer', () => {
    const { onOpenChange, onSelect } = renderDrawer();

    fireEvent.click(screen.getByTestId('drawer-openchange'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders drawer chrome but no rows when the registry is empty', () => {
    setTokens([]);
    renderDrawer();

    expect(screen.getByTestId('drawer-title')).toHaveTextContent('selectAToken');
    expect(screen.queryByTestId(/^swap-token-/)).not.toBeInTheDocument();
  });
});
