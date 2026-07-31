import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { clearSendDraft, hasSendDraft, setSendDraft } from './send-draft';
import { SendFlow } from './SendManager';
import { SendFlowStep } from './types';
import { WalletType } from '../onboarding/types';

/**
 * SendManager is a Navigator-hosted, react-hook-form-driven multi-step send
 * flow. We drive it through the exported `SendFlow` wrapper (which also
 * exercises NavigatorWrapper) and mock every module boundary so each branch is
 * reachable deterministically:
 *   - `components/Navigator` is mocked so `cardStack`, `navigateTo`, `goBack`
 *     and the rendered route are fully controllable (this also lets us hit
 *     `renderStep`'s default branch with an unknown route name).
 *   - The four step/drawer child components are mocked into thin harnesses that
 *     surface their props and expose buttons/inputs to fire the callbacks.
 *   - Data hooks, platform gates, the wallet store, woozie navigation and the
 *     speculative-proving RPCs are all jest.fn()s steered per test.
 * The real `./send-draft`, `./types`, `../onboarding/types`, react-hook-form
 * and yup are kept so their integration with SendManager is exercised for real.
 */

// ---------------------------------------------------------------------------
// Mutable control state (all read lazily inside mock factory closures).
// ---------------------------------------------------------------------------
let mockPathname = '/send';
let mockSearch = '';
let mockCardStack: { name: string }[] = [{ name: SendFlowStep.SelectRecipient }];
let mockRenderRouteName: string | undefined;

let mockSelectedToken: any = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1 };
let mockSelectedContact: any = { id: '0xcontact', name: 'Alice', isOwned: false, contactType: 'external' };

let capturedBackHandler: (() => boolean) | null = null;

const navigateToMock = jest.fn();
const goBackMock = jest.fn();
const navigateMock = jest.fn();

const useAccountMock = jest.fn(() => ({ publicKey: 'me-pk' }) as any);
const useAllAccountsMock = jest.fn(() => [] as any[]);
const useAllBalancesMock = jest.fn(() => ({ data: undefined as any }));
const useAllTokensBaseMetadataMock = jest.fn(() => ({}) as any);
const useFilteredContactsMock = jest.fn(() => ({ contacts: [] as any[] }));
const useHideNavbarWhileOpenMock = jest.fn();
const useMobileBackHandlerMock = jest.fn();

const isExtensionMock = jest.fn(() => false);
const isDelegateProofEnabledMock = jest.fn(() => false);
const isValidMidenAddressMock = jest.fn((addr: string) => !!addr && addr.startsWith('0x'));
const stringToBigIntMock = jest.fn((s: string) => BigInt(Math.floor(parseFloat(s || '0'))));
const requestSpeculateSendMock = jest.fn();
const requestSpeculateInvalidateMock = jest.fn();
const isScanAvailableMock = jest.fn(() => false);
const scanQRCodeMock = jest.fn();

const closeTransactionModalMock = jest.fn();
const setLastCompletedTxHashMock = jest.fn();
const walletStoreState = {
  isTransactionModalOpen: false,
  lastCompletedTxHash: null as string | null,
  closeTransactionModal: closeTransactionModalMock,
  setLastCompletedTxHash: setLastCompletedTxHashMock
};

// ---------------------------------------------------------------------------
// Module mocks.
// ---------------------------------------------------------------------------
jest.mock('components/Navigator', () => ({
  __esModule: true,
  useNavigator: () => ({ navigateTo: navigateToMock, goBack: goBackMock, cardStack: mockCardStack }),
  NavigatorProvider: ({ children }: any) => <div data-testid="nav-provider">{children}</div>,
  Navigator: ({ renderRoute }: any) => {
    const name = mockRenderRouteName ?? mockCardStack[mockCardStack.length - 1]?.name;
    return <div data-testid="navigator">{renderRoute({ name, animationIn: 'push', animationOut: 'pop' }, 0)}</div>;
  }
}));

