import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { AddContactDrawer } from './AddContactDrawer';

const addContactMock = jest.fn();
jest.mock('lib/miden/front', () => ({ useContacts: () => ({ addContact: addContactMock }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, onOpenChange, children }: any) =>
    open ? (
      <div>
        {/* vaul routes swipe, backdrop and Escape through onOpenChange; expose it so a dismiss
            can be fired in tests. */}
        <button type="button" data-testid="drawer-dismiss" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null,
  DrawerContent: ({ children }: any) => <div>{children}</div>,
  DrawerHeader: ({ children }: any) => <div>{children}</div>,
  DrawerTitle: ({ children }: any) => <h2>{children}</h2>
}));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, isLoading: _isLoading, ...rest }: any) => <button {...rest}>{title}</button>
}));
jest.mock('components/contacts/ContactAvatar', () => ({
  ContactAvatar: ({ name, network }: any) => <span data-testid="avatar" data-name={name} data-network={network} />
}));
jest.mock('components/NetworkChip', () => ({
  NetworkChip: ({ label, selected, onClick, ...rest }: any) => (
    <button type="button" aria-pressed={selected} onClick={onClick} data-testid={rest['data-testid']}>
      {label}
    </button>
  )
}));
jest.mock('./bridge-networks', () => ({
  BRIDGE_NETWORKS: [
    { id: 'sepolia', name: 'Sepolia', chainId: 1 },
    { id: 'base', name: 'Base', chainId: 2 }
  ],
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 1 }
}));

const MIDEN = 'mtst1arl2mg5w4524rsfkvuvvtxtwryfdpp48_qr7qqq9wr6w';
const EVM = '0x3650dB63221d7A67f9b99B0C3590D366701D0Dd9';
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden'),
  isValidRecipientAddress: (a: string) => a !== 'mtst1bad'
}));

beforeEach(() => addContactMock.mockReset().mockResolvedValue(undefined));

function renderSheet(address = MIDEN, network?: string) {
  const onOpenChange = jest.fn();
  render(<AddContactDrawer open address={address} network={network as any} onOpenChange={onOpenChange} />);
  return onOpenChange;
}

it('shows the known address in full and asks only for a name', () => {
  renderSheet();

  expect(screen.getByTestId('add-contact-address')).toHaveTextContent(MIDEN);
  expect(screen.getByTestId('address-book-name-input')).toBeInTheDocument();
  expect(screen.queryByTestId('add-contact-network-sepolia')).not.toBeInTheDocument();
  expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();
});

it('suggests the resolved Miden Name as an editable label and saves the actual address', async () => {
  render(<AddContactDrawer open address={MIDEN} initialName="alice.miden" onOpenChange={jest.fn()} />);
  expect(screen.getByTestId('address-book-name-input')).toHaveValue('alice.miden');
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });
  expect(addContactMock).toHaveBeenCalledWith(expect.objectContaining({ address: MIDEN, name: 'alice.miden' }));
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

  expect(screen.getByTestId('add-contact-network-sepolia')).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByTestId('add-contact-network-base'));
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Bob' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  expect(addContactMock).toHaveBeenCalledWith(expect.objectContaining({ address: EVM, name: 'Bob', network: 'base' }));
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
