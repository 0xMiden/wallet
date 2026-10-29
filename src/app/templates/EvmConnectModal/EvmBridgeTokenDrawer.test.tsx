import React from 'react';

import { render, screen, within } from '@testing-library/react';

import { EvmBridgeTokenDrawer, type OfferedErc20 } from './EvmBridgeTokenDrawer';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ symbol }: { symbol: string }) => <span data-testid="token-logo" data-symbol={symbol} />
}));

const renderDrawer = () =>
  render(
    <EvmBridgeTokenDrawer
      open
      onOpenChange={jest.fn()}
      selected="CIRCLE_USDC"
      ethBalance="0.5"
      ethBalanceValue={500000000000000000n}
      circleUsdcBalance="12"
      onSelect={jest.fn()}
    />
  );

describe('EvmBridgeTokenDrawer', () => {
  it('offers Circle USDC and ETH, and no retired Epoch USDC row', () => {
    renderDrawer();

    expect(screen.getAllByRole('button').map(row => row.getAttribute('data-testid'))).toEqual([
      'bridge-token-ETH',
      'bridge-token-CIRCLE_USDC'
    ]);
    expect(screen.queryByTestId('bridge-token-USDC')).not.toBeInTheDocument();
  });

  it('offers Circle USDC under its symbol with the USDC logo', () => {
    renderDrawer();

    const row = screen.getByTestId('bridge-token-CIRCLE_USDC');
    expect(within(row).getByText('USDC')).toBeInTheDocument();
    expect(within(row).getByText('12 USDC')).toBeInTheDocument();
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
  });

  it('leaves the ETH row on its symbol', () => {
    renderDrawer();

    const row = screen.getByTestId('bridge-token-ETH');
    expect(within(row).getByText('ETH')).toBeInTheDocument();
    expect(within(row).getByText('0.5 ETH')).toBeInTheDocument();
  });

  it('draws each offered ERC-20 after ETH and Circle USDC, keyed by address, with its own logo and balance', () => {
    const onSelect = jest.fn();
    const wbtc: OfferedErc20 = {
      symbol: 'WBTC',
      contractAddress: '0x21472df1b5d2b673f6444b41258c6460294a2c06',
      decimals: 8,
      delivery: { midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e', scale: 0 }
    };
    render(
      <EvmBridgeTokenDrawer
        open
        onOpenChange={jest.fn()}
        selected={{ kind: 'erc20', contractAddress: wbtc.contractAddress }}
        ethBalance="0.5"
        ethBalanceValue={500000000000000000n}
        circleUsdcBalance="12"
        erc20Rows={[
          { token: wbtc, name: 'WBTC', balance: '1.5', value: 150000000n },
          {
            token: { symbol: 'BUG', contractAddress: '0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956', decimals: 18 },
            name: 'BUG',
            balance: '0',
            value: null,
            loading: true
          }
        ]}
        onSelect={onSelect}
      />
    );

    expect(screen.getAllByRole('button').map(row => row.getAttribute('data-testid'))).toEqual([
      'bridge-token-ETH',
      'bridge-token-CIRCLE_USDC',
      `bridge-token-ERC20_${wbtc.contractAddress}`
    ]);
    const row = screen.getByTestId(`bridge-token-ERC20_${wbtc.contractAddress}`);
    expect(within(row).getByText('1.5 WBTC')).toBeInTheDocument();
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-symbol', 'WBTC');
    expect(
      screen.queryByTestId('bridge-token-ERC20_0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('loading');
    expect(screen.queryByTestId('bridge-token-list-unavailable')).not.toBeInTheDocument();

    row.click();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'erc20', contractAddress: wbtc.contractAddress });
  });

  it('hides zero and unavailable balances but keeps a positive balance that displays as zero', () => {
    const token: OfferedErc20 = {
      symbol: 'WBTC',
      contractAddress: '0x21472df1b5d2b673f6444b41258c6460294a2c06',
      decimals: 8
    };
    const props = {
      open: true,
      onOpenChange: jest.fn(),
      selected: 'ETH',
      ethBalance: '0',
      ethBalanceValue: 0n,
      onSelect: jest.fn()
    } satisfies React.ComponentProps<typeof EvmBridgeTokenDrawer>;
    const { rerender } = render(
      <EvmBridgeTokenDrawer {...props} erc20Rows={[{ token, name: 'WBTC', balance: '0', value: 0n }]} />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('bridgeDepositNoTokenBalance');

    rerender(<EvmBridgeTokenDrawer {...props} erc20Rows={[{ token, name: 'WBTC', balance: '0', value: null }]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <EvmBridgeTokenDrawer
        {...props}
        ethBalanceValue={1n}
        erc20Rows={[{ token, name: 'WBTC', balance: '0', value: 1n }]}
      />
    );
    expect(screen.getByTestId('bridge-token-ETH')).toBeInTheDocument();
    expect(screen.getByTestId(`bridge-token-ERC20_${token.contractAddress}`)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps Circle USDC available at zero balance', () => {
    render(
      <EvmBridgeTokenDrawer
        open
        onOpenChange={jest.fn()}
        selected="CIRCLE_USDC"
        circleUsdcBalance="0"
        onSelect={jest.fn()}
      />
    );
    expect(screen.getByTestId('bridge-token-CIRCLE_USDC')).toBeInTheDocument();
  });

  it('puts the token rows in an inner scroll area', () => {
    renderDrawer();
    const body = screen.getByTestId('bridge-token-scroll');
    expect(body).toHaveClass('min-h-0', 'overflow-y-auto', 'overscroll-contain');
    expect(within(body).getByTestId('bridge-token-ETH')).toBeInTheDocument();
    expect(within(body).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('says when the token list could not be read instead of showing a shorter list', () => {
    render(
      <EvmBridgeTokenDrawer
        open
        onOpenChange={jest.fn()}
        selected="ETH"
        ethBalance="0.5"
        ethBalanceValue={500000000000000000n}
        erc20Rows={[]}
        erc20Unavailable
        onSelect={jest.fn()}
      />
    );

    expect(screen.getByTestId('bridge-token-list-unavailable')).toHaveTextContent('bridgeDepositTokensUnavailable');
  });

  // A mainnet document names no AggLayer chain and no Epoch test USDC: Circle's USDC is the one token, and the
  // Epoch USDC is not a token there at all.
  it('lists only Circle USDC when the host offers no ETH and no Epoch USDC', () => {
    render(
      <EvmBridgeTokenDrawer
        open
        onOpenChange={jest.fn()}
        selected="CIRCLE_USDC"
        circleUsdcBalance="3"
        circleUsdcLabel="USDC"
        onSelect={jest.fn()}
      />
    );

    expect(screen.queryByTestId('bridge-token-ETH')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bridge-token-USDC')).not.toBeInTheDocument();
    const row = screen.getByTestId('bridge-token-CIRCLE_USDC');
    expect(within(row).getByText('3 USDC')).toBeInTheDocument();
  });
});
