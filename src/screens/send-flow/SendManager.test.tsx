import React from 'react';

import { render, screen, fireEvent, act } from '@testing-library/react';

import { ROUTE_DWELL_MS } from 'lib/telemetry/use-route-dwell';

import { clearSendDraft, consumeSendDraft, setSendDraft } from './send-draft';
import { settleSendFlow } from './send-telemetry';
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
 *   - Data hooks, platform gates, the wallet store and woozie navigation are all
 *     jest.fn()s steered per test.
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
let capturedBackHandlerDeps: unknown[] | null = null;

/** Same comparison React uses for a deps array: same length, `Object.is` per slot. */
function sameDeps(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

const navigateToMock = jest.fn();
const goBackMock = jest.fn();
const navigateMock = jest.fn();

const useAccountMock = jest.fn(() => ({ publicKey: 'me-pk' }) as any);
const useAllAccountsMock = jest.fn(() => [] as any[]);
const useAllBalancesMock = jest.fn(() => ({ data: undefined as any }));
let mockBalancesLoading = false;
const useAllTokensBaseMetadataMock = jest.fn(() => ({}) as any);
const useFilteredContactsMock = jest.fn(() => ({ contacts: [] as any[] }));
const useRecentRecipientsMock = jest.fn((_accountId?: string | null) => [] as any[]);
const useHideNavbarWhileOpenMock = jest.fn();
const useMobileBackHandlerMock = jest.fn();

const isValidMidenAddressMock = jest.fn((addr: string) => !!addr && addr.startsWith('0x'));
const stringToBigIntMock = jest.fn((s: string) => BigInt(Math.floor(parseFloat(s || '0'))));
const isScanAvailableMock = jest.fn(() => false);
const scanQRCodeMock = jest.fn();
// `isMobile` now selects the scan path: mobile keeps the native plugin
// (`scanQRCode`), the extension opens the webcam ScanQrDrawer. Defaults to true
// so the existing native-scan tests below exercise `scanQRCode` unchanged; the
// extension drawer tests flip it to false.
const isMobileMock = jest.fn(() => true);
const clipboardReadMock = jest.fn();
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: () => clipboardReadMock() } }));

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock; step: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn(), step: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'unknown');

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
  NavigatorProvider: ({ children, initialRouteName, initialRouteNames }: any) => (
    <div data-testid="nav-provider" data-initial-stack={(initialRouteNames ?? [initialRouteName]).join(',')}>
      {children}
    </div>
  ),
  Navigator: ({ renderRoute }: any) => {
    const name = mockRenderRouteName ?? mockCardStack[mockCardStack.length - 1]?.name;
    return <div data-testid="navigator">{renderRoute({ name, animationIn: 'push', animationOut: 'pop' }, 0)}</div>;
  }
}));

jest.mock('./SelectRecipient', () => ({
  SelectRecipient: (props: any) => (
    <div data-testid="select-recipient">
      <span data-testid="sr-address">{props.address}</span>
      <span data-testid="sr-network">{props.network ?? ''}</span>
      <span data-testid="sr-valid">{String(props.isValidAddress)}</span>
      <span data-testid="sr-error">{props.error ?? ''}</span>
      <span data-testid="sr-name">{props.recipientName ?? ''}</span>
      <textarea data-testid="sr-input" onChange={props.onAddressChange} />
      <span data-testid="sr-canadd">{String(props.canAddContact)}</span>
      <span data-testid="sr-recents">{JSON.stringify(props.recents)}</span>
      <button data-testid="sr-addressbook" onClick={props.onAddressBook} />
      <button data-testid="sr-addcontact" onClick={props.onAddContact} />
      <button data-testid="sr-selectrecent" onClick={() => props.onSelectRecent(props.recents[0])} />
      {props.onScan && <button data-testid="sr-scan" onClick={props.onScan} />}
      {props.onPaste && <button data-testid="sr-paste" onClick={props.onPaste} />}
      <button data-testid="sr-confirm" onClick={props.onConfirm} />
    </div>
  )
}));

jest.mock('./ScanQrDrawer', () => ({
  ScanQrDrawer: (props: any) => (
    <div data-testid="scan-qr-drawer">
      <span data-testid="scan-open">{String(props.open)}</span>
      <button
        data-testid="scan-detected"
        onClick={() => props.onDetected('mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph')}
      />
      <button data-testid="scan-error" onClick={() => props.onError('cameraPermissionDenied')} />
      <button data-testid="scan-close" onClick={() => props.onOpenChange(false)} />
    </div>
  )
}));