jest.mock('./SelectRecipient', () => ({
  SelectRecipient: (props: any) => (
    <div data-testid="select-recipient">
      <span data-testid="sr-address">{props.address}</span>
      <span data-testid="sr-valid">{String(props.isValidAddress)}</span>
      <span data-testid="sr-error">{props.error ?? ''}</span>
      <textarea data-testid="sr-input" onChange={props.onAddressChange} />
      <button data-testid="sr-addressbook" onClick={props.onAddressBook} />
      {props.onScan && <button data-testid="sr-scan" onClick={props.onScan} />}
      <button data-testid="sr-confirm" onClick={props.onConfirm} />
    </div>
  )
}));

jest.mock('./SelectAmount', () => ({
  SelectAmount: (props: any) => (
    <div data-testid="select-amount">
      <span data-testid="sa-token">{props.token ? props.token.name : 'no-token'}</span>
      <span data-testid="sa-amount">{props.amount}</span>
      <span data-testid="sa-valid">{String(props.isValidAmount)}</span>
      <span data-testid="sa-error">{props.error ?? ''}</span>
      <span data-testid="sa-footer">{props.footerClassName}</span>
      <input data-testid="sa-input" onChange={(e: any) => props.onAmountChange(e.target.value)} />
      <button data-testid="sa-selecttoken" onClick={props.onSelectToken} />
      <button data-testid="sa-confirm" onClick={props.onConfirm} />
    </div>
  )
}));

jest.mock('./SelectToken', () => ({
  SelectTokenDrawer: (props: any) => (
    <div data-testid="token-drawer">
      <span data-testid="td-open">{String(props.open)}</span>
      <button data-testid="td-select" onClick={() => props.onSelect(mockSelectedToken)} />
      <button data-testid="td-close" onClick={() => props.onOpenChange(false)} />
    </div>
  )
}));

jest.mock('./AccountsList', () => ({
  AccountsListDrawer: (props: any) => (
    <div data-testid="accounts-drawer">
      <span data-testid="ad-open">{String(props.open)}</span>
      <span data-testid="ad-recipient">{props.recipientAccountId ?? ''}</span>
      <span data-testid="ad-accounts">{JSON.stringify(props.accounts)}</span>
      <button data-testid="ad-select" onClick={() => props.onSelectContact(mockSelectedContact)} />
      <button data-testid="ad-close" onClick={() => props.onOpenChange(false)} />
    </div>
  )
}));

jest.mock('./bridge-networks', () => ({
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
  BRIDGE_NETWORKS: [],
  getBridgeNetwork: jest.fn()
}));

