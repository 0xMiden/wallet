import React from 'react';

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import {
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET,
  publishMockBridgeSnapshot
} from 'lib/epoch/testing/bridge-config';
import { TEST_SWAP_TOKENS, TEST_TOKEN_IBTC, TEST_TOKEN_IETH } from 'lib/miden/swap/testing/registry';
import { _setSwapTokensForTest } from 'lib/miden/swap/tokens';
import { USD_QUOTE_MAX_AGE_MS } from 'lib/prices/amount';
import { hasUnquotedDefaultPrice } from 'lib/prices/unquoted-default';
import type { UsdcxBurnFeeEstimate } from 'lib/shared/types';
import { ROUTE_DWELL_MS } from 'lib/telemetry/use-route-dwell';

import { clearSendDraft, consumeSendDraft, setSendDraft } from './send-draft';
import { settleSendFlow } from './send-telemetry';
import { SendFlow } from './SendManager';
import { SendFlowStep } from './types';
import { WalletType } from '../onboarding/types';

// This verified-list fixture assigns explicit price assets to the test faucets.
const mockVerifiedPriceAssets = new Map<string, string>();
jest.mock('lib/token-list/runtime', () => ({
  ...jest.requireActual<typeof import('lib/token-list/runtime')>('lib/token-list/runtime'),
  peekTokenPriceAssets: () => mockVerifiedPriceAssets
}));
beforeEach(() => {
  mockVerifiedPriceAssets.clear();
  for (const token of TEST_SWAP_TOKENS) {
    if (token.priceSymbol) mockVerifiedPriceAssets.set(token.faucetId, token.priceSymbol);
  }
});

// Install swap fixtures for tests that also read swap metadata.
beforeAll(() => _setSwapTokensForTest(TEST_SWAP_TOKENS));
afterAll(() => _setSwapTokensForTest(undefined));

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
const useAllBalancesMock = jest.fn((_address?: string): { data: any; isLoading?: boolean } => ({ data: undefined }));
let mockBalancesLoading = false;
let mockHiddenTokensLoaded = true;
let mockHiddenTokenIds = new Set<string>();
let mockRpcUrl = 'https://testnet.example';
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
// The bridged price entries the testnet config names (the manual mock beside the module).
let mockSendNetwork = 'devnet';
// Testnet before any document has been accepted, as on a first start that cannot reach the config repo.
let mockSendConfigLoaded = true;
jest.mock('lib/remote-config/runtime', () => {
  const fixture = jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>(
    'lib/epoch/testing/bridge-config'
  );
  const devnet = { ...fixture.TEST_BRIDGE_CONFIG_SNAPSHOT, network: 'devnet' };
  const unloaded = { ...fixture.TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null, status: 'loading' as const };
  return fixture.remoteConfigRuntimeMock(() => {
    if (mockSendNetwork !== 'testnet') return devnet;
    return mockSendConfigLoaded ? fixture.TEST_BRIDGE_CONFIG_SNAPSHOT : unloaded;
  });
});

