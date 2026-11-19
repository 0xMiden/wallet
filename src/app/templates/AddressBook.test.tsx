import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import type { BackupRefreshOutcome, BackupRefreshReason } from 'lib/shared/types';

import AddressBook from './AddressBook';

const navigateMock = jest.fn();
const contactsMock = jest.fn();
jest.mock('lib/woozie', () => ({ navigate: (...args: unknown[]) => navigateMock(...args) }));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contactsMock() })
}));
// The page asks the backend for a backup contacts read when it opens; the backup is off here.
const mockRefreshBackup = jest.fn<Promise<BackupRefreshOutcome>, [BackupRefreshReason]>();
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ refreshBackup: mockRefreshBackup })
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({ title, variant: _variant, ...rest }: any) => <button {...rest}>{title}</button>
}));
jest.mock('components/contacts/ContactAvatar', () => ({
  ContactAvatar: ({ network }: any) => <span data-testid="avatar" data-network={network} />
}));
jest.mock('screens/send-flow/bridge-networks', () => ({
  BRIDGE_NETWORKS: [{ id: 'sepolia', name: 'Sepolia', chainId: 1 }],
  defaultBridgeNetwork: () => ({ id: 'sepolia', name: 'Sepolia', chainId: 1 })
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
  mockRefreshBackup.mockReset().mockResolvedValue('disabled');
});

// The address book opening is the one event that reads the backup's contacts.
it('asks for the backup contacts once when it opens, not on a re-render', () => {
  const { rerender } = render(<AddressBook />);

  expect(mockRefreshBackup).toHaveBeenCalledTimes(1);
  expect(mockRefreshBackup).toHaveBeenCalledWith('address-book');

  fireEvent.change(screen.getByTestId('address-book-search'), { target: { value: 'ali' } });
  rerender(<AddressBook />);
  expect(mockRefreshBackup).toHaveBeenCalledTimes(1);
});

it('logs a failed backup contacts read and still shows the contacts', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new Error('offline');
  mockRefreshBackup.mockRejectedValueOnce(failure);
  try {
    render(<AddressBook />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(warn).toHaveBeenCalledWith('[AddressBook] the backup contacts refresh failed:', failure);
    expect(screen.getByTestId('address-book-contact-mtst1alice')).toBeInTheDocument();
  } finally {
    warn.mockRestore();
  }
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

it('shows an empty state through EmptyState with the dashed surface, and opens the new-contact page', () => {
  contactsMock.mockReturnValue([MINE]);
  render(<AddressBook />);

  // Assert EmptyState's OWN structure, not just the testid and copy: the hand-rolled card this
  // replaced rendered the same testid and the same two strings in spans, so a text-only assertion
  // passed identically before and after and pinned nothing.
  const empty = screen.getByTestId('address-book-empty');
  expect(empty.querySelector('h3')).toHaveTextContent('noContactsYet');
  expect(empty).toHaveTextContent('noContactsYetHint');
  expect(empty).toHaveClass('border-dashed');
  expect(empty).not.toHaveClass('bg-fill');
  // Was `w-full max-w-none rounded-full bg-fill text-base font-semibold text-ink` - the Secondary
  // variant already paints bg-fill/text-ink, so hand-painting them again was redundant.
  expect(screen.getByTestId('address-book-new-contact').className).not.toMatch(
    /rounded-full|text-base|font-semibold|bg-fill|text-ink/
  );
  fireEvent.click(screen.getByTestId('address-book-new-contact'));
  expect(navigateMock).toHaveBeenCalledWith('/contacts/new');
});

it('draws contacts and my-accounts as plain groups, flush on the page margin with full-width hairlines', () => {
  render(<AddressBook />);
  const first = screen.getByTestId('address-book-contact-mtst1alice');
  const second = screen.getByTestId('address-book-contact-0xzed');
  // The Address Book's body IS the list, so the group has no surface of its own.
  expect(first.parentElement).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
  expect(first.parentElement).not.toHaveClass('bg-fill');
  expect(second.parentElement).toBe(first.parentElement);
  // The first row's hairline is hidden by `first:`; the rest run the group's full width.
  expect(first).toHaveClass('first:before:hidden');
  expect(second).toHaveClass('before:bg-hairline');

  const account = screen.getByTestId('address-book-account-mtst1mine');
  expect(account.parentElement).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
  expect(account.parentElement).not.toHaveClass('bg-fill');
});

it('draws the rows and labels with the shared list components', () => {
  render(<AddressBook />);

  // The Settings-root header treatment: a 20px `ink` title behind the section's glyph.
  expect(screen.getByRole('heading', { level: 2, name: 'contacts' })).toHaveClass('text-title-section', 'text-ink');
  const contact = screen.getByTestId('address-book-contact-0xzed');
  expect(contact.querySelector('[data-slot="chevron"]')).not.toBeNull();
  expect(screen.getByTestId('address-book-account-mtst1mine').querySelector('[data-slot="chevron"]')).toBeNull();
});

it('sits on the shared sub-page frame: the CTA is pinned outside the scrolling body', () => {
  render(<AddressBook />);

  const body = screen.getByTestId('address-book').querySelector('[data-slot="body"]');
  expect(body).toHaveClass('gap-5', 'overflow-y-auto', 'px-4');
  // The page adds no gap of its own — the 20px between its sections is the layout's.
  expect(screen.getByTestId('address-book-search').closest('[data-slot="body"]')).toBe(body);

  const cta = screen.getByTestId('address-book-new-contact');
  expect(cta.closest('[data-slot="footer"]')).not.toBeNull();
  expect(cta.closest('[data-slot="body"]')).toBeNull();
});
