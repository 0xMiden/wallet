import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SelectRecipient, SelectRecipientProps } from './SelectRecipient';

jest.mock('lib/epoch', () => ({
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL: 'USDC',
  EPOCH_DESTINATION_CHAIN_ID: 11155111
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (key === 'enterAddress' ? 'Enter Address' : key) })
}));

const ETH_ADDRESS = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const MIDEN_ADDRESS = 'mtst1recipient';

function renderRecipient(overrides: Partial<SelectRecipientProps> = {}) {
  const props: SelectRecipientProps = {
    address: '',
    isValidAddress: false,
    chain: 'miden',
    onAddressChange: jest.fn(),
    onAddressBook: jest.fn(),
    onSelectNetwork: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides
  };

  render(<SelectRecipient {...props} />);
  return props;
}

describe('SelectRecipient', () => {
  it('shows Choose Network before an address is entered', () => {
    const props = renderRecipient();

    expect(screen.getByTestId('send-network-selector')).toHaveTextContent('Choose Network');
    expect(screen.queryByTestId('send-network-miden')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-network-selector'));
    expect(props.onSelectNetwork).toHaveBeenCalledTimes(1);
  });

  it('uses the Enter Address placeholder and leaves unknown recipients plain', () => {
    renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum', onScan: jest.fn() });

    expect(screen.getByTestId('send-recipient-input')).toHaveAttribute('placeholder', 'Enter Address');
    expect(screen.queryByTestId('send-recipient-avatar')).not.toBeInTheDocument();
    expect(screen.queryByText('Scan QR Code')).not.toBeInTheDocument();
  });

  it('shows Scan QR Code with extracted icons and compact action pills while the address field is empty', () => {
    renderRecipient({ onScan: jest.fn() });

    expect(screen.getByText('Scan QR Code')).toBeInTheDocument();
    expect(screen.getByTestId('send-address-book-icon')).toBeInTheDocument();
    expect(screen.getByTestId('send-scan-icon')).toBeInTheDocument();
    expect(screen.getByText('addressBook').closest('button')).toHaveClass(
      'h-auto!',
      'px-2!',
      'py-1!',
      'bg-surface-interactive!'
    );
    expect(screen.getByText('Scan QR Code').closest('button')).toHaveClass(
      'h-auto!',
      'px-2!',
      'py-1!',
      'bg-surface-interactive!'
    );
  });

  it('shows the saved contact identity when a recipient name is provided', () => {
    renderRecipient({
      address: ETH_ADDRESS,
      isValidAddress: true,
      chain: 'ethereum',
      recipientName: 'Charlie'
    });

    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.getByTestId('send-recipient-avatar')).toBeInTheDocument();
  });

  it('requires an EVM network and opens the network picker', () => {
    const props = renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum' });

    expect(screen.getByTestId('send-recipient-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('send-network-selector'));
    expect(props.onSelectNetwork).toHaveBeenCalledTimes(1);
  });

  it('enables EVM confirmation after Sepolia is selected', () => {
    renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum', network: 'sepolia' });

    expect(screen.getByText('Sepolia')).toBeInTheDocument();
    expect(screen.getByTestId('send-recipient-confirm')).toBeEnabled();
  });

  it('shows Miden as a static network and allows a valid Miden recipient', () => {
    renderRecipient({ address: MIDEN_ADDRESS, isValidAddress: true, chain: 'miden' });

    expect(screen.getByTestId('send-network-miden')).toBeInTheDocument();
    expect(screen.queryByTestId('send-network-selector')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-recipient-confirm')).toBeEnabled();
  });
});