jest.mock('lib/miden/swap/bridge-price-allowlist');
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: () => clipboardReadMock() } }));
// The token prices under test follow the default rule, no price without a quote; pinned here against
// Developer Settings' nominal $1 switch (lib/prices/unquoted-default). The nominal fee case flips it.
jest.mock('lib/prices/unquoted-default', () => ({ hasUnquotedDefaultPrice: jest.fn(() => false) }));
const mockedHasUnquotedDefaultPrice = jest.mocked(hasUnquotedDefaultPrice);

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
// The real store, whose balance maps the real balance hook reads in the cases that run it in place of the mock.
const realWalletStore = () => jest.requireActual<typeof import('lib/store')>('lib/store').useWalletStore;
const walletStoreState = {
  tokenPrices: { USDC: { price: 3 } } as Record<string, { price: number }>,
  isTransactionModalOpen: false,
  lastCompletedTxHash: null as string | null,
  closeTransactionModal: closeTransactionModalMock,
  setLastCompletedTxHash: setLastCompletedTxHashMock,
  get balances() {
    return realWalletStore().getState().balances;
  },
  get balancesLoading() {
    return realWalletStore().getState().balancesLoading;
  },
  get balancesLastFetched() {
    return realWalletStore().getState().balancesLastFetched;
  },
  // A read the real hook starts stores nothing; a case lands its rows itself.
  fetchBalances: jest.fn(async () => undefined)
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
      <span data-testid="sr-evidence">{JSON.stringify(props.errorDiagnostics ?? null)}</span>
      <span data-testid="sr-error">{props.error ?? ''}</span>
      <textarea data-testid="sr-input" onChange={props.onAddressChange} />
      <span data-testid="sr-canadd">{String(props.canAddContact)}</span>
      <span data-testid="sr-recents">{JSON.stringify(props.recents)}</span>
      <span data-testid="sr-networks">{JSON.stringify(props.networks.map((n: any) => n.id))}</span>
      <button data-testid="sr-addressbook" onClick={props.onAddressBook} />
      <button data-testid="sr-addcontact" onClick={props.onAddContact} />
      <button data-testid="sr-selectrecent" onClick={() => props.onSelectRecent(props.recents[0])} />
      {props.onScan && <button data-testid="sr-scan" onClick={props.onScan} />}
      {props.onPaste && <button data-testid="sr-paste" onClick={props.onPaste} />}
      {props.networks.map((network: { id: string }) => (
        <button
          key={network.id}
          data-testid={`sr-network-${network.id}`}
          onClick={() => props.onSelectNetwork(network.id)}
        />
      ))}
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
      <span data-testid="sa-token-id">{props.token ? props.token.id : ''}</span>
      <span data-testid="sa-fiat-price">{props.token ? String(props.token.fiatPrice) : ''}</span>
      <span data-testid="sa-balance">{props.token ? String(props.token.balance) : ''}</span>
      <span data-testid="sa-decimals">{props.token ? String(props.token.decimals) : ''}</span>
      <span data-testid="sa-scale-known">{props.token ? String(props.token.scaleIsKnown) : ''}</span>
      <span data-testid="sa-amount">{props.amount}</span>
      <span data-testid="sa-valid">{String(props.isValidAmount)}</span>
      <span data-testid="sa-max-disabled">{String(!!props.maxDisabled)}</span>
      <span data-testid="sa-token-held">{String(!!props.tokenHeld)}</span>
      <span data-testid="sa-error">{props.error ?? ''}</span>
      <span data-testid="sa-error-values">{JSON.stringify(props.errorValues ?? null)}</span>
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
      <span data-testid="td-usdcx-only">{String(props.usdcxOnly)}</span>
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
// When set, the networks every send offers, one stable array as the real list is while the snapshot holds.
let mockOfferedNetworks: Array<{ id: string; name: string; chainId: number }> | undefined;
jest.mock('./bridge-networks', () => {
  const sepolia = { id: 'sepolia', name: 'Sepolia', chainId: 11155111 };
  // The testnet USDCx destinations, in the destination table's order.
  const usdcxNetworks = [
    { id: 'arc-testnet', name: 'Arc Testnet', chainId: 5042002 },
    sepolia,
    { id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', chainId: 421614 },
    { id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 }
  ];
  const sepoliaOnly = [sepolia];
  return {
    defaultBridgeNetwork: () => sepolia,
    get BRIDGE_NETWORKS() {
      return mockBridgeNetworks;
    },
    getBridgeNetwork: jest.fn(),
    usdcxBridgeNetworks: () => usdcxNetworks,
    defaultUsdcxBridgeNetwork: () => usdcxNetworks[0],
    isUsdcxBridgeNetwork: (id: string | undefined) => usdcxNetworks.some(n => n.id === id),
    isEpochBridgeNetwork: (id: string | undefined) => id === sepolia.id,
    sendBridgeNetworks: (usdcxWithdrawals: boolean) =>
      mockOfferedNetworks ?? (usdcxWithdrawals ? usdcxNetworks : sepoliaOnly)
  };
});

// USDCx withdrawal is offered only for the token id a test names; unset, every token takes the Epoch route.
let mockUsdcxTokenId: string | undefined;
let mockUsdcxWithdrawalNetwork = true;
jest.mock('lib/usdcx/withdrawal', () => ({
  isUsdcxWithdrawalAvailable: (tokenId: string | undefined) => !!tokenId && tokenId === mockUsdcxTokenId,
  isUsdcxWithdrawalNetwork: () => mockUsdcxWithdrawalNetwork
}));

let mockEpochAmount: string | undefined;
const useEpochQuoteMock = jest.fn((_args: { faucetId?: string; enabled: boolean }) => ({
  amount: mockEpochAmount,
  loading: false
}));
jest.mock('./useEpochQuote', () => ({
  useEpochQuote: (args: any) => useEpochQuoteMock(args)
}));

jest.mock('./SendRoute', () => ({
  SendRoute: (props: any) => (
    <>
      <span data-testid="route-fee">{String(props.fastFeeUsd)}</span>
      <span data-testid="route-selected">{props.route}</span>
      <span data-testid="route-usdcx">{String(props.usdcxAvailable)}</span>
      <span data-testid="route-usdcx-payout">
        {props.usdcxPayout ? `${props.usdcxPayout.chainId}:${props.usdcxPayout.amount}` : ''}
      </span>
      <button data-testid="route-confirm" onClick={props.onConfirm} />
    </>
  )
}));

// The burn fee dry run behind `useBurnFeeReserve`; it never answers unless a case says otherwise.
const mockEstimateUsdcxBurnFee = jest.fn<Promise<UsdcxBurnFeeEstimate>, [string, number]>(() => new Promise(() => {}));
jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ estimateUsdcxBurnFee: mockEstimateUsdcxBurnFee })
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => useAccountMock(),
  useAllAccounts: () => useAllAccountsMock(),
  useAllBalances: (address: string) => ({ isLoading: mockBalancesLoading, ...useAllBalancesMock(address) }),
  useAllTokensBaseMetadata: () => useAllTokensBaseMetadataMock()
}));
jest.mock('app/hooks/useHiddenTokens', () => ({
  useHiddenTokens: () => ({ loaded: mockHiddenTokensLoaded, isHidden: (id: string) => mockHiddenTokenIds.has(id) })
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveRpcUrl: () => mockRpcUrl
}));
let mockBaseFee: number | null = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => mockBaseFee
}));
let mockNativeId: string | null = 'MIDEN-ID';
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({
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
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign((selector: (state: typeof walletStoreState) => unknown) => selector(walletStoreState), {
    getState: () => walletStoreState
  })
}));
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
jest.mock('lib/i18n/numbers', () => ({
  stringToBigInt: (...a: any[]) => (stringToBigIntMock as jest.Mock)(...a),
  // The balance check has to see the real digit shift. The stand-in above floors through parseFloat,
  // which is the comparison this suite is pinning.
  typedAmountExceedsBalance: (...a: [string, number, number]) =>
    jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers').typedAmountExceedsBalance(...a),
  amountExceedsTokenDecimals: (...a: [string, number]) =>
    jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers').amountExceedsTokenDecimals(...a)
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
  mockSendNetwork = 'devnet';
  mockSendConfigLoaded = true;
  jest.clearAllMocks();
  clearSendDraft();
  mockPathname = '/send';
  mockSearch = '';
  mockCardStack = [{ name: SendFlowStep.SelectRecipient }];
  mockRenderRouteName = undefined;
  mockEpochAmount = undefined;
  mockUsdcxTokenId = undefined;
  mockUsdcxWithdrawalNetwork = true;
  mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1 };
  mockSelectedContact = { id: '0xcontact', name: 'Alice', isOwned: false, contactType: 'external' };
  capturedBackHandler = null;
  capturedBackHandlerDeps = null;

  useAccountMock.mockReturnValue({ publicKey: 'me-pk' });
  useAllAccountsMock.mockReturnValue([]);
  mockBaseFee = 0;
  mockBalancesLoading = false;
  mockHiddenTokensLoaded = true;
  mockHiddenTokenIds = new Set();
  mockRpcUrl = 'https://testnet.example';
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

  it.each([SendFlowStep.SelectAmount, SendFlowStep.Route])(
    'hides the top home actions on %s and restores them on back',
    step => {
      mockCardStack = [{ name: step }];
      const view = renderFlow();
      expect(document.body).toHaveAttribute('data-hide-home-actions');
      mockCardStack = [{ name: SendFlowStep.SelectRecipient }];
      view.rerender(<SendFlow isLoading={false} />);
      expect(document.body).not.toHaveAttribute('data-hide-home-actions');
    }
  );

  it('links the amount step fee shortfall notice to Receive', () => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();

    fireEvent.click(screen.getByTestId('sa-receive'));

    expect(navigateMock).toHaveBeenCalledWith('/receive');
  });

  it('asks for the navbar hold past the recipient step on any route, leaving visibility to the hook', () => {
    mockPathname = '/';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();
    expect(useHideNavbarWhileOpenMock).toHaveBeenCalledWith(true);
    expect(useHideNavbarWhileOpenMock).not.toHaveBeenCalledWith(false);
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
  it('binds unexpected validation to the current form error and clears it for an empty recipient', () => {
    renderFlow();
    fireEvent.change(screen.getByTestId('sr-input'), { target: { value: 'not-an-address' } });
    expect(JSON.parse(screen.getByTestId('sr-evidence').textContent!)).toEqual({
      kind: 'recipient_validation',
      recipientValidationStage: 'validator_exception'
    });
    fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '   ' } });
    expect(screen.getByTestId('sr-evidence')).toHaveTextContent('null');
    expect(screen.getByTestId('sr-error')).toBeEmptyDOMElement();
  });

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

  it('selects the first offered network once when Sepolia is not offered', () => {
    mockOfferedNetworks = [
      { id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 },
      { id: 'arc-testnet', name: 'Arc Testnet', chainId: 5042002 }
    ];
    mockBridgeNetworks = mockOfferedNetworks;
    try {
      mockSelectedContact = { id: '0xpicked', name: 'Bob', isOwned: false, contactType: 'external' };
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('ad-select'));
      });

      expect(screen.getByTestId('sr-network')).toHaveTextContent('base-sepolia');
    } finally {
      mockOfferedNetworks = undefined;
      mockBridgeNetworks = [];
    }
  });

  it('selects no network when none is offered', () => {
    mockOfferedNetworks = [];
    mockBridgeNetworks = [{ id: 'sepolia', name: 'Sepolia', chainId: 11155111 }];
    try {
      mockSelectedContact = { id: '0xpicked', name: 'Bob', isOwned: false, contactType: 'external' };
      renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('ad-select'));
      });

      expect(screen.getByTestId('sr-network')).toBeEmptyDOMElement();
    } finally {
      mockOfferedNetworks = undefined;
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

  it('rejects a typed base unit above an 18-decimal token balance', () => {
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 18, balance: 1, fiatPrice: 1, scaleIsKnown: true };
    renderAmountStep();
    selectToken();
    typeAmount('1.000000000000000001');

    expect(screen.getByTestId('sa-error')).toHaveTextContent('amountMustBeLessThanBalance');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
    act(() => fireEvent.click(screen.getByTestId('sa-confirm')));
    expect(navigateToMock).not.toHaveBeenCalled();
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

  it('re-flags a restored over-balance amount after its token is selected', () => {
    setSendDraft({ amount: '1.000000000000000001', recipientAddress: '0xrecip', tokenId: 'T1' });
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 18 }, balance: 1, fiatPrice: 1 }]
    });
    renderAmountStep();

    expect(screen.getByTestId('sa-amount')).toHaveTextContent('1.000000000000000001');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('amountMustBeLessThanBalance');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
  });

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

  it('keeps an amount intact and blocks review when the selected token cannot represent it', () => {
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1, scaleIsKnown: true };
    renderAmountStep();
    act(() => fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '1.123456' } }));
    act(() => fireEvent.click(screen.getByTestId('td-select')));

    expect(screen.getByTestId('sa-amount')).toHaveTextContent('1.123456');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('amountExceedsTokenDecimals');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
    expect(useEpochQuoteMock).toHaveBeenLastCalledWith(expect.objectContaining({ amount: undefined }));
    act(() => fireEvent.click(screen.getByTestId('sa-confirm')));
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('shows the precision error when a finer amount is typed after token selection', () => {
    mockSelectedToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1, scaleIsKnown: true };
    renderAmountStep();
    act(() => fireEvent.click(screen.getByTestId('td-select')));
    act(() => fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '1.123456' } }));

    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('amountExceedsTokenDecimals');
  });

  it('refuses a restored amount the selected token cannot represent before review', () => {
    const amount = '1.123456';
    setSendDraft({
      amount,
      recipientAddress: 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph',
      tokenId: 'T1'
    });
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 2 }, balance: 100, fiatPrice: 1 }]
    });
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    renderFlow();

    act(() => fireEvent.click(screen.getByTestId('sa-confirm')));

    expect(screen.getByTestId('sa-error')).toHaveTextContent('amountExceedsTokenDecimals');
    expect(navigateMock).not.toHaveBeenCalled();
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
  const balanceData = [
    { tokenId: MIDEN_USDC_FAUCET, metadata: { symbol: 'TKN', decimals: 2 }, balance: 42, fiatPrice: 3 }
  ];

  it('preselects the token from the tokenId search param when a balance matches', () => {
    mockSearch = `?tokenId=${MIDEN_USDC_FAUCET}`;
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
  });

  it('preselects the token from a restored draft tokenId', () => {
    setSendDraft({ amount: '7', recipientAddress: '0xrecip', tokenId: MIDEN_USDC_FAUCET });
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    // Draft values seed the form.
    expect(screen.getByTestId('sa-amount')).toHaveTextContent('7');
  });

  it('values a preselected token at its feed price', () => {
    mockSearch = `?tokenId=${MIDEN_USDC_FAUCET}`;
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-fiat-price')).toHaveTextContent(/^3$/);
  });

  it('gives a preselected token the feed does not list no price, not the store $1 default', () => {
    mockSearch = '?tokenId=U1';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: 'U1', metadata: { symbol: 'UNLISTED', decimals: 2 }, balance: 5, fiatPrice: 1 }]
    });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('UNLISTED');
    expect(screen.getByTestId('sa-fiat-price')).toHaveTextContent(/^0$/);
  });

  it('values a preselected swap token at the asset it stands for', () => {
    mockSearch = `?tokenId=${TEST_TOKEN_IETH.faucetId}`;
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: TEST_TOKEN_IETH.faucetId, metadata: { symbol: 'IETH', decimals: 8 }, balance: 2, fiatPrice: 0 }]
    });
    walletStoreState.tokenPrices = { ETH: { price: 3000 } };
    try {
      renderFlow();
      expect(screen.getByTestId('sa-token')).toHaveTextContent('IETH');
      expect(screen.getByTestId('sa-fiat-price')).toHaveTextContent(/^3000$/);
    } finally {
      walletStoreState.tokenPrices = { USDC: { price: 3 } };
    }
  });

  describe('after the user picks another token', () => {
    const T2 = TEST_TOKEN_IBTC.faucetId;
    const threeTokens = (t2Balance = 7) => [
      { tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 2 }, balance: 42, fiatPrice: 0 },
      { tokenId: T2, metadata: { symbol: 'TK2', decimals: 2 }, balance: t2Balance, fiatPrice: 0 },
      { tokenId: 'T3', metadata: { symbol: 'TK3', decimals: 2 }, balance: 9, fiatPrice: 0 }
    ];

    const preselectT1ThenPickT2 = () => {
      mockSearch = '?tokenId=T1';
      mockCardStack = [{ name: SendFlowStep.SelectAmount }];
      mockSelectedToken = { id: T2, name: 'TK2', decimals: 2, balance: 7, fiatPrice: 0, scaleIsKnown: true };
      useAllBalancesMock.mockReturnValue({ data: threeTokens() });
      const utils = renderFlow();
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK2');
      return utils;
    };

    afterEach(() => {
      walletStoreState.tokenPrices = { USDC: { price: 3 } };
    });

    it('keeps the picked token when prices refresh, and gives it the price that lands', () => {
      const { rerender } = preselectT1ThenPickT2();
      walletStoreState.tokenPrices = { USDC: { price: 3 }, BTC: { price: 5 } };
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK2');
      expect(screen.getByTestId('sa-fiat-price')).toHaveTextContent(/^5$/);
    });

    it('keeps the picked token when balances refresh, and copies its new balance', () => {
      const { rerender } = preselectT1ThenPickT2();
      useAllBalancesMock.mockReturnValue({ data: threeTokens(11) });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK2');
      expect(screen.getByTestId('sa-balance')).toHaveTextContent(/^11$/);
    });

    it('applies the same preselection again after it went away', () => {
      const { rerender } = preselectT1ThenPickT2();
      mockSearch = '';
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK2');
      mockSearch = '?tokenId=T1';
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    });

    it('applies a new preselected token once', () => {
      const { rerender } = preselectT1ThenPickT2();
      mockSearch = '?tokenId=T3';
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK3');

      mockSelectedToken = { id: T2, name: 'TK2', decimals: 2, balance: 7, fiatPrice: 0, scaleIsKnown: true };
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      useAllBalancesMock.mockReturnValue({ data: threeTokens() });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK2');
    });

    it('keeps the picked token when a preselected token that was absent appears', () => {
      mockSearch = '?tokenId=T1';
      mockCardStack = [{ name: SendFlowStep.SelectAmount }];
      mockSelectedToken = { id: T2, name: 'TK2', decimals: 2, balance: 7, fiatPrice: 0, scaleIsKnown: true };
      useAllBalancesMock.mockReturnValue({ data: threeTokens().filter(t => t.tokenId !== 'T1') });
      const { rerender } = renderFlow();
      expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      useAllBalancesMock.mockReturnValue({ data: threeTokens() });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK2');
    });

    it('keeps a picked token that leaves the balances at a zero balance the amount step cannot confirm', () => {
      mockCardStack = [{ name: SendFlowStep.SelectAmount }];
      walletStoreState.tokenPrices = { BTC: { price: 5 } };
      mockSelectedToken = { id: T2, name: 'TK2', decimals: 2, balance: 7, fiatPrice: 5, scaleIsKnown: false };
      useAllBalancesMock.mockReturnValue({
        data: [{ tokenId: T2, metadata: { symbol: 'TK2', decimals: 2, scaleIsUnknown: true }, balance: 7 }]
      });
      const { rerender } = renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      act(() => {
        fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '5' } });
      });
      expect(screen.getByTestId('sa-valid')).toHaveTextContent('true');

      useAllBalancesMock.mockReturnValue({ data: threeTokens().filter(t => t.tokenId !== T2) });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent(/^TK2$/);
      expect(screen.getByTestId('sa-token-id')).toHaveTextContent(new RegExp(`^${T2}$`));
      expect(screen.getByTestId('sa-balance')).toHaveTextContent(/^0$/);
      expect(screen.getByTestId('sa-decimals')).toHaveTextContent(/^2$/);
      expect(screen.getByTestId('sa-fiat-price')).toHaveTextContent(/^5$/);
      expect(screen.getByTestId('sa-scale-known')).toHaveTextContent(/^false$/);
      expect(screen.getByTestId('sa-error')).toHaveTextContent('amountMustBeLessThanBalance');
      expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
    });

    it('keeps the balance of a picked token a still-loading snapshot does not list', () => {
      mockCardStack = [{ name: SendFlowStep.SelectAmount }];
      mockSelectedToken = { id: T2, name: 'TK2', decimals: 2, balance: 7, fiatPrice: 0, scaleIsKnown: true };
      mockBalancesLoading = true;
      useAllBalancesMock.mockReturnValue({
        data: [{ tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 0 }]
      });
      const { rerender } = renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      useAllBalancesMock.mockReturnValue({
        data: [{ tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 1 }]
      });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-balance')).toHaveTextContent(/^7$/);
    });
  });

  describe('when the token row gains its real scale', () => {
    const placeholderRow = {
      tokenId: 'T2',
      metadata: { symbol: 'TK2', decimals: 6, scaleIsUnknown: true },
      balance: 7
    };
    const resolvedRow = { tokenId: 'T2', metadata: { symbol: 'TK2', decimals: 8 }, balance: 7 };

    it('rebuilds a preselected token from the resolved row', () => {
      mockSearch = '?tokenId=T2';
      mockCardStack = [{ name: SendFlowStep.SelectAmount }];
      useAllBalancesMock.mockReturnValue({ data: [placeholderRow] });
      const { rerender } = renderFlow();
      expect(screen.getByTestId('sa-decimals')).toHaveTextContent(/^6$/);
      expect(screen.getByTestId('sa-scale-known')).toHaveTextContent('false');
      useAllBalancesMock.mockReturnValue({ data: [resolvedRow] });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-decimals')).toHaveTextContent(/^8$/);
      expect(screen.getByTestId('sa-scale-known')).toHaveTextContent('true');
    });

    it('rebuilds a token picked in the drawer from the resolved row', () => {
      mockCardStack = [{ name: SendFlowStep.SelectAmount }];
      mockSelectedToken = { id: 'T2', name: 'TK2', decimals: 6, balance: 7, fiatPrice: 0, scaleIsKnown: false };
      useAllBalancesMock.mockReturnValue({ data: [placeholderRow] });
      const { rerender } = renderFlow();
      act(() => {
        fireEvent.click(screen.getByTestId('td-select'));
      });
      expect(screen.getByTestId('sa-decimals')).toHaveTextContent(/^6$/);
      useAllBalancesMock.mockReturnValue({ data: [resolvedRow] });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('TK2');
      expect(screen.getByTestId('sa-decimals')).toHaveTextContent(/^8$/);
      expect(screen.getByTestId('sa-scale-known')).toHaveTextContent('true');
    });
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

  it('selects the only sendable token when there is no tokenId', () => {
    mockSearch = '';
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({ data: balanceData });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
  });
});

