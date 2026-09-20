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
  HistoryAction: { Push: 'pushstate', Replace: 'replacestate' },
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>
}));
// The app's own locale id form, which `Intl` rejects as-is.
jest.mock('lib/i18n/core', () => ({ getCurrentLocale: () => 'en_US' }));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => backMock }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('components/flow/FlowLayout', () => ({
  FlowLayout: ({ title, titleAccessory, onBack, children, footer }: any) => (
    <div>
      <button type="button" onClick={onBack} data-testid="flow-back" />
      <h1>{title}</h1>
      {titleAccessory}
      {children}
      {footer}
    </div>
  )
}));
jest.mock('components/ui/Button', () => ({
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
const clipboardWriteMock = jest.fn().mockResolvedValue(undefined);
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => clipboardWriteMock(...args) }
}));
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden')
}));

const PAUL = { name: 'Paul G', address: '0xpaul', network: 'sepolia', addedAt: Date.UTC(2026, 8, 18) };
const ALICE = { name: 'Alice', address: 'mtst1alice' };
// A `0x` contact saved before the network field existed, so it carries no `network`.
const NINA = { name: 'Nina', address: '0xnina', addedAt: Date.UTC(2026, 8, 19) };

beforeEach(() => {
  jest.clearAllMocks();
  updateContactMock.mockResolvedValue(undefined);
  removeContactMock.mockResolvedValue(undefined);
  contactsMock.mockReturnValue([PAUL, ALICE, NINA, { name: 'Main', address: 'mtst1mine', accountInWallet: true }]);
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
});

it('copies the address through the shared CopyButton, not a private implementation', async () => {
  render(<ContactDetailPage address="0xpaul" />);

  // The row used to pass DetailRow a `{ label, onClick }` action backed by its own copied state and
  // its own 1500ms constant. Asserting CopyButton's own node is what distinguishes the two: a test
  // that only counted Clipboard.write calls passed either way.
  const copy = screen.getByTestId('contact-copy');
  await act(async () => {
    fireEvent.click(copy);
  });

  expect(clipboardWriteMock).toHaveBeenCalledWith({ string: '0xpaul' });
  expect(copy.querySelector('[aria-live="polite"]')).not.toBeNull();
});

it('shows Miden for a Miden contact and sends without a network', () => {
  render(<ContactDetailPage address="mtst1alice" />);

  expect(screen.getByTestId('contact-network')).toHaveTextContent('miden');
  expect(sendToContactPath(ALICE)).toBe('/send?to=mtst1alice');
});

it('keeps Save disabled on a 0x contact stored without a network until something is edited', () => {
  render(<ContactDetailPage address="0xnina" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  // `contactNetwork` resolves Nina's missing network to the default, so the network state and the
  // raw stored value differ by construction. Comparing against the raw value made this Save live
  // with nothing edited, and saving wrote a network the user never chose.
  expect(screen.getByTestId('contact-save')).toBeDisabled();

  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Nina S' } });
  expect(screen.getByTestId('contact-save')).toBeEnabled();
});

it('renames a contact from edit mode', async () => {
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));
  expect(screen.getByRole('heading')).toHaveTextContent('editContact');
  expect(screen.getByTestId('contact-save')).toBeDisabled();

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
  fireEvent.click(screen.getByTestId('flow-back'));

  expect(screen.getByTestId('contact-send')).toBeInTheDocument();
  expect(backMock).not.toHaveBeenCalled();
  expect(updateContactMock).not.toHaveBeenCalled();
});

it('survives the optimistic store dropping the contact mid-write and still reports the failure', async () => {
  // `updateSettings` applies its optimistic `set()` synchronously, so the contact leaves the store
  // the moment `removeContact` is CALLED, not when it resolves. The page must not read that
  // absence as "unknown id" and redirect, or the rejection below is reported to a page that is
  // already gone. The static-list mock the other tests use cannot see this.
  let reject: (e: Error) => void = () => undefined;
  removeContactMock.mockImplementationOnce(() => {
    // The optimistic `set()` lands synchronously inside the call, before the round trip resolves.
    contactsMock.mockReturnValue([ALICE, NINA, { name: 'Main', address: 'mtst1mine', accountInWallet: true }]);
    return new Promise<void>((_, rej) => {
      reject = (e: Error) => {
        // `updateSettings` rolls the optimistic update back in its catch before rethrowing.
        contactsMock.mockReturnValue([
          PAUL,
          ALICE,
          NINA,
          { name: 'Main', address: 'mtst1mine', accountInWallet: true }
        ]);
        rej(e);
      };
    });
  });
  const { rerender } = render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });

  // The store subscription re-renders the page while the write is still in flight.
  await act(async () => {
    rerender(<ContactDetailPage address="0xpaul" />);
  });
  expect(screen.queryByTestId('redirect')).toBeNull();

  await act(async () => {
    reject(new Error('contact store unavailable'));
  });
  expect(backMock).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('contact store unavailable');
});