jest.mock('./SendAmount', () => ({
  SendAmount: (props: any) => (
    <div data-testid="select-amount">
      <span data-testid="sa-token">{props.token ? props.token.name : 'no-token'}</span>
      <span data-testid="sa-amount">{props.amount}</span>
      <span data-testid="sa-valid">{String(props.isValidAmount)}</span>
      <span data-testid="sa-error">{props.error ?? ''}</span>
      <span data-testid="sa-recipient">{props.recipientName ?? props.recipientAddress}</span>
      <span data-testid="sa-network">{props.network ?? ''}</span>
      <button data-testid="sa-receive" onClick={props.onReceive} />
      <input data-testid="sa-input" onChange={(e: any) => props.onAmountChange(e.target.value)} />
      <button data-testid="sa-selecttoken" onClick={props.onSelectToken} />
      {props.onBack && <button data-testid="sa-back" onClick={props.onBack} />}
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

// The add-contact sheet has its own tests; stub it to its observable props.
jest.mock('./AddContactDrawer', () => ({
  AddContactDrawer: (props: any) => (
    <div data-testid="add-contact-drawer">
      <span data-testid="acd-open">{String(props.open)}</span>
      <span data-testid="acd-address">{props.address ?? ''}</span>
      <span data-testid="acd-network">{props.network ?? ''}</span>
      <button data-testid="acd-close" onClick={() => props.onOpenChange(false)} />
      {/* Lets a test put the sheet into the in-flight-write state the real SheetBody reports. */}
      <button data-testid="acd-busy" onClick={() => props.onBusyChange?.(true)} />
    </div>
  )
}));

// Recents come from Dexie; drive them from the test instead of the real DB.
jest.mock('./useRecentRecipients', () => ({
  useRecentRecipients: (...a: any[]) => useRecentRecipientsMock(...a)
}));

let mockBridgeNetworks: Array<{ id: string; name: string; chainId: number }> = [];
jest.mock('./bridge-networks', () => ({
  DEFAULT_BRIDGE_NETWORK: { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
  get BRIDGE_NETWORKS() {
    return mockBridgeNetworks;
  },
  getBridgeNetwork: jest.fn()
}));

jest.mock('./useEpochQuote', () => ({
  useEpochQuote: () => ({ amount: undefined, loading: false })
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => useAccountMock(),
  useAllAccounts: () => useAllAccountsMock(),
  useAllBalances: () => ({ ...useAllBalancesMock(), isLoading: mockBalancesLoading }),
  useAllTokensBaseMetadata: () => useAllTokensBaseMetadataMock()
}));
let mockBaseFee: number | null = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => mockBaseFee
}));
let mockNativeId: string | null = 'MIDEN-ID';
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockNativeId
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
jest.mock('lib/platform', () => ({ isExtension: () => false, isMobile: () => isMobileMock() }));
jest.mock('lib/qr', () => ({
  isScanAvailable: () => isScanAvailableMock(),
  scanQRCode: () => scanQRCodeMock()
}));
jest.mock('lib/store', () => ({ useWalletStore: { getState: () => walletStoreState } }));
jest.mock('lib/woozie', () => ({
  navigate: (...a: any[]) => navigateMock(...a),
  useLocation: () => ({ pathname: mockPathname, search: mockSearch })
}));
jest.mock('utils/miden', () => {
  class MidenAddressError extends Error {
    reason: 'invalid' | 'wrong-network';

    constructor(reason: 'invalid' | 'wrong-network') {
      super(reason);
      this.reason = reason;
    }
  }
  return {
    MidenAddressError,
    isValidMidenAddress: (a: string) => {
      if (!isValidMidenAddressMock(a)) throw new MidenAddressError('invalid');
      return true;
    },
    isValidEthereumAddress: (a: string) => a.startsWith('0x') && a.length > 2,
    isValidRecipientAddress: (a: string) => isValidMidenAddressMock(a),
    detectAddressChain: (a: string) => (a.startsWith('0x') ? 'ethereum' : 'miden')
  };
});
jest.mock('lib/i18n/numbers', () => ({ stringToBigInt: (...a: any[]) => (stringToBigIntMock as jest.Mock)(...a) }));
// The Miden Name lookup and its build flag. The flag is off by default, so the
// suites above see today's behaviour.
let mockNameResolveEnabled = false;
const resolveMidenNameMock = jest.fn<Promise<string | null>, [string, { signal?: AbortSignal }?]>();
jest.mock('lib/feature-flags', () => ({
  isMidenNameResolveEnabled: () => mockNameResolveEnabled
}));
jest.mock('lib/miden/name/resolver', () => ({
  resolveMidenName: (label: string, options?: { signal?: AbortSignal }) => resolveMidenNameMock(label, options)
}));
// The real `./send-telemetry` is kept so the cross-route handoff it exists for is
// exercised for real; only the reporting primitive underneath it is mocked.
jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const renderFlow = (isLoading = false) => render(<SendFlow isLoading={isLoading} />);

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
  capturedBackHandlerDeps = null;

  useAccountMock.mockReturnValue({ publicKey: 'me-pk' });
  useAllAccountsMock.mockReturnValue([]);
  mockBaseFee = 0;
  mockBalancesLoading = false;
  mockNativeId = 'MIDEN-ID';
  useAllBalancesMock.mockReturnValue({ data: undefined });
  useAllTokensBaseMetadataMock.mockReturnValue({});
  useFilteredContactsMock.mockReturnValue({ contacts: [] });
  isScanAvailableMock.mockReturnValue(false);
  isMobileMock.mockReturnValue(true);
  isValidMidenAddressMock.mockImplementation((addr: string) => !!addr && addr.startsWith('0x'));
  stringToBigIntMock.mockImplementation((s: string) => BigInt(Math.floor(parseFloat(s || '0'))));

  walletStoreState.isTransactionModalOpen = false;
  walletStoreState.lastCompletedTxHash = null;
  mockNameResolveEnabled = false;

  // Capture the back-button handler the way registration actually picks one. The real hook
  // registers inside `useEffect(..., [...deps, onScreen])` with `handler` deliberately excluded
  // from the deps, so the live handler is the one from the render that last CHANGED a dep, not the
  // newest one. Re-capturing on every render hands tests the freshest closure and makes a value
  // missing from the deps array impossible to catch.
  useMobileBackHandlerMock.mockImplementation((cb: any, deps: unknown[] = []) => {
    if (!capturedBackHandlerDeps || !sameDeps(deps, capturedBackHandlerDeps)) {
      capturedBackHandlerDeps = deps;
      capturedBackHandler = cb;
    }
  });
});