describe('single sendable token default', () => {
  const native = { tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 10 };
  const other = { tokenId: 'OTHER', metadata: { symbol: 'OTHER', decimals: 6 }, balance: 20 };

  beforeEach(() => {
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
  });

  it('fills only the token and leaves amount, navigation and the picker under user control', () => {
    useAllBalancesMock.mockReturnValue({ data: [native] });
    renderFlow();
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^MIDEN-ID$/);
    expect(screen.getByTestId('sa-amount')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(navigateToMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sa-selecttoken'));
    expect(screen.getByTestId('td-open')).toHaveTextContent('true');
  });

  it.each([{ rows: [] }, { rows: [{ ...native, balance: 0 }] }, { rows: [native, other] }])(
    'leaves no default for $rows',
    ({ rows }) => {
      useAllBalancesMock.mockReturnValue({ data: rows });
      renderFlow();
      expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    }
  );

  it('waits for balance loading and then selects from the resolved snapshot', () => {
    mockBalancesLoading = true;
    useAllBalancesMock.mockReturnValue({ data: [native] });
    const { rerender } = renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    mockBalancesLoading = false;
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^MIDEN-ID$/);
  });

  it('waits for wallet and hidden-token loading, and excludes hidden tokens', () => {
    mockHiddenTokensLoaded = false;
    mockHiddenTokenIds = new Set(['OTHER']);
    useAllBalancesMock.mockReturnValue({ data: [native, other] });
    const { rerender } = renderFlow(true);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    mockHiddenTokensLoaded = true;
    rerender(<SendFlow isLoading={true} />);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^MIDEN-ID$/);
  });

  it('does not default an unknown scale, then selects once its metadata resolves', () => {
    useAllBalancesMock.mockReturnValue({ data: [{ ...other, metadata: { ...other.metadata, scaleIsUnknown: true } }] });
    const { rerender } = renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    useAllBalancesMock.mockReturnValue({ data: [other] });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^OTHER$/);
  });

  it('excludes a native balance held entirely by the fee reserve', () => {
    mockBaseFee = 1_000_000;
    useAllBalancesMock.mockReturnValue({ data: [native, other] });
    renderFlow();
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^OTHER$/);
  });

  it('leaves no default when the account cannot pay the known fee', () => {
    mockBaseFee = 1_000_000;
    useAllBalancesMock.mockReturnValue({ data: [{ ...native, balance: 0 }, other] });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-error')).toHaveTextContent('insufficientFeeAsset');
  });

  it('keeps a manual choice across later balance and price refreshes', () => {
    useAllBalancesMock.mockReturnValue({ data: [native] });
    const { rerender } = renderFlow();
    mockSelectedToken = { id: 'OTHER', name: 'OTHER', decimals: 6, balance: 20, fiatPrice: 0, scaleIsKnown: true };
    fireEvent.click(screen.getByTestId('td-select'));
    useAllBalancesMock.mockReturnValue({ data: [native, other] });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^OTHER$/);
  });

  it('keeps an existing default when another funded token arrives', () => {
    useAllBalancesMock.mockReturnValue({ data: [native] });
    const { rerender } = renderFlow();
    useAllBalancesMock.mockReturnValue({ data: [native, other] });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^MIDEN-ID$/);
  });

  it('clears an exhausted automatic token and waits when no candidate remains', () => {
    useAllBalancesMock.mockReturnValue({ data: [native] });
    const { rerender } = renderFlow();
    fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '2' } });
    useAllBalancesMock.mockReturnValue({ data: [{ ...native, balance: 0 }] });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-amount')).toBeEmptyDOMElement();
  });

  it('resets token and amount on an account change and waits for its balances', () => {
    useAllBalancesMock.mockReturnValue({ data: [native] });
    const { rerender } = renderFlow();
    fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '2' } });
    useAccountMock.mockReturnValue({ publicKey: 'new-account' });
    mockBalancesLoading = true;
    useAllBalancesMock.mockReturnValue({ data: undefined });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-amount')).toBeEmptyDOMElement();
    mockBalancesLoading = false;
    useAllBalancesMock.mockReturnValue({ data: [other] });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^OTHER$/);
  });

  it('resets on an effective network change and does not reuse the old balance snapshot', () => {
    useAllBalancesMock.mockReturnValue({ data: [native] });
    const { rerender } = renderFlow();
    fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '2' } });
    mockRpcUrl = 'https://devnet.example';
    // The save that changed the network dropped every cached balance.
    mockBalancesLoading = true;
    useAllBalancesMock.mockReturnValue({ data: undefined });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-amount')).toBeEmptyDOMElement();
    mockBalancesLoading = false;
    useAllBalancesMock.mockReturnValue({ data: [other] });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^OTHER$/);
  });

  it('waits for a new snapshot when the account and the network change in the same render', () => {
    useAllBalancesMock.mockReturnValue({ data: [native] });
    const { rerender } = renderFlow();
    useAccountMock.mockReturnValue({ publicKey: 'new-account' });
    mockRpcUrl = 'https://devnet.example';
    // The save that changed the network dropped every cached balance, the new account's too.
    mockBalancesLoading = true;
    useAllBalancesMock.mockReturnValue({ data: undefined });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    mockBalancesLoading = false;
    useAllBalancesMock.mockReturnValue({ data: [other] });
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^OTHER$/);
  });

  it('selects only a destination-compatible token after the network changes', () => {
    mockUsdcxTokenId = 'OTHER';
    mockCardStack = [{ name: SendFlowStep.SelectRecipient }];
    useAllBalancesMock.mockReturnValue({ data: [native, other] });
    const { rerender } = renderFlow();
    fireEvent.change(screen.getByTestId('sr-input'), { target: { value: '0xrecip' } });
    fireEvent.click(screen.getByTestId('sr-network-arc-testnet'));
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^OTHER$/);
  });

  describe('with the real balance hook', () => {
    const { useAllBalances } = jest.requireActual<typeof import('lib/miden/front/balance')>('lib/miden/front/balance');
    const store = realWalletStore();
    const noMetadata = {};
    const land = (address: string, rows: any[]) =>
      store.setState(state => ({
        balances: { ...state.balances, [address]: rows },
        balancesLoading: { ...state.balancesLoading, [address]: false },
        balancesLastFetched: { ...state.balancesLastFetched, [address]: Date.now() }
      }));
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
      store.setState({ balances: {}, balancesLoading: {}, balancesLastFetched: {} });
      land('me-pk', [native]);
      useAllBalancesMock.mockImplementation((address = '') => useAllBalances(address, noMetadata));
      // React only warns about an effect that re-renders forever, and the loop never ends; failing on the warning does.
      const consoleError = console.error;
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).includes('Maximum update depth exceeded')) throw new Error(String(args[0]));
        consoleError(...args);
      });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it('settles after switching to an account with no cached balances', () => {
      const { rerender } = renderFlow();
      expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^MIDEN-ID$/);
      useAccountMock.mockReturnValue({ publicKey: 'uncached-pk' });
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
      expect(screen.getByTestId('sa-amount')).toBeEmptyDOMElement();
    });

    describe('after a network change drops the cached balances', () => {
      const fresh = { tokenId: 'FRESH', metadata: { symbol: 'FRESH', decimals: 6 }, balance: 3 };
      // What a Developer Settings save does in this realm.
      const saveNewNetwork = () => {
        mockRpcUrl = 'https://devnet.example';
        store.getState().clearBalances();
      };

      beforeEach(() => land('other-pk', [other]));

      it('chooses no token for an account whose rows were cached before the change until its new snapshot lands', () => {
        const { rerender } = renderFlow();
        expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^MIDEN-ID$/);
        saveNewNetwork();
        rerender(<SendFlow isLoading={false} />);
        useAccountMock.mockReturnValue({ publicKey: 'other-pk' });
        rerender(<SendFlow isLoading={false} />);
        expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
        land('other-pk', [fresh]);
        rerender(<SendFlow isLoading={false} />);
        expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^FRESH$/);
      });

      it('chooses no token in a Send screen mounted after the change until a new snapshot lands', () => {
        saveNewNetwork();
        const { rerender } = renderFlow();
        expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
        land('me-pk', [fresh]);
        rerender(<SendFlow isLoading={false} />);
        expect(screen.getByTestId('sa-token-id')).toHaveTextContent(/^FRESH$/);
      });
    });
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
// Fast-route fee: only a priced token of known scale has a dollar input.
// ---------------------------------------------------------------------------
describe('fast-route fee', () => {
  const renderRouteStep = (metadata: Record<string, unknown>, tokenId = 'T1', { amount = '5', quote = '4' } = {}) => {
    setSendDraft({ amount, recipientAddress: '0xrecip', tokenId });
    mockCardStack = [{ name: SendFlowStep.Route }];
    mockEpochAmount = quote;
    useAllBalancesMock.mockReturnValue({ data: [{ tokenId, metadata, balance: 42, fiatPrice: 0 }] });
    renderFlow();
    return screen.getByTestId('route-fee');
  };

  it('is the dollar input less the quoted USDC for a priced token', () => {
    expect(renderRouteStep({ symbol: 'TKN', decimals: 2 }, MIDEN_USDC_FAUCET)).toHaveTextContent(/^11$/);
  });

  it('is absent for a token the feed does not price, not $0', () => {
    expect(renderRouteStep({ symbol: 'UNLISTED', decimals: 2 })).toHaveTextContent(/^undefined$/);
  });

  it('is absent for a priced token whose scale is unknown', () => {
    expect(renderRouteStep({ symbol: 'TKN', decimals: 2, scaleIsUnknown: true }, MIDEN_USDC_FAUCET)).toHaveTextContent(
      /^undefined$/
    );
  });

  // The nominal $1 is a display figure, so 1000 tokens at it are not $1000 the user sends.
  it('is absent for a token valued only at the nominal $1, not the $995 it would invent', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    try {
      expect(
        renderRouteStep({ symbol: 'IMIDEN', decimals: 2 }, 'T1', { amount: '1000', quote: '5' })
      ).toHaveTextContent(/^undefined$/);
    } finally {
      mockedHasUnquotedDefaultPrice.mockReturnValue(false);
    }
  });

  it('stops using the sent token quote once it expires, without any other update', () => {
    jest.useFakeTimers();
    try {
      walletStoreState.tokenPrices = {
        USDC: { price: 3, observedAt: Date.now() }
      } as typeof walletStoreState.tokenPrices;
      const fee = renderRouteStep({ symbol: 'TKN', decimals: 2 }, MIDEN_USDC_FAUCET);
      expect(fee).toHaveTextContent(/^11$/);

      act(() => {
        jest.advanceTimersByTime(USD_QUOTE_MAX_AGE_MS + 1);
      });

      expect(screen.getByTestId('route-fee')).toHaveTextContent(/^undefined$/);
    } finally {
      jest.useRealTimers();
      walletStoreState.tokenPrices = { USDC: { price: 3 } };
    }
  });

  it('keeps the fee of a token the feed prices while the nominal rate is on', () => {
    mockedHasUnquotedDefaultPrice.mockReturnValue(true);
    try {
      expect(renderRouteStep({ symbol: 'TKN', decimals: 2 }, MIDEN_USDC_FAUCET)).toHaveTextContent(/^11$/);
    } finally {
      mockedHasUnquotedDefaultPrice.mockReturnValue(false);
    }
  });
});

