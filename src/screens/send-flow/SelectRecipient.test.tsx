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

const mockBridgeNetworks = [{ id: 'sepolia', name: 'Sepolia', chainId: 11155111 }];
jest.mock('./bridge-networks', () => ({
  BRIDGE_OUTPUT_TOKEN_SYMBOL: 'USDC',
  get BRIDGE_NETWORKS() {
    return mockBridgeNetworks;
  },
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
    Button: ({ variant: _variant, accent, title, iconLeft, children, ...rest }: any) =>
      ReactMock.createElement('button', { type: 'button', 'data-accent': accent, ...rest }, iconLeft, children ?? title)
  };
});

function baseRecipientProps(overrides: Partial<SelectRecipientProps> = {}): SelectRecipientProps {
  return {
    address: '',
    isValidAddress: false,
    chain: 'miden',
    onAddressChange: jest.fn(),
    onAddressBook: jest.fn(),
    onSelectNetwork: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides
  };
}

function renderRecipient(overrides: Partial<SelectRecipientProps> = {}) {
  const props = baseRecipientProps(overrides);

  render(<SelectRecipient {...props} />);
  return props;
}

describe('SelectRecipient', () => {
  it('titles the step as the tab, with the entry below it on one row of pills that never wraps', () => {
    renderRecipient();
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveClass('text-title-tab');
    expect(screen.getByTestId('send-recipient-input')).toHaveClass('text-hero-name');
    const pills = screen.getByTestId('send-address-book').parentElement;
    expect(pills).toHaveClass('overflow-x-auto');
    expect(pills).not.toHaveClass('flex-wrap');
  });

  it('hides the network selector before an address is entered', () => {
    renderRecipient();

    expect(screen.queryByTestId('send-network-options')).not.toBeInTheDocument();
  });

  it('uses the chain-aware address placeholder and leaves unknown recipients plain', () => {
    renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum', onScan: jest.fn() });

    // Localised, like every other string on the page: the placeholder and the scan label used to
    // be English literals held in a `const`, which `lint:i18n` cannot see (it only reads JSX).
    expect(screen.getByTestId('send-recipient-input')).toHaveAttribute('placeholder', 'sendRecipientPlaceholder');
    expect(screen.queryByTestId('send-recipient-avatar')).not.toBeInTheDocument();
    expect(screen.queryByText('scanQrTitle')).not.toBeInTheDocument();
  });

  it('shows Scan QR code with extracted icons and compact action pills while the address field is empty', () => {
    renderRecipient({ onScan: jest.fn() });

    expect(screen.getByText('scanQrTitle')).toBeInTheDocument();
    expect(screen.getByTestId('send-address-book-icon')).toBeInTheDocument();
    expect(screen.getByTestId('send-scan-icon')).toBeInTheDocument();
    // Both pills are the app's shared Pill, so they are the same height, padding and type
    // scale as every other chip (the network chip beside them included).
    for (const label of ['addressBook', 'scanQrTitle']) {
      expect(screen.getByText(label).closest('button')).toHaveClass('h-8', 'px-3', 'rounded-full', 'text-pill');
    }
  });

  it('shows the saved contact identity when a recipient name is provided', () => {
    renderRecipient({
      address: ETH_ADDRESS,
      isValidAddress: true,
      chain: 'ethereum',
      recipientName: 'Charlie'
    });

    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.getByTestId('send-recipient-avatar')).toHaveTextContent('C');
  });

  it('shows the only bridge network as a fact rather than a lone selectable chip', () => {
    renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum', network: 'sepolia' });

    const chip = screen.getByTestId('send-network-sepolia');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveTextContent('Sepolia');
  });

  it('offers the bridge networks as chips once there is more than one', () => {
    mockBridgeNetworks.push({ id: 'base', name: 'Base', chainId: 8453 });
    try {
      const props = renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum' });

      expect(screen.getByTestId('send-recipient-confirm')).toBeDisabled();
      expect(screen.getByTestId('send-network-sepolia')).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(screen.getByTestId('send-network-base'));
      expect(props.onSelectNetwork).toHaveBeenCalledWith('base');
    } finally {
      mockBridgeNetworks.pop();
    }
  });

  it('hides the network selector for an incomplete EVM address', () => {
    renderRecipient({ address: '0x1234', isValidAddress: false, chain: 'ethereum' });

    expect(screen.queryByTestId('send-network-options')).not.toBeInTheDocument();
  });

  it('enables EVM confirmation once the network is set', () => {
    renderRecipient({ address: ETH_ADDRESS, isValidAddress: true, chain: 'ethereum', network: 'sepolia' });

    expect(screen.getByTestId('send-recipient-confirm')).toBeEnabled();
  });

  it('gives Confirm the send flow colour', () => {
    renderRecipient();

    expect(screen.getByTestId('send-recipient-confirm')).toHaveAttribute('data-accent', 'send');
  });

  it('shows Miden as the network for a valid Miden recipient', () => {
    renderRecipient({ address: MIDEN_ADDRESS, isValidAddress: true, chain: 'miden' });

    expect(screen.getByTestId('send-network-options')).toBeInTheDocument();
    expect(screen.getByTestId('send-network-miden')).toHaveTextContent('miden');
    expect(screen.getByTestId('send-recipient-confirm')).toBeEnabled();
  });
});