jest.mock('./useEpochQuote', () => ({
  useEpochQuote: () => ({ amount: undefined, loading: false })
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => useAccountMock(),
  useAllAccounts: () => useAllAccountsMock(),
  useAllBalances: (...a: any[]) => (useAllBalancesMock as jest.Mock)(...a),
  useAllTokensBaseMetadata: () => useAllTokensBaseMetadataMock()
}));
jest.mock('lib/miden/front/use-filtered-contacts.hook', () => ({
  useFilteredContacts: () => useFilteredContactsMock()
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => id }),
  sameWalletAccountId: (a: string, b: string) => a === b
}));
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: (...a: any[]) => useHideNavbarWhileOpenMock(...a)
}));
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (cb: any, deps: any) => useMobileBackHandlerMock(cb, deps)
}));
jest.mock('lib/platform', () => ({ isExtension: () => isExtensionMock(), isMobile: () => false }));
jest.mock('lib/qr', () => ({
  isScanAvailable: () => isScanAvailableMock(),
  scanQRCode: () => scanQRCodeMock()
}));
jest.mock('lib/settings/helpers', () => ({ isDelegateProofEnabled: () => isDelegateProofEnabledMock() }));
jest.mock('lib/store', () => ({ useWalletStore: { getState: () => walletStoreState } }));
jest.mock('lib/woozie', () => ({
  navigate: (...a: any[]) => navigateMock(...a),
  useLocation: () => ({ pathname: mockPathname, search: mockSearch })
}));
jest.mock('utils/miden', () => ({
  isValidMidenAddress: (a: string) => isValidMidenAddressMock(a),
  isValidEthereumAddress: (a: string) => a.startsWith('0x') && a.length > 2,
  isValidRecipientAddress: (a: string) => isValidMidenAddressMock(a),
  detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden')
}));
jest.mock('lib/i18n/numbers', () => ({ stringToBigInt: (...a: any[]) => (stringToBigIntMock as jest.Mock)(...a) }));
jest.mock('lib/miden/activity', () => ({
  requestSpeculateSend: (...a: any[]) => requestSpeculateSendMock(...a),
  requestSpeculateInvalidate: (...a: any[]) => requestSpeculateInvalidateMock(...a)
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const renderFlow = (isLoading = false) => render(<SendFlow isLoading={isLoading} />);

const origSpecFlag = process.env.MIDEN_USE_SPECULATIVE_PROVING;

beforeEach(() => {
  jest.clearAllMocks();
  clearSendDraft();
  mockPathname = '/send';
  mockSearch = '';
  mockCardStack = [{ name: SendFlowStep.SelectRecipient }];
  mockRenderRouteName = undefined;
  mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1 };
  mockSelectedContact = { id: '0xcontact', name: 'Alice', isOwned: false, contactType: 'external' };
  capturedBackHandler = null;

  useAccountMock.mockReturnValue({ publicKey: 'me-pk' });
  useAllAccountsMock.mockReturnValue([]);
  useAllBalancesMock.mockReturnValue({ data: undefined });
  useAllTokensBaseMetadataMock.mockReturnValue({});
  useFilteredContactsMock.mockReturnValue({ contacts: [] });
  isExtensionMock.mockReturnValue(false);
  isDelegateProofEnabledMock.mockReturnValue(false);
  isScanAvailableMock.mockReturnValue(false);
  isValidMidenAddressMock.mockImplementation((addr: string) => !!addr && addr.startsWith('0x'));
  stringToBigIntMock.mockImplementation((s: string) => BigInt(Math.floor(parseFloat(s || '0'))));

  walletStoreState.isTransactionModalOpen = false;
  walletStoreState.lastCompletedTxHash = null;

  // Capture the back-button handler from each render so tests can invoke it.
  useMobileBackHandlerMock.mockImplementation((cb: any) => {
    capturedBackHandler = cb;
  });

  delete process.env.MIDEN_USE_SPECULATIVE_PROVING;
});

afterEach(() => {
  clearSendDraft();
  if (origSpecFlag === undefined) delete process.env.MIDEN_USE_SPECULATIVE_PROVING;
  else process.env.MIDEN_USE_SPECULATIVE_PROVING = origSpecFlag;
});

// ---------------------------------------------------------------------------
// Rendering / step selection.
// ---------------------------------------------------------------------------
describe('SendManager rendering', () => {
  it('renders the recipient step by default and hides nothing (navbar stays)', () => {
    renderFlow();
    expect(screen.getByTestId('select-recipient')).toBeInTheDocument();
    expect(screen.getByTestId('send-flow')).toBeInTheDocument();
    // currentStep === SelectRecipient on /send -> pastRecipientStep false.
    expect(useHideNavbarWhileOpenMock).toHaveBeenCalledWith(false);
    // Drawers start closed.
    expect(screen.getByTestId('td-open')).toHaveTextContent('false');
    expect(screen.getByTestId('ad-open')).toHaveTextContent('false');
  });

  it('renders the amount step and hides the navbar past the recipient step', () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();
    expect(screen.getByTestId('select-amount')).toBeInTheDocument();
    expect(screen.getByTestId('sa-footer')).toHaveTextContent('pt-4 pb-6');
    expect(useHideNavbarWhileOpenMock).toHaveBeenCalledWith(true);
  });

  it('does not hide the navbar when not on the /send path even past recipient', () => {
    mockPathname = '/';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();
    expect(useHideNavbarWhileOpenMock).toHaveBeenCalledWith(false);
  });

  it('renders the default (empty) branch for an unknown route name', () => {
    mockRenderRouteName = 'TotallyUnknownStep';
    renderFlow();
    expect(screen.getByTestId('navigator')).toBeInTheDocument();
    expect(screen.queryByTestId('select-recipient')).not.toBeInTheDocument();
    expect(screen.queryByTestId('select-amount')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Contacts list memoization.
// ---------------------------------------------------------------------------
describe('contact list assembly', () => {
  it('maps owned accounts (public/private/guardian) and external contacts, filtering self and dupes', () => {
    useAccountMock.mockReturnValue({ publicKey: 'me-pk' });
    useAllAccountsMock.mockReturnValue([
      { publicKey: 'me-pk', name: 'Me', isPublic: true, type: WalletType.OnChain }, // filtered (self)
      { publicKey: 'pub-1', name: 'Pub', isPublic: true, type: WalletType.OnChain },
      { publicKey: 'priv-1', name: 'Priv', isPublic: false, type: WalletType.OffChain },
      { publicKey: 'guard-1', name: 'Guard', isPublic: false, type: WalletType.Guardian }
    ]);
    useFilteredContactsMock.mockReturnValue({
      contacts: [
        { address: 'me-pk', name: 'SelfAddr' }, // filtered (self)
        { address: 'pub-1', name: 'DupOfOwned' }, // filtered (dup of owned account)
        { address: '0xext', name: 'External' } // kept
      ]
    });

    renderFlow();
    const accounts = JSON.parse(screen.getByTestId('ad-accounts').textContent || '[]');
    expect(accounts).toEqual([
      { id: 'pub-1', name: 'Pub', isOwned: true, contactType: 'public', isGuardian: false },
      { id: 'priv-1', name: 'Priv', isOwned: true, contactType: 'private', isGuardian: false },
      { id: 'guard-1', name: 'Guard', isOwned: true, contactType: 'private', isGuardian: true },
      { id: '0xext', name: 'External', isOwned: false, contactType: 'external' }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stale completion-modal dismissal effect.
// ---------------------------------------------------------------------------
describe('stale transaction modal dismissal', () => {
  it('closes an open modal and clears the last completed hash when entering /send', () => {
    walletStoreState.isTransactionModalOpen = true;
    walletStoreState.lastCompletedTxHash = '0xdone';
    renderFlow();
    expect(closeTransactionModalMock).toHaveBeenCalledWith(true);
    expect(setLastCompletedTxHashMock).toHaveBeenCalledWith(null);
  });

  it('does nothing when the modal is closed and there is no completed hash', () => {
    renderFlow();
    expect(closeTransactionModalMock).not.toHaveBeenCalled();
    expect(setLastCompletedTxHashMock).not.toHaveBeenCalled();
  });

  it('skips the dismissal entirely when not on the /send path', () => {
    mockPathname = '/';
    walletStoreState.isTransactionModalOpen = true;
    walletStoreState.lastCompletedTxHash = '0xdone';
    renderFlow();
    expect(closeTransactionModalMock).not.toHaveBeenCalled();
    expect(setLastCompletedTxHashMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mobile back handler branches.
// ---------------------------------------------------------------------------
describe('mobile back handler', () => {
  it('closes the contacts drawer first when it is open', () => {
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('sr-addressbook'));
    });
    expect(screen.getByTestId('ad-open')).toHaveTextContent('true');

    let result: boolean | undefined;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(screen.getByTestId('ad-open')).toHaveTextContent('false');
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('closes the token drawer when it is open (and no contacts drawer)', () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('sa-selecttoken'));
    });
    expect(screen.getByTestId('td-open')).toHaveTextContent('true');

    let result: boolean | undefined;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(screen.getByTestId('td-open')).toHaveTextContent('false');
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('pops the navigator when there is more than one card and no drawers', () => {
    mockCardStack = [{ name: SendFlowStep.SelectRecipient }, { name: SendFlowStep.SelectAmount }];
    renderFlow();
    let result: boolean | undefined;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('closes the whole flow (navigate home) on the first step', () => {
    mockCardStack = [{ name: SendFlowStep.SelectRecipient }];
    renderFlow();
    let result: boolean | undefined;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(goBackMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/');
  });
});

// ---------------------------------------------------------------------------
// Recipient address entry + validation.
// ---------------------------------------------------------------------------
describe('recipient address entry', () => {
  it('sets and clears the recipient error as the address becomes invalid/valid', () => {
    renderFlow();
    // Invalid address -> manual error, isValidAddress false.
    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: 'not-an-address' } });
    });
    expect(screen.getByTestId('sr-error')).toHaveTextContent('invalidMidenAccountId');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('false');
    expect(screen.getByTestId('sr-address')).toHaveTextContent('not-an-address');

    // Valid address -> error cleared, isValidAddress true.
    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '0xvalid' } });
    });
    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('true');
  });

  it('clears the recipient error when the address is emptied', () => {
    renderFlow();
    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: 'not-an-address' } });
    });
    expect(screen.getByTestId('sr-error')).toHaveTextContent('invalidMidenAccountId');

    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '   ' } });
    });
    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
  });

  it('rejects the current Miden account as a typed recipient', () => {
    isValidMidenAddressMock.mockImplementation((address: string) => address === 'me-pk');
    renderFlow();

    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: 'me-pk' } });
    });

    expect(screen.getByTestId('sr-error')).toHaveTextContent('cannotSendToSelf');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('false');
  });

  it('uses the Ethereum-specific error for a malformed 0x recipient', () => {
    renderFlow();

    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '0x' } });
    });

    expect(screen.getByTestId('sr-error')).toHaveTextContent('invalidEthereumAddress');
  });

  it('advances to the amount step when confirming the recipient', () => {
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('sr-confirm'));
    });
    expect(navigateToMock).toHaveBeenCalledWith(SendFlowStep.SelectAmount);
  });

  it('selects a contact from the address book, clearing the recipient error', () => {
    mockSelectedContact = { id: '0xpicked', name: 'Bob', isOwned: false, contactType: 'external' };
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });
    expect(screen.getByTestId('sr-address')).toHaveTextContent('0xpicked');
    expect(screen.getByTestId('ad-recipient')).toHaveTextContent('0xpicked');
  });

  it('rejects the current account when it is selected from contacts', () => {
    mockSelectedContact = { id: 'me-pk', name: 'Me', isOwned: true, contactType: 'public' };
    renderFlow();

    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });

    expect(screen.getByTestId('sr-address')).toHaveTextContent('me-pk');
    expect(screen.getByTestId('sr-error')).toHaveTextContent('cannotSendToSelf');
  });

  it.each([
    ['me-pk', 'cannotSendToSelf'],
    ['0xscanned', '']
  ])('validates a scanned recipient %s against the current account', async (address, expectedError) => {
    isScanAvailableMock.mockReturnValue(true);
    scanQRCodeMock.mockResolvedValue({ success: true, address });
    renderFlow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('sr-scan'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('sr-address')).toHaveTextContent(address);
    expect(screen.getByTestId('sr-error')).toHaveTextContent(expectedError);
  });

  it('surfaces a QR scanner error other than cancellation', async () => {
    isScanAvailableMock.mockReturnValue(true);
    scanQRCodeMock.mockResolvedValue({ success: false, errorKey: 'cameraDenied' });
    renderFlow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('sr-scan'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('sr-error')).toHaveTextContent('cameraDenied');
  });

  it('ignores QR scan cancellation', async () => {
    isScanAvailableMock.mockReturnValue(true);
    scanQRCodeMock.mockResolvedValue({ success: false, errorKey: 'scanCancelled' });
    renderFlow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('sr-scan'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
  });

  it('lets the token/contacts drawers be closed via onOpenChange', () => {
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('sr-addressbook'));
    });
    expect(screen.getByTestId('ad-open')).toHaveTextContent('true');
    act(() => {
      fireEvent.click(screen.getByTestId('ad-close'));
    });
    expect(screen.getByTestId('ad-open')).toHaveTextContent('false');
  });
});

