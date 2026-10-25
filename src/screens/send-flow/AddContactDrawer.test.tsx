import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

import { AddContactDrawer } from './AddContactDrawer';

const addContactMock = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

jest.mock('lib/miden/front', () => ({ useContacts: () => ({ addContact: addContactMock }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// The sheet's closeOnBack, captured so a test can see which tier owns its mobile back.
let mockDrawerCloseOnBack: boolean | undefined;
jest.mock('lib/ui/drawer', () => ({
  useIsInDrawer: () => true,
  Drawer: ({ open, onOpenChange, closeOnBack, children }: any) => {
    if (closeOnBack !== undefined) mockDrawerCloseOnBack = closeOnBack;
    return open ? (
      <div>
        {/* vaul routes swipe, backdrop and Escape through onOpenChange; expose it so a dismiss
            can be fired in tests. */}
        <button type="button" data-testid="drawer-dismiss" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null;
  },
  DrawerContent: ({ children }: any) => <div>{children}</div>,
  DrawerHeader: ({ children }: any) => <div>{children}</div>,
  DrawerTitle: ({ children }: any) => <h2>{children}</h2>
}));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, isLoading: _isLoading, accent, ...rest }: any) => (
    <button data-accent={accent} {...rest}>
      {title}
    </button>
  )
}));
jest.mock('components/contacts/ContactAvatar', () => ({
  ContactAvatar: ({ name, network }: any) => <span data-testid="avatar" data-name={name} data-network={network} />
}));
jest.mock('components/NetworkChip', () => ({
  NetworkLogo: () => null,
  NetworkChip: ({ label, selected, onClick, ...rest }: any) => (
    <button type="button" aria-pressed={selected} onClick={onClick} data-testid={rest['data-testid']}>
      {label}
    </button>
  )
}));
let mockNetworkName = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetworkName }));
jest.mock('./bridge-networks', () => ({
  BRIDGE_NETWORKS: [
    { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
    { id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 },
    { id: 'ethereum', name: 'Ethereum', chainId: 1 },
    { id: 'base', name: 'Base', chainId: 8453 }
  ],
  defaultBridgeNetwork: () =>
    mockNetworkName === 'mainnet'
      ? { id: 'ethereum', name: 'Ethereum', chainId: 1 }
      : { id: 'sepolia', name: 'Sepolia', chainId: 11155111 }
}));

const MIDEN = 'mtst1arl2mg5w4524rsfkvuvvtxtwryfdpp48_qr7qqq9wr6w';
const EVM = '0x3650dB63221d7A67f9b99B0C3590D366701D0Dd9';
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden'),
  isValidRecipientAddress: (a: string) => a !== 'mtst1bad'
}));

beforeEach(() => {
  mockNetworkName = 'testnet';
  addContactMock.mockReset().mockResolvedValue(undefined);
});

function renderSheet(address = MIDEN, network?: string) {
  const onOpenChange = jest.fn();
  render(<AddContactDrawer open address={address} network={network as any} onOpenChange={onOpenChange} />);
  return onOpenChange;
}

it("leaves mobile back to SendManager's handler, which holds the sheet while a save is in flight", () => {
  render(<AddContactDrawer open address={MIDEN} onOpenChange={jest.fn()} />);
  expect(mockDrawerCloseOnBack).toBe(false);
});

it('shows the known address in full and asks only for a name', () => {
  renderSheet();

  expect(screen.getByTestId('add-contact-address')).toHaveTextContent(MIDEN);
  expect(screen.getByTestId('address-book-name-input')).toBeInTheDocument();
  expect(screen.queryByTestId('add-contact-network-sepolia')).not.toBeInTheDocument();
  expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();
});

it('gives the add-contact submit the send flow colour', () => {
  renderSheet();

  expect(screen.getByTestId('address-book-add-contact')).toHaveAttribute('data-accent', 'send');
});

it('saves a Miden contact with a trimmed name and closes', async () => {
  const onOpenChange = renderSheet();
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: '  Alice  ' } });

  expect(screen.getByTestId('avatar')).toHaveAttribute('data-name', 'Alice');
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  expect(addContactMock).toHaveBeenCalledWith(expect.objectContaining({ address: MIDEN, name: 'Alice' }));
  expect(addContactMock.mock.calls[0][0]).not.toHaveProperty('network');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('lets a 0x contact choose its network, starting from the one chosen on the send step', async () => {
  renderSheet(EVM, 'sepolia');

  fireEvent.click(screen.getByTestId('add-contact-network-picker'));
  expect(screen.getByTestId('add-contact-network-sepolia')).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByTestId('add-contact-network-base-sepolia'));
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Bob' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  expect(addContactMock).toHaveBeenCalledWith(
    expect.objectContaining({ address: EVM, name: 'Bob', network: 'base-sepolia' })
  );
});

