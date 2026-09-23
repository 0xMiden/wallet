import React from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { isMobile } from 'lib/platform';
import { isScanAvailable } from 'lib/qr';

import { NewContactPage } from './NewContactPage';

const addContactMock = jest.fn();
const backMock = jest.fn();
// Capture the page's mobile back handler so a test can fire the hardware/gesture back.
let capturedMobileBack: (() => boolean) | undefined;
let capturedMobileBackDeps: unknown[] | undefined;
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  // Registration happens inside `useEffect(..., [...deps, onScreen])` with `handler` deliberately
  // excluded, so the live handler is the one from the render that last CHANGED a dep. Capturing
  // every render would hand tests the freshest closure and make a missing dep untestable.
  useMobileBackHandler: (cb: () => boolean, deps: unknown[] = []) => {
    const changed =
      !capturedMobileBackDeps ||
      deps.length !== capturedMobileBackDeps.length ||
      deps.some((d, i) => !Object.is(d, capturedMobileBackDeps![i]));
    if (changed) {
      capturedMobileBackDeps = deps;
      capturedMobileBack = cb;
    }
  }
}));
const navigateMock = jest.fn();
const contactsMock = jest.fn();
const resolveNameMock = jest.fn<Promise<string | null>, [string, { signal?: AbortSignal }]>();
const nameSupportedMock = jest.fn(() => true);
jest.mock('lib/miden/name/config', () => ({ isMidenNameSupported: () => nameSupportedMock() }));
jest.mock('lib/miden/name/resolver', () => ({
  resolveMidenName: (label: string, options: { signal?: AbortSignal }) => resolveNameMock(label, options)
}));
jest.mock('lib/miden/front', () => ({ useContacts: () => ({ addContact: addContactMock }) }));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => ({ allContacts: contactsMock() })
}));
jest.mock('app/hooks/useBackWithFallback', () => ({ useBackWithFallback: () => backMock }));
jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => navigateMock(...args),
  HistoryAction: { Push: 'pushstate', Replace: 'replacestate' }
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
  })
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
jest.mock('screens/send-flow/ScanQrDrawer', () => ({ ScanQrDrawer: () => null }));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => false) }));
jest.mock('lib/qr', () => ({ isScanAvailable: jest.fn(() => false), scanQRCode: jest.fn() }));
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: jest.fn() } }));
jest.mock('utils/miden', () => ({
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden'),
  isValidRecipientAddress: (a: string) => a.startsWith('0x') || a.startsWith('mtst1good')
}));

const EVM = '0x3650dB63221d7A67f9b99B0C3590D366701D0Dd9';

beforeEach(() => {
  // Both must reset, or the previous test's deps make the first render of this one skip its capture.
  capturedMobileBack = undefined;
  capturedMobileBackDeps = undefined;
  addContactMock.mockReset().mockResolvedValue(undefined);
  resolveNameMock.mockReset().mockResolvedValue('mtst1goodbob');
  nameSupportedMock.mockReturnValue(true);
  backMock.mockReset();
  navigateMock.mockReset();
  contactsMock.mockReturnValue([{ name: 'Alice', address: 'mtst1goodalice' }]);
  (isMobile as jest.Mock).mockReturnValue(false);
  (isScanAvailable as jest.Mock).mockReturnValue(false);
  (Clipboard.read as jest.Mock).mockReset();
});

const typeAddress = (value: string) => {
  const field = screen.getByTestId('address-book-address-input');
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

describe('Miden Name contacts', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const finishLookup = async () => {
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
  };

  it('resolves a normalized name and saves its address with the suggested username', async () => {
    render(<NewContactPage />);
    typeAddress(' Bob.MIDEN ');
    expect(screen.getByRole('status')).toHaveTextContent('midenNameResolving');
    expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();
    await finishLookup();
    expect(resolveNameMock).toHaveBeenCalledWith('bob', expect.objectContaining({ signal: expect.anything() }));
    expect(screen.getByTestId('contact-resolved-address')).toHaveTextContent('mtst1goodbob');
    expect(screen.getByTestId('address-book-name-input')).toHaveValue('bob.miden');
    await act(async () => {
      fireEvent.click(screen.getByTestId('address-book-add-contact'));
    });
    expect(addContactMock).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'mtst1goodbob', name: 'bob.miden' })
    );
  });

  it('keeps a custom contact label when the lookup finishes', async () => {
    render(<NewContactPage />);
    typeAddress('bob.miden');
    fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'My friend' } });
    await finishLookup();
    expect(screen.getByTestId('address-book-name-input')).toHaveValue('My friend');
  });

  it.each([false, true])('checks the resolved address for an existing contact (owned: %s)', async accountInWallet => {
    contactsMock.mockReturnValue([{ name: 'Bob', address: 'mtst1goodbob', accountInWallet }]);
    render(<NewContactPage />);
    typeAddress('bob.miden');
    await finishLookup();
    expect(screen.getByTestId('contact-address-error')).toHaveTextContent(
      accountInWallet ? 'contactIsYourAccount' : 'contactAlreadySaved'
    );
    expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();
  });

  it.each(['missing', 'failed', 'unsupported'])('prevents saving when lookup is %s', async outcome => {
    if (outcome === 'missing') resolveNameMock.mockResolvedValue(null);
    if (outcome === 'failed') resolveNameMock.mockRejectedValue(new Error('offline'));
    if (outcome === 'unsupported') nameSupportedMock.mockReturnValue(false);
    render(<NewContactPage />);
    typeAddress('bob.miden');
    await finishLookup();
    expect(screen.getByTestId('contact-address-error')).toHaveTextContent(
      outcome === 'missing'
        ? 'midenNameNotFound'
        : outcome === 'failed'
          ? 'midenNameResolveFailed'
          : 'midenNameUnsupportedNetwork'
    );
    expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();
    expect(resolveNameMock).toHaveBeenCalledTimes(outcome === 'unsupported' ? 0 : 1);
  });

  it('ignores a late name result after switching to an address', async () => {
    let finish: (address: string) => void = () => undefined;
    resolveNameMock.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    render(<NewContactPage />);
    typeAddress('bob.miden');
    await finishLookup();
    typeAddress(EVM);
    await act(async () => finish('mtst1goodbob'));
    expect(screen.queryByTestId('contact-resolved-address')).not.toBeInTheDocument();
    expect(screen.getByTestId('address-book-name-input')).toHaveValue('');
    expect(screen.getByTestId('new-contact-network-sepolia')).toBeInTheDocument();
    expect(resolveNameMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });
});

