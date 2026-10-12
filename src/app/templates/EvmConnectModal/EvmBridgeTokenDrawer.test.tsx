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
  TokenLogo: ({ symbol }: { symbol: string }) => <span data-testid="token-logo" data-symbol={symbol} />
}));

const renderDrawer = (usdcLabel: string) =>
  render(
    <EvmBridgeTokenDrawer
      open
      onOpenChange={jest.fn()}
      selected="USDC"
      ethBalance="0.5"
      usdcBalance="12"
      usdcLabel={usdcLabel}
      onSelect={jest.fn()}
    />
  );

describe('EvmBridgeTokenDrawer', () => {
  it('names the USDC row by the label it is given, keeping its test id and logo on USDC', () => {
    renderDrawer('Test Epoch USDC');

    const row = screen.getByTestId('bridge-token-USDC');
    expect(within(row).getByText('Test Epoch USDC')).toBeInTheDocument();
    expect(within(row).getByText('12 Test Epoch USDC')).toBeInTheDocument();
    expect(within(row).getByTestId('token-logo')).toHaveAttribute('data-symbol', 'USDC');
  });

  it('leaves the ETH row on its symbol', () => {
    renderDrawer('Test Epoch USDC');

    const row = screen.getByTestId('bridge-token-ETH');
    expect(within(row).getByText('ETH')).toBeInTheDocument();
    expect(within(row).getByText('0.5 ETH')).toBeInTheDocument();
  });
});