it('keeps the sheet open and shows the error when saving fails', async () => {
  addContactMock.mockRejectedValue(new Error('contactWithTheSameAddressAlreadyExists'));
  const onOpenChange = renderSheet();
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Alice' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  expect(screen.getByRole('alert')).toHaveTextContent('contactWithTheSameAddressAlreadyExists');
  expect(onOpenChange).not.toHaveBeenCalled();
});

it('refuses an invalid address without saving', async () => {
  renderSheet('mtst1bad');
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Alice' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  expect(screen.getByRole('alert')).toHaveTextContent('invalidAddress');
  expect(addContactMock).not.toHaveBeenCalled();
});

it('ignores a sheet dismiss while the save is in flight, so a failure still has somewhere to show', async () => {
  let reject: (e: Error) => void = () => undefined;
  addContactMock.mockReturnValueOnce(
    new Promise<void>((_, rej) => {
      reject = rej;
    })
  );
  const onOpenChange = renderSheet();
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Alice' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  // The sheet body holds the only node that can report a failed save, and it is remounted per
  // address - so a dismiss mid-write discards the rejection with nowhere to land.
  fireEvent.click(screen.getByTestId('drawer-dismiss'));
  expect(onOpenChange).not.toHaveBeenCalledWith(false);

  await act(async () => {
    reject(new Error('contact store unavailable'));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('contact store unavailable');
});

it('can still be dismissed after a successful save', async () => {
  const onOpenChange = jest.fn();
  const { rerender } = render(<AddContactDrawer open address={MIDEN} onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Alice' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });
  expect(addContactMock).toHaveBeenCalled();

  // The busy flag lives in the parent, which outlives the sheet body and survives close/reopen.
  // Raising it on save and clearing it only on failure left the sheet permanently undismissable.
  onOpenChange.mockClear();
  rerender(<AddContactDrawer open address={EVM} onOpenChange={onOpenChange} />);
  fireEvent.click(screen.getByTestId('drawer-dismiss'));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

describe('AddContactDrawer user-visible errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });

  afterEach(() => jest.useRealTimers());

  const saveContact = async () => {
    fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Alice' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('address-book-add-contact'));
    });
  };

  const expectReport = async (id: string) => {
    await act(async () => jest.advanceTimersByTimeAsync(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'inline']]);
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  };

  it.each([
    new Error('Contact Alice at mtst1private failed: https://contacts.invalid/save?amount=123.45'),
    'Contact Alice at mtst1private failed: https://contacts.invalid/save?amount=123.45'
  ])('reports a raw save rejection by its site code while retaining the display text (%s)', async reason => {
    addContactMock.mockRejectedValueOnce(reason);
    const onOpenChange = renderSheet();
    await saveContact();

    expect(screen.getByRole('alert')).toHaveTextContent(reason instanceof Error ? reason.message : reason);
    expect(screen.getByTestId('address-book-add-contact')).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    await expectReport('raw_contact_save_failed');
  });

  it('reports invalidAddress instead of treating the validation refusal as a raw save failure', async () => {
    renderSheet('mtst1bad');
    await saveContact();

    expect(screen.getByRole('alert')).toHaveTextContent('invalidAddress');
    expect(addContactMock).not.toHaveBeenCalled();
    await expectReport('invalidAddress');
  });

  it('does not report a save rejection that editing the name clears before 1000 ms', async () => {
    addContactMock.mockRejectedValueOnce(new Error('contact store unavailable'));
    renderSheet();
    await saveContact();
    expect(screen.getByRole('alert')).toHaveTextContent('contact store unavailable');
    await act(async () => jest.advanceTimersByTimeAsync(999));

    fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Alice corrected' } });
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });
});

it('keeps the send-step Add Contact picker on Mainnet and normalizes a stale test-chain draft', async () => {
  mockNetworkName = 'mainnet';
  renderSheet(EVM, 'sepolia');
  expect(screen.getByTestId('add-contact-network-picker')).toHaveTextContent('Ethereum');
  fireEvent.click(screen.getByTestId('add-contact-network-picker'));
  expect(screen.getByTestId('add-contact-network-base')).toBeInTheDocument();
  expect(screen.queryByTestId('add-contact-network-sepolia')).not.toBeInTheDocument();
  expect(screen.queryByTestId('add-contact-network-base-sepolia')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('add-contact-network-base'));
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Synthetic Mainnet' } });
  await act(async () => fireEvent.click(screen.getByTestId('address-book-add-contact')));
  expect(addContactMock).toHaveBeenCalledWith(expect.objectContaining({ network: 'base' }));
});
