import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

// Safe above the `jest.mock` calls below (which jest hoists anyway): every
// mock factory only *closes over* the `mock*` bindings, it never dereferences
// them at module-init time.
import { DepositArrivalDrawer } from './DepositArrivalDrawer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` — identity translator that folds interpolation values into
// the key so the interpolated title stays assertable.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${Object.values(params).join(' ')}` : key)
  })
}));

// Drawer — the real component renders through `vaul` portals; a passthrough
// stub keeps the children in the DOM and exposes `open` / `onOpenChange`.
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
      <button data-testid="drawer-close" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-content">{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-header">{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div data-testid="drawer-title">{children}</div>
}));

jest.mock('components/Button', () => ({
  Button: ({
    title,
    onClick,
    'data-testid': testId
  }: {
    title: string;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button data-testid={testId} onClick={onClick}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' }
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol }: { symbol: string }) => <span data-testid="token-logo" data-symbol={symbol} />
}));

const mockNavigate = jest.fn();
let mockLocation = { pathname: '/', search: '' };
jest.mock('lib/woozie', () => ({
  navigate: (to: string) => mockNavigate(to),
  useLocation: () => mockLocation
}));

let mockFlagEnabled = true;
jest.mock('lib/feature-flags', () => ({
  isDepositAddressBridgeEnabled: () => mockFlagEnabled
}));

interface MockArrival {
  key: string;
  address: string;
  token: 'ETH' | 'USDC';
  amount: bigint;
  balance: bigint;
  drawerShown: boolean;
}

const mockMarkDrawerShown = jest.fn(() => Promise.resolve());
let mockPendingDrawer: MockArrival | null = null;

interface MockStoreState {
  pendingDrawer: MockArrival | null;
  markDrawerShown: () => Promise<void>;
}

// Deep module paths, matching the component's imports (the barrel would drag
// the Epoch SDK into the module graph).
jest.mock('lib/deposit-bridge/store', () => ({
  useDepositAddressStore: <T,>(selector: (state: MockStoreState) => T): T =>
    selector({ pendingDrawer: mockPendingDrawer, markDrawerShown: mockMarkDrawerShown })
}));

jest.mock('lib/deposit-bridge/tokens', () => ({
  getDepositToken: (id: 'ETH' | 'USDC') =>
    id === 'ETH' ? { id, symbol: 'ETH', decimals: 18 } : { id, symbol: 'USDC', decimals: 18 }
}));

jest.mock('lib/deposit-bridge/balances', () => ({
  formatBalance: (value: bigint, decimals: number) => String(Number(value) / 10 ** decimals)
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ethArrival = (balance = 500000000000000000n, amount = 500000000000000000n): MockArrival => ({
  key: '0xabc:ETH',
  address: '0xabc',
  token: 'ETH',
  amount,
  balance,
  drawerShown: false
});

beforeEach(() => {
  mockNavigate.mockClear();
  mockMarkDrawerShown.mockClear();
  mockPendingDrawer = null;
  mockLocation = { pathname: '/', search: '' };
  mockFlagEnabled = true;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DepositArrivalDrawer', () => {
  it('renders nothing while there is no pending arrival', () => {
    render(<DepositArrivalDrawer />);
    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(mockMarkDrawerShown).not.toHaveBeenCalled();
  });

  it('opens on a pending arrival and shows amount, symbol and chain badge', () => {
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    expect(screen.getByTestId('drawer').getAttribute('data-open')).toBe('true');
    expect(screen.getByTestId('drawer-title').textContent).toBe('depositArrivalDrawerTitle:0.5 ETH');
    expect(screen.getByTestId('token-logo').getAttribute('data-symbol')).toBe('ETH');
    expect(screen.getByText('ethereumSepolia')).toBeTruthy();
  });

  it('marks the drawer shown exactly once per arrival balance', () => {
    mockPendingDrawer = ethArrival();
    const { rerender } = render(<DepositArrivalDrawer />);
    expect(mockMarkDrawerShown).toHaveBeenCalledTimes(1);
    expect(mockMarkDrawerShown).toHaveBeenCalledWith('ETH');

    // Same balance re-observed on a later poll — must not re-acknowledge.
    mockPendingDrawer = ethArrival();
    rerender(<DepositArrivalDrawer />);
    expect(mockMarkDrawerShown).toHaveBeenCalledTimes(1);

    // A larger deposit is a new balance value — re-opens and re-marks.
    mockPendingDrawer = ethArrival(900000000000000000n, 400000000000000000n);
    rerender(<DepositArrivalDrawer />);
    expect(mockMarkDrawerShown).toHaveBeenCalledTimes(2);
  });

  it('navigates to the pre-armed cross-chain bridge flow on "Bridge to Miden"', () => {
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    fireEvent.click(screen.getByTestId('deposit-arrival-bridge'));

    expect(mockNavigate).toHaveBeenCalledWith('/receive?tab=crosschain&bridge=1&token=ETH');
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('"Later" only closes — it never acknowledges the arrival', () => {
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    fireEvent.click(screen.getByTestId('deposit-arrival-later'));

    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The only store write is the once-per-balance show gate.
    expect(mockMarkDrawerShown).toHaveBeenCalledTimes(1);
  });

  it('closing via the drawer chrome also just closes', () => {
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    fireEvent.click(screen.getByTestId('drawer-close'));

    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(mockMarkDrawerShown).toHaveBeenCalledTimes(1);
  });

  it('is suppressed on the Receive cross-chain tab and does not consume the arrival', () => {
    mockLocation = { pathname: '/receive', search: '?tab=crosschain' };
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(mockMarkDrawerShown).not.toHaveBeenCalled();
  });

  it('still opens on the Receive Miden tab', () => {
    mockLocation = { pathname: '/receive', search: '' };
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    expect(screen.getByTestId('drawer')).toBeTruthy();
  });

  it('is suppressed on any generating-transaction route', () => {
    mockLocation = { pathname: '/generating-transaction/abc', search: '' };
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(mockMarkDrawerShown).not.toHaveBeenCalled();
  });

  it('renders nothing when the feature flag is off', () => {
    mockFlagEnabled = false;
    mockPendingDrawer = ethArrival();
    render(<DepositArrivalDrawer />);

    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(mockMarkDrawerShown).not.toHaveBeenCalled();
  });
});