// ---------------------------------------------------------------------------
// USDCx withdrawal: the token decides the route, the destinations and the Epoch quote.
// ---------------------------------------------------------------------------
describe('USDCx withdrawal wiring', () => {
  const usdcxToken = { id: 'USDCX', name: 'USDCx', decimals: 6, balance: 100, fiatPrice: 1 };
  const otherToken = { id: 'T1', name: 'TKN', decimals: 2, balance: 100, fiatPrice: 1 };

  const pickToken = (token: typeof usdcxToken) => {
    mockSelectedToken = token;
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
  };

  const pickEvmRecipient = () => {
    mockSelectedContact = { id: '0xrecip', name: 'R', isOwned: false, contactType: 'external' };
    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });
  };

  const offeredNetworks = () => JSON.parse(screen.getByTestId('sr-networks').textContent!);

  beforeEach(() => {
    mockUsdcxTokenId = usdcxToken.id;
  });

  it('switches the route to USDCx for the USDCx token and back to Epoch for another', () => {
    mockCardStack = [{ name: SendFlowStep.Route }];
    renderFlow();
    pickEvmRecipient();
    expect(screen.getByTestId('route-selected')).toHaveTextContent(/^epoch$/);

    pickToken(usdcxToken);
    expect(screen.getByTestId('route-selected')).toHaveTextContent(/^usdcx$/);
    expect(screen.getByTestId('route-usdcx')).toHaveTextContent(/^true$/);

    pickToken(otherToken);
    expect(screen.getByTestId('route-selected')).toHaveTextContent(/^epoch$/);
    expect(screen.getByTestId('route-usdcx')).toHaveTextContent(/^false$/);
  });

  it('keeps Arc selected and clears another token picked after USDCx', () => {
    const { rerender } = renderFlow();
    pickToken(usdcxToken);
    pickEvmRecipient();
    expect(screen.getByTestId('sr-network')).toHaveTextContent(/^arc-testnet$/);

    pickToken(otherToken);
    expect(screen.getByTestId('sr-network')).toHaveTextContent(/^arc-testnet$/);
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
  });

  it('offers all bridge destinations before and after token selection', () => {
    renderFlow();
    expect(offeredNetworks()).toEqual(['arc-testnet', 'sepolia', 'arbitrum-sepolia', 'base-sepolia']);
    pickToken(usdcxToken);
    pickEvmRecipient();
    expect(offeredNetworks()).toEqual(['arc-testnet', 'sepolia', 'arbitrum-sepolia', 'base-sepolia']);

    pickToken(otherToken);
    expect(offeredNetworks()).toEqual(['arc-testnet', 'sepolia', 'arbitrum-sepolia', 'base-sepolia']);
  });

  it('offers Sepolia alone where USDCx withdrawals do not exist and moves a saved USDCx-only destination there', () => {
    mockUsdcxWithdrawalNetwork = false;
    const { rerender } = renderFlow();
    pickToken(otherToken);
    mockSelectedContact = { id: '0xrecip', name: 'R', isOwned: false, contactType: 'external', network: 'arc-testnet' };
    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });

    expect(offeredNetworks()).toEqual(['sepolia']);
    expect(screen.getByTestId('sr-network')).toHaveTextContent(/^sepolia$/);
    expect(screen.getByTestId('td-usdcx-only')).toHaveTextContent('false');
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
  });

  it('moves a USDCx-only destination to Sepolia when the effective network stops offering it', () => {
    const { rerender } = renderFlow();
    pickEvmRecipient();
    fireEvent.click(screen.getByTestId('sr-network-arc-testnet'));
    expect(screen.getByTestId('sr-network')).toHaveTextContent(/^arc-testnet$/);

    mockUsdcxWithdrawalNetwork = false;
    rerender(<SendFlow isLoading={false} />);
    expect(screen.getByTestId('sr-network')).toHaveTextContent(/^sepolia$/);
  });

  it.each(['arc-testnet', 'base-sepolia', 'arbitrum-sepolia'])(
    'keeps %s selected and clears an unsupported token',
    network => {
      const { rerender } = renderFlow();
      pickToken(otherToken);
      fireEvent.click(screen.getByTestId(`sr-network-${network}`));
      pickEvmRecipient();
      expect(screen.getByTestId('sr-network')).toHaveTextContent(network);
      expect(screen.getByTestId('td-usdcx-only')).toHaveTextContent('true');
      mockCardStack = [{ name: SendFlowStep.SelectAmount }];
      rerender(<SendFlow isLoading={false} />);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
      pickToken(otherToken);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
      pickToken(usdcxToken);
      expect(screen.getByTestId('sa-token')).toHaveTextContent('USDCx');
    }
  );

  it('disables the Epoch quote on the USDCx path and enables it for another token on the same bridge send', () => {
    renderFlow();
    pickToken(usdcxToken);
    pickEvmRecipient();
    expect(useEpochQuoteMock).toHaveBeenLastCalledWith(expect.objectContaining({ faucetId: 'USDCX', enabled: false }));

    fireEvent.click(screen.getByTestId('sr-network-sepolia'));
    pickToken(otherToken);
    expect(useEpochQuoteMock).toHaveBeenLastCalledWith(expect.objectContaining({ faucetId: 'T1', enabled: true }));
  });

  // Circle takes a flat ~1.0035 USDC from a Sepolia payout; the allowance a burn there must exceed is 1.5 USDC.
  it('blocks a USDCx amount the Sepolia fee allowance takes whole, naming the allowance and the network', () => {
    // Six decimals, as USDCx has; the shared mock drops them.
    stringToBigIntMock.mockImplementation((s: string) => BigInt(Math.round(parseFloat(s) * 1_000_000)));
    setSendDraft({
      amount: '1.5',
      recipientAddress: '0xrecip',
      tokenId: usdcxToken.id,
      bridgeNetwork: 'sepolia',
      bridgeRoute: 'usdcx'
    });
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: usdcxToken.id, metadata: { symbol: 'USDCx', decimals: 6 }, balance: 100, fiatPrice: 0 }]
    });
    renderFlow();

    expect(screen.getByTestId('sa-error')).toHaveTextContent(/^usdcxSendMoreThanPayoutFee$/);
    expect(screen.getByTestId('sa-error-values')).toHaveTextContent('{"amount":"1.5","network":"Sepolia"}');
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('false');

    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value: '1.500001' } });
    });
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent('true');
  });

  it("hands the Route step the USDCx burn's destination chain and its amount in base units", () => {
    // Six decimals, as USDCx has; the shared mock drops them.
    stringToBigIntMock.mockImplementation((s: string) => BigInt(Math.round(parseFloat(s) * 1_000_000)));
    setSendDraft({
      amount: '2.5',
      recipientAddress: '0xrecip',
      tokenId: usdcxToken.id,
      bridgeNetwork: 'sepolia',
      bridgeRoute: 'usdcx'
    });
    mockCardStack = [{ name: SendFlowStep.Route }];
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: usdcxToken.id, metadata: { symbol: 'USDCx', decimals: 6 }, balance: 100, fiatPrice: 0 }]
    });
    renderFlow();
    expect(screen.getByTestId('route-usdcx-payout')).toHaveTextContent(/^11155111:2500000$/);

    pickToken(otherToken);
    expect(screen.getByTestId('route-usdcx-payout')).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// The measured fee reserve of a USDCx burn of the native token.