afterEach(() => {
  clearSendDraft();
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
    expect(useHideNavbarWhileOpenMock).toHaveBeenCalledWith(true);
  });

  it('links the amount step fee shortfall notice to Receive', () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();

    fireEvent.click(screen.getByTestId('sa-receive'));

    expect(navigateMock).toHaveBeenCalledWith('/receive');
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
describe('on-screen step back button', () => {
  it('opens a fresh flow on the recipient step', () => {
    renderFlow();

    expect(screen.getByTestId('nav-provider')).toHaveAttribute('data-initial-stack', SendFlowStep.SelectRecipient);
  });

  it('reopens a restored draft with the recipient step under Amount, so back reaches the address', () => {
    setSendDraft({ amount: '7', recipientAddress: '0xrecip', tokenId: 'T1' });
    renderFlow();

    expect(screen.getByTestId('nav-provider')).toHaveAttribute(
      'data-initial-stack',
      `${SendFlowStep.SelectRecipient},${SendFlowStep.SelectAmount}`
    );
  });

  it('pops to the recipient step from Amount', () => {
    mockCardStack = [{ name: SendFlowStep.SelectRecipient }, { name: SendFlowStep.SelectAmount }];
    renderFlow();

    fireEvent.click(screen.getByTestId('sa-back'));

    expect(goBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('closes the flow when Amount is the root step (restored draft)', () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();

    fireEvent.click(screen.getByTestId('sa-back'));

    expect(goBackMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/');
  });
});

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

  it('does not close the add-contact drawer on mobile back while its save is in flight', () => {
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('sr-addcontact'));
    });
    expect(screen.getByTestId('acd-open')).toHaveTextContent('true');
    act(() => {
      fireEvent.click(screen.getByTestId('acd-busy'));
    });

    // This path writes the sheet's open state directly, so it never reaches the drawer's own
    // dismiss guard. Tearing the sheet down here destroys the only node that can report a failed
    // save. The gesture is still consumed, so back does not fall through to the Navigator.
    let result: boolean | undefined;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(screen.getByTestId('acd-open')).toHaveTextContent('true');
    expect(goBackMock).not.toHaveBeenCalled();
  });

  it('closes the add-contact drawer before anything else', () => {
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('sr-addcontact'));
    });
    expect(screen.getByTestId('acd-open')).toHaveTextContent('true');

    let result: boolean | undefined;
    act(() => {
      result = capturedBackHandler!();
    });
    expect(result).toBe(true);
    expect(screen.getByTestId('acd-open')).toHaveTextContent('false');
    expect(goBackMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
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
// Recent recipients + saving a new contact.
// ---------------------------------------------------------------------------
describe('recent recipients', () => {
  it('resolves recent addresses against the contact list and fills the recipient on tap', () => {
    useAllAccountsMock.mockReturnValue([
      { publicKey: '0xalice', name: 'Alice', isPublic: true, type: 'standard' },
      { publicKey: 'me', name: 'Me', isPublic: true, type: 'standard' }
    ]);
    useRecentRecipientsMock.mockReturnValue([
      { address: '0xAlice', chain: 'ethereum', networkName: 'Sepolia' },
      { address: '0xstranger', chain: 'ethereum' }
    ]);
    renderFlow();

    // The first recent matches a wallet account (case-insensitively) and picks
    // up its name; the unknown one stays nameless.
    const recents = JSON.parse(screen.getByTestId('sr-recents').textContent!);
    expect(recents[0]).toMatchObject({ address: '0xAlice', name: 'Alice', networkName: 'Sepolia' });
    expect(recents[1].name).toBeUndefined();

    act(() => {
      fireEvent.click(screen.getByTestId('sr-selectrecent'));
    });
    expect(screen.getByTestId('sr-address')).toHaveTextContent('0xAlice');
  });

  it('queries recents for the active account', () => {
    renderFlow();
    expect(useRecentRecipientsMock).toHaveBeenCalledWith('me-pk');
  });
});

describe('adding an unknown recipient to contacts', () => {
  it('offers to save a valid address that is not a known contact, and forwards it to the sheet', () => {
    renderFlow();
    expect(screen.getByTestId('sr-canadd')).toHaveTextContent('false');

    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '0xstranger' } });
    });

    expect(screen.getByTestId('sr-canadd')).toHaveTextContent('true');

    act(() => {
      fireEvent.click(screen.getByTestId('sr-addcontact'));
    });
    expect(screen.getByTestId('acd-open')).toHaveTextContent('true');
    expect(screen.getByTestId('acd-address')).toHaveTextContent('0xstranger');
  });

  it('does not offer to save an address that is already a contact', () => {
    useAllAccountsMock.mockReturnValue([
      { publicKey: '0xalice', name: 'Alice', isPublic: true, type: 'standard' },
      { publicKey: 'me', name: 'Me', isPublic: true, type: 'standard' }
    ]);
    renderFlow();

    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '0xalice' } });
    });

    expect(screen.getByTestId('sr-valid')).toHaveTextContent('true');
    expect(screen.getByTestId('sr-canadd')).toHaveTextContent('false');
  });

  it('does not offer to save an invalid address', () => {
    renderFlow();

    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: 'not-an-address' } });
    });

    expect(screen.getByTestId('sr-canadd')).toHaveTextContent('false');
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

  it('selects the only bridge network for a valid 0x recipient, so Confirm is ready', () => {
    mockBridgeNetworks = [{ id: 'sepolia', name: 'Sepolia', chainId: 11155111 }];
    try {
      mockSelectedContact = { id: '0xpicked', name: 'Bob', isOwned: false, contactType: 'external' };
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('ad-select'));
      });

      expect(screen.getByTestId('sr-network')).toHaveTextContent('sepolia');
    } finally {
      mockBridgeNetworks = [];
    }
  });

  it("preselects a 0x contact's saved network when it is picked", () => {
    mockSelectedContact = { id: '0xpicked', name: 'Bob', isOwned: false, contactType: 'external', network: 'sepolia' };
    renderFlow();
    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });

    expect(screen.getByTestId('sr-network')).toHaveTextContent('sepolia');
    // The add-contact sheet gets the same network, so saving keeps what was chosen.
    expect(screen.getByTestId('acd-network')).toHaveTextContent('sepolia');
  });

  it("starts with the recipient and saved network handed over by a contact's page", () => {
    mockSearch = '?to=0xfromcontact&network=sepolia';
    mockBridgeNetworks = [
      { id: 'sepolia', name: 'Sepolia', chainId: 11155111 },
      { id: 'base', name: 'Base', chainId: 84532 }
    ];
    try {
      renderFlow();

      expect(screen.getByTestId('sr-address')).toHaveTextContent('0xfromcontact');
      expect(screen.getByTestId('sr-network')).toHaveTextContent('sepolia');
    } finally {
      mockBridgeNetworks = [];
    }
  });

  it('validates a handed-over recipient like a typed one', () => {
    mockSearch = '?to=me-pk';
    renderFlow();

    expect(screen.getByTestId('sr-error')).toHaveTextContent('cannotSendToSelf');
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

  it('pastes a trimmed address from the native clipboard on mobile and validates it', async () => {
    clipboardReadMock.mockResolvedValue({ type: 'text/plain', value: '  me-pk\n' });
    renderFlow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('sr-paste'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('sr-address')).toHaveTextContent('me-pk');
    expect(screen.getByTestId('sr-error')).toHaveTextContent('cannotSendToSelf');
  });

  it('leaves the address untouched when the clipboard is empty or unreadable', async () => {
    clipboardReadMock.mockResolvedValueOnce({ type: 'text/plain', value: '   ' });
    clipboardReadMock.mockRejectedValueOnce(new Error('denied'));
    renderFlow();

    for (let i = 0; i < 2; i++) {
      await act(async () => {
        fireEvent.click(screen.getByTestId('sr-paste'));
        await Promise.resolve();
      });
    }

    expect(screen.getByTestId('sr-address')).toHaveTextContent('');
    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
  });

  // Off mobile there is no read that works: a WebView's readText() raises the platform's paste
  // callout instead of returning text, and in the extension it never settles, because the manifest
  // holds clipboardWrite and not clipboardRead. The pill is gated like the scanner rather than
  // offered and silently doing nothing; the field is a textarea, so the platform's paste still works.
  it('offers no paste control off mobile', () => {
    isMobileMock.mockReturnValue(false);
    renderFlow();

    expect(screen.queryByTestId('sr-paste')).not.toBeInTheDocument();
  });

  it('ignores a clipboard that holds no text, so an image cannot become the recipient', async () => {
    clipboardReadMock.mockResolvedValue({
      type: 'image/png',
      value: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    });
    renderFlow();

    await act(async () => {
      fireEvent.click(screen.getByTestId('sr-paste'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('sr-address')).toHaveTextContent('');
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
// Extension webcam QR scan (non-mobile scan path -> ScanQrDrawer).
// ---------------------------------------------------------------------------
describe('extension webcam QR scan', () => {
  beforeEach(() => {
    // Extension context: not mobile, but scanning is available via the webcam.
    isMobileMock.mockReturnValue(false);
    isScanAvailableMock.mockReturnValue(true);
  });

  it('opens the webcam scan drawer instead of invoking the native plugin', () => {
    renderFlow();
    expect(screen.getByTestId('scan-open')).toHaveTextContent('false');

    act(() => {
      fireEvent.click(screen.getByTestId('sr-scan'));
    });

    expect(screen.getByTestId('scan-open')).toHaveTextContent('true');
    // The native mobile scanner must never run on the extension path.
    expect(scanQRCodeMock).not.toHaveBeenCalled();
  });

  it('populates the recipient input and runs validation on a drawer-detected address', () => {
    // Accept the scanned mtst1 address so a cleared error proves validation ran.
    isValidMidenAddressMock.mockImplementation((addr: string) => addr.startsWith('mtst1') || addr.startsWith('0x'));
    renderFlow();

    act(() => {
      fireEvent.click(screen.getByTestId('scan-detected'));
    });

    expect(screen.getByTestId('sr-address')).toHaveTextContent('mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('true');
    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
  });

  it('surfaces a drawer scan error on the recipient field', () => {
    renderFlow();

    act(() => {
      fireEvent.click(screen.getByTestId('scan-error'));
    });

    expect(screen.getByTestId('sr-error')).toHaveTextContent('cameraPermissionDenied');
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

  it('blocks the amount step when the account holds no MIDEN to pay the fee', () => {
    // The fee is withdrawn from the account's own vault, so a token-only holder
    // cannot move anything. Without this the form stays enabled and the failure
    // lands after biometric confirmation, reading as a lost transaction.
    mockBaseFee = 10000;
    useAllBalancesMock.mockReturnValue({
      data: [
        { tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 2 }, balance: 50, fiatPrice: 1 },
        { tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 0, fiatPrice: 1 }
      ]
    });
    renderAmountStep();
    selectToken();
    typeAmount('10');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('insufficientFeeAsset');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
  });

  it('says so before any amount is typed, not after the send is composed', () => {
    // The blocker used to wait for an amount, so a token-only holder filled in a recipient
    // and an amount before learning nothing was sendable. Nothing about that verdict depends
    // on the amount -- swap and earn deposit both say it on mount. Breaks if the check moves
    // back below the empty-amount guard.
    mockBaseFee = 10000;
    useAllBalancesMock.mockReturnValue({
      data: [
        { tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 2 }, balance: 50, fiatPrice: 1 },
        { tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 0, fiatPrice: 1 }
      ]
    });
    renderAmountStep();
    selectToken();

    expect(screen.getByTestId('sa-error')).toHaveTextContent('insufficientFeeAsset');
  });

  it('does not block on a chain that charges no fee', () => {
    mockBaseFee = 0;
    useAllBalancesMock.mockReturnValue({
      data: [
        { tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 2 }, balance: 50, fiatPrice: 1 },
        { tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 0, fiatPrice: 1 }
      ]
    });
    renderAmountStep();
    selectToken();
    typeAmount('10');
    expect(screen.getByTestId('sa-error')).not.toHaveTextContent('insufficientFeeAsset');
  });

  it.each([true, false])('waits for the balance before checking fees (mobile: %s)', mobile => {
    isMobileMock.mockReturnValue(mobile);
    mockBaseFee = 10000;
    mockBalancesLoading = true;
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 0, fiatPrice: 1 }]
    });
    const view = renderAmountStep();
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');

    selectToken();
    typeAmount('5');
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();

    mockBalancesLoading = false;
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 10, fiatPrice: 1 }]
    });
    view.rerender(<SendFlow isLoading={false} />);
    typeAmount('');
    expect(screen.getByTestId('sa-error')).not.toHaveTextContent('insufficientFeeAsset');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
  });

  it('checks the resolved balance even when the amount is still empty', () => {
    mockBaseFee = 10000;
    mockBalancesLoading = true;
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 0, fiatPrice: 1 }]
    });
    const view = renderAmountStep();
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();

    mockBalancesLoading = false;
    view.rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-error')).toHaveTextContent('insufficientFeeAsset');

    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 10, fiatPrice: 1 }]
    });
    view.rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
  });

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

    expect(consumeSendDraft()).toBeNull();
    expect(navigateToMock).toHaveBeenCalledWith(SendFlowStep.Route);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does nothing when required fields are missing', () => {
    renderAmountStep();
    act(() => {
      fireEvent.click(screen.getByTestId('sa-confirm'));
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(consumeSendDraft()).toBeNull();
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
// `send` telemetry flow.
// ---------------------------------------------------------------------------
describe('send telemetry', () => {
  /** Throwing accessor so a missing handle names how many flows were begun. */
  const handleAt = (index: number): TelemetryHandle => {
    const handle = telemetryHandles[index];
    if (!handle) throw new Error(`no flow was begun at index ${index} (begun: ${telemetryHandles.length})`);
    return handle;
  };

  /** Everything this suite handed to telemetry, for the privacy assertions. */
  const telemetryPayload = () =>
    JSON.stringify({
      begun: beginFlowMock.mock.calls,
      classified: classifyErrorMock.mock.calls,
      failed: telemetryHandles.map(handle => handle.fail.mock.calls),
      steps: telemetryHandles.map(handle => handle.step.mock.calls)
    });

  beforeEach(() => {
    // Scoped to this block: route dwell is a timer, and advancing the clock for
    // every other suite would count a visit those tests never made.
    jest.useFakeTimers();
    // The flow handle is module-scoped (it outlives this route on purpose), so
    // discard any handle a previous test left open.
    settleSendFlow(flow => flow.cancel());
    beginFlowMock.mockClear();
    classifyErrorMock.mockClear();
    telemetryHandles.length = 0;
  });

  afterEach(() => jest.useRealTimers());

  /**
   * Let the route settle. Arriving at /send no longer begins the flow on its
   * own: the carousel commits a route on every swipe release, so a route has to
   * hold still to count as a visit. See `useRouteDwell`.
   */
  const dwell = () => act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS));

  /** Render and stay, which is what a user who meant to send does. */
  const renderSend = (isLoading = false) => {
    const rendered = renderFlow(isLoading);
    dwell();
    return rendered;
  };

  const reachReview = (amount: string, recipient: string) => {
    mockSelectedContact = { id: recipient, name: 'R', isOwned: false, contactType: 'external' };
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 1e9, fiatPrice: 1 };
    isValidMidenAddressMock.mockImplementation((addr: string) => addr === recipient);
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    const rendered = renderSend();
    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: amount } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('sa-confirm'));
    });
    return rendered;
  };

  it('begins the send flow on entry to /send', () => {
    renderSend();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('send');
  });

  it('begins one flow per entry, not one per render', () => {
    renderSend();
    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '0xrecip' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('sr-addressbook'));
    });

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the flow when the user leaves the send flow without handing off', () => {
    const { unmount } = renderSend();

    unmount();

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('keeps the flow open across the handoff to the review page', () => {
    const { unmount } = reachReview('5', 'mtst1recipient');
    expect(navigateMock).toHaveBeenCalledWith(expect.stringContaining('/send/review'));

    unmount();

    // Settling here would report every successful send as abandoned-at-review;
    // the review page owns the terminal call.
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
    expect(handleAt(0).complete).not.toHaveBeenCalled();
  });

  it('reports nothing while another home page is showing, since the carousel keeps this one mounted', () => {
    // TabLayout renders Overview / Send / Receive / Earn / Swap as one carousel
    // and mounts all of them at once, for the whole session. A mount-triggered
    // flow therefore began a send on every app open and never ended it, because
    // swiping away does not unmount this screen — a phantom abandoned send per
    // launch, which is what the shipped build was actually reporting.
    mockPathname = '/';

    renderSend();

    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('reports nothing for a pane the carousel only swiped past', () => {
    // Reaching Swap from Overview is four swipe releases, and each release
    // navigates — so /send is committed on the way past. Before the dwell gate
    // that emitted a matched, plausible, entirely meaningless send: begun and
    // abandoned at `select_recipient`, by a finger that never stopped there.
    mockPathname = '/';
    const view = renderFlow();

    mockPathname = '/send';
    view.rerender(<SendFlow isLoading={false} />);
    act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS - 1));

    mockPathname = '/receive';
    view.rerender(<SendFlow isLoading={false} />);
    dwell();

    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('records the send as abandoned when the user swipes away, without waiting for an unmount', () => {
    const view = renderSend();
    expect(beginFlowMock).toHaveBeenCalledWith('send');

    mockPathname = '/';
    view.rerender(<SendFlow isLoading={false} />);

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
  });

  it('never passes the recipient address or the amount to telemetry', () => {
    reachReview('4200', 'mtst1recipientaddress');

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('mtst1recipientaddress');
    expect(telemetryPayload()).not.toContain('4200');
  });
});

