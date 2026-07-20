import React from 'react';

import { render, screen, fireEvent, within } from '@testing-library/react';

import { SelectTokenDrawer } from './SelectToken';
import { UIToken } from './types';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert against the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

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

// vaul drawer — render children plus a probe button so we can fire the
// `onOpenChange` the component wires to the sheet, and surface `open`.
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
      <button data-testid="drawer-openchange" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2 data-testid="drawer-title">{children}</h2>
}));

// `components/ui` barrel — stub SearchInput to a controlled input so typing
// drives the component's `onChange(value)` contract directly.
jest.mock('components/ui', () => ({
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

// `components/AssetRow` wraps TokenLogo + sparkline + price plumbing; stub it to
// a button that surfaces the symbol and forwards the click so we can assert the
// UIToken the drawer builds on select.
jest.mock('components/AssetRow', () => ({
  AssetRow: ({
    asset,
    onClick,
    'data-testid': dataTestId
  }: {
    asset: { metadata: { symbol: string } };
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button data-testid={dataTestId} onClick={onClick}>
      {asset.metadata.symbol}
    </button>
  )
}));

type Balance = {
  tokenId: string;
  metadata: { symbol: string; name?: string; decimals: number };
  balance: number;
  fiatPrice: number;
};

const BTC: Balance = {
  tokenId: 't-btc',
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
  mockUseAccount.mockReturnValue({ publicKey: 'pk-abc' });
  mockUseAllTokensBaseMetadata.mockReturnValue({});
  mockUseAllBalances.mockReturnValue({ data: [] });
  mockStoreState = { tokenPrices: {} };
});

describe('SelectTokenDrawer', () => {
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

  it('builds the UIToken, resets the search and closes the drawer on select', () => {
    setBalances([BTC, ETH]);
    const { onSelect, onOpenChange } = renderDrawer();

    // Narrow the list first so we can prove the query is cleared afterwards.
    fireEvent.change(search(), { target: { value: 'btc' } });
    expect(search()).toHaveValue('btc');
    expect(screen.queryByTestId('send-token-ETH')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('send-token-BTC'));

    const expected: UIToken = { id: 't-btc', name: 'BTC', decimals: 8, balance: 1.5, fiatPrice: 50000 };
    expect(onSelect).toHaveBeenCalledWith(expected);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Search reset back to empty, so both tokens are visible again.
    expect(search()).toHaveValue('');
    expect(screen.getByTestId('send-token-BTC')).toBeInTheDocument();
    expect(screen.getByTestId('send-token-ETH')).toBeInTheDocument();
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
});
