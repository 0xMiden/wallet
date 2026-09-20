import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { ContactDetailPage, sendToContactPath } from './ContactDetailPage';

const updateContactMock = jest.fn();
const removeContactMock = jest.fn();
const confirmMock = jest.fn();
const navigateMock = jest.fn();
const backMock = jest.fn();
const contactsMock = jest.fn();
jest.mock('lib/miden/front', () => ({
  useContacts: () => ({ updateContact: updateContactMock, removeContact: removeContactMock })
}));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contactsMock() })
}));
jest.mock('lib/ui/dialog', () => ({ useConfirm: () => confirmMock }));
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => navigateMock(...args),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));
// The app's own locale id form, which `Intl` rejects as-is.
jest.mock('lib/i18n/core', () => ({ getCurrentLocale: () => 'en_US' }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => backMock }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/ui/SubPageLayout', () => ({
  SubPageLayout: ({ title, headerActions, onBack, onSubmit, children, footer, ...rest }: any) => (
    <div data-testid={rest['data-testid']}>
      <button type="button" onClick={onBack} data-testid="page-back" />
      <h1>{title}</h1>
      {headerActions}
      <form onSubmit={onSubmit}>{children}</form>
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
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden')
}));

const PAUL = { name: 'Paul G', address: '0xpaul', network: 'sepolia', addedAt: Date.UTC(2026, 8, 18) };
const ALICE = { name: 'Alice', address: 'mtst1alice' };

beforeEach(() => {
  jest.clearAllMocks();
  updateContactMock.mockResolvedValue(undefined);
  removeContactMock.mockResolvedValue(undefined);
  contactsMock.mockReturnValue([PAUL, ALICE, { name: 'Main', address: 'mtst1mine', accountInWallet: true }]);
});

it('shows the full address, network and date, and sends to the contact', () => {
  render(<ContactDetailPage address="0xpaul" />);

  expect(screen.getByRole('heading')).toHaveTextContent('Paul G');
  expect(screen.getByTestId('contact-address')).toHaveTextContent('0xpaul');
  expect(screen.getByTestId('contact-network')).toHaveTextContent('Sepolia');
  expect(screen.getByTestId('avatar')).toHaveAttribute('data-network', 'ethereum');
  expect(screen.getByText('Sep 18, 2026')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('contact-send'));
  expect(navigateMock).toHaveBeenCalledWith('/send?to=0xpaul&network=sepolia');

  // Was `w-full max-w-none rounded-full text-base font-semibold`.
  expect(screen.getByTestId('contact-send').className).not.toMatch(/rounded-full|text-base|font-semibold/);
});

it('copies the full address with the shared copy action, which rolls to Copied', async () => {
  const { Clipboard } = jest.requireMock('@capacitor/clipboard');
  render(<ContactDetailPage address="0xpaul" />);

  const copy = screen.getByTestId('contact-copy-address');
  expect(screen.getByTestId('contact-address')).toContainElement(copy);

  await act(async () => {
    fireEvent.click(copy);
  });

  expect(Clipboard.write).toHaveBeenCalledWith({ string: '0xpaul' });
  expect(copy.querySelector('[data-copy-label] [data-present="true"]')).toHaveTextContent('copied');
});

it('shows Miden for a Miden contact and sends without a network', () => {
  render(<ContactDetailPage address="mtst1alice" />);

  expect(screen.getByTestId('contact-network')).toHaveTextContent('miden');
  expect(sendToContactPath(ALICE)).toBe('/send?to=mtst1alice');
});

it('renames a contact from edit mode', async () => {
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));
  expect(screen.getByRole('heading')).toHaveTextContent('editContact');
  expect(screen.getByTestId('contact-save')).toBeDisabled();
  // Was `w-full max-w-none rounded-full text-base font-semibold`.
  expect(screen.getByTestId('contact-save').className).not.toMatch(/rounded-full|text-base|font-semibold/);

  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: ' Paul Graham ' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-save'));
  });

  expect(updateContactMock).toHaveBeenCalledWith('0xpaul', { name: 'Paul Graham', network: 'sepolia' });
  expect(screen.getByRole('heading')).toHaveTextContent('Paul G');
});

it('leaves edit mode on back without saving', () => {
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));
  fireEvent.click(screen.getByTestId('page-back'));

  expect(screen.getByTestId('contact-send')).toBeInTheDocument();
  expect(backMock).not.toHaveBeenCalled();
  expect(updateContactMock).not.toHaveBeenCalled();
});

it('deletes only after confirming, then goes back', async () => {
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  confirmMock.mockResolvedValueOnce(false);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });
  expect(removeContactMock).not.toHaveBeenCalled();
  expect(confirmMock).toHaveBeenCalledWith({
    title: 'deleteContact',
    children: 'deleteContactConfirm',
    confirmLabel: 'delete',
    destructive: true
  });

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });
  expect(removeContactMock).toHaveBeenCalledWith('0xpaul');
  expect(backMock).toHaveBeenCalled();
});

it('redirects to the address book for an unknown address or one of my accounts', () => {
  const { unmount } = render(<ContactDetailPage address="0xnobody" />);
  expect(screen.getByTestId('redirect')).toHaveTextContent('/settings/address-book');
  unmount();

  render(<ContactDetailPage address="mtst1mine" />);
  expect(screen.getByTestId('redirect')).toBeInTheDocument();
});