// ---------------------------------------------------------------------------
describe('USDCx burn fee reserve', () => {
  // 9.909734 USDCx at base fee 7: the static reserve holds back 210 base units (cap 9.909524) and the measured one
  // 315 (cap 9.909419), so 9.9095 fits only the static cap.
  const NATIVE = 'MIDEN-ID';
  const never = () => new Promise<UsdcxBurnFeeEstimate>(() => {});
  const measured = (reserve: bigint): UsdcxBurnFeeEstimate => ({ outcome: 'measured', reserve });

  const openBurn = (step: SendFlowStep, amount = '') => {
    setSendDraft({
      amount,
      recipientAddress: '0xrecip',
      tokenId: NATIVE,
      bridgeNetwork: 'arc-testnet',
      bridgeRoute: 'usdcx'
    });
    mockCardStack = [{ name: step }];
    return renderFlow();
  };

  const typeAmount = (value: string) => {
    act(() => {
      fireEvent.change(screen.getByTestId('sa-input'), { target: { value } });
    });
  };

  beforeEach(() => {
    mockUsdcxTokenId = NATIVE;
    mockBaseFee = 7;
    stringToBigIntMock.mockImplementation((s: string) => BigInt(Math.round(parseFloat(s) * 1_000_000)));
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: NATIVE, metadata: { symbol: 'USDCx', decimals: 6 }, balance: 9.909734, fiatPrice: 0 }]
    });
    mockEstimateUsdcxBurnFee.mockReset().mockImplementation(never);
  });

  it('disables Max and Continue and says the fee is being measured before any amount is typed', () => {
    openBurn(SendFlowStep.SelectAmount);

    expect(screen.getByTestId('sa-max-disabled')).toHaveTextContent(/^true$/);
    expect(screen.getByTestId('sa-valid')).toHaveTextContent(/^false$/);
    expect(screen.getByTestId('sa-error')).toHaveTextContent(/^usdcxBurnFeeMeasuring$/);
    expect(mockEstimateUsdcxBurnFee).toHaveBeenCalledTimes(1);
  });

  it('keeps the measuring message and Continue disabled for an amount below the static cap', () => {
    openBurn(SendFlowStep.SelectAmount);

    typeAmount('5');

    expect(screen.getByTestId('sa-error')).toHaveTextContent(/^usdcxBurnFeeMeasuring$/);
    expect(screen.getByTestId('sa-valid')).toHaveTextContent(/^false$/);
  });

  it('keeps Max and Continue disabled with the failure message once the estimate and its retry fail', async () => {
    mockEstimateUsdcxBurnFee.mockResolvedValue({ outcome: 'failed' });
    openBurn(SendFlowStep.SelectAmount);

    await waitFor(() => expect(mockEstimateUsdcxBurnFee).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('sa-error')).toHaveTextContent(/^usdcxBurnFeeUnavailable$/));
    typeAmount('5');

    expect(screen.getByTestId('sa-error')).toHaveTextContent(/^usdcxBurnFeeUnavailable$/);
    expect(screen.getByTestId('sa-max-disabled')).toHaveTextContent(/^true$/);
    expect(screen.getByTestId('sa-valid')).toHaveTextContent(/^false$/);
    expect(mockEstimateUsdcxBurnFee).toHaveBeenCalledTimes(2);
  });

  it('caps the amount at the measured reserve once it lands', async () => {
    mockEstimateUsdcxBurnFee.mockResolvedValue(measured(315n));
    openBurn(SendFlowStep.SelectAmount);
    await act(async () => {});

    expect(screen.getByTestId('sa-max-disabled')).toHaveTextContent(/^false$/);
    expect(Number(screen.getByTestId('sa-balance').textContent)).toBeCloseTo(9.909419, 6);
    typeAmount('9.9095');
    expect(screen.getByTestId('sa-error')).toHaveTextContent(/^amountMustBeLessThanBalance$/);
  });

  it('measures once per account and chain, not again for another recipient', async () => {
    mockEstimateUsdcxBurnFee.mockResolvedValue(measured(315n));
    openBurn(SendFlowStep.SelectAmount);
    await act(async () => {});

    mockSelectedContact = { id: '0xother', name: 'Other', isOwned: false, contactType: 'external' };
    act(() => {
      fireEvent.click(screen.getByTestId('ad-select'));
    });
    await act(async () => {});

    expect(screen.getByTestId('sa-recipient')).toHaveTextContent(/^0xother$/);
    expect(mockEstimateUsdcxBurnFee).toHaveBeenCalledTimes(1);
    expect(mockEstimateUsdcxBurnFee).toHaveBeenCalledWith('me-pk', 5042002);
  });

  it('refuses review from the Route step while the fee is measured and for an amount the measured reserve exceeds', async () => {
    let land: (estimate: UsdcxBurnFeeEstimate) => void = () => {};
    mockEstimateUsdcxBurnFee.mockImplementation(
      () =>
        new Promise(resolve => {
          land = resolve;
        })
    );
    // Accepted under the static cap, which the old flow applied while the dry run ran.
    openBurn(SendFlowStep.Route, '9.9095');

    fireEvent.click(screen.getByTestId('route-confirm'));
    expect(navigateMock).not.toHaveBeenCalled();

    await act(async () => land(measured(315n)));
    fireEvent.click(screen.getByTestId('route-confirm'));

    expect(navigateMock).not.toHaveBeenCalled();
    expect(consumeSendDraft()).toBeNull();
  });

  it('compares a typed base unit before handing a native burn from Route to review', async () => {
    const amount = '1.000000000000000001';
    mockBaseFee = 0;
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: NATIVE, metadata: { symbol: 'MIDEN', decimals: 18 }, balance: 1, fiatPrice: 0 }]
    });
    mockEstimateUsdcxBurnFee.mockResolvedValue(measured(0n));
    openBurn(SendFlowStep.Route, amount);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('route-confirm'));

    expect(navigateMock).not.toHaveBeenCalled();
    expect(consumeSendDraft()).toBeNull();
  });

  it('hands an amount the measured reserve covers to review', async () => {
    mockEstimateUsdcxBurnFee.mockResolvedValue(measured(315n));
    openBurn(SendFlowStep.Route, '9.9094');
    await act(async () => {});

    fireEvent.click(screen.getByTestId('route-confirm'));

    expect(navigateMock).toHaveBeenCalledWith(expect.stringMatching(/^\/send\/review\?/));
  });

  // A burn that costs nothing is a measurement, so the static cap applies, and it keeps the full balance on a zero fee.
  it('enables Max for the full balance under a measured zero reserve at a zero base fee', async () => {
    mockBaseFee = 0;
    mockEstimateUsdcxBurnFee.mockResolvedValue(measured(0n));
    openBurn(SendFlowStep.SelectAmount);
    await act(async () => {});

    expect(screen.getByTestId('sa-max-disabled')).toHaveTextContent(/^false$/);
    expect(screen.getByTestId('sa-balance')).toHaveTextContent(/^9\.909734$/);
    typeAmount('9.909734');
    expect(screen.getByTestId('sa-error')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-valid')).toHaveTextContent(/^true$/);
  });

  it('hands the full balance to review under a measured zero reserve at a zero base fee', async () => {
    mockBaseFee = 0;
    mockEstimateUsdcxBurnFee.mockResolvedValue(measured(0n));
    openBurn(SendFlowStep.Route, '9.909734');
    await act(async () => {});

    fireEvent.click(screen.getByTestId('route-confirm'));

    expect(navigateMock).toHaveBeenCalledWith(expect.stringMatching(/^\/send\/review\?/));
  });
});