it('keeps the user on the page and shows the error when the delete write fails', async () => {
  removeContactMock.mockRejectedValueOnce(new Error('contact store unavailable'));
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });

  // The delete used to navigate away before the write was even attempted, so a rejection left the
  // user on a list still showing the contact with nothing said.
  expect(backMock).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('contact store unavailable');
});

it('disables the delete button while the write is in flight', async () => {
  let release: () => void = () => undefined;
  removeContactMock.mockReturnValueOnce(
    new Promise<void>(resolve => {
      release = resolve;
    })
  );
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });

  // Awaiting the write before navigating means the button outlives the tap, so it has to be held
  // shut: a second tap would otherwise re-open the confirm and fire a redundant write.
  expect(screen.getByTestId('contact-delete')).toBeDisabled();
  fireEvent.click(screen.getByTestId('contact-delete'));
  expect(removeContactMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    release();
  });
});

it('will not save while a delete is in flight, so the delete cannot be undone by a stale list', async () => {
  let release: () => void = () => undefined;
  removeContactMock.mockReturnValueOnce(
    new Promise<void>(resolve => {
      release = resolve;
    })
  );
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Paul Graham' } });

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });

  // Both writers replace the WHOLE contact list from their own render-time snapshot, so a save
  // landing during a delete would write the pre-delete list back and resurrect the contact.
  expect(screen.getByTestId('contact-save')).toBeDisabled();
  fireEvent.click(screen.getByTestId('contact-save'));
  expect(updateContactMock).not.toHaveBeenCalled();

  await act(async () => {
    release();
  });
});

it('will not leave edit mode while a write is in flight, so the error still has somewhere to show', async () => {
  let reject: (e: Error) => void = () => undefined;
  removeContactMock.mockReturnValueOnce(
    new Promise<void>((_, rej) => {
      reject = rej;
    })
  );
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });

  // The role="alert" node lives only in the editing branch, so leaving edit mode mid-write would
  // destroy the only thing that can report the failure below.
  fireEvent.click(screen.getByTestId('flow-back'));
  expect(screen.getByTestId('contact-save')).toBeInTheDocument();

  await act(async () => {
    reject(new Error('contact store unavailable'));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('contact store unavailable');
});

it('does not navigate when the page is gone by the time the delete resolves', async () => {
  let resolve: () => void = () => undefined;
  removeContactMock.mockReturnValueOnce(
    new Promise<void>(res => {
      resolve = res;
    })
  );
  const { unmount } = render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });

  unmount();
  await act(async () => {
    resolve();
  });

  // `back()` reads live location at call time, so navigating from a page the user already left
  // would traverse from wherever they are now. Liveness is what makes a relative pop safe.
  expect(backMock).not.toHaveBeenCalled();
});

it('deletes only after confirming, then goes back', async () => {
  render(<ContactDetailPage address="0xpaul" />);
  fireEvent.click(screen.getByTestId('contact-edit'));

  confirmMock.mockResolvedValueOnce(false);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });
  expect(removeContactMock).not.toHaveBeenCalled();

  confirmMock.mockResolvedValueOnce(true);
  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-delete'));
  });
  expect(removeContactMock).toHaveBeenCalledWith('0xpaul');
  // Pops our own entry rather than replacing it with the address-book URL, which would leave that
  // URL duplicated in two adjacent history entries and make the next Back appear to do nothing.
  expect(backMock).toHaveBeenCalledTimes(1);
});

it('redirects to the address book for an unknown address or one of my accounts', () => {
  const { unmount } = render(<ContactDetailPage address="0xnobody" />);
  expect(screen.getByTestId('redirect')).toHaveTextContent('/settings/address-book');
  unmount();

  render(<ContactDetailPage address="mtst1mine" />);
  expect(screen.getByTestId('redirect')).toBeInTheDocument();
});
