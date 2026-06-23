import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import Tokens from './Tokens';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'miden-faucet-id'
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: 'test-account' }),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: jest.fn()
}));

jest.mock('utils/string', () => ({
  truncateAddress: (addr: string) => addr.slice(0, 8)
}));

jest.mock('components/Avatar', () => ({
  Avatar: () => <div data-testid="avatar" />
}));

jest.mock('components/CardItem', () => ({
  CardItem: ({ title }: { title: string }) => <div data-testid="card-item">{title}</div>
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: () => <div data-testid="token-logo" />
}));

const mockGetTokenPrice = jest.fn();
jest.mock('lib/prices', () => ({
  getTokenPrice: (...args: unknown[]) => mockGetTokenPrice(...args)
}));

const mockUseAllBalances = jest.requireMock('lib/miden/front').useAllBalances;

describe('Tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default to a positive 24h change (green branch). Individual tests
    // override this to exercise the negative (red) branch.
    mockGetTokenPrice.mockReturnValue({ price: 1, percentageChange24h: 1 });
  });

  it('renders even when no balances are loaded yet', () => {
    mockUseAllBalances.mockReturnValue({
      data: [],
      isLoading: true
    });

    render(<Tokens />);

    // Component renders — no card items when empty
    expect(screen.queryAllByTestId('card-item').length).toBe(0);
  });

  it('renders token list when tokens are loaded with zero balance', () => {
    mockUseAllBalances.mockReturnValue({
      data: [
        {
          tokenId: 'token-1',
          balance: 0,
          metadata: { symbol: 'TKN', name: 'Token', decimals: 8 }
        }
      ],
      isLoading: false
    });

    render(<Tokens />);

    expect(screen.getByPlaceholderText('searchForToken')).toBeInTheDocument();
  });

  it('renders token list when tokens are loaded with positive balance', () => {
    mockUseAllBalances.mockReturnValue({
      data: [
        {
          tokenId: 'token-1',
          balance: 100,
          metadata: { symbol: 'TKN', name: 'Token', decimals: 8 }
        }
      ],
      isLoading: false
    });

    render(<Tokens />);

    expect(screen.getByPlaceholderText('searchForToken')).toBeInTheDocument();
  });

  it('renders when MIDEN token exists with zero balance (MIDEN is always present)', () => {
    mockUseAllBalances.mockReturnValue({
      data: [
        {
          tokenId: 'miden-faucet-id',
          balance: 0,
          metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 8 }
        }
      ],
      isLoading: false
    });

    render(<Tokens />);

    expect(screen.getByPlaceholderText('searchForToken')).toBeInTheDocument();
  });

  it('does not show skeleton loader - balances are displayed immediately from cache', () => {
    mockUseAllBalances.mockReturnValue({
      data: [],
      isLoading: true
    });

    const { container } = render(<Tokens />);

    // Skeleton loader was removed - balances are now shown immediately from IndexedDB cache
    expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument();
  });

  it('displays tokens without skeleton animation', () => {
    mockUseAllBalances.mockReturnValue({
      data: [
        {
          tokenId: 'token-1',
          balance: 100,
          metadata: { symbol: 'TKN', name: 'Token', decimals: 8 }
        }
      ],
      isLoading: false
    });

    const { container } = render(<Tokens />);

    expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument();
  });

  it('falls back to the symbol when a token has no name', () => {
    mockUseAllBalances.mockReturnValue({
      data: [
        {
          tokenId: 'token-noname',
          balance: 1,
          // No `name` — title should fall back to the symbol.
          metadata: { symbol: 'NONAME', decimals: 8 }
        }
      ],
      isLoading: false
    });

    render(<Tokens />);

    expect(screen.getByText('NONAME')).toBeInTheDocument();
  });

  it('renders a negative 24h price change (red branch)', () => {
    mockGetTokenPrice.mockReturnValue({ price: 1, percentageChange24h: -3.5 });
    mockUseAllBalances.mockReturnValue({
      data: [{ tokenId: 'token-1', balance: 100, metadata: { symbol: 'TKN', name: 'Token', decimals: 8 } }],
      isLoading: false
    });

    render(<Tokens />);

    expect(screen.getByText('Token')).toBeInTheDocument();
  });

  it('filters the token list by the search query (name and symbol)', () => {
    mockUseAllBalances.mockReturnValue({
      data: [
        // Including the MIDEN faucet in a multi-token list ensures the sort
        // comparator actually runs and hits its `=== midenFaucetId` branch.
        { tokenId: 'miden-faucet-id', balance: 0, metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 8 } },
        { tokenId: 'a', balance: 5, metadata: { symbol: 'AAA', name: 'Alpha', decimals: 8 } },
        { tokenId: 'b', balance: 5, metadata: { symbol: 'BBB', decimals: 8 } }
      ],
      isLoading: false
    });

    render(<Tokens />);

    // Both render before filtering.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('BBB')).toBeInTheDocument();

    // Search by name — only the matching token survives.
    fireEvent.change(screen.getByPlaceholderText('searchForToken'), { target: { value: 'alp' } });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('BBB')).not.toBeInTheDocument();

    // Search by symbol on the token that has no name (exercises the
    // optional-chained name match short-circuit and the symbol branch).
    fireEvent.change(screen.getByPlaceholderText('searchForToken'), { target: { value: 'bbb' } });
    expect(screen.getByText('BBB')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });
});
