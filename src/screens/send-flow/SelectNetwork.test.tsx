import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SelectNetworkDrawer } from './SelectNetwork';

jest.mock('lib/epoch', () => ({
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL: 'USDC',
  EPOCH_DESTINATION_CHAIN_ID: 11155111
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

describe('SelectNetworkDrawer', () => {
  it('lists Miden and configured EVM networks and closes after selection', () => {
    const onOpenChange = jest.fn();
    const onSelect = jest.fn();

    render(<SelectNetworkDrawer open onOpenChange={onOpenChange} onSelect={onSelect} selectedNetwork={undefined} />);

    const sepolia = screen.getByTestId('send-network-sepolia');
    expect(screen.getByTestId('send-network-miden-option')).toBeInTheDocument();
    expect(screen.getByTestId('send-network-sepolia-logo')).toBeInTheDocument();
    expect(sepolia).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(sepolia);

    expect(onSelect).toHaveBeenCalledWith('sepolia');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('marks the selected network', () => {
    render(<SelectNetworkDrawer open onOpenChange={jest.fn()} onSelect={jest.fn()} selectedNetwork="sepolia" />);

    expect(screen.getByTestId('send-network-sepolia')).toHaveAttribute('aria-pressed', 'true');
  });
});