it('saves a 0x contact with its network and goes back', async () => {
  render(<NewContactPage />);
  expect(screen.getByTestId('address-book-add-contact')).toBeDisabled();
  // Was `w-full max-w-none rounded-full text-base font-semibold`.
  expect(screen.getByTestId('address-book-add-contact').className).not.toMatch(/rounded-full|text-base|font-semibold/);

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

it('says so when a paste finds nothing on the clipboard', async () => {
  (isMobile as jest.Mock).mockReturnValue(true);
  (Clipboard.read as jest.Mock).mockRejectedValue(new Error('There is no data on the clipboard'));
  render(<NewContactPage />);

  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-paste'));
  });

  expect(screen.getByTestId('contact-address-error')).toHaveTextContent('nothingToPaste');
  expect(screen.getByTestId('address-book-address-input')).toHaveValue('');
});

it('fills the address from a successful paste, with no error', async () => {
  (isMobile as jest.Mock).mockReturnValue(true);
  (Clipboard.read as jest.Mock).mockResolvedValue({ value: EVM, type: 'text/plain' });
  render(<NewContactPage />);

  await act(async () => {
    fireEvent.click(screen.getByTestId('contact-paste'));
  });

  expect(screen.getByTestId('address-book-address-input')).toHaveValue(EVM);
  expect(screen.queryByTestId('contact-address-error')).not.toBeInTheDocument();
});

describe('TextField layout', () => {
  it('labels the address and name fields', () => {
    render(<NewContactPage />);

    expect(screen.getByLabelText('contactAddressOrMidenName')).toBe(screen.getByTestId('address-book-address-input'));
    expect(screen.getByLabelText('name')).toBe(screen.getByTestId('address-book-name-input'));
  });

  it('puts Paste and Scan inside the address field, next to the textarea, when both are available', () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    (isScanAvailable as jest.Mock).mockReturnValue(true);
    render(<NewContactPage />);

    // The field box is the textarea's own container: the pills sit in it (the trailing
    // slot), not in a row below the field.
    const fieldBox = screen.getByTestId('address-book-address-input').parentElement!;
    expect(fieldBox).toContainElement(screen.getByTestId('contact-paste'));
    expect(fieldBox).toContainElement(screen.getByTestId('contact-scan'));
  });

  it('renders neither pill when paste and scan are both unavailable', () => {
    render(<NewContactPage />);

    expect(screen.queryByTestId('contact-paste')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contact-scan')).not.toBeInTheDocument();
  });

  it('hides the pills once the field has an address', () => {
    (isMobile as jest.Mock).mockReturnValue(true);
    (isScanAvailable as jest.Mock).mockReturnValue(true);
    render(<NewContactPage />);

    typeAddress('mtst1goodbob');
    expect(screen.queryByTestId('contact-paste')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contact-scan')).not.toBeInTheDocument();
  });

  it("shows an invalid address in the field's error slot, announced and tied to the field", () => {
    render(<NewContactPage />);
    typeAddress('mtst1bad');

    const field = screen.getByTestId('address-book-address-input');
    const alert = screen.getByRole('alert');
    expect(alert).toBe(screen.getByTestId('contact-address-error'));
    expect(alert).toHaveTextContent('invalidAddress');
    // Below the field box, not inside it, and referenced by the field.
    expect(field.parentElement).not.toContainElement(alert);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', alert.id);
  });
});

it('ignores the header back while the save is in flight, so the save navigates exactly once', async () => {
  let resolveSave: () => void = () => undefined;
  addContactMock.mockReturnValueOnce(
    new Promise<void>(resolve => {
      resolveSave = resolve;
    })
  );
  render(<NewContactPage />);
  typeAddress(EVM);
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Paul' } });

  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  // `back` is claim-gated once per location. A tap here would navigate AND reset the claim, so the
  // save's own back() would fire again and overshoot by a screen.
  fireEvent.click(screen.getByTestId('page-back'));
  expect(backMock).not.toHaveBeenCalled();

  await act(async () => {
    resolveSave();
  });
  // Exactly once: the in-flight tap was ignored, and the save's own completion pops one entry.
  expect(backMock).toHaveBeenCalledTimes(1);
});

it('consumes the mobile hardware back while the save is in flight', async () => {
  let resolveSave: () => void = () => undefined;
  addContactMock.mockReturnValueOnce(
    new Promise<void>(resolve => {
      resolveSave = resolve;
    })
  );
  render(<NewContactPage />);
  typeAddress(EVM);
  fireEvent.change(screen.getByTestId('address-book-name-input'), { target: { value: 'Paul' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('address-book-add-contact'));
  });

  // Same rule as the detail page: the gated header back is not the only exit on mobile.
  expect(capturedMobileBack!()).toBe(true);

  await act(async () => {
    resolveSave();
  });
  expect(backMock).toHaveBeenCalledTimes(1);
});