describe('SelectRecipient — recent recipients', () => {
  const RECENTS = [
    { address: 'mtst1recent_alice', name: 'Alice', chain: 'miden' as const },
    { address: ETH_ADDRESS, chain: 'ethereum' as const, networkName: 'Sepolia' },
    { address: '0x1111111111111111111111111111111111111111', chain: 'ethereum' as const }
  ];

  it('lists recents with names, a network badge per row and a network fallback, and fills on tap', () => {
    const onSelectRecent = jest.fn();
    renderRecipient({ recents: RECENTS, onSelectRecent });

    expect(screen.getByText('recent')).toBeInTheDocument();
    expect(screen.getAllByTestId('send-recent-recipient')).toHaveLength(3);

    // A saved contact shows its name; an unknown address falls back to the truncated form.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // The network rides the avatar as a badge, so the row never spends its second line on it.
    expect(screen.getAllByTestId('contact-avatar').map(el => el.dataset.network)).toEqual([
      'miden',
      'ethereum',
      'ethereum'
    ]);
    // Only a named recipient shows the address on the second line; the others already show it
    // above, so that line names their network instead (falling back to Ethereum).
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

  it('keeps the confirm footer at a fixed height that only the keyboard shrinks', () => {
    renderRecipient();
    const footer = screen.getByTestId('send-recipient-confirm').parentElement;
    // data-navbar-cushion: the CSS collapses the cushion when the tab bar hides, which is the
    // only way the CTA is guaranteed to stay clear of a bar that draws over it.
    expect(footer?.getAttribute('data-navbar-cushion')).toBe('true');
    expect(footer?.className).toContain('var(--keyboard-height,0px)');
  });
});

describe('SelectRecipient — paste', () => {
  it('shows Paste while the address field is empty and calls onPaste', () => {
    const props = renderRecipient({ onPaste: jest.fn() });

    fireEvent.click(screen.getByTestId('send-paste'));

    expect(screen.getByText('paste')).toBeInTheDocument();
    expect(props.onPaste).toHaveBeenCalledTimes(1);
  });

  it('hides Paste once an address is entered', () => {
    renderRecipient({ address: MIDEN_ADDRESS, isValidAddress: true, onPaste: jest.fn() });

    expect(screen.queryByTestId('send-paste')).not.toBeInTheDocument();
  });

  it('hides Paste when no paste handler is provided', () => {
    renderRecipient();

    expect(screen.queryByTestId('send-paste')).not.toBeInTheDocument();
  });
});

describe('SelectRecipient — address field growth', () => {
  // The field measures with height:auto, which cannot be interpolated, so the height it is drawn
  // at has to go back before the new one or the CSS transition is cancelled. Restoring the last
  // inline target instead snapped the field for a keystroke that landed mid-grow.
  it('writes back the height it is drawn at before the new height', () => {
    const { rerender } = render(<SelectRecipient {...baseRecipientProps()} address="mtst1a" />);
    const field = screen.getByTestId('send-recipient-input') as HTMLTextAreaElement;

    // One wrapped line is already applied, and the field is mid-transition at 90px.
    field.style.height = '120px';
    jest.spyOn(window, 'getComputedStyle').mockReturnValue({ height: '90px' } as CSSStyleDeclaration);
    const writes: string[] = [];
    Object.defineProperty(field.style, 'height', {
      configurable: true,
      get: () => writes[writes.length - 1] ?? '120px',
      set: (value: string) => writes.push(value)
    });
    Object.defineProperty(field, 'scrollHeight', { value: 150, configurable: true });

    rerender(<SelectRecipient {...baseRecipientProps()} address="mtst1abcdefghijklmnop" />);

    expect(writes).toEqual(['auto', '90px', '150px']);
  });
});