// ---------------------------------------------------------------------------
// Amount entry + validation (amount step).
// ---------------------------------------------------------------------------
describe('amount entry', () => {
  const renderAmountStep = () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    return renderFlow();
  };

  const selectToken = () => {
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
  };

  const typeAmount = (value: string) => {
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value } });
    });
  };

  it('flags a non-positive amount as invalid', () => {
    renderAmountStep();
    typeAmount('0');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('invalidAmount');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
  });

  it('flags an amount above the selected token balance', () => {
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1 };
    renderAmountStep();
    selectToken();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    typeAmount('200');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('amountMustBeLessThanBalance');
  });

  it('accepts a valid amount within balance', () => {
    renderAmountStep();
    selectToken();
    typeAmount('5');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('true');
  });

  it('accepts a positive amount when no token is selected yet (balance check skipped)', () => {
    renderAmountStep();
    typeAmount('5');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('');
  });

  it('treats an empty amount string as invalid (falls back to 0)', () => {
    renderAmountStep();
    typeAmount('5'); // seed a value so clearing it actually fires onChange
    typeAmount('');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('invalidAmount');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
  });
});

// ---------------------------------------------------------------------------
// Token-change revalidation effect.
// ---------------------------------------------------------------------------
describe('revalidation when the token changes', () => {
  const renderAmountStep = () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    return renderFlow();
  };

  it('does nothing when there is no amount yet', () => {
    renderAmountStep();
    act(() => {
      fireEvent.click(screen.getByTestId('td-select')); // token changes, amount empty
    });
    expect(screen.getByTestId('sa-error')).toHaveTextContent('');
  });

  it('re-flags an over-balance amount when a token is picked after typing', () => {
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 10, fiatPrice: 1 };
    renderAmountStep();
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '50' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
    expect(screen.getByTestId('sa-error')).toHaveTextContent('amountMustBeLessThanBalance');
  });

  it('flags an invalid amount when a token is picked after typing zero', () => {
    renderAmountStep();
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '0' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
    expect(screen.getByTestId('sa-error')).toHaveTextContent('invalidAmount');
  });

  it('clears the amount error when a token is picked and the amount fits', () => {
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1 };
    renderAmountStep();
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '5' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
    expect(screen.getByTestId('sa-error')).toHaveTextContent('');
  });
});

