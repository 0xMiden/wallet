import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { BridgeNetwork } from 'screens/send-flow/bridge-networks';

import { EvmBridgeNetworkDrawer } from './EvmBridgeNetworkDrawer';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}));
jest.mock('components/NetworkChip', () => ({
  NetworkLogo: () => <span data-testid="network-logo" />
}));

const ARC: BridgeNetwork = { id: 'arc-testnet', name: 'Arc Testnet', chainId: 5042002 };
const SEPOLIA: BridgeNetwork = { id: 'sepolia', name: 'Sepolia', chainId: 11155111 };

describe('EvmBridgeNetworkDrawer', () => {
  it('lists every source network, marks the chosen one and reports a tap', () => {
    const onSelect = jest.fn();
    render(
      <EvmBridgeNetworkDrawer
        open
        onOpenChange={jest.fn()}
        networks={[ARC, SEPOLIA]}
        selected={ARC}
        onSelect={onSelect}
      />
    );

    expect(screen.getByText('selectNetwork')).toBeInTheDocument();
    expect(screen.getByTestId('bridge-network-arc-testnet')).toHaveTextContent('Arc Testnet');
    expect(screen.getByTestId('bridge-network-sepolia')).toHaveTextContent('Sepolia');

    fireEvent.click(screen.getByTestId('bridge-network-sepolia'));
    expect(onSelect).toHaveBeenCalledWith(SEPOLIA);
  });
});