it('does not preselect the retired Epoch faucet from a Testnet token-page link', () => {
  mockSendNetwork = 'testnet';
  mockSearch = `?tokenId=${MIDEN_USDC_FAUCET}`;
  useAllBalancesMock.mockReturnValue({
    data: [{ tokenId: MIDEN_USDC_FAUCET, metadata: { symbol: 'USDC', decimals: 6 }, balance: 100 }]
  });
  mockRenderRouteName = SendFlowStep.SelectAmount;
  renderFlow();
  expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
  expect(screen.getByTestId('sa-token-held')).toHaveTextContent('false');
});

describe('Testnet send while no bridge config document has arrived', () => {
  const T1_ROW = { tokenId: 'T1', metadata: { symbol: 'TKN', decimals: 2 }, balance: 42, fiatPrice: 3 };
  const NATIVE_ROW = { tokenId: 'MIDEN-ID', metadata: { symbol: 'MIDEN', decimals: 6 }, balance: 10, fiatPrice: 0 };
  const pickNative = () => {
    mockSelectedToken = { id: 'MIDEN-ID', name: 'MIDEN', decimals: 6, balance: 10, fiatPrice: 0 };
    act(() => {
      fireEvent.click(screen.getByTestId('td-select'));
    });
  };
  const acceptDocument = () =>
    act(() => {
      mockSendConfigLoaded = true;
      publishMockBridgeSnapshot();
    });

  beforeEach(() => {
    mockSendNetwork = 'testnet';
    mockSendConfigLoaded = false;
    mockCardStack = [{ name: SendFlowStep.SelectAmount }];
  });

  it('keeps a restored draft whole until the document names its token as the retired faucet', () => {
    setSendDraft({ amount: '7', recipientAddress: '0xrecip', tokenId: MIDEN_USDC_FAUCET });
    useAllBalancesMock.mockReturnValue({
      data: [{ tokenId: MIDEN_USDC_FAUCET, metadata: { symbol: 'TKN', decimals: 2 }, balance: 42, fiatPrice: 3 }]
    });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    expect(screen.getByTestId('sa-amount')).toHaveTextContent('7');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('true');

    acceptDocument();

    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-amount')).toBeEmptyDOMElement();
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('false');
  });

  it('says why a linked token is not applied, and applies it with no notice once the document arrives', () => {
    mockSearch = '?tokenId=T1';
    useAllBalancesMock.mockReturnValue({ data: [T1_ROW] });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('true');

    acceptDocument();

    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('false');
  });

  it('says why a restored draft cannot continue, keeping its token and amount, until the document arrives', () => {
    isValidMidenAddressMock.mockImplementation((addr: string) => addr === 'mtst1recipient');
    setSendDraft({ amount: '7', recipientAddress: 'mtst1recipient', tokenId: 'T1' });
    useAllBalancesMock.mockReturnValue({ data: [T1_ROW] });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    expect(screen.getByTestId('sa-amount')).toHaveTextContent('7');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('true');
    act(() => {
      fireEvent.click(screen.getByTestId('sa-confirm'));
    });
    expect(navigateMock).not.toHaveBeenCalled();

    acceptDocument();

    expect(screen.getByTestId('sa-token')).toHaveTextContent('TKN');
    expect(screen.getByTestId('sa-amount')).toHaveTextContent('7');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('false');
    act(() => {
      fireEvent.click(screen.getByTestId('sa-confirm'));
    });
    expect(navigateMock).toHaveBeenCalledWith(expect.stringMatching(/^\/send\/review\?/));
  });

  it("leaves a held row to the picker's notice while nothing is linked or chosen", () => {
    useAllBalancesMock.mockReturnValue({ data: [T1_ROW] });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('false');
  });

  it('shows no held notice for the native token chosen beside a held row', () => {
    useAllBalancesMock.mockReturnValue({ data: [NATIVE_ROW, T1_ROW] });
    renderFlow();
    pickNative();
    expect(screen.getByTestId('sa-token-id')).toHaveTextContent('MIDEN-ID');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('false');
  });

  it('drops a held link from the notice once the user picks the native token instead', () => {
    mockSearch = '?tokenId=T1';
    useAllBalancesMock.mockReturnValue({ data: [NATIVE_ROW, T1_ROW] });
    renderFlow();
    expect(screen.getByTestId('sa-token')).toHaveTextContent('no-token');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('true');

    pickNative();

    expect(screen.getByTestId('sa-token-id')).toHaveTextContent('MIDEN-ID');
    expect(screen.getByTestId('sa-token-held')).toHaveTextContent('false');
  });
});