// ---------------------------------------------------------------------------
// Confirm amount -> hand off to the review page.
// ---------------------------------------------------------------------------
describe('confirming the amount', () => {
  const renderAmountStep = () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    return renderFlow();
  };

  it('routes an Ethereum recipient to bridge route selection', () => {
    mockSelectedContact = { id: '0xrecip', name: 'R', isOwned: false, contactType: 'external' };
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1 };
    renderAmountStep();
    // Set recipient (via contacts drawer), token (via token drawer) and amount.
    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '5' } });
    });

    act(() => {
      fireEvent.click(screen.getByTestId('sa-confirm'));
    });

    expect(hasSendDraft()).toBe(false);
    expect(navigateToMock).toHaveBeenCalledWith(SendFlowStep.Route);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does nothing when required fields are missing', () => {
    renderAmountStep();
    act(() => {
      fireEvent.click(screen.getByTestId('sa-confirm'));
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(hasSendDraft()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token preselection effect + NavigatorWrapper wiring.
// ---------------------------------------------------------------------------
describe('token preselection', () => {
  const balanceData = [{ tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 2 }, balance: 42, fiatPrice: 3 }];

  it('preselects the token from the tokenId search param when a balance matches', () => {
    mockSearch = '?tokenId=T1';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
  });

  it('preselects the token from a restored draft tokenId', () => {
    setSendDraft({ amount: '7', recipientAddress: '0xrecip', tokenId: 'T1' });
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    // Draft values seed the form.
    expect(screen.getByTestId('sa-amount')).toHaveTextContent('7');
  });

  it('does not preselect when balances have not loaded yet', () => {
    mockSearch = '?tokenId=T1';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: undefined });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
  });

  it('does not preselect when no balance matches the tokenId', () => {
    mockSearch = '?tokenId=NOPE';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
  });

  it('does not preselect when there is no tokenId at all', () => {
    mockSearch = '';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
  });
});

