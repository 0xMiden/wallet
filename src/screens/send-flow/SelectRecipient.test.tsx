import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SelectRecipient, SelectRecipientProps } from './SelectRecipient';

jest.mock('lib/epoch', () => ({
  BRIDGEABLE_EVM_OUTPUT_TOKEN_SYMBOL: 'USDC',
  EPOCH_DESTINATION_CHAIN_ID: 11155111
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const ETH_ADDRESS = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const MIDEN_ADDRESS = 'mtst1recipient';

jest.mock('./bridge-networks', () => ({
  BRIDGE_OUTPUT_TOKEN_SYMBOL: 'USDC',
  getBridgeNetwork: (id: string | undefined) =>
    id === 'sepolia' ? { id: 'sepolia', name: 'Sepolia', chainId: 11155111 } : undefined
}));

// `components/Button` pulls in framer-motion, Capacitor haptics and the icon
// barrel transitively. We stub it with a plain <button> that still renders
// `iconLeft` (so the internal AddressBookIcon SVG is exercised) and forwards
// onClick/disabled/className/data-testid, keeping the test focused on
// SelectRecipient's own branches.
jest.mock('components/Button', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost' },
    Button: ({ variant: _variant, title, iconLeft, children, ...rest }: any) =>
      ReactMock.createElement('button', { type: 'button', ...rest }, iconLeft, children ?? title)
  };
});

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
  it('hides the network selector before an address is entered', () => {
    renderRecipient();

    expect(screen.queryByTestId('send-network-selector')).not.toBeInTheDocument();
  });

  it('uses the chain-aware address placeholder and leaves unknown recipients plain', () => {
    renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum', onScan: jest.fn() });

    expect(screen.getByTestId('send-recipient-input')).toHaveAttribute(
      'placeholder',
      'Enter Miden or Ethereum Address'
    );
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

  it('hides the network selector for an incomplete EVM address', () => {
    renderRecipient({ address: '0x1234', isValidAddress: false, chain: 'ethereum' });

    expect(screen.queryByTestId('send-network-selector')).not.toBeInTheDocument();
  });

  it('enables EVM confirmation after Sepolia is selected', () => {
    renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum', network: 'sepolia' });

    expect(screen.getByText('Sepolia')).toBeInTheDocument();
    expect(screen.getByTestId('send-recipient-confirm')).toBeEnabled();
  });

  it('hides the network block and allows a valid Miden recipient', () => {
    renderRecipient({ address: MIDEN_ADDRESS, isValidAddress: true, chain: 'miden' });

    expect(screen.queryByTestId('send-network-selector')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-recipient-confirm')).toBeEnabled();
  });
});

describe('SelectRecipient — recent recipients', () => {
  const RECENTS = [
    { address: 'mtst1recent_alice', name: 'Alice', chain: 'miden' as const },
    { address: ETH_ADDRESS, chain: 'ethereum' as const, networkName: 'Sepolia' },
    { address: '0x1111111111111111111111111111111111111111', chain: 'ethereum' as const }
  ];

  it('lists recents with names, chain badges and a network fallback, and fills on tap', () => {
    const onSelectRecent = jest.fn();
    renderRecipient({ recents: RECENTS, onSelectRecent });

    expect(screen.getByText('recent')).toBeInTheDocument();
    expect(screen.getAllByTestId('send-recent-recipient')).toHaveLength(3);

    // A saved contact shows its name; an unknown address falls back to the truncated form.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // Miden rows get the badge, EVM rows show the network name (falling back to Ethereum).
    expect(screen.getByText('miden')).toBeInTheDocument();
    expect(screen.getByText('Sepolia')).toBeInTheDocument();
    expect(screen.getByText('ethereum')).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId('send-recent-recipient')[0]!);
    expect(onSelectRecent).toHaveBeenCalledWith(RECENTS[0]);
  });

  it('hides the recents section once an address is entered', () => {
    renderRecipient({ recents: RECENTS, address: MIDEN_ADDRESS });

    expect(screen.queryByTestId('send-recent-recipients')).not.toBeInTheDocument();
  });

  it('renders nothing when there are no recent sends', () => {
    renderRecipient({ recents: [] });

    expect(screen.queryByTestId('send-recent-recipients')).not.toBeInTheDocument();
  });
});

describe('SelectRecipient — add to contacts', () => {
  it('offers to save an unknown valid recipient and opens the add-contact sheet', () => {
    const onAddContact = jest.fn();
    const props = renderRecipient({
      address: MIDEN_ADDRESS,
      isValidAddress: true,
      canAddContact: true,
      onAddContact
    });

    expect(screen.getByText('addToContactsPrompt')).toBeInTheDocument();
    expect(screen.queryByText('addressBook')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('send-address-book'));
    expect(onAddContact).toHaveBeenCalledTimes(1);
    expect(props.onAddressBook).not.toHaveBeenCalled();
  });

  it('keeps the address book pill for a known contact', () => {
    const props = renderRecipient({
      address: MIDEN_ADDRESS,
      isValidAddress: true,
      recipientName: 'Alice',
      onAddContact: jest.fn()
    });

    expect(screen.getByText('addressBook')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-address-book'));
    expect(props.onAddressBook).toHaveBeenCalledTimes(1);
  });

  it('falls back to the address book when no add-contact handler is wired', () => {
    const props = renderRecipient({ address: MIDEN_ADDRESS, isValidAddress: true, canAddContact: true });

    expect(screen.getByText('addressBook')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-address-book'));
    expect(props.onAddressBook).toHaveBeenCalledTimes(1);
  });
});

describe('SelectRecipient — mobile keyboard (regression)', () => {
  it('labels the return key Done on the address field', () => {
    renderRecipient();
    expect(screen.getByTestId('send-recipient-input').getAttribute('enterkeyhint')).toBe('done');
  });

  it('Enter dismisses the keyboard instead of inserting a newline', () => {
    renderRecipient({ address: MIDEN_ADDRESS });
    const textarea = screen.getByTestId('send-recipient-input') as HTMLTextAreaElement;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    // fireEvent returns false when the handler called preventDefault (no newline).
    const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(notPrevented).toBe(false);
    expect(document.activeElement).not.toBe(textarea);
  });

  it('has a navbar cushion on the confirm footer so it snugs up when the navbar hides', () => {
    renderRecipient();
    const footer = screen.getByTestId('send-recipient-confirm').parentElement;
    expect(footer?.getAttribute('data-navbar-cushion')).toBe('true');
  });
});
