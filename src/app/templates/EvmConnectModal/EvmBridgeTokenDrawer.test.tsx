import React from 'react';

import { render, screen, within } from '@testing-library/react';

import { EvmBridgeTokenDrawer } from './EvmBridgeTokenDrawer';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => (
    <span data-testid="token-logo" data-faucet={faucetId} />
  )
}));

const ETH_FAUCET = '0x1111111111111111111111111111aa';
const USDCX_FAUCET = '0x2222222222222222222222222222bb';

const renderDrawer = () =>
  render(
    <EvmBridgeTokenDrawer
      open
      onOpenChange={jest.fn()}
      selected="CIRCLE_USDC"
      ethBalance="0.5"
      ethFaucetId={ETH_FAUCET}
      circleUsdcBalance="12"
      circleUsdcFaucetId={USDCX_FAUCET}
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

  it("draws each Epoch token after Circle USDC, with its Miden faucet's logo, and picks it as an Epoch token", () => {
    const onSelect = jest.fn();
    render(
      <EvmBridgeTokenDrawer
        open
        onOpenChange={jest.fn()}
        selected="CIRCLE_USDC"
        circleUsdcBalance="12"
        epochRows={[
          {
            key: 'POL',
            address: '0x0000000000000000000000000000000000000000',
            midenFaucetId: '0xa5b56b51edbda2514c711385dc6f31',
            name: 'POL',
            balance: '3'
          }
        ]}
        onSelect={onSelect}
      />
    );

    expect(screen.getAllByRole('button').map(row => row.getAttribute('data-testid'))).toEqual([
      'bridge-token-CIRCLE_USDC',
      'bridge-token-EPOCH_POL'
    ]);
    const row = screen.getByTestId('bridge-token-EPOCH_POL');
    expect(within(row).getByText('3 POL')).toBeInTheDocument();
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-faucet', '0xa5b56b51edbda2514c711385dc6f31');
    row.click();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'epoch', key: 'POL' });
  });

  it('offers Circle USDC under its symbol with the logo of the USDCx faucet it arrives in', () => {
    renderDrawer();

    const row = screen.getByTestId('bridge-token-CIRCLE_USDC');
    expect(within(row).getByText('USDC')).toBeInTheDocument();
    expect(within(row).getByText('12 USDC')).toBeInTheDocument();
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-faucet', USDCX_FAUCET);
  });

  it('leaves the ETH row on its symbol, with the logo of the faucet AggLayer delivers ETH into', () => {
    renderDrawer();

    const row = screen.getByTestId('bridge-token-ETH');
    expect(within(row).getByText('ETH')).toBeInTheDocument();
    expect(within(row).getByText('0.5 ETH')).toBeInTheDocument();
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-faucet', ETH_FAUCET);
  });

  it('draws each offered ERC-20 after ETH and Circle USDC, keyed by address, with its own logo and balance', () => {
    const onSelect = jest.fn();
    const wbtc = {
      symbol: 'WBTC',
      contractAddress: '0x21472df1b5d2b673f6444b41258c6460294a2c06' as const,
      decimals: 8,
      delivery: { midenFaucetId: '0x36bb3163d7ef0ad102f35bf507c61e', scale: 0 }
    };
    render(
      <EvmBridgeTokenDrawer
        open
        onOpenChange={jest.fn()}
        selected={{ kind: 'erc20', contractAddress: wbtc.contractAddress }}
        ethBalance="0.5"
        circleUsdcBalance="12"
        erc20Rows={[
          { token: wbtc, name: 'WBTC', balance: '1.5' },
          {
            token: { symbol: 'BUG', contractAddress: '0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956', decimals: 18 },
            name: 'BUG',
            balance: '0',
            loading: true
          }
        ]}
        onSelect={onSelect}
      />
    );

    expect(screen.getAllByRole('button').map(row => row.getAttribute('data-testid'))).toEqual([
      'bridge-token-ETH',
      'bridge-token-CIRCLE_USDC',
      `bridge-token-ERC20_${wbtc.contractAddress}`,
      'bridge-token-ERC20_0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956'
    ]);
    const row = screen.getByTestId(`bridge-token-ERC20_${wbtc.contractAddress}`);
    expect(within(row).getByText('1.5 WBTC')).toBeInTheDocument();
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-faucet', wbtc.delivery.midenFaucetId);
    // BUG has no faucet until its first deposit, so its row asks for no logo and draws the default.
    expect(
      within(screen.getByTestId('bridge-token-ERC20_0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956')).getByTestId(
        'token-logo'
      )
    ).not.toHaveAttribute('data-faucet');
    expect(
      within(screen.getByTestId('bridge-token-ERC20_0x22939b3a4dfd9fc6211f99cdc6bd9f6708ae2956')).getByText('loading')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('bridge-token-list-unavailable')).not.toBeInTheDocument();

    row.click();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'erc20', contractAddress: wbtc.contractAddress });
  });

  it('says when the token list could not be read instead of showing a shorter list', () => {
    render(
      <EvmBridgeTokenDrawer
        open
        onOpenChange={jest.fn()}
        selected="ETH"
        ethBalance="0.5"
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