// ---------------------------------------------------------------------------
// Speculative pre-proving effect (feature-flagged, extension-only).
// ---------------------------------------------------------------------------
describe('speculative pre-proving', () => {
  const seedValidDraft = (amount = '5') => {
    setSendDraft({ amount, recipientAddress: '0xrecip', tokenId: 'T1' });
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
  };

  const enableFlag = () => {
    process.env.MIDEN_USE_SPECULATIVE_PROVING = 'true';
    isExtensionMock.mockReturnValue(true);
  };

  it('requests a speculative send once the form is valid (debounced)', () => {
    jest.useFakeTimers();
    try {
      enableFlag();
      seedValidDraft('5');
      renderFlow();
      // token undefined initially -> no request yet.
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      expect(requestSpeculateSendMock).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(requestSpeculateSendMock).toHaveBeenCalledWith({
        accountId: 'me-pk',
        recipientAccountId: '0xrecip',
        faucetId: 'T1',
        noteType: 'private',
        amount: BigInt(5)
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('bails out when stringToBigInt throws', () => {
    jest.useFakeTimers();
    try {
      enableFlag();
      stringToBigIntMock.mockImplementation(() => {
        throw new Error('bad number');
      });
      seedValidDraft('5');
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(requestSpeculateSendMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not speculate when delegated proving is enabled', () => {
    jest.useFakeTimers();
    try {
      enableFlag();
      isDelegateProofEnabledMock.mockReturnValue(true);
      seedValidDraft('5');
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(requestSpeculateSendMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not speculate outside the extension context', () => {
    jest.useFakeTimers();
    try {
      process.env.MIDEN_USE_SPECULATIVE_PROVING = 'true';
      isExtensionMock.mockReturnValue(false);
      seedValidDraft('5');
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(requestSpeculateSendMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not speculate for an invalid recipient address', () => {
    jest.useFakeTimers();
    try {
      enableFlag();
      isValidMidenAddressMock.mockReturnValue(false);
      seedValidDraft('5');
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(requestSpeculateSendMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not speculate for a non-positive amount', () => {
    jest.useFakeTimers();
    try {
      enableFlag();
      seedValidDraft('0');
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(requestSpeculateSendMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not speculate for an amount above balance', () => {
    jest.useFakeTimers();
    try {
      enableFlag();
      mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 1, fiatPrice: 1 };
      seedValidDraft('5');
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(requestSpeculateSendMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the debounce timer when dependencies change before it fires', () => {
    jest.useFakeTimers();
    try {
      enableFlag();
      seedValidDraft('5');
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select')); // schedules timer
      });
      // Change the amount before the 500ms elapses -> cleanup clears the timer.
      act(() => {
        fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '6' } });
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      // Exactly one request from the rescheduled timer (not two).
      expect(requestSpeculateSendMock).toHaveBeenCalledTimes(1);
      expect(requestSpeculateSendMock).toHaveBeenCalledWith(expect.objectContaining({ amount: BigInt(6) }));
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Speculative invalidation on unmount.
// ---------------------------------------------------------------------------
describe('speculative invalidation on unmount', () => {
  it('invalidates speculative state on unmount when no draft is pending', () => {
    process.env.MIDEN_USE_SPECULATIVE_PROVING = 'true';
    isExtensionMock.mockReturnValue(true);
    const { unmount } = renderFlow();
    unmount();
    expect(requestSpeculateInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate on unmount when a draft handoff is pending', () => {
    process.env.MIDEN_USE_SPECULATIVE_PROVING = 'true';
    isExtensionMock.mockReturnValue(true);
    const { unmount } = renderFlow();
    setSendDraft({ amount: '5', recipientAddress: '0xrecip', tokenId: 'T1' });
    unmount();
    expect(requestSpeculateInvalidateMock).not.toHaveBeenCalled();
  });

  it('does not invalidate on unmount outside the extension context', () => {
    process.env.MIDEN_USE_SPECULATIVE_PROVING = 'true';
    isExtensionMock.mockReturnValue(false);
    const { unmount } = renderFlow();
    unmount();
    expect(requestSpeculateInvalidateMock).not.toHaveBeenCalled();
  });

  it('does not invalidate on unmount when the feature flag is off', () => {
    isExtensionMock.mockReturnValue(true);
    const { unmount } = renderFlow();
    unmount();
    expect(requestSpeculateInvalidateMock).not.toHaveBeenCalled();
  });
});
