import React from 'react';

import { fireEvent, render, screen, within } from '@testing-library/react';

import AddressBook from './AddressBook';

const navigateMock = jest.fn();
const contactsMock = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => navigateMock(...args) }));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contactsMock() })
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, ...rest }: any) => <button {...rest}>{title}</button>
}));
jest.mock('components/contacts/ContactAvatar', () => ({
  ContactAvatar: ({ network }: any) => <span data-testid="avatar" data-network={network} />
}));
jest.mock('screens/send-flow/bridge-networks', () => ({
  BRIDGE_NETWORKS: [{ id: 'sepolia', name: 'Sepolia', chainId: 1 }],
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 1 }
}));
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden')
}));

const ALICE = { name: 'Alice', address: 'mtst1alice' };
const ZED = { name: 'Zed', address: '0xzed', network: 'sepolia' };
const MINE = { name: 'Main', address: 'mtst1mine', accountInWallet: true, isPublic: true };

beforeEach(() => {
  navigateMock.mockReset();
  contactsMock.mockReturnValue([ZED, ALICE, MINE]);
});

it('lists saved contacts by name, then my accounts', () => {
  render(<AddressBook />);

  const rows = screen.getAllByTestId(/^address-book-(contact|account)-/);
  expect(rows.map(row => row.getAttribute('data-testid'))).toEqual([
    'address-book-contact-mtst1alice',
    'address-book-contact-0xzed',
    'address-book-account-mtst1mine'
  ]);
  expect(screen.getByText('contacts')).toBeInTheDocument();
  expect(screen.getByText('myAccounts')).toBeInTheDocument();
});

it('names each contact network and badges only 0x contacts', () => {
  render(<AddressBook />);

  const zed = screen.getByTestId('address-book-contact-0xzed');
  expect(zed).toHaveTextContent('Sepolia ·');
  expect(within(zed).getByTestId('avatar')).toHaveAttribute('data-network', 'ethereum');
  const alice = screen.getByTestId('address-book-contact-mtst1alice');
  expect(alice).toHaveTextContent('miden ·');
  expect(within(alice).getByTestId('avatar')).not.toHaveAttribute('data-network');
  expect(screen.getByTestId('address-book-account-mtst1mine')).toHaveTextContent('public ·');
});

it('opens a contact on tap; own accounts are not links', () => {
  render(<AddressBook />);

  fireEvent.click(screen.getByTestId('address-book-contact-0xzed'));
  expect(navigateMock).toHaveBeenCalledWith('/contacts/0xzed');
  expect(screen.getByTestId('address-book-account-mtst1mine').tagName).toBe('DIV');
});

it('searches names and addresses across both sections', () => {
  render(<AddressBook />);

  fireEvent.change(screen.getByTestId('address-book-search'), { target: { value: 'ALI' } });
  expect(screen.getByTestId('address-book-contact-mtst1alice')).toBeInTheDocument();
  expect(screen.queryByTestId('address-book-contact-0xzed')).not.toBeInTheDocument();
  expect(screen.queryByText('myAccounts')).not.toBeInTheDocument();

  fireEvent.change(screen.getByTestId('address-book-search'), { target: { value: 'nobody' } });
  expect(screen.getByText('noContactsFound')).toBeInTheDocument();
});

it('shows an empty state with no saved contacts, and opens the new-contact page', () => {
  contactsMock.mockReturnValue([MINE]);
  render(<AddressBook />);

  expect(screen.getByTestId('address-book-empty')).toHaveTextContent('noContactsYet');
  fireEvent.click(screen.getByTestId('address-book-new-contact'));
  expect(navigateMock).toHaveBeenCalledWith('/contacts/new');
});
