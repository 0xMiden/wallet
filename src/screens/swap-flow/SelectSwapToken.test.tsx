import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import { SelectSwapTokenDrawer } from './SelectSwapToken';

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and we can assert against the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `lib/mobile/haptics` reaches for the Capacitor Haptics plugin; stub the one
// helper the component fires so we can assert selection triggers feedback.
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
};
const mockGetSwapTokens = jest.fn<SwapToken[], []>(() => []);
jest.mock('lib/miden/swap/tokens', () => ({
  getSwapTokens: () => mockGetSwapTokens()
}));

// `components/TokenLogo` renders inline SVG logos; stub it to a probe that
// surfaces the `symbol`/`size` props the component passes through.
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol, size }: { symbol: string; size?: string }) => (
    <span data-testid="token-logo" data-symbol={symbol} data-size={size} />
  )
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

const IMIDEN: SwapToken = { symbol: 'IMIDEN', faucetId: 'fid-miden', decimals: 8, logoSymbol: 'MIDEN' };
const IETH: SwapToken = { symbol: 'IETH', faucetId: 'fid-eth', decimals: 8, logoSymbol: 'ETH' };
const IBTC: SwapToken = { symbol: 'IBTC', faucetId: 'fid-btc', decimals: 8, logoSymbol: 'BTC' };

const setTokens = (tokens: SwapToken[]) => {
  mockGetSwapTokens.mockReturnValue(tokens);
};

const renderDrawer = (overrides: Partial<React.ComponentProps<typeof SelectSwapTokenDrawer>> = {}) => {
  const onOpenChange = jest.fn();
  const onSelect = jest.fn();
  const utils = render(<SelectSwapTokenDrawer open onOpenChange={onOpenChange} onSelect={onSelect} {...overrides} />);
  return { onOpenChange, onSelect, ...utils };
};

const tokenButton = (symbol: string) => screen.getByTestId(`swap-token-${symbol}`);
// The selected-side indicator is an unlabeled `bg-primary-500` dot inside the row.
const selectedDot = (symbol: string) => tokenButton(symbol).querySelector('.bg-primary-500');

beforeEach(() => {
  jest.clearAllMocks();
  setTokens([IMIDEN, IETH, IBTC]);
});

describe('SelectSwapTokenDrawer', () => {
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
    // `logoSymbol` (not `symbol`) drives the logo, and the row uses the md size.
    expect(logo).toHaveAttribute('data-symbol', 'ETH');
    expect(logo).toHaveAttribute('data-size', 'md');
  });

  it('marks only the row matching currentFaucetId as selected', () => {
    renderDrawer({ currentFaucetId: 'fid-eth' });

    expect(selectedDot('IETH')).toBeInTheDocument();
    expect(selectedDot('IMIDEN')).toBeNull();
    expect(selectedDot('IBTC')).toBeNull();
  });

  it('renders no selected indicator when currentFaucetId is undefined', () => {
    renderDrawer();

    expect(selectedDot('IMIDEN')).toBeNull();
    expect(selectedDot('IETH')).toBeNull();
    expect(selectedDot('IBTC')).toBeNull();
  });

  it('renders no selected indicator when currentFaucetId matches no token', () => {
    renderDrawer({ currentFaucetId: 'fid-unknown' });

    expect(document.querySelector('.bg-primary-500')).toBeNull();
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
