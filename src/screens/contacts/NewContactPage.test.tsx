import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { NewContactPage } from './NewContactPage';

const addContactMock = jest.fn();
const backMock = jest.fn();
const contactsMock = jest.fn();
jest.mock('lib/miden/front', () => ({ useContacts: () => ({ addContact: addContactMock }) }));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contactsMock() })
}));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => backMock }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
}));
jest.mock('components/flow/FlowLayout', () => ({
  FlowLayout: ({ title, children, footer }: any) => (
    <div>
      <h1>{title}</h1>
      {children}
      {footer}
    </div>
  )
}));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, isLoading: _isLoading, ...rest }: any) => <button {...rest}>{title}</button>
}));
jest.mock('components/contacts/ContactAvatar', () => ({
  ContactAvatar: ({ name, network }: any) => <span data-testid="avatar" data-name={name} data-network={network} />
}));
jest.mock('components/NetworkChip', () => ({
  NetworkChip: ({ label, ...rest }: any) => <span data-testid={rest['data-testid']}>{label}</span>
}));
jest.mock('screens/send-flow/bridge-networks', () => ({
  BRIDGE_NETWORKS: [{ id: 'sepolia', name: 'Sepolia', chainId: 1 }],
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 1 }
}));
jest.mock('screens/send-flow/ScanQrDrawer', () => ({ ScanQrDrawer: () => null }));
jest.mock('lib/platform', () => ({ isMobile: () => false }));
jest.mock('lib/qr', () => ({ isScanAvailable: () => false, scanQRCode: jest.fn() }));
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: jest.fn() } }));
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden'),
  isValidRecipientAddress: (a: string) => a.startsWith('0x') || a.startsWith('mtst1good')
}));

const EVM = '0x3650dB63221d7A67f9b99B0C3590D366701D0Dd9';

beforeEach(() => {
  addContactMock.mockReset().mockResolvedValue(undefined);
  backMock.mockReset();
  contactsMock.mockReturnValue([{ name: 'Alice', address: 'mtst1goodalice' }]);
});

const typeAddress = (value: string) => {
  const field = screen.getByTestId('address-book-address-input');
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

it('saves a 0x contact with its network and goes back', async () => {
  render(<NewContactPage />);
  expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();

  typeAddress(` ${EVM} `);
  expect(screen.getByTestId('new-contact-network-sepolia')).toBeInTheDocument();
  expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();

  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: ' Paul ' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  expect(addContactMock).toHaveBeenCalledWith(
    expect.objectContaining({ address: EVM, name: 'Paul', network: 'sepolia' })
  );
  expect(backMock).toHaveBeenCalled();
});

it('saves a Miden contact without a network', async () => {
  render(<NewContactPage />);
  typeAddress('mtst1goodbob');
  expect(screen.getByTestId('new-contact-network-miden')).toBeInTheDocument();
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Bob' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  const saved = addContactMock.mock.calls[0][0];
  expect(saved).toEqual(expect.objectContaining({ address: 'mtst1goodbob', name: 'Bob' }));
  expect(saved).not.toHaveProperty('network');
});

it('flags an invalid address once the field is left', () => {
  render(<NewContactPage />);
  fireEvent.change(screen.getByTestId('address-book-address-input'), { target: { value: 'mtst1bad' } });
  expect(screen.queryByTestId('contact-address-error')).not.toBeInTheDocument();

  fireEvent.blur(screen.getByTestId('address-book-address-input'));
  expect(screen.getByTestId('contact-address-error')).toHaveTextContent('invalidAddress');
});

it('catches an address that is already saved, in any letter case', () => {
  contactsMock.mockReturnValue([{ name: 'Alice', address: EVM.toLowerCase() }]);
  render(<NewContactPage />);
  typeAddress(EVM);
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Again' } });

  expect(screen.getByTestId('contact-address-error')).toHaveTextContent('contactAlreadySaved:{"name":"Alice"}');
  expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();
});

it('catches one of my own accounts', () => {
  contactsMock.mockReturnValue([{ name: 'Main', address: 'mtst1goodmine', accountInWallet: true }]);
  render(<NewContactPage />);
  typeAddress('mtst1goodmine');

  expect(screen.getByTestId('contact-address-error')).toHaveTextContent('contactIsYourAccount');
});