// ---------------------------------------------------------------------------
// Miden Name recipient (`alice.miden`), behind MIDEN_NAME_RESOLVE_ENABLED.
// ---------------------------------------------------------------------------
describe('Miden Name recipient', () => {
  const DEBOUNCE_MS = 400;
  let warnSpy: jest.SpyInstance;

  interface Deferred {
    promise: Promise<string | null>;
    resolve: (value: string | null) => void;
  }

  function deferredAddress(): Deferred {
    let resolve: (value: string | null) => void = () => undefined;
    const promise = new Promise<string | null>(res => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const typeRecipient = (value: string) => {
    act(() => {
      fireEvent.change(screen.getByTestId('sr-input'), { target: { value } });
    });
  };

  /** Let the debounce timer fire and the lookup promise settle. */
  const runLookup = async () => {
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockNameResolveEnabled = true;
    resolveMidenNameMock.mockReset();
    // Resolved bech32 addresses do not start with 0x, so they are Miden addresses here.
    isValidMidenAddressMock.mockImplementation((addr: string) => addr.startsWith('mtst1') || addr === 'me-pk');
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    warnSpy.mockRestore();
  });

  it('with the flag off, a name input shows the address error as today and does no lookup', async () => {
    mockNameResolveEnabled = false;
    renderFlow();

    typeRecipient('alice.miden');
    await runLookup();

    expect(screen.getByTestId('sr-error')).toHaveTextContent('invalidMidenAccountId');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('false');
    expect(resolveMidenNameMock).not.toHaveBeenCalled();
  });

  it('does no lookup for a bech32 address', async () => {
    renderFlow();

    typeRecipient('mtst1recipient');
    await runLookup();

    expect(resolveMidenNameMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('true');
  });

  it('shows resolving, then the name, and sends the resolved address with the name to review', async () => {
    resolveMidenNameMock.mockResolvedValue('mtst1alice');
    const view = renderFlow();

    typeRecipient('Alice.miden');
    expect(screen.getByTestId('sr-error')).toHaveTextContent('midenNameResolving');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('false');

    // The lookup waits for the debounce.
    act(() => {
      jest.advanceTimersByTime(DEBOUNCE_MS - 1);
    });
    expect(resolveMidenNameMock).not.toHaveBeenCalled();

    await runLookup();
    expect(resolveMidenNameMock).toHaveBeenCalledTimes(1);
    expect(resolveMidenNameMock.mock.calls[0]?.[0]).toBe('alice');
    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('true');
    expect(screen.getByTestId('sr-name')).toHaveTextContent('alice.miden');

    // Continue to the amount step and on to review.
    mockCardStack = [{ name: SendFlowStep.SelectRecipient }, { name: SendFlowStep.SelectAmount }];
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 1e9, fiatPrice: 1 };
    view.rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-recipient')).toHaveTextContent('alice.miden');
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '5' } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId('sa-confirm'));
    });

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const url: string = navigateMock.mock.calls[0][0];
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(url.startsWith('/send/review?')).toBe(true);
    expect(params.get('to')).toBe('mtst1alice');
    expect(params.get('name')).toBe('alice.miden');

    // The draft keeps the name, so backing out of review shows it again.
    expect(consumeSendDraft()).toEqual({
      amount: '5',
      recipientAddress: 'Alice.miden',
      tokenId: 'T1',
      bridgeNetwork: undefined,
      bridgeRoute: undefined,
      midenName: { label: 'alice', address: 'mtst1alice' }
    });
  });

  it('blocks a name that is not found', async () => {
    resolveMidenNameMock.mockResolvedValue(null);
    renderFlow();

    typeRecipient('ghost.miden');
    await runLookup();

    expect(screen.getByTestId('sr-error')).toHaveTextContent('midenNameNotFound');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('false');
    expect(screen.getByTestId('sr-name')).toHaveTextContent('');
  });

  it('shows the lookup failure when the lookup throws', async () => {
    resolveMidenNameMock.mockRejectedValue(new Error('rpc down'));
    renderFlow();

    typeRecipient('alice.miden');
    await runLookup();

    expect(screen.getByTestId('sr-error')).toHaveTextContent('midenNameResolveFailed');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('false');
  });

  it('ignores the result of a lookup for an input that changed', async () => {
    const alice = deferredAddress();
    const bob = deferredAddress();
    resolveMidenNameMock.mockReturnValueOnce(alice.promise).mockReturnValueOnce(bob.promise);
    renderFlow();

    typeRecipient('alice.miden');
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });
    typeRecipient('bob.miden');
    // The change aborts the first lookup.
    expect(resolveMidenNameMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS);
    });

    // The old lookup settles late: nothing changes.
    await act(async () => {
      alice.resolve('mtst1alice');
      await Promise.resolve();
    });
    expect(screen.getByTestId('sr-error')).toHaveTextContent('midenNameResolving');
    expect(screen.getByTestId('sr-name')).toHaveTextContent('');

    await act(async () => {
      bob.resolve('mtst1bob');
      await Promise.resolve();
    });
    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
    expect(screen.getByTestId('sr-name')).toHaveTextContent('bob.miden');
  });

  it('blocks a name that resolves to the current account', async () => {
    resolveMidenNameMock.mockResolvedValue('me-pk');
    renderFlow();

    typeRecipient('me.miden');
    await runLookup();

    expect(screen.getByTestId('sr-error')).toHaveTextContent('cannotSendToSelf');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('false');
  });

  it('clears the debounce timer on unmount', async () => {
    const view = renderFlow();

    typeRecipient('alice.miden');
    view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS * 2);
    });

    expect(resolveMidenNameMock).not.toHaveBeenCalled();
  });

  it('restores a resolved name from the draft without a new lookup', async () => {
    setSendDraft({
      amount: '5',
      recipientAddress: 'alice.miden',
      tokenId: 'T1',
      midenName: { label: 'alice', address: 'mtst1alice' }
    });
    mockCardStack = [{ name: SendFlowStep.SelectRecipient }];
    renderFlow();
    await runLookup();

    expect(resolveMidenNameMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('sr-name')).toHaveTextContent('alice.miden');
    expect(screen.getByTestId('sr-valid')).toHaveTextContent('true');
    expect(screen.getByTestId('sr-error')).toHaveTextContent('');
  });
});
