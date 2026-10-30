import React from 'react';

import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';

import { SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { applyOverrideFor } from 'lib/miden/metadata/overrides';
import { SpendingLimitAuthorization } from 'lib/miden/spending-limits/types';
import { _resetNormalizedFaucetIdsForTest } from 'lib/miden/swap/faucet-ids';
import { SwapPair } from 'lib/miden/swap/tokens';
import { TokenPrices } from 'lib/prices/binance';
import type { GeoLookup } from 'lib/remote-config/geo';
import { parseBridgeConfig, type BridgeConfig } from 'lib/remote-config/schema';
import testnet from 'lib/remote-config/testing/testnet.json';
import { ROUTE_DWELL_MS } from 'lib/telemetry/use-route-dwell';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

// Import after the mocks are registered.
import { SwapFlow } from './SwapManager';

// ---------------------------------------------------------------------------
// Fixture tokens. Prefixed `mock` so the hoisted jest.mock factories may close
// over them. Default flow: offer = AAA (index 0), request = BBB (index 1).
// ---------------------------------------------------------------------------
const mockTokenA = { symbol: 'AAA', faucetId: 'faucet-A', decimals: 8, logoSymbol: 'MIDEN' };
const mockTokenB = { symbol: 'BBB', faucetId: 'faucet-B', decimals: 8, logoSymbol: 'ETH' };
const mockTokenC = { symbol: 'CCC', faucetId: 'faucet-C', decimals: 8, logoSymbol: 'BTC' };

// Mutable module-level state driven per test (all `mock`-prefixed for hoisting).
let mockRenderedRoutes: Array<{ name: string }>;
let mockPathname = '/swap';
let mockNav: { navigateTo: jest.Mock; goBack: jest.Mock; cardStack: Array<{ name: string }> };
let mockBackHandler: (() => boolean) | null;
let mockWalletState: {
  tokenPrices: TokenPrices;
  isTransactionModalOpen: boolean;
  lastCompletedTxHash: string | null;
  closeTransactionModal: jest.Mock;
  setLastCompletedTxHash: jest.Mock;
  assessSpendingLimit: jest.Mock;
  readSpendingLimit: jest.Mock;
};
/** The hook's state, with the quote's fields loosened to what the manager and the stubs read. */
let mockReceiveQuoteCache = new Map<string, NonNullable<typeof mockSwapQuoteResult.quote>>();
let mockSwapQuoteResult: {
  loading: boolean;
  quote?: {
    price: Record<string, unknown>;
    requestedAmount: bigint;
    builtAsk: boolean;
    eta: Record<string, unknown>;
    fetchedAt: number;
  };
  error?: string;
  errorCode?: string;
};
let mockBalanceData: Array<{ tokenId: string; balance: number }>;
let mockAllBalancesReturn: { data?: Array<{ tokenId: string; balance: number }> };
let mockMetadata: Record<string, unknown>;
let mockAccountReturn: { publicKey: string };

// Latest props captured from the mocked children so tests can invoke callbacks
// with precise arguments (e.g. the drawer's `onSelect(token)`).
let mockDrawerProps: {
  open: boolean;
  currentFaucetId?: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: typeof mockTokenA) => void;
};

const mockGetSwapTokens = jest.fn(() => [mockTokenA, mockTokenB, mockTokenC]);
const mockUseSwapQuote = jest.fn();
// The pre-submit check: answers the quote the hook holds at the time of the press.
const mockQuoteNow = jest.fn();
const mockUseAccount = jest.fn(() => mockAccountReturn);
const mockUseAllBalances = jest.fn((_pk: string, _md: Record<string, unknown>) => mockAllBalancesReturn);
const mockUseAllTokensBaseMetadata = jest.fn(() => mockMetadata);
const mockParseBech32 = (id: string) => {
  if (id.includes('_') || /^0x/i.test(id)) throw new Error(`Invalid bech32 account: ${id}`);
  return { toString: () => id };
};
const mockAccountIdStringToSdk = jest.fn(mockParseBech32);
const mockAccountRefToSdk = (id: string) => {
  const ref = id.split('_')[0] ?? id;
  const parsed = /^0x/i.test(ref) ? ref.toLowerCase() : ref;
  return { toString: () => parsed };
};
// As the SDK's re-encode does, an id already in the fake bech32 form maps to itself.
const mockFakeBech32 = (id: { toString(): string }) => {
  const s = id.toString();
  return s.startsWith('bech32-') ? s : `bech32-${s}`;
};
const mockGetBech32 = jest.fn(mockFakeBech32);
const mockConfirmSensitive = jest.fn().mockResolvedValue(true);
const mockFormatBigInt = jest.fn((amount: bigint, _decimals: number) => amount.toString());
const mockStringToBigInt = jest.fn((str: string, _decimals: number) => BigInt(Math.trunc(Number(str) || 0)));
const mockInitiateSwap = jest.fn().mockResolvedValue('tx-1');
const mockVaultPreflight = jest.fn().mockResolvedValue(undefined);
jest.mock('lib/miden/swap/balance', () => ({
  assertSwapVaultBalance: (...args: unknown[]) => mockVaultPreflight(...args)
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  cacheScope: () => mockNetworkScope
}));
const mockRequestSWProcessing = jest.fn();
const mockIsExtension = jest.fn(() => true);
const mockIsDelegateProof = jest.fn(() => false);
const mockNavigate = jest.fn();
const mockFetchOneClickAssets = jest.fn();
let mockBridgeConfig: BridgeConfig | null;
let mockGeo: GeoLookup | undefined;

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// `react-i18next` — echo the key back so we can assert against raw keys.
let mockNetworkScope = 'testnet|rpc';
let mockBaseFee: number | null = 0;
jest.mock('app/hooks/useVerificationBaseFee', () => ({ __esModule: true, default: () => mockBaseFee }));
let mockNativeFaucetId: string | null = 'MIDEN-ID';
let mockLegacyFeeIdentity: string | undefined;
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockLegacyFeeIdentity ?? mockNativeFaucetId
}));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => mockNativeFaucetId }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `components/Navigator` — replace the animated stack with a controllable stub:
// render `renderRoute` for each route in `mockRenderedRoutes` (so both flow
// steps mount at once for a single SwapManager instance), and hand back a
// controllable navigator context.
jest.mock('components/Navigator', () => ({
  useNavigator: () => mockNav,
  NavigatorProvider: ({ children }: { children: React.ReactNode }) => children,
  Navigator: ({ renderRoute }: { renderRoute: (route: { name: string }, index: number) => React.ReactNode }) =>
    mockRenderedRoutes.map((route, index) => (
      <div key={route.name} data-nav-route={route.name}>
        {renderRoute(route, index)}
      </div>
    ))
}));

// The three swap-flow children are exercised by their own suites; stub them to
// thin harnesses that surface every prop and forward every callback.
let mockRealSwapDisplays = false;
let mockRealSwapAmounts = false;
jest.mock('./SwapAmounts', () => {
  const { AmountInput } = jest.requireActual<typeof import('components/AmountInput')>('components/AmountInput');
  return {
    SwapAmounts: (props: import('./SwapAmounts').SwapAmountsProps) => (
      <div data-testid="swap-amounts">
        {mockRealSwapAmounts &&
          React.createElement(jest.requireActual<typeof import('./SwapAmounts')>('./SwapAmounts').SwapAmounts, props)}
        <span data-testid="sa-offer-token">{props.offerToken.symbol}</span>
        <span data-testid="sa-request-token">{props.requestToken.symbol}</span>
        <span data-testid="sa-offer-balance">{String(props.offerBalance)}</span>
        <span data-testid="sa-offer-amount">{props.offerAmount}</span>
        <span data-testid="sa-request-amount">{props.requestAmount}</span>
        <span data-testid="sa-can-proceed">{String(props.canProceed)}</span>
        <span data-testid="sa-status">{props.statusMessage ?? ''}</span>
        <span data-testid="sa-status-error">{String(props.statusIsError)}</span>
        <span data-testid="sa-request-loading">{String(props.requestLoading)}</span>
        <span data-testid="sa-offer-loading">{String(props.offerLoading)}</span>
        <span data-testid="sa-one-click-networks">
          {(props.oneClickNetworks ?? []).map(network => network.id).join(',')}
        </span>
        <input data-testid="sa-offer-input" onChange={e => props.onOfferAmountChange(e.target.value)} />
        <AmountInput
          data-testid="sa-request-input"
          value={props.requestAmount}
          loading={props.requestLoading}
          onValueChange={amount => props.onRequestAmountChange(amount ?? '')}
        />
        <button data-testid="sa-select-offer" onClick={props.onSelectOfferToken} />
        <button data-testid="sa-select-request" onClick={props.onSelectRequestToken} />
        <button data-testid="sa-swap-direction" onClick={props.onSwapDirection} />
        <button data-testid="sa-confirm" onClick={props.onConfirm} />
      </div>
    )
  };
});

let mockReviewSubmit: () => void;
jest.mock('./ReviewSwap', () => ({
  ReviewSwap: (props: import('./ReviewSwap').ReviewSwapProps) => {
    mockReviewSubmit = props.onSubmit;
    return (
      <div data-testid="review-swap" data-submitting={String(Boolean(props.submitting))}>
        {mockRealSwapDisplays &&
          React.createElement(jest.requireActual<typeof import('./ReviewSwap')>('./ReviewSwap').ReviewSwap, props)}
        <span data-testid="rs-offer-token">{props.offerToken.symbol}</span>
        <span data-testid="rs-request-token">{props.requestToken.symbol}</span>
        <span data-testid="rs-offer-amount">{props.offerAmount}</span>
        <span data-testid="rs-request-amount">{props.requestAmount}</span>
        <span data-testid="rs-market-price">{String(props.quote?.price.fillPrice)}</span>
        <span data-testid="rs-fill-seconds">{String(props.quote?.eta.estimatedSeconds)}</span>
        <span data-testid="rs-slippage">{String(props.slippageBps)}</span>
        <span data-testid="rs-request-edited">{String(props.requestEdited)}</span>
        <button data-testid="rs-set-slippage" onClick={() => props.onSlippageBpsChange(50)} />
        <input
          data-testid="rs-expiry"
          value={props.expirySeconds}
          onChange={event => props.onExpirySecondsChange(event.target.value)}
        />
        <button data-testid="rs-auto-consume" onClick={() => props.onAutoConsumeChange(!props.autoConsume)}>
          {String(props.autoConsume)}
        </button>
        <span data-testid="rs-submit-error">{props.submitError ?? ''}</span>
        <button data-testid="rs-go-back" onClick={props.onGoBack} />
        <button data-testid="rs-submit" onClick={props.onSubmit} />
      </div>
    );
  }
}));

jest.mock('./SelectSwapToken', () => ({
  SelectSwapTokenDrawer: (props: Record<string, any>) => {
    mockDrawerProps = props as typeof mockDrawerProps;
    return (
      <div
        data-testid="swap-token-drawer"
        data-open={String(props.open)}
        data-current={props.currentFaucetId ?? ''}
        data-partners-of={props.partnersOf ?? ''}
      >
        <button data-testid="drawer-close" onClick={() => props.onOpenChange(false)} />
      </div>
    );
  }
}));

// Set by a test that needs the mock challenge to hand back an authorization for a DIFFERENT
// account than the one the challenge itself was opened for - a stale/forged credential, which the
// real `SpendingLimitChallenge` never produces (its authorization always carries the challenge's
// own `source.accountId`) but which `runSwap` must independently refuse.
let mockAuthorizationAccountOverride: string | undefined;

let mockChallengeCloseOnBack: boolean | undefined;
let mockChallengeResult: SpendingLimitChallengeProps['onResult'];
jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: any) => {
    mockChallengeCloseOnBack = props.closeOnBack;
    mockChallengeResult = props.onResult;
    const source = props.assessment ?? props.unpriced;
    return (
      <div data-testid="spending-limit-challenge">
        <span>{source.revision}</span>
        <span data-testid="challenge-kind">{props.assessment !== undefined ? 'assessment' : 'unpriced'}</span>
        <button
          type="button"
          onClick={() =>
            props.onResult({
              kind: props.assessment !== undefined ? 'usd' : 'unpriced',
              id: 'authorization-1',
              accountId: mockAuthorizationAccountOverride ?? source.accountId,
              revision: source.revision,
              issuedAt: 120,
              expiresAt: 240
            })
          }
        >
          authorize-limit
        </button>
        <button type="button" onClick={() => props.onResult(undefined)}>
          cancel-limit
        </button>
      </div>
    );
  }
}));

let mockRealSwapRegistry = false;
let mockDefaultPairOverride: SwapPair | undefined;
// The solver's pairs, by faucet id; undefined means every two tokens of the registry are a pair.
let mockSolverPairs: Array<[string, string]> | undefined;
const mockSwapPartners = (faucetId: string) =>
  mockGetSwapTokens().filter(
    token =>
      token.faucetId !== faucetId &&
      (mockSolverPairs === undefined ||
        mockSolverPairs.some(pair => pair.includes(faucetId) && pair.includes(token.faucetId)))
  );
jest.mock('lib/miden/swap/tokens', () => ({
  tokenQuote: (prices: TokenPrices) => prices.AAA,
  normalizedFaucetId:
    jest.requireActual<typeof import('lib/miden/swap/faucet-ids')>('lib/miden/swap/faucet-ids').normalizedFaucetId,
  getSwapTokens: () =>
    mockRealSwapRegistry
      ? jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens').getSwapTokens()
      : mockGetSwapTokens(),
  subscribeSwapTokens: (listener: () => void) =>
    jest.requireActual('lib/miden/swap/tokens').subscribeSwapTokens(listener),
  getSwapTokensVersion: () => jest.requireActual('lib/miden/swap/tokens').getSwapTokensVersion(),
  getSwapPartners: (faucetId: string) =>
    mockRealSwapRegistry
      ? jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens').getSwapPartners(faucetId)
      : mockSwapPartners(faucetId),
  isSwapPair: (faucetId: string, other: string) =>
    mockRealSwapRegistry
      ? jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens').isSwapPair(faucetId, other)
      : mockSwapPartners(faucetId).some(token => token.faucetId === other),
  // The form opens on the document's first two tokens; mirror that over the mocked registry.
  getDefaultSwapPair: () => {
    if (mockRealSwapRegistry)
      return jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens').getDefaultSwapPair();
    if (mockDefaultPairOverride !== undefined) return mockDefaultPairOverride;
    const [offer, request] = mockGetSwapTokens();
    return offer && request ? { offer, request } : null;
  }
}));

// The gate reads the registry and the bridge config through these; the registry mock above decides the pair.
jest.mock('lib/miden/swap/use-swap-tokens', () => ({
  useSwapTokens: () =>
    mockRealSwapRegistry
      ? jest
          .requireActual<typeof import('lib/miden/swap/use-swap-tokens')>('lib/miden/swap/use-swap-tokens')
          .useSwapTokens()
      : mockGetSwapTokens(),
  swapAvailability: (snapshot: unknown) =>
    mockRealSwapRegistry
      ? jest.requireActual('lib/miden/swap/use-swap-tokens').swapAvailability(snapshot)
      : mockGetSwapTokens().length >= 2
        ? { state: 'available' }
        : { state: 'loading' }
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => ({
    network: 'mainnet',
    status: 'ready',
    config: mockBridgeConfig,
    derived: null,
    lastFetch: null,
    geo: mockGeo
  })
}));
jest.mock('lib/one-click/config', () => {
  const actual = jest.requireActual<typeof import('lib/one-click/config')>('lib/one-click/config');
  return {
    ...actual,
    useOneClickConfig: () =>
      actual.getOneClickConfig({
        network: 'mainnet',
        status: 'ready',
        config: mockBridgeConfig,
        derived: null,
        lastFetch: null
      })
  };
});
jest.mock('lib/one-click/client', () => ({
  ...jest.requireActual<typeof import('lib/one-click/client')>('lib/one-click/client'),
  fetchOneClickAssets: (...args: unknown[]) => mockFetchOneClickAssets(...args)
}));

jest.mock('./useSwapQuote', () => ({
  useSwapQuote: (...args: unknown[]) => mockUseSwapQuote(...args)
}));

// Reached only by the suites that run the real hook.
const mockQuoteSwap = jest.fn();
jest.mock('lib/miden/swap/quote', () => ({
  ...jest.requireActual('lib/miden/swap/quote'),
  quoteSwap: (...args: unknown[]) => mockQuoteSwap(...args)
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount(),
  useAllBalances: (pk: string, md: Record<string, unknown>) => mockUseAllBalances(pk, md),
  useAllTokensBaseMetadata: () => mockUseAllTokensBaseMetadata()
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (s: string) => mockAccountIdStringToSdk(s),
  accountRefToSdk: (s: string) => mockAccountRefToSdk(s),
  walletAccountIdToSdk: (s: string) => mockAccountRefToSdk(s),
  getBech32AddressFromAccountId: (a: { toString(): string }) => mockGetBech32(a)
}));

jest.mock('lib/biometric', () => ({
  confirmSensitiveAction: (reason: string, hasHardwareProtector: () => Promise<boolean>) =>
    mockConfirmSensitive(reason, hasHardwareProtector)
}));

jest.mock('lib/miden/back/protector-probe', () => ({
  probeHardwareProtector: jest.fn()
}));

jest.mock('lib/i18n/numbers', () => ({
  ...jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers'),
  stringToBigInt: (str: string, decimals: number) => mockStringToBigInt(str, decimals),
  // The inverse of the stand-in above: base units read as whole display units.
  formatBigInt: (amount: bigint, decimals: number) => mockFormatBigInt(amount, decimals)
}));

jest.mock('lib/miden/activity', () => ({
  initiateSwapTransaction: (...args: unknown[]) => mockInitiateSwap(...args),
  requestSWTransactionProcessing: () => mockRequestSWProcessing()
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual<typeof import('lib/platform')>('lib/platform'),
  isExtension: () => mockIsExtension()
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => mockIsDelegateProof()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean) => {
    mockBackHandler = handler;
  }
}));

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (state: typeof mockWalletState) => unknown) => (selector ? selector(mockWalletState) : mockWalletState),
    { getState: () => mockWalletState }
  )
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  // The swap flow only reports while its route is showing, because the home
  // carousel keeps this screen mounted the whole time the wallet is open.
  useLocation: () => ({ pathname: mockPathname }),
  HistoryAction: { Push: 'push', Replace: 'replace' }
}));

// Telemetry: record the flow name and hand back a fresh spy handle per flow, so
// the assertions below can tell a completed swap from an abandoned one.
type SwapFlowHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock; step: jest.Mock };
const swapFlowHandles: SwapFlowHandle[] = [];
const mockBeginFlow = jest.fn((_flow: string) => {
  const handle: SwapFlowHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn(), step: jest.fn() };
  swapFlowHandles.push(handle);
  return handle;
});
jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => mockBeginFlow(flow),
  classifyError: () => 'rpc'
}));

const swapFlow = (index = 0): SwapFlowHandle => {
  const handle = swapFlowHandles[index];
  if (!handle) throw new Error(`expected a swap flow at index ${index}`);
  return handle;
};

const stepsReported = (index = 0): string[] => swapFlow(index).step.mock.calls.map(([step]) => step);

const renderFlow = () => render(<SwapFlow />);

/**
 * A quote at a fill price, with the ask the wallet built from it in base units (the `formatBigInt`
 * stand-in shows those as whole display units) and the solver's usual pre-sign testnet verdict:
 * at market, nothing to match yet.
 */
const quoteAt = (
  fillPrice: string,
  requestedAmount: bigint,
  eta: Record<string, unknown> = {},
  // The inputs the quote was built for: the suite's usual pay amount of 10 at the default slippage.
  inputs: { offeredAmount?: bigint; slippageBps?: number; builtAsk?: boolean } = {}
) => ({
  price: { fillPrice, marketPrice: fillPrice, feePpm: 50, offeredDecimals: 8, requestedDecimals: 8, asOf: 0 },
  offeredAmount: inputs.offeredAmount ?? 10n,
  requestedAmount,
  builtAsk: inputs.builtAsk ?? true,
  slippageBps: inputs.slippageBps ?? 5,
  eta: {
    priceBand: 'at_market',
    fillStatus: 'none',
    reason: 'liquidity',
    settlementsRunning: true,
    estimatedSeconds: null,
    median24hSeconds: null,
    expectedRequestedAmount: null,
    ...eta
  },
  fetchedAt: 0
});

beforeEach(() => {
  mockRealSwapRegistry = false;
  jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens')._setSwapTokensForTest(undefined);
  jest.clearAllMocks();
  mockVaultPreflight.mockReset().mockResolvedValue(undefined);
  _resetNormalizedFaucetIdsForTest();

  mockNetworkScope = 'testnet|rpc';
  mockBaseFee = 0;
  mockNativeFaucetId = 'MIDEN-ID';
  mockRenderedRoutes = [{ name: 'SwapAmounts' }, { name: 'ReviewSwap' }];
  mockPathname = '/swap';
  swapFlowHandles.length = 0;
  mockBeginFlow.mockClear();
  mockNav = { navigateTo: jest.fn(), goBack: jest.fn(), cardStack: [{ name: 'SwapAmounts' }] };
  mockBackHandler = null;
  mockAuthorizationAccountOverride = undefined;
  mockDefaultPairOverride = undefined;
  mockWalletState = {
    tokenPrices: { AAA: { price: 1, change24h: 0, percentageChange24h: 0, observedAt: Date.now() } },
    isTransactionModalOpen: false,
    lastCompletedTxHash: null,
    closeTransactionModal: jest.fn(),
    setLastCompletedTxHash: jest.fn(),
    assessSpendingLimit: jest.fn().mockResolvedValue(undefined),
    readSpendingLimit: jest.fn().mockResolvedValue({
      accountId: 'pk-1',
      limit: 100_000_000n,
      revision: 'revision-1',
      createdAt: 1,
      updatedAt: 2
    })
  };
  mockFormatBigInt.mockImplementation(amount => amount.toString());
  mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 5n) };
  mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
  mockAllBalancesReturn = { data: mockBalanceData };
  mockMetadata = { some: 'metadata' };
  mockAccountReturn = { publicKey: 'pk-1' };
  mockBridgeConfig = null;
  mockGeo = undefined;
  mockFetchOneClickAssets.mockReset();

  mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenB, mockTokenC]);
  mockSolverPairs = undefined;
  mockGetBech32.mockImplementation(mockFakeBech32);
  mockAccountIdStringToSdk.mockImplementation(mockParseBech32);
  mockConfirmSensitive.mockResolvedValue(true);
  mockStringToBigInt.mockImplementation((str: string, _decimals: number) => BigInt(Math.trunc(Number(str) || 0)));
  mockInitiateSwap.mockResolvedValue('tx-1');
  mockIsExtension.mockReturnValue(true);
  mockIsDelegateProof.mockReturnValue(false);
  mockReceiveQuoteCache = new Map();
  mockUseSwapQuote.mockImplementation(mockQuoteForInputs);
  mockQuoteNow.mockReset();
  mockQuoteNow.mockImplementation(async () => {
    const quote = mockSwapQuoteResult.quote;
    if (quote === undefined) throw new Error('no quote');
    return quote;
  });
});

afterEach(() => {
  cleanup();
});

/**
 * The mocked hook answers for whatever pay amount is typed, as the real one does once its quote
 * lands. One object per amount, so a re-render sees the same quote, as with the real hook's state.
 */
const mockQuoteForInputs = (opts: import('./useSwapQuote').UseSwapQuoteOpts) => {
  const quote = mockSwapQuoteResult.quote;
  if (!opts.requestEdited || quote === undefined) return { ...mockSwapQuoteResult, quoteNow: mockQuoteNow };
  let requestedAmount: bigint;
  try {
    requestedAmount = mockStringToBigInt(opts.requestAmount, opts.requestToken.decimals);
  } catch {
    return { loading: false, quoteNow: mockQuoteNow };
  }
  if (requestedAmount <= 0n) return { loading: false, quoteNow: mockQuoteNow };
  const key = `${opts.requestAmount}|${opts.slippageBps}|${quote.price.fillPrice}|${quote.requestedAmount}`;
  const receive = mockReceiveQuoteCache.get(key) ?? {
    ...quote,
    requestedAmount,
    builtAsk: false,
    slippageBps: opts.slippageBps
  };
  mockReceiveQuoteCache.set(key, receive);
  return { ...mockSwapQuoteResult, quote: receive, quoteNow: mockQuoteNow };
};

const quoteFollowsOffer = () => {
  const byOffer = new Map<string, NonNullable<typeof mockSwapQuoteResult.quote>>();
  mockUseSwapQuote.mockImplementation((opts: import('./useSwapQuote').UseSwapQuoteOpts) => {
    if (opts.requestEdited) return mockQuoteForInputs(opts);
    const { offerAmount, offerToken } = opts;
    const quote = mockSwapQuoteResult.quote;
    let offeredAmount: bigint | undefined;
    try {
      offeredAmount = mockStringToBigInt(offerAmount, offerToken.decimals);
    } catch {
      offeredAmount = undefined;
    }
    if (quote === undefined || offeredAmount === undefined) {
      return { ...mockSwapQuoteResult, quoteNow: mockQuoteNow };
    }
    const key = offeredAmount.toString();
    const followed = byOffer.get(key) ?? { ...quote, offeredAmount };
    byOffer.set(key, followed);
    return { ...mockSwapQuoteResult, quote: followed, quoteNow: mockQuoteNow };
  });
};

// A new market quote: a new rate, a new receive amount and a new fill time together.
const moveMarket = () => {
  mockSwapQuoteResult = { ...mockSwapQuoteResult, quote: quoteAt('3', 7n, { estimatedSeconds: 42 }) };
};

const expectReviewQuote = (marketPrice: string, fillSeconds: string) => {
  expect(screen.getByTestId('rs-market-price')).toHaveTextContent(marketPrice);
  expect(screen.getByTestId('rs-fill-seconds')).toHaveTextContent(fillSeconds);
};

const setOffer = (value: string) => fireEvent.change(screen.getByTestId('sa-offer-input'), { target: { value } });
const setRequest = (value: string) => fireEvent.change(screen.getByTestId('sa-request-input'), { target: { value } });

const breachAssessment = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'pk-1',
  usdAmount: 10n,
  revision: 'revision-1',
  assessedAt: 100,
  breach: { spent: 95n, proposedTotal: 105n, limit: 100n, overBy: 5n, resetAt: 200 },
  ...overrides
});

describe('SwapFlow / SwapManager', () => {
  it('does not query below $1 and starts at exactly $1', async () => {
    jest.useFakeTimers();
    try {
      const { useSwapQuote } = jest.requireActual<typeof import('./useSwapQuote')>('./useSwapQuote');
      mockUseSwapQuote.mockImplementation(useSwapQuote);
      mockQuoteSwap.mockResolvedValue(quoteAt('2', 5n, {}, { offeredAmount: 1n }));
      renderFlow();
      setOffer('0.99');
      await act(async () => jest.advanceTimersByTime(1000));
      expect(mockQuoteSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapBelowMinimum');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      setOffer('1');
      await act(async () => jest.advanceTimersByTime(500));
      expect(mockQuoteSwap).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      jest.useRealTimers();
    }
  });

  it('blocks quotes when the USD price is unavailable', () => {
    mockWalletState.tokenPrices = {};
    renderFlow();
    setOffer('10');
    expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.getByTestId('sa-status')).toHaveTextContent('swapMinimumPriceUnavailable');
  });

  it('checks the receive value before requesting its offered amount', () => {
    renderFlow();
    setRequest('0.99');
    expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    setRequest('1');
    expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('blocks submission when the offer price falls below the minimum', async () => {
    const view = renderFlow();
    setOffer('10');
    mockWalletState.tokenPrices = {
      AAA: { price: 0.09, change24h: 0, percentageChange24h: 0, observedAt: Date.now() }
    };
    view.rerender(<SwapFlow />);
    await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
    expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapBelowMinimum');
    expect(mockInitiateSwap).not.toHaveBeenCalled();
  });

  it('opens an already-mounted unavailable form when real registry override tokens arrive', async () => {
    mockRealSwapRegistry = true;
    const registry = jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens');
    registry._setSwapTokensForTest([]);
    renderFlow();
    await act(async () => undefined);
    expect(screen.getByTestId('swap-unavailable-notice')).toBeInTheDocument();

    act(() => registry._setSwapTokensForTest([mockTokenA, mockTokenB]));

    expect(screen.queryByTestId('swap-unavailable-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
    expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
  });

  it('keeps a fulfilled real quote when the already-selected receive token is picked again', async () => {
    jest.useFakeTimers();
    const { useSwapQuote } = jest.requireActual<typeof import('./useSwapQuote')>('./useSwapQuote');
    const { stringToBigInt, formatBigInt } = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
    mockUseSwapQuote.mockImplementation(useSwapQuote);
    mockStringToBigInt.mockImplementation(stringToBigInt);
    mockFormatBigInt.mockImplementation(formatBigInt);
    mockQuoteSwap.mockImplementation(async (_offer, offeredAmount, _request, options) => ({
      ...quoteAt('1', (offeredAmount * 9995n) / 10000n, { fillStatus: 'full', reason: null }),
      offeredAmount,
      slippageBps: options.slippageBps,
      fetchedAt: Date.now()
    }));
    renderFlow();
    setOffer('10');

    await act(async () => jest.advanceTimersByTime(500));

    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('9.995');
    expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');

    fireEvent.click(screen.getByTestId('sa-select-request'));
    act(() => mockDrawerProps.onSelect(mockTokenB));

    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('9.995');
    expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');
  });

  it('renders both flow steps with the default token pair and the auto-derived quote', () => {
    renderFlow();

    expect(screen.getByTestId('swap-flow')).toBeInTheDocument();
    expect(screen.getByTestId('swap-amounts')).toBeInTheDocument();
    expect(screen.getByTestId('review-swap')).toBeInTheDocument();

    expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
    expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
    // No pay amount yet → quote is empty and the CTA is disabled.
    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('');
    expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    expect(screen.getByTestId('sa-status')).toHaveTextContent('');

    // Review side reflects the live oracle rate from the swap-eta quote.
    expect(screen.getByTestId('rs-market-price')).toHaveTextContent('2');
    expect(screen.getByTestId('rs-expiry')).toHaveValue('120');
    expect(screen.getByTestId('rs-auto-consume')).toHaveTextContent('true');

    // Drawer starts closed, keyed to the offer side by default.
    const drawer = screen.getByTestId('swap-token-drawer');
    expect(drawer).toHaveAttribute('data-open', 'false');
    expect(drawer).toHaveAttribute('data-current', 'faucet-A');
  });

  it('keeps configured 1Click networks hidden and does not fetch its catalog while the rollout switch is off', () => {
    mockBridgeConfig = parseBridgeConfig(
      {
        ...testnet,
        network: 'mainnet',
        features: { ...testnet.features, nearIntents: false },
        swap: {
          ...testnet.swap,
          oneClick: {
            serviceUrl: 'https://one-click.example',
            midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }]
          }
        }
      },
      'mainnet'
    );
    if (!mockBridgeConfig) throw new Error('The disabled-feature fixture must remain a valid wallet config');
    mockRealSwapAmounts = true;
    renderFlow();

    expect(screen.queryByTestId('one-click-pay-network-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('one-click-receive-network-picker')).not.toBeInTheDocument();
    expect(screen.queryByTestId('one-click-connect-origin-wallet')).not.toBeInTheDocument();
    expect(mockFetchOneClickAssets).not.toHaveBeenCalled();
  });

  it('keeps one-click routes available from the surviving provider catalog mappings', async () => {
    mockBridgeConfig = parseBridgeConfig(
      {
        ...testnet,
        network: 'mainnet',
        features: { ...testnet.features, nearIntents: true },
        swap: {
          ...testnet.swap,
          oneClick: {
            serviceUrl: 'https://one-click.example',
            midenAssets: [
              { assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 },
              { assetId: 'miden:other', faucetId: '0x637c15a622074e91188aa894456c52', decimals: 6 }
            ]
          }
        }
      },
      'mainnet'
    );
    if (!mockBridgeConfig) throw new Error('The enabled-feature fixture must remain a valid wallet config');
    mockFetchOneClickAssets.mockResolvedValue([
      {
        assetId: 'miden:usdc',
        blockchain: 'miden',
        symbol: 'USDC',
        decimals: 6,
        faucetId: '0x537c15a622074e91188aa894456c52'
      },
      { assetId: 'eth:token', blockchain: 'eth', symbol: 'ETH', decimals: 18 }
    ]);

    renderFlow();

    await waitFor(() => expect(screen.getByTestId('sa-one-click-networks')).toHaveTextContent('miden,eth'));
    expect(mockFetchOneClickAssets).toHaveBeenCalledTimes(1);
  });

  describe('startup eligibility on the 1Click route', () => {
    const decision = (swap: boolean): GeoLookup => ({
      state: 'ready',
      network: 'mainnet',
      version: 1,
      allowed: { wallet: true, earn: true, swap }
    });
    // A 1Click catalog with a Miden and an EVM asset, and no solver pair: the route that used to open the form alone.
    const withOneClickRouteOnly = () => {
      mockGetSwapTokens.mockReturnValue([]);
      mockBridgeConfig = parseBridgeConfig(
        {
          ...testnet,
          network: 'mainnet',
          features: { ...testnet.features, nearIntents: true },
          swap: {
            ...testnet.swap,
            oneClick: {
              serviceUrl: 'https://one-click.example',
              midenAssets: [{ assetId: 'miden:usdc', faucetId: '0x537c15a622074e91188aa894456c52', decimals: 6 }]
            }
          }
        },
        'mainnet'
      );
      if (!mockBridgeConfig) throw new Error('The 1Click fixture must remain a valid wallet config');
      mockFetchOneClickAssets.mockResolvedValue([
        {
          assetId: 'miden:usdc',
          blockchain: 'miden',
          symbol: 'USDC',
          decimals: 6,
          faucetId: '0x537c15a622074e91188aa894456c52'
        },
        { assetId: 'eth:token', blockchain: 'eth', symbol: 'ETH', decimals: 18 }
      ]);
    };

    it.each<[string, GeoLookup, string]>([
      ['pending', { state: 'loading' }, 'pending'],
      ['failed', { state: 'failed' }, 'service-down'],
      ['restricted', decision(false), 'restricted']
    ])('keeps the form closed while the decision is %s', async (_label, geo, reason) => {
      withOneClickRouteOnly();
      mockGeo = geo;
      renderFlow();
      await waitFor(() => expect(mockFetchOneClickAssets).toHaveBeenCalledTimes(1));
      await act(async () => undefined);
      const notice = screen.getByTestId('swap-unavailable-notice');
      expect(notice).toHaveAttribute('data-reason', reason);
      expect(notice).toHaveTextContent(reason === 'restricted' ? 'geoRestrictedTitle' : 'swapUnavailableTitle');
      expect(screen.queryByTestId('swap-amounts')).not.toBeInTheDocument();
    });

    it('closes a solver-pair form too while the decision is pending', () => {
      mockGeo = { state: 'loading' };
      renderFlow();
      expect(screen.getByTestId('swap-unavailable-notice')).toHaveAttribute('data-reason', 'pending');
      expect(screen.queryByTestId('swap-amounts')).not.toBeInTheDocument();
    });

    it('opens the 1Click form once the decision allows Swap', async () => {
      withOneClickRouteOnly();
      mockGeo = decision(true);
      renderFlow();
      await waitFor(() => expect(screen.getByTestId('sa-one-click-networks')).toHaveTextContent('miden,eth'));
      expect(screen.queryByTestId('swap-unavailable-notice')).not.toBeInTheDocument();
    });
  });

  it('renders nothing for an unknown route (renderStep default branch)', () => {
    mockRenderedRoutes = [{ name: '__unknown__' }];
    renderFlow();

    expect(screen.queryByTestId('swap-amounts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-swap')).not.toBeInTheDocument();
    // The flow shell + drawer still render.
    expect(screen.getByTestId('swap-flow')).toBeInTheDocument();
    expect(screen.getByTestId('swap-token-drawer')).toBeInTheDocument();
  });

  it('passes the account public key and base metadata through to useAllBalances', () => {
    renderFlow();
    expect(mockUseAllBalances).toHaveBeenCalledWith('pk-1', mockMetadata);
  });

  it('defaults balance data to an empty list when useAllBalances yields no data', () => {
    mockAllBalancesReturn = {};
    renderFlow();
    expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('0');
  });

  describe('offer balance resolution', () => {
    it('matches a hex offer faucet by its canonical bech32 balance key', () => {
      const offer = { ...mockTokenA, faucetId: '0Xabc' };
      mockGetSwapTokens.mockReturnValue([offer, mockTokenB]);
      mockBalanceData = [
        { tokenId: 'bech32-0xabc', balance: 42 },
        { tokenId: '0Xabc', balance: 7 }
      ];
      mockAllBalancesReturn = { data: mockBalanceData };

      renderFlow();

      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('42');
    });

    it('matches the balance by the bech32-normalized faucet key', () => {
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('100');
    });

    it('falls back to matching the raw faucet id when the bech32 key differs', () => {
      mockGetBech32.mockImplementation(() => 'unrelated-key');
      mockBalanceData = [{ tokenId: 'faucet-A', balance: 50 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('50');
    });

    it('uses the raw faucet id as the key when bech32 conversion throws (catch branch)', () => {
      mockGetBech32.mockImplementation(() => {
        throw new Error('sdk not ready');
      });
      mockBalanceData = [{ tokenId: 'faucet-A', balance: 7 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('7');
    });

    it('resolves to 0 when no balance entry matches', () => {
      mockBalanceData = [{ tokenId: 'someone-else', balance: 999 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('0');
    });
  });

  describe('fee reserve on a NATIVE offer', () => {
    // The fee comes out of this account's own vault, so offering the entire native
    // balance is accepted and then fails in the epilogue on its own fee -- AFTER the
    // user signed. Send already reserves for this; swap quoted and enforced the raw
    // balance, so the same signed-then-failed outcome was still reachable here.
    // Reserve = baseFee * FEE_RESERVE_MULTIPLE / 10^decimals = 10000*30/1e8 = 0.003.
    // These offer 1, so the quote on screen is one built for 1, as the hook would answer.
    beforeEach(() => {
      mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 5n, {}, { offeredAmount: 1n }) };
    });

    it('fee identity: reserves the actual native offer despite a different legacy display override', () => {
      mockLegacyFeeIdentity = 'legacy-B';
      mockNativeFaucetId = 'bech32-faucet-A';
      mockBaseFee = 7;
      mockTokenA.decimals = 6;
      mockAllBalancesReturn = {
        data: [
          { tokenId: 'bech32-faucet-A', balance: 1 },
          { tokenId: 'legacy-B', balance: 1 }
        ]
      };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('0.99979');
      setOffer('1');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      mockTokenA.decimals = 8;
    });

    it.each([
      [0, 1, false],
      [1, 0, true]
    ])('fee identity: funds foreign offers from actual A=%s rather than legacy B=%s', (actual, legacy, allowed) => {
      mockLegacyFeeIdentity = 'legacy-B';
      mockNativeFaucetId = 'actual-native';
      mockBaseFee = 7;
      mockAllBalancesReturn = {
        data: [
          { tokenId: 'bech32-faucet-A', balance: 2 },
          { tokenId: 'actual-native', balance: actual },
          { tokenId: 'legacy-B', balance: legacy }
        ]
      };
      renderFlow();
      setOffer('1');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent(String(allowed));
    });

    it.each([0, null])('fee identity: leaves the offer unreserved with current fee %s and a legacy override', fee => {
      mockLegacyFeeIdentity = 'legacy-B';
      mockNativeFaucetId = 'bech32-faucet-A';
      mockBaseFee = fee;
      mockAllBalancesReturn = { data: [{ tokenId: 'bech32-faucet-A', balance: 1 }] };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('1');
      setOffer('1');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
    });

    it('holds back the fee reserve from the offerable balance', () => {
      mockNativeFaucetId = 'bech32-faucet-A';
      mockBaseFee = 10000;
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      // Quoted "Available" must equal what the validation enforces, or Max overshoots.
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('99.997');
    });

    it('leaves a NON-NATIVE offer at its full balance', () => {
      // Its fee is paid in a different asset, so nothing needs holding back.
      mockNativeFaucetId = 'MIDEN-ID';
      mockBaseFee = 10000;
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('100');
    });

    it('leaves the full balance on a zero-fee chain', () => {
      // `maxSendableNative` fails open, so a chain that charges nothing -- and the
      // window before discovery lands -- keeps the whole balance offerable.
      mockNativeFaucetId = 'bech32-faucet-A';
      mockBaseFee = 0;
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 100 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('100');
    });
  });

  describe('mount effect: dismissing a stale completion modal', () => {
    it('closes an open transaction modal and clears the last completed hash', () => {
      mockWalletState.isTransactionModalOpen = true;
      mockWalletState.lastCompletedTxHash = '0xabc';
      renderFlow();

      expect(mockWalletState.closeTransactionModal).toHaveBeenCalledWith(true);
      expect(mockWalletState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
    });

    it('does nothing when no modal is open and no hash is set', () => {
      renderFlow();
      expect(mockWalletState.closeTransactionModal).not.toHaveBeenCalled();
      expect(mockWalletState.setLastCompletedTxHash).not.toHaveBeenCalled();
    });
  });

  it('blocks a receive-derived pay amount one base unit above balance even when Number rounds it to the balance', () => {
    const { stringToBigInt, formatBigInt } = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
    mockStringToBigInt.mockImplementation(stringToBigInt);
    mockFormatBigInt.mockImplementation(formatBigInt);
    mockGetSwapTokens.mockReturnValue([
      { ...mockTokenA, decimals: 18 },
      { ...mockTokenB, decimals: 6 }
    ]);
    mockAllBalancesReturn = { data: [{ tokenId: 'bech32-faucet-A', balance: 1 }] };
    mockSwapQuoteResult = {
      loading: false,
      quote: quoteAt('2', 2000000n, {}, { offeredAmount: 1000000000000000001n, builtAsk: false })
    };
    renderFlow();
    setRequest('2');
    expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('1.000000000000000001');
    expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
  });

  it('blocks a full displayed balance when its base units exceed exact double precision', () => {
    const { stringToBigInt, formatBigInt } = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
    mockStringToBigInt.mockImplementation(stringToBigInt);
    mockFormatBigInt.mockImplementation(formatBigInt);
    mockGetSwapTokens.mockReturnValue([
      { ...mockTokenA, decimals: 18 },
      { ...mockTokenB, decimals: 6 }
    ]);
    mockAllBalancesReturn = { data: [{ tokenId: 'bech32-faucet-A', balance: 1 }] };
    mockSwapQuoteResult = {
      loading: false,
      quote: quoteAt('2', 2000000n, {}, { offeredAmount: 1000000000000000000n })
    };

    renderFlow();
    setOffer('1');

    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('2');
    expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
  });

  describe('amount editing + quote mirroring', () => {
    it('mirrors the derived quote into the receive field and enables the CTA', () => {
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
    });

    it.each(['.', '', '0'])('clears quotes for manually incomplete receive input %s', input => {
      const { stringToBigInt } = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
      mockStringToBigInt.mockImplementation(stringToBigInt);
      // The hook hides its quote for an edited ask it cannot quote (see useSwapQuote.test.ts).
      quoteFollowsOffer();
      const followOffer = mockUseSwapQuote.getMockImplementation();
      mockUseSwapQuote.mockImplementation(opts =>
        opts.requestEdited && !(Number(opts.requestAmount) > 0)
          ? { loading: false, quoteNow: mockQuoteNow }
          : followOffer?.(opts)
      );
      renderFlow();
      setOffer('10');
      expect(screen.getByTestId('rs-market-price')).toHaveTextContent('2');

      setRequest(input);
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ requestEdited: true }));
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(screen.getByTestId('rs-market-price')).toHaveTextContent('undefined');
    });

    it('keeps the receive target while the quote derives pay', () => {
      renderFlow();
      setRequest('9');

      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('9');
      // Receive is now the fixed side; the matched quote supplies pay.
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
    });

    it('disables the CTA when the pay amount exceeds the balance', () => {
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 5 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    });

    it('blocks an 18-decimal offer one base unit above its spendable balance', async () => {
      const { stringToBigInt } = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
      mockGetSwapTokens.mockReturnValue([{ ...mockTokenA, decimals: 18 }, mockTokenB, mockTokenC]);
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 1 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      mockStringToBigInt.mockImplementation(stringToBigInt);
      quoteFollowsOffer();
      renderFlow();
      setOffer('1.000000000000000001');

      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(
        expect.objectContaining({ offerAmount: '1.000000000000000001' })
      );
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
    });

    it('preserves and blocks the active offer amount when the selected token has fewer decimals', async () => {
      const { stringToBigInt } = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
      const lowPrecisionOffer = { ...mockTokenC, decimals: 2 };
      mockGetSwapTokens.mockReturnValue([{ ...mockTokenA, decimals: 18 }, mockTokenB, lowPrecisionOffer]);
      mockBalanceData = [
        { tokenId: 'bech32-faucet-A', balance: 10 },
        { tokenId: 'bech32-faucet-C', balance: 10 }
      ];
      mockAllBalancesReturn = { data: mockBalanceData };
      mockStringToBigInt.mockImplementation(stringToBigInt);
      quoteFollowsOffer();
      renderFlow();
      setOffer('1.123456');
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(lowPrecisionOffer));

      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('1.123456');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ offerAmount: '' }));
      expect(mockStringToBigInt).not.toHaveBeenCalledWith('1.123456', 2);
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
    });

    it('accepts an offer whose excess fractional digits are only trailing zeroes', () => {
      const { stringToBigInt, formatBigInt } =
        jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
      const lowPrecisionOffer = { ...mockTokenC, decimals: 2 };
      mockGetSwapTokens.mockReturnValue([{ ...mockTokenA, decimals: 8 }, mockTokenB, lowPrecisionOffer]);
      mockBalanceData = [
        { tokenId: 'bech32-faucet-A', balance: 10 },
        { tokenId: 'bech32-faucet-C', balance: 10 }
      ];
      mockAllBalancesReturn = { data: mockBalanceData };
      mockStringToBigInt.mockImplementation(stringToBigInt);
      mockFormatBigInt.mockImplementation(formatBigInt);
      quoteFollowsOffer();
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(lowPrecisionOffer));
      setOffer('1.2300');

      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('1.2300');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ offerAmount: '1.2300' }));
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
      expect(mockStringToBigInt).toHaveBeenCalledWith('1.2300', 2);
    });

    it('blocks a receive amount beyond the selected request token precision', async () => {
      const { stringToBigInt } = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
      const lowPrecisionRequest = { ...mockTokenC, decimals: 2 };
      mockGetSwapTokens.mockReturnValue([mockTokenA, mockTokenB, lowPrecisionRequest]);
      mockStringToBigInt.mockImplementation(stringToBigInt);
      quoteFollowsOffer();
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(lowPrecisionRequest));
      setRequest('1.123456');

      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ requestAmount: '' }));
      expect(mockStringToBigInt).not.toHaveBeenCalledWith('1.123456', 2);
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
    });

    it('accepts a receive target whose excess fractional digits are only trailing zeroes', () => {
      const { stringToBigInt, formatBigInt } =
        jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
      const lowPrecisionRequest = { ...mockTokenC, decimals: 2 };
      mockGetSwapTokens.mockReturnValue([mockTokenA, mockTokenB, lowPrecisionRequest]);
      mockStringToBigInt.mockImplementation(stringToBigInt);
      mockFormatBigInt.mockImplementation(formatBigInt);
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(lowPrecisionRequest));
      setRequest('1.2300');

      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('1.2300');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ requestAmount: '1.2300' }));
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
      expect(mockStringToBigInt).toHaveBeenCalledWith('1.2300', 2);
    });

    it('flags an offer above the holding of a registry token whose stored override carries decimals', () => {
      // 100 AAA in base units at the registry's 8 decimals. The row's scale comes from the faucet
      // record with the stored override applied, as the store builds every balance row.
      const faucetRecord = { name: 'Token A', symbol: 'AAA', decimals: mockTokenA.decimals };
      const rowMetadata = applyOverrideFor('bech32-faucet-A', faucetRecord, {
        'bech32-faucet-A': { name: 'Mine', symbol: 'MN', decimals: 2 }
      });
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 10_000_000_000 / 10 ** rowMetadata.decimals }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      setOffer('150');

      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(screen.getByTestId('sa-offer-balance')).toHaveTextContent('100');
    });
  });

  it('keeps the active pay amount as the receive source after swapping direction', () => {
    renderFlow();
    setOffer('10');
    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');

    fireEvent.click(screen.getByTestId('sa-swap-direction'));

    expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
    expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
    expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');
    expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('10');
    expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('true');
  });

  it('keeps the active receive amount as the pay source after swapping direction', () => {
    renderFlow();
    setRequest('9');

    fireEvent.click(screen.getByTestId('sa-swap-direction'));

    expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
    expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
    expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('9');
    expect(screen.getByTestId('sa-request-amount')).toBeEmptyDOMElement();
    expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('false');
  });

  describe('after a flip, before the new pair is quoted', () => {
    // useSwapQuote answers { loading: true } for a pair it has no quote for yet, so the
    // AAA->BBB rate must not price the BBB->AAA order.
    beforeEach(() => {
      mockUseSwapQuote.mockImplementation(({ offerToken }: { offerToken: typeof mockTokenA }) =>
        offerToken.faucetId === mockTokenA.faucetId
          ? { ...mockSwapQuoteResult, quoteNow: mockQuoteNow }
          : { loading: true, quoteNow: mockQuoteNow }
      );
    });

    const flip = () => {
      setOffer('10');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');
      fireEvent.click(screen.getByTestId('sa-swap-direction'));
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
    };

    it('keeps the source amount and calculates only the new pay side', () => {
      renderFlow();
      flip();

      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');
      expect(screen.getByTestId('sa-offer-loading')).toHaveTextContent('true');
      expect(screen.getByTestId('sa-status')).toHaveTextContent('');
      expect(screen.getByTestId('rs-market-price')).toHaveTextContent('undefined');
    });

    it('never submits an amount priced off the previous pair', async () => {
      renderFlow();
      flip();

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
    });
  });

  describe('token drawer', () => {
    it('opens keyed to the offer side and forwards close events', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));

      const drawer = screen.getByTestId('swap-token-drawer');
      expect(drawer).toHaveAttribute('data-open', 'true');
      expect(drawer).toHaveAttribute('data-current', 'faucet-A');

      fireEvent.click(screen.getByTestId('drawer-close'));
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-open', 'false');
    });

    it('opens keyed to the request side', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));

      const drawer = screen.getByTestId('swap-token-drawer');
      expect(drawer).toHaveAttribute('data-open', 'true');
      expect(drawer).toHaveAttribute('data-current', 'faucet-B');
    });

    it('offer side: picking the token already on the request side flips the pair', () => {
      renderFlow();
      setOffer('10');
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenB));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('true');
    });

    it('offer side: picking a fresh token just replaces the offer token', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
    });

    it('request side: picking the token already on the offer side flips the pair', () => {
      renderFlow();
      setRequest('9');
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenA));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('9');
      expect(screen.getByTestId('sa-request-amount')).toBeEmptyDOMElement();
      expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('false');
    });

    it('request side: picking a fresh token just replaces the request token', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('CCC');
    });

    it('preserves the active pay source and recalculates the receive side after token selection', () => {
      renderFlow();
      setOffer('10');
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-request-amount')).toBeEmptyDOMElement();
      expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('false');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ offerAmount: '10' }));
    });

    it('preserves the active receive source when its token changes', () => {
      renderFlow();
      setRequest('9');
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-amount')).toBeEmptyDOMElement();
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('9');
      expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('true');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ requestAmount: '9' }));
    });

    it('lists every token with a pair on the offer side, and only the partners of the pay token on the request side', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-partners-of', '');

      fireEvent.click(screen.getByTestId('sa-select-request'));
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-partners-of', 'faucet-A');
    });

    it('offer side: a pay token the solver does not pair with the receive token moves the receive side to its first partner', () => {
      // A-B and A-C are pairs; B-C is not.
      mockSolverPairs = [
        ['faucet-A', 'faucet-B'],
        ['faucet-A', 'faucet-C']
      ];
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenC));
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenB));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
    });

    it('preserves a receive target and blocks an unsupported pair when changing pay token', () => {
      mockSolverPairs = [
        ['faucet-A', 'faucet-B'],
        ['faucet-A', 'faucet-C']
      ];
      renderFlow();
      setRequest('9');
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('9');
      expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('true');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapPairNotListed');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: false, requestAmount: '9', requestToken: mockTokenB })
      );
    });

    it('offer side: a pay token the solver pairs with the receive token keeps the receive side', () => {
      mockSolverPairs = [
        ['faucet-A', 'faucet-B'],
        ['faucet-C', 'faucet-B'],
        ['faucet-C', 'faucet-A']
      ];
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenC));

      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
    });
  });

  describe('live registry changes', () => {
    const selectThirdOffer = () => {
      act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS));
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      act(() => mockDrawerProps.onSelect(mockTokenC));
      setOffer('10');
    };

    beforeEach(() => {
      jest.useFakeTimers();
      mockAllBalancesReturn = { data: [{ tokenId: 'bech32-faucet-C', balance: 100 }] };
    });
    afterEach(() => jest.useRealTimers());

    it.each([
      { change: 'faucet', token: { ...mockTokenC, faucetId: 'replacement-C' } },
      { change: 'precision', token: { ...mockTokenC, decimals: 0 } },
      { change: 'symbol', token: { ...mockTokenC, symbol: 'CC2' } },
      { change: 'logo', token: { ...mockTokenC, logoSymbol: 'ETH' } }
    ])('resets a selected third-token draft after its $change changes', ({ token }) => {
      const { rerender } = renderFlow();
      selectThirdOffer();
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');

      mockGetSwapTokens.mockReturnValue([mockTokenA, mockTokenB, token]);
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-offer-amount')).toBeEmptyDOMElement();
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    });

    it('resets the draft when a selected third token is removed', () => {
      const { rerender } = renderFlow();
      selectThirdOffer();
      mockGetSwapTokens.mockReturnValue([mockTokenA, mockTokenB]);
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-offer-amount')).toBeEmptyDOMElement();
    });

    it('resets a default-pair draft when its precision changes', () => {
      const { rerender } = renderFlow();
      setOffer('10');
      mockGetSwapTokens.mockReturnValue([{ ...mockTokenA, decimals: 0 }, mockTokenB, mockTokenC]);
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-offer-amount')).toBeEmptyDOMElement();
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(
        expect.objectContaining({ offerToken: expect.objectContaining({ decimals: 0 }) })
      );
    });

    it('disables Continue when the solver stops listing the open pair, until a listed partner is picked', () => {
      mockAllBalancesReturn = { data: [{ tokenId: 'bech32-faucet-A', balance: 100 }] };
      mockSolverPairs = [
        ['faucet-A', 'faucet-B'],
        ['faucet-A', 'faucet-C']
      ];
      const { rerender } = renderFlow();
      setOffer('10');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');

      // Both tokens stay listed, so the draft is kept; only the pair is gone.
      mockSolverPairs = [['faucet-A', 'faucet-C']];
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');

      fireEvent.click(screen.getByTestId('sa-select-request'));
      act(() => mockDrawerProps.onSelect(mockTokenC));
      setOffer('10');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    });

    describe('a pair the solver stops listing after review opens', () => {
      // The solver drops AAA -> BBB while both tokens stay listed, which keeps the draft.
      const delistOpenPair = (rerender: (ui: React.ReactElement) => void) => {
        mockSolverPairs = [['faucet-A', 'faucet-C']];
        rerender(<SwapFlow />);
      };

      beforeEach(() => {
        mockAllBalancesReturn = { data: [{ tokenId: 'bech32-faucet-A', balance: 100 }] };
        mockSolverPairs = [
          ['faucet-A', 'faucet-B'],
          ['faucet-A', 'faucet-C']
        ];
      });

      const expectRefusedAndRetryable = () => {
        expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPairNotListed');
        expect(mockInitiateSwap).not.toHaveBeenCalled();
        expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
        expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
        expect(swapFlow().complete).not.toHaveBeenCalled();
        expect(swapFlow().fail).not.toHaveBeenCalled();
        expect(swapFlow().cancel).not.toHaveBeenCalled();
      };

      it('refuses the review Swap and starts no spending-limit check or swap', async () => {
        const { rerender } = renderFlow();
        act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS));
        setOffer('10');
        delistOpenPair(rerender);
        await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
        expectRefusedAndRetryable();
        expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
        expect(mockConfirmSensitive).not.toHaveBeenCalled();
      });

      it('reports user-visible error: refuses the review Swap and starts no spending-limit check or swap', async () => {
        jest.useFakeTimers();
        jest.mocked(reportUserVisibleError).mockClear();
        mockRealSwapDisplays = true;
        const { rerender } = renderFlow();
        act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS));
        setOffer('10');
        delistOpenPair(rerender);
        await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
        expectRefusedAndRetryable();
        expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
        expect(mockConfirmSensitive).not.toHaveBeenCalled();
        act(() => jest.advanceTimersByTime(1000));
        expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapPairNotListed', 'review']]);
      }, 30_000); // renders the real swap displays; coverage instrumentation takes it past the 5 s default

      it('refuses the resubmit when the delist lands while a spending-limit challenge is open', async () => {
        mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
        const { rerender } = renderFlow();
        act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS));
        setOffer('10');
        await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
        expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
        delistOpenPair(rerender);
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
        expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
        expectRefusedAndRetryable();
      });

      it('refuses the swap when the delist lands while the user confirms', async () => {
        let confirm: (value: boolean) => void = () => undefined;
        mockConfirmSensitive.mockReturnValueOnce(new Promise<boolean>(resolve => (confirm = resolve)));
        const { rerender } = renderFlow();
        act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS));
        setOffer('10');
        await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
        expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'true');
        delistOpenPair(rerender);
        await act(async () => confirm(true));
        expectRefusedAndRetryable();
      });
    });

    it('preserves the draft when a refresh republishes the same registry content', () => {
      const { rerender } = renderFlow();
      selectThirdOffer();
      mockGetSwapTokens.mockReturnValue([{ ...mockTokenA }, { ...mockTokenB }, { ...mockTokenC }]);
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');
    });

    it('resets an idle draft when the default pair changes within stable effective tokens', () => {
      const nativeToken = { ...mockTokenC, symbol: 'MIDEN', logoSymbol: 'MIDEN' };
      mockGetSwapTokens.mockReturnValue([nativeToken, mockTokenA, mockTokenB]);
      mockDefaultPairOverride = { offer: mockTokenA, request: mockTokenB };
      const { rerender } = renderFlow();
      setOffer('10');
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('BBB');
      expect(screen.getByTestId('sa-offer-amount')).toHaveTextContent('10');

      mockDefaultPairOverride = { offer: nativeToken, request: mockTokenA };
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('MIDEN');
      expect(screen.getByTestId('sa-request-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-offer-amount')).toBeEmptyDOMElement();
      expect(screen.getByTestId('sa-request-amount')).toBeEmptyDOMElement();
    });

    it.each([
      { change: 'selected-token removal', tokens: [mockTokenA, mockTokenB] },
      { change: 'metadata refresh', tokens: [mockTokenA, mockTokenB, { ...mockTokenC, decimals: 0 }] }
    ])('holds the busy review and original flow across $change', async ({ tokens }) => {
      let confirm: (value: boolean) => void = () => undefined;
      mockConfirmSensitive.mockReturnValueOnce(new Promise<boolean>(resolve => (confirm = resolve)));
      const { rerender } = renderFlow();
      selectThirdOffer();
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      mockGetSwapTokens.mockReturnValue(tokens);
      rerender(<SwapFlow />);
      expect(screen.getByTestId('rs-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'true');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(swapFlow().cancel).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledTimes(1);
      await act(async () => confirm(true));
      expect(mockInitiateSwap).toHaveBeenCalledTimes(1);
      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-C', 10n, 'faucet-B', 5n, false, 120, true, 5);
      expect(swapFlow().complete).toHaveBeenCalledTimes(1);
      expect(swapFlow().cancel).not.toHaveBeenCalled();
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-offer-amount')).toBeEmptyDOMElement();
    });

    it('holds the busy review across entire-registry removal, then refuses the pair the solver no longer lists', async () => {
      let confirm: (value: boolean) => void = () => undefined;
      mockConfirmSensitive.mockReturnValueOnce(new Promise<boolean>(resolve => (confirm = resolve)));
      const { rerender } = renderFlow();
      selectThirdOffer();
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      mockGetSwapTokens.mockReturnValue([]);
      rerender(<SwapFlow />);
      expect(screen.getByTestId('rs-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'true');
      expect(swapFlow().cancel).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledTimes(1);
      await act(async () => confirm(true));
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(swapFlow().complete).not.toHaveBeenCalled();
      expect(swapFlow().fail).not.toHaveBeenCalled();
      // Released, the manager gives way to the gate's unavailable pane.
      expect(screen.queryByTestId('swap-amounts')).not.toBeInTheDocument();
      expect(screen.queryByTestId('review-swap')).not.toBeInTheDocument();
    });

    it('owns review presses synchronously before assessment resolves', async () => {
      let assess: (value: undefined) => void = () => undefined;
      mockWalletState.assessSpendingLimit.mockReturnValueOnce(new Promise<undefined>(resolve => (assess = resolve)));
      renderFlow();
      selectThirdOffer();
      await act(async () => {
        void mockReviewSubmit();
        void mockReviewSubmit();
      });
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledTimes(1);
      await act(async () => assess(undefined));
      expect(mockInitiateSwap).toHaveBeenCalledTimes(1);
    });

    it.each([
      { change: 'selected-token removal', tokens: [mockTokenA, mockTokenB] },
      { change: 'entire-registry removal', tokens: [] }
    ])('holds the approval challenge through $change until cancellation', async ({ tokens }) => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      const { rerender } = renderFlow();
      selectThirdOffer();
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      mockGetSwapTokens.mockReturnValue(tokens);
      rerender(<SwapFlow />);
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(screen.getByTestId('rs-offer-token')).toHaveTextContent('CCC');
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(swapFlow().cancel).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledTimes(1);
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' })));
      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.queryByTestId('swap-amounts') !== null).toBe(tokens.length !== 0);
      expect(screen.queryByTestId('sa-offer-amount')?.textContent ?? null).toBe(tokens.length === 0 ? null : '');
    });

    it('executes a held challenge once despite duplicate authorization callbacks', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      let finish: (value: string) => void = () => undefined;
      mockInitiateSwap.mockReturnValueOnce(new Promise<string>(resolve => (finish = resolve)));
      const { rerender } = renderFlow();
      selectThirdOffer();
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      const authorize = mockChallengeResult;
      mockGetSwapTokens.mockReturnValue([mockTokenA, mockTokenB, { ...mockTokenC, decimals: 0 }]);
      rerender(<SwapFlow />);
      await act(async () => {
        const authorization: SpendingLimitAuthorization = {
          kind: 'usd',
          id: 'authorization-1',
          accountId: 'pk-1',
          usdAmount: 10n,
          spendsDigest: 'spends-1',
          revision: 'revision-1',
          issuedAt: 120,
          expiresAt: 240
        };
        authorize(authorization);
        authorize(authorization);
      });
      expect(mockInitiateSwap).toHaveBeenCalledTimes(1);
      expect(mockInitiateSwap).toHaveBeenCalledWith(
        'pk-1',
        'faucet-C',
        10n,
        'faucet-B',
        5n,
        false,
        120,
        true,
        5,
        expect.objectContaining({ id: 'authorization-1' })
      );
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'true');
      expect(swapFlow().cancel).not.toHaveBeenCalled();
      await act(async () => finish('tx-held'));
      expect(swapFlow().complete).toHaveBeenCalledTimes(1);
      expect(swapFlow().cancel).not.toHaveBeenCalled();
      expect(screen.getByTestId('sa-offer-token')).toHaveTextContent('AAA');
      expect(screen.getByTestId('sa-offer-amount')).toBeEmptyDOMElement();
    });
  });

  describe('positive protocol amounts', () => {
    beforeEach(() => {
      mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 2n, {}, { offeredAmount: 1n }) };
      mockGetSwapTokens.mockReturnValue([{ ...mockTokenA, decimals: 0 }, { ...mockTokenB, decimals: 0 }, mockTokenC]);
      mockStringToBigInt.mockImplementation((str, decimals) => BigInt(Math.trunc(Number(str) * 10 ** decimals)));
      quoteFollowsOffer();
    });

    it.each(['offer', 'request'])('refuses a positive display %s amount that becomes zero raw units', async side => {
      renderFlow();
      if (side === 'offer') {
        setRequest('2');
        setOffer('0.5');
      } else {
        setOffer('1');
        setRequest('0.5');
      }
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it.each(['offer', 'request'])('refuses an undefined raw %s conversion', async side => {
      mockStringToBigInt.mockImplementation((str, decimals) => {
        if (str === '0.5') throw new Error('invalid raw amount');
        return BigInt(Math.trunc(Number(str) * 10 ** decimals));
      });
      renderFlow();
      if (side === 'offer') {
        setRequest('2');
        setOffer('0.5');
      } else {
        setOffer('1');
        setRequest('0.5');
      }
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it.each(['offer', 'request'])('refuses deferred authorization after the raw %s becomes zero', async side => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      renderFlow();
      setOffer('1');
      setRequest('2');
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      if (side === 'offer') setOffer('0.5');
      else setRequest('0.5');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('submits positive integer amounts with their exact zero-decimal raw values', async () => {
      renderFlow();
      setOffer('1');
      setRequest('3');
      setRequest('2');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockInitiateSwap).toHaveBeenCalledWith(
        'pk-1',
        'faucet-A',
        1n,
        'faucet-B',
        2n,
        false,
        120,
        true,
        undefined
      );
    });

    it('accepts a fractional display amount when the token precision gives it positive raw units', async () => {
      mockFormatBigInt.mockImplementation((amount, decimals) => String(Number(amount) / 10 ** decimals));
      mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 20n, {}, { offeredAmount: 5n }) };
      mockGetSwapTokens.mockReturnValue([{ ...mockTokenA, decimals: 1 }, { ...mockTokenB, decimals: 1 }, mockTokenC]);
      renderFlow();
      setOffer('0.5');
      setRequest('3');
      setRequest('2');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(mockInitiateSwap).toHaveBeenCalledWith(
        'pk-1',
        'faucet-A',
        5n,
        'faucet-B',
        20n,
        false,
        120,
        true,
        undefined
      );
    });
  });

  describe('status message', () => {
    it('reports user-visible missing fees rejected by review', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      mockBaseFee = 7;
      mockAllBalancesReturn = {
        data: [
          { tokenId: 'bech32-faucet-A', balance: 100 },
          { tokenId: 'MIDEN-ID', balance: 0 }
        ]
      };
      renderFlow();
      setOffer('10');
      await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('insufficientFeeAsset');
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['insufficientFeeAsset', 'review']]);
    });

    it('does not report user-visible successful quote state', () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapAmounts = true;
      renderFlow();
      setOffer('10');
      act(() => jest.advanceTimersByTime(1000));
      expect(reportUserVisibleError).not.toHaveBeenCalled();
    });

    it.each([
      ['no_market', 'swapVerdictNoMarket'],
      ['no_price', 'swapVerdictNoPrice']
    ])('reports user-visible quote verdict %s', (code, id) => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapAmounts = true;
      mockSwapQuoteResult = {
        loading: false,
        error: 'private quote detail',
        errorCode: code === 'no_market' ? 'no_market' : 'no_price'
      };
      renderFlow();
      setOffer('10');
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'inline']]);
    });

    it('shows a same-token error when both sides are the same faucet', () => {
      mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenA, mockTokenC]);
      renderFlow();

      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapSameToken');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('true');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
    });

    it('reports user-visible error: shows a same-token error when both sides are the same faucet', () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapAmounts = true;
      mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenA, mockTokenC]);
      renderFlow();

      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapSameToken');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('true');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapSameToken', 'inline']]);
    });

    it('shows a price-unavailable error when the quote errors', () => {
      mockSwapQuoteResult = { loading: false, error: 'quote boom', errorCode: 'unknown' };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapPriceUnavailable');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('true');
    });

    it('reports user-visible error: shows a price-unavailable error when the quote errors', () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapAmounts = true;
      mockSwapQuoteResult = { loading: false, error: 'quote boom', errorCode: 'unknown' };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapPriceUnavailable');
      expect(screen.getByTestId('sa-status-error')).toHaveTextContent('true');
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapPriceUnavailable', 'inline']]);
    });

    it('names the reason when the service says the pair is not traded or has no price', () => {
      mockSwapQuoteResult = { loading: false, error: 'no market', errorCode: 'no_market' };
      const { rerender } = renderFlow();
      setOffer('10');
      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapVerdictNoMarket');

      mockSwapQuoteResult = { loading: false, error: 'no price', errorCode: 'no_price' };
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-status')).toHaveTextContent('swapVerdictNoPrice');
    });

    it('shows no status message once a quote has landed', () => {
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-status')).toHaveTextContent('');
    });
  });

  describe('receive-field skeleton', () => {
    it.each(['0', '0.0000000001'])(
      'keeps receive input editable when the previous pay quote rounds to zero at fill price %s',
      fillPrice => {
        mockSwapQuoteResult = { loading: false, quote: quoteAt(fillPrice, 0n) };
        renderFlow();
        setOffer('10');

        expect(screen.getByTestId('sa-request-input')).toBeEnabled();
        expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');
        mockUseSwapQuote.mockReturnValue({ loading: true, quoteNow: mockQuoteNow });
        setRequest('9');
        expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('9');
        expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      }
    );

    it('keeps a valid-rate unfillable order editable and eligible', () => {
      renderFlow();
      setOffer('10');
      expect(screen.getByTestId('sa-request-input')).toBeEnabled();
      setRequest('9');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
      expect(screen.getByTestId('sa-status')).toHaveTextContent('');
    });

    it('flags the receive field as calculating while the first quote is pending', () => {
      mockSwapQuoteResult = { loading: true };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('true');
    });

    it('clears the skeleton once the quote seeds the receive amount', () => {
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');
      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');
    });

    it('clears the skeleton when the quote errors instead of spinning forever', () => {
      mockSwapQuoteResult = { loading: false, error: 'quote boom', errorCode: 'unknown' };
      renderFlow();
      setOffer('10');

      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('false');
    });
  });

  it('navigates to the review step from the amounts CTA', () => {
    renderFlow();
    fireEvent.click(screen.getByTestId('sa-confirm'));
    expect(mockNav.navigateTo).toHaveBeenCalledWith('ReviewSwap');
  });

  it('goes back from the review step', () => {
    renderFlow();
    fireEvent.click(screen.getByTestId('rs-go-back'));
    expect(mockNav.goBack).toHaveBeenCalled();
  });

  describe('onSubmit', () => {
    it('submits the edited expiry and auto-consume preference', async () => {
      renderFlow();
      setOffer('10');
      fireEvent.change(screen.getByTestId('rs-expiry'), { target: { value: '300' } });
      fireEvent.click(screen.getByTestId('rs-auto-consume'));

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, false, 300, false, 5);
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledWith('pk-1', [{ faucetId: 'faucet-A', amount: 10n }]);
    });

    it('tells the review screen a submission is in flight while the spending limit is assessed', async () => {
      let settle!: (value: undefined) => void;
      mockWalletState.assessSpendingLimit.mockReturnValue(new Promise(resolve => (settle = resolve)));
      renderFlow();
      setOffer('10');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'true');

      await act(async () => settle(undefined));
    });

    it('holds the review still while a press is in flight: the amount shown is the one sent', async () => {
      let settle!: (value: undefined) => void;
      mockWalletState.assessSpendingLimit.mockReturnValue(new Promise(resolve => (settle = resolve)));
      const { rerender } = renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      moveMarket();
      rerender(<SwapFlow />);
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('5');

      await act(async () => settle(undefined));
      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, false, 120, true, 5);
    });

    it('holds the rate and fill time with the amount while a press is in flight, then follows the quote', async () => {
      let releaseConfirm!: (confirmed: boolean) => void;
      mockConfirmSensitive.mockReturnValueOnce(new Promise<boolean>(resolve => (releaseConfirm = resolve)));
      const { rerender } = renderFlow();
      setOffer('10');
      expectReviewQuote('2', 'null');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      moveMarket();
      rerender(<SwapFlow />);
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'true');
      expectReviewQuote('2', 'null');

      await act(async () => releaseConfirm(false));
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
      expectReviewQuote('3', '42');
    });

    it('catches the review up with the latest quote once a press settles on Review', async () => {
      let releaseConfirm!: (confirmed: boolean) => void;
      mockConfirmSensitive.mockReturnValueOnce(new Promise<boolean>(resolve => (releaseConfirm = resolve)));
      const { rerender } = renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      moveMarket();
      rerender(<SwapFlow />);

      await act(async () => releaseConfirm(false));
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('discards a spending-limit assessment minted for another account', async () => {
      // The staleness guard exists because the account can change under an open challenge. An
      // assessment naming a different account can never authorize this swap, so it is dropped
      // before it reaches the user rather than being shown and then refused at the chokepoint.
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment({ accountId: 'pk-someone-else' }));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('uses strict authentication instead of ordinary confirmation for a spending-limit breach', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(mockConfirmSensitive).not.toHaveBeenCalled();
      expect(mockInitiateSwap).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(mockInitiateSwap).toHaveBeenCalledWith(
        'pk-1',
        'faucet-A',
        10n,
        'faucet-B',
        5n,
        false,
        120,
        true,
        5,
        expect.objectContaining({
          id: 'authorization-1',
          accountId: 'pk-1',
          revision: 'revision-1'
        })
      );
      expect(mockConfirmSensitive).not.toHaveBeenCalled();
    });

    it('discards an authorization for a different account instead of swapping against it', async () => {
      // `SpendingLimitChallenge` always mints an authorization bound to the account its own
      // assessment named; this plants a forged/stale one directly to prove `runSwap` refuses it on
      // its own.
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      mockAuthorizationAccountOverride = 'pk-someone-else';
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    });

    it('opens the unvalued challenge when the pre-check cannot price the swap', async () => {
      mockWalletState.assessSpendingLimit.mockRejectedValue({
        code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
        symbol: 'AAA'
      });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockWalletState.readSpendingLimit).toHaveBeenCalledWith('pk-1');
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('falls back to the generic error when the pre-check itself cannot open the unpriced challenge', async () => {
      // Distinct from the "no configured limit" fallback: `readSpendingLimit` fails outright (a
      // storage fault), reached from `onSubmit`'s own catch before `runSwap` is ever entered.
      mockWalletState.assessSpendingLimit.mockRejectedValue({
        code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
        symbol: 'AAA'
      });
      mockWalletState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-submit-error')).not.toHaveTextContent('');
    });

    it('falls back to a generic error when the price-unavailable pre-check has no configured limit to read', async () => {
      mockWalletState.assessSpendingLimit.mockRejectedValue({
        code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
        symbol: 'AAA'
      });
      mockWalletState.readSpendingLimit.mockResolvedValue(undefined);
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-submit-error')).not.toHaveTextContent('');
    });

    it('shows a real Error rejection from the pre-check by its own message', async () => {
      // Not price-unavailable and not an authorization-required breach - a genuine failure of the
      // pre-check itself, which must surface as its own reason rather than a swallowed string.
      mockWalletState.assessSpendingLimit.mockRejectedValue(new Error('assessment backend down'));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('assessment backend down');
    });

    it('reports user-visible error: shows a real Error rejection from the pre-check by its own message', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      // Not price-unavailable and not an authorization-required breach - a genuine failure of the
      // pre-check itself, which must surface as its own reason rather than a swallowed string.
      mockWalletState.assessSpendingLimit.mockRejectedValue(new Error('assessment backend down'));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('assessment backend down');
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_swap_submit_failed', 'review']]);
    });

    it('opens the unvalued challenge when the actual swap cannot be priced', async () => {
      mockInitiateSwap.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'AAA' });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
    });

    it('re-enables the swap button when the drawer authorize path cannot open the unpriced challenge', async () => {
      // The `runSwap` catch's own `openUnpricedChallenge` attempt throws here, not the pre-check's
      // - reached only once a breach already opened the challenge and the user re-authorizes into
      // an actual swap that itself cannot be priced.
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      mockInitiateSwap.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'AAA' });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

      mockWalletState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-submit-error')).not.toHaveTextContent('');
    });

    it('cancels a spending-limit challenge without queueing or losing the swap draft', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(
        breachAssessment({ breach: { spent: 95n, proposedTotal: 105n, limit: 100n, overBy: 5n, resetAt: null } })
      );
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
    });

    it('reopens the challenge with the final atomic assessment after an expiry or insertion race', async () => {
      const firstAssessment = breachAssessment();
      mockWalletState.assessSpendingLimit.mockResolvedValue(firstAssessment);
      mockInitiateSwap.mockRejectedValue({
        code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
        assessment: {
          ...firstAssessment,
          revision: 'revision-2',
          assessedAt: 121,
          breach: { ...firstAssessment.breach, spent: 99n, proposedTotal: 109n, overBy: 9n }
        }
      });
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('rejects a non-positive expiry', async () => {
      renderFlow();
      setOffer('10');
      fireEvent.change(screen.getByTestId('rs-expiry'), { target: { value: '0' } });

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
    });

    it('rejects an empty pay amount with a validation error', async () => {
      renderFlow();
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('reports user-visible error: rejects an empty pay amount with a validation error', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      renderFlow();
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapInvalidAmounts', 'review']]);
    });

    it('rejects a same-token swap with a validation error', async () => {
      mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenA, mockTokenC]);
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('reports user-visible error: rejects a same-token swap with a validation error', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      mockGetSwapTokens.mockImplementation(() => [mockTokenA, mockTokenA, mockTokenC]);
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapInvalidAmounts', 'review']]);
    });

    it('rejects when the derived receive amount is zero', async () => {
      mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 0n) };
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('rejects when the pay amount exceeds the balance', async () => {
      mockBalanceData = [{ tokenId: 'bech32-faucet-A', balance: 5 }];
      mockAllBalancesReturn = { data: mockBalanceData };
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapInvalidAmounts');
      expect(mockInitiateSwap).not.toHaveBeenCalled();
    });

    it('is a no-op when there is no public key', async () => {
      mockAccountReturn = { publicKey: '' };
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('');
    });

    it('ignores a second submit while the first is still in flight', async () => {
      let releaseConfirm: (v: boolean) => void = () => {};
      mockConfirmSensitive.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          releaseConfirm = resolve;
        })
      );
      renderFlow();
      setOffer('10');

      // First click enters the in-flight state (confirm pending).
      fireEvent.click(screen.getByTestId('rs-submit'));
      // Second click short-circuits on the `submitting` guard.
      fireEvent.click(screen.getByTestId('rs-submit'));

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockWalletState.assessSpendingLimit).toHaveBeenCalledTimes(1);
      expect(mockConfirmSensitive).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseConfirm(false);
      });
    });

    it('does not submit when biometric confirmation is declined, and leaves the button usable', async () => {
      mockConfirmSensitive.mockResolvedValue(false);
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockConfirmSensitive).toHaveBeenCalledWith('confirmSwapReason', expect.any(Function));
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(mockWalletState.setLastCompletedTxHash).not.toHaveBeenCalled();
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
    });

    it('confirms with the shared hardware-only protector probe', async () => {
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockConfirmSensitive).toHaveBeenCalledWith('confirmSwapReason', probeHardwareProtector);
    });

    it("shows the review screen's own error, and swaps nothing, when the protector probe rejects", async () => {
      mockConfirmSensitive.mockRejectedValue(new Error('protector check failed'));
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('protector check failed');
    });

    it('submits, nudges the service worker on extension, and hands off to the progress page', async () => {
      mockIsDelegateProof.mockReturnValue(true);
      mockInitiateSwap.mockResolvedValue('tx 123');
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockWalletState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, true, 120, true, 5);
      expect(mockRequestSWProcessing).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx%20123', 'replace');
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('');
    });

    it('does not nudge the service worker off-extension', async () => {
      mockIsExtension.mockReturnValue(false);
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).toHaveBeenCalled();
      expect(mockRequestSWProcessing).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith('/generating-transaction/tx-1', 'replace');
    });

    it('surfaces an Error message when the swap fails', async () => {
      mockInitiateSwap.mockRejectedValue(new Error('chain rejected'));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('chain rejected');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('reports user-visible error: surfaces an Error message when the swap fails', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      mockInitiateSwap.mockRejectedValue(new Error('chain rejected'));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('chain rejected');
      expect(mockNavigate).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_swap_submit_failed', 'review']]);
    });

    it('stringifies a non-Error rejection', async () => {
      mockInitiateSwap.mockRejectedValue('plain failure');
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('plain failure');
    });

    it('reports user-visible error: stringifies a non-Error rejection', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      mockInitiateSwap.mockRejectedValue('plain failure');
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('plain failure');
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['raw_swap_submit_failed', 'review']]);
    });
  });

  describe('telemetry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /**
     * Let the route settle. Arriving at /swap no longer begins the flow on its
     * own: the carousel commits a route on every swipe release, so a route has
     * to hold still to count as a visit — see `useRouteDwell`.
     */
    const dwell = () => act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS));

    /** Render and stay, which is what a user who meant to swap does. */
    const renderSwap = () => {
      const rendered = renderFlow();
      dwell();
      return rendered;
    };

    // A swap used to report nothing at all: it is not a send, so the send flow
    // never saw it, and a completed swap left no trace while an abandoned one
    // was indistinguishable from never opening the screen.
    it('begins a `swap` flow on entry', () => {
      renderSwap();

      expect(mockBeginFlow).toHaveBeenCalledTimes(1);
      expect(mockBeginFlow).toHaveBeenCalledWith('swap');
    });

    it('completes on a successful submit, before the navigation that unmounts the screen', async () => {
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(swapFlow().complete).toHaveBeenCalledTimes(1);
      expect(swapFlow().cancel).not.toHaveBeenCalled();
    });

    it('does not report a completed swap as abandoned when the screen then unmounts', async () => {
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      cleanup();

      expect(swapFlow().cancel).not.toHaveBeenCalled();
      expect(swapFlow().complete).toHaveBeenCalledTimes(1);
    });

    it('records the swap as abandoned when the user leaves without submitting', () => {
      renderSwap();
      setOffer('10');

      cleanup();

      expect(swapFlow().cancel).toHaveBeenCalledTimes(1);
      expect(swapFlow().complete).not.toHaveBeenCalled();
    });

    it('reports the failure kind when the submit throws, rather than calling it a cancellation', async () => {
      mockInitiateSwap.mockRejectedValueOnce(new Error('rpc exploded'));
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(swapFlow().fail).toHaveBeenCalledWith('rpc');
      expect(swapFlow().cancel).not.toHaveBeenCalled();
    });

    it('begins a fresh flow for a retry after a failure, instead of losing the second attempt', async () => {
      mockInitiateSwap.mockRejectedValueOnce(new Error('rpc exploded'));
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockBeginFlow).toHaveBeenCalledTimes(2);
      expect(swapFlow(1).complete).toHaveBeenCalledTimes(1);
    });

    it('leaves the flow open when validation rejects the amount, since the user can still fix it', async () => {
      renderFlow();

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(swapFlow().complete).not.toHaveBeenCalled();
      expect(swapFlow().fail).not.toHaveBeenCalled();
      expect(swapFlow().cancel).not.toHaveBeenCalled();
    });

    it('reports nothing while another home page is showing, since the carousel keeps this one mounted', () => {
      // TabLayout renders Overview / Send / Receive / Earn / Swap in one
      // carousel and mounts them all at once, for the whole session. A
      // mount-triggered flow therefore fired on every app open and reported a
      // swap the user never started — then never ended it, because swiping away
      // does not unmount this screen either.
      mockPathname = '/';

      renderFlow();

      expect(mockBeginFlow).not.toHaveBeenCalled();
    });

    it('reports nothing for a pane the carousel only swiped past', () => {
      // Swap sits at the far end of the carousel, so it is reached — and left —
      // by swiping through every other pane. Without a dwell each of those
      // crossings opened and closed a flow that described nothing anyone did.
      mockPathname = '/';
      const { rerender } = renderFlow();

      mockPathname = '/swap';
      rerender(<SwapFlow />);
      act(() => void jest.advanceTimersByTime(ROUTE_DWELL_MS - 1));

      mockPathname = '/earn';
      rerender(<SwapFlow />);
      dwell();

      expect(mockBeginFlow).not.toHaveBeenCalled();
    });

    it('reports the swap as abandoned when the user swipes away, without waiting for an unmount', () => {
      const { rerender } = renderSwap();

      mockPathname = '/';
      rerender(<SwapFlow />);

      expect(swapFlow().cancel).toHaveBeenCalledTimes(1);
    });

    it('records the step reached, so an abandoned swap says where it stopped', () => {
      mockNav = { navigateTo: jest.fn(), goBack: jest.fn(), cardStack: [{ name: 'ReviewSwap' }] };
      renderSwap();

      expect(stepsReported()).toContain('review');
    });

    it('marks the swap as submitting once past the confirmation, separating our failures from cold feet', async () => {
      renderFlow();
      setOffer('10');

      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(stepsReported()).toContain('submitting');
    });
  });

  describe('an open spending-limit challenge holds the review still', () => {
    const breach = breachAssessment();

    const openChallengeThenMoveMarket = async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breach);
      const view = renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
      moveMarket();
      view.rerender(<SwapFlow />);
      return view;
    };

    it('sends the amount the press reviewed when the challenge is approved after the market moves', async () => {
      await openChallengeThenMoveMarket();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('5');
      expectReviewQuote('2', 'null');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });

      expect(mockInitiateSwap).toHaveBeenCalledWith(
        'pk-1',
        'faucet-A',
        10n,
        'faucet-B',
        5n,
        false,
        120,
        true,
        5,
        expect.objectContaining({ revision: 'revision-1' })
      );
    });

    it('keeps the reviewed amount under a revised challenge and sends it on approval', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breach);
      mockInitiateSwap.mockRejectedValueOnce({
        code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
        assessment: { ...breach, revision: 'revision-2', assessedAt: 121 }
      });
      const { rerender } = renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });
      expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');

      moveMarket();
      rerender(<SwapFlow />);
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('5');
      expectReviewQuote('2', 'null');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' }));
      });
      expect(mockInitiateSwap).toHaveBeenLastCalledWith(
        'pk-1',
        'faucet-A',
        10n,
        'faucet-B',
        5n,
        false,
        120,
        true,
        5,
        expect.objectContaining({ revision: 'revision-2' })
      );
    });

    it('catches the review up to the new quote once the challenge is dismissed', async () => {
      await openChallengeThenMoveMarket();

      fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
      expectReviewQuote('3', '42');
    });

    it('keeps mobile back with its own handler while the challenge is open', async () => {
      await openChallengeThenMoveMarket();
      expect(mockChallengeCloseOnBack).toBe(false);
    });

    it('catches the review up once mobile back abandons the challenge', async () => {
      await openChallengeThenMoveMarket();

      act(() => {
        mockBackHandler!();
      });

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
      expectReviewQuote('3', '42');
    });

    it('catches the review up once the stale-context reset abandons the challenge', async () => {
      const { rerender } = await openChallengeThenMoveMarket();

      mockAccountReturn = { publicKey: 'pk-2' };
      rerender(<SwapFlow />);

      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('7');
      expectReviewQuote('3', '42');
    });
  });

  describe('pre-submit check', () => {
    // As the real hook does, a `quoteNow` answer lands in the hook's state as well as in the caller's hands.
    const quoteNowAnswers = (quote: NonNullable<typeof mockSwapQuoteResult.quote>) =>
      mockQuoteNow.mockImplementationOnce(async () => {
        mockSwapQuoteResult = { loading: false, quote };
        return quote;
      });

    it('re-quotes the exact ask on screen before anything else, and goes on when the solver fills it', async () => {
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockQuoteNow).toHaveBeenCalledTimes(1);
      expect(mockQuoteNow).toHaveBeenCalledWith(5n);
      expect(mockQuoteNow.mock.invocationCallOrder[0]).toBeLessThan(
        mockWalletState.assessSpendingLimit.mock.invocationCallOrder[0]!
      );
      expect(mockInitiateSwap).toHaveBeenCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, false, 120, true, 5);
    });

    it('refuses an ask the price has moved past, shows the fresh quote and rebuilds the wallet-built amount', async () => {
      const moved = quoteAt('1', 5n, { priceBand: 'off_market', fillStatus: 'none', reason: 'price' });
      quoteNowAnswers(moved);
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPriceMoved');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
      expect(screen.getByTestId('rs-market-price')).toHaveTextContent('1');
      // The second call is the rebuild from the new price: no ask of its own.
      expect(mockQuoteNow).toHaveBeenCalledTimes(2);
      expect(mockQuoteNow).toHaveBeenLastCalledWith();
    });

    it('reports user-visible error: refuses an ask the price has moved past, shows the fresh quote and rebuilds the wallet-built amount', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      const moved = quoteAt('1', 5n, { priceBand: 'off_market', fillStatus: 'none', reason: 'price' });
      quoteNowAnswers(moved);
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPriceMoved');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
      expect(screen.getByTestId('rs-market-price')).toHaveTextContent('1');
      // The second call is the rebuild from the new price: no ask of its own.
      expect(mockQuoteNow).toHaveBeenCalledTimes(2);
      expect(mockQuoteNow).toHaveBeenLastCalledWith();
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapPriceMoved', 'review']]);
    });

    it('keeps a user-edited ask as it is when the solver reads it as off market', async () => {
      quoteNowAnswers(quoteAt('2', 9n, { priceBand: 'off_market', fillStatus: 'none', reason: 'price' }));
      renderFlow();
      setOffer('10');
      setRequest('9');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPriceMoved');
      expect(mockQuoteNow).toHaveBeenCalledTimes(1);
      expect(mockQuoteNow).toHaveBeenCalledWith(9n);
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent('9');
    });

    it('refuses an ask the solver reads off market while its settlements are paused', async () => {
      quoteNowAnswers(
        quoteAt('2', 5n, { settlementsRunning: false, priceBand: 'off_market', fillStatus: 'none', reason: 'price' })
      );
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPriceMoved');
    });

    it('refuses to sign on a pair the solver does not trade or price', async () => {
      quoteNowAnswers(quoteAt('2', 5n, { priceBand: null, fillStatus: 'none', reason: 'no_price' }));
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPriceMoved');
    });

    it('lets the usual testnet answer through: at market with nothing to match yet', async () => {
      quoteNowAnswers(quoteAt('2', 5n, { fillStatus: 'none', reason: 'liquidity' }));
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).toHaveBeenCalledTimes(1);
    });

    it('refuses to sign an ask it could not check', async () => {
      mockQuoteNow.mockRejectedValueOnce(new Error('offline'));
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPriceUnavailable');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
    });

    it('reports user-visible error: refuses to sign an ask it could not check', async () => {
      jest.useFakeTimers();
      jest.mocked(reportUserVisibleError).mockClear();
      mockRealSwapDisplays = true;
      mockQuoteNow.mockRejectedValueOnce(new Error('offline'));
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(mockWalletState.assessSpendingLimit).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapPriceUnavailable');
      expect(screen.getByTestId('review-swap')).toHaveAttribute('data-submitting', 'false');
      act(() => jest.advanceTimersByTime(1000));
      expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['swapPriceUnavailable', 'review']]);
    });
  });

  // The real hook over a quoteSwap stand-in, since the ask's origin is lost between the hook's
  // pre-submit check and the receive field that reads its answer.
  describe('a press that stops short of the queue keeps the wallet-built receive amount', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      const { useSwapQuote } = jest.requireActual<typeof import('./useSwapQuote')>('./useSwapQuote');
      mockUseSwapQuote.mockImplementation(useSwapQuote);
      // quoteSwap's labelling: wallet-built for an ask it built, or for one it is told the wallet built.
      mockQuoteSwap.mockImplementation(
        async (
          _offer: unknown,
          offeredAmount: bigint,
          _request: unknown,
          options: { requestedAmount?: bigint; builtAsk?: boolean; slippageBps: number }
        ) =>
          quoteAt(
            '2',
            options.requestedAmount ?? 5n,
            {},
            {
              offeredAmount,
              slippageBps: options.slippageBps,
              builtAsk: options.requestedAmount === undefined || options.builtAsk === true
            }
          )
      );
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const reviewTheBuiltAsk = async () => {
      renderFlow();
      setOffer('10');
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent(/^5$/);
    };
    const press = () =>
      act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
    const expectTheBuiltAskSent = () =>
      expect(mockInitiateSwap).toHaveBeenLastCalledWith('pk-1', 'faucet-A', 10n, 'faucet-B', 5n, false, 120, true, 5);

    it('after a cancelled biometric, and a second press sends it', async () => {
      await reviewTheBuiltAsk();
      mockConfirmSensitive.mockResolvedValueOnce(false);
      await press();
      expect(mockQuoteSwap).toHaveBeenCalledTimes(2);
      expect(mockInitiateSwap).not.toHaveBeenCalled();
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent(/^5$/);

      await press();
      expectTheBuiltAskSent();
    });

    it('after a dismissed spending-limit challenge, and a second press sends it', async () => {
      await reviewTheBuiltAsk();
      mockWalletState.assessSpendingLimit.mockResolvedValueOnce(breachAssessment());
      await press();
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent(/^5$/);

      await press();
      expectTheBuiltAskSent();
    });

    it('after the queue refuses the swap, and a second press sends it', async () => {
      await reviewTheBuiltAsk();
      mockInitiateSwap.mockRejectedValueOnce(new Error('queue refused'));
      await press();
      expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('queue refused');
      expect(screen.getByTestId('rs-request-amount')).toHaveTextContent(/^5$/);

      await press();
      expect(mockInitiateSwap).toHaveBeenCalledTimes(2);
      expectTheBuiltAskSent();
    });
  });

  describe('a kept quote for other inputs', () => {
    // The hook keeps the last same-pair quote on screen while a changed input reloads. Its ask was
    // built for the old inputs, so it must not fill the receive field, enable Continue or be signed.
    it('empties the receive field and blocks Continue when the pay amount changes, until its own quote lands', async () => {
      const { rerender } = renderFlow();
      setOffer('10');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('5');

      setOffer('20');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('false');
      expect(screen.getByTestId('sa-request-loading')).toHaveTextContent('true');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      expect(mockQuoteNow).not.toHaveBeenCalled();
      expect(mockInitiateSwap).not.toHaveBeenCalled();

      mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 10n, {}, { offeredAmount: 20n }) };
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('10');
      expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
    });

    it('empties the receive field when the slippage changes, until a quote at that slippage lands', () => {
      const { rerender } = renderFlow();
      setOffer('10');
      fireEvent.click(screen.getByTestId('rs-set-slippage'));
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('');

      mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 4n, {}, { slippageBps: 50 }) };
      rerender(<SwapFlow />);
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('4');
    });

    it('never fills the receive field from a quote of the user own ask once they hand it back', () => {
      mockSwapQuoteResult = { loading: false, quote: quoteAt('2', 9n, {}, { builtAsk: false }) };
      renderFlow();
      setOffer('10');
      expect(screen.getByTestId('sa-request-amount')).toHaveTextContent('');
    });
  });

  describe('slippage', () => {
    it('opens on 0.05 % and hands the review change to the quote', () => {
      renderFlow();
      expect(screen.getByTestId('rs-slippage')).toHaveTextContent('5');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(
        expect.objectContaining({ slippageBps: 5, requestEdited: false })
      );

      fireEvent.click(screen.getByTestId('rs-set-slippage'));
      expect(screen.getByTestId('rs-slippage')).toHaveTextContent('50');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ slippageBps: 50 }));
    });

    it('tells the quote and the review when the user has taken the receive field over', () => {
      renderFlow();
      setRequest('9');
      expect(screen.getByTestId('rs-request-edited')).toHaveTextContent('true');
      expect(mockUseSwapQuote).toHaveBeenLastCalledWith(expect.objectContaining({ requestEdited: true }));
    });
  });

  describe('mobile back handler', () => {
    it('closes an open spending-limit challenge before anything else', async () => {
      mockWalletState.assessSpendingLimit.mockResolvedValue(breachAssessment());
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });
      expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
      // The swap draft is untouched - this is a dismissal, not a cancel-and-lose-state action.
      expect(screen.getByTestId('rs-offer-amount')).toHaveTextContent('10');
    });

    it('closes the token drawer first when it is open', () => {
      renderFlow();
      fireEvent.click(screen.getByTestId('sa-select-offer'));
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-open', 'true');

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(screen.getByTestId('swap-token-drawer')).toHaveAttribute('data-open', 'false');
    });

    it('steps back inside the flow when the card stack has depth', () => {
      mockNav.cardStack = [{ name: 'SwapAmounts' }, { name: 'ReviewSwap' }];
      renderFlow();

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(mockNav.goBack).toHaveBeenCalled();
    });

    it('goes nowhere while a submission is in flight at Review', async () => {
      mockWalletState.assessSpendingLimit.mockReturnValue(new Promise(() => undefined));
      mockNav.cardStack = [{ name: 'SwapAmounts' }, { name: 'ReviewSwap' }];
      renderFlow();
      setOffer('10');
      await act(async () => {
        fireEvent.click(screen.getByTestId('rs-submit'));
      });

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(mockNav.goBack).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('closes the flow when the drawer is shut and the stack is at the root', () => {
      renderFlow();

      let handled: boolean | undefined;
      act(() => {
        handled = mockBackHandler!();
      });

      expect(handled).toBe(true);
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });
});

beforeEach(() => {
  mockLegacyFeeIdentity = undefined;
});

afterEach(() => {
  mockTokenA.decimals = 8;
});

jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

afterEach(() => {
  mockRealSwapDisplays = false;
  mockRealSwapAmounts = false;
  jest.useRealTimers();
});

// Load the real review after the mock bindings initialize, before any timed test.
// Cold coverage instrumentation otherwise consumes the first interaction's deadline.
jest.requireActual<typeof import('./ReviewSwap')>('./ReviewSwap');

it('refuses a cached sufficient balance when the SDK vault cannot cover the pay amount', async () => {
  renderFlow();
  setOffer('10');
  expect(screen.getByTestId('sa-can-proceed')).toHaveTextContent('true');
  mockVaultPreflight.mockRejectedValueOnce(new Error('amountMustBeLessThanBalance'));
  await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
  expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('amountMustBeLessThanBalance');
  expect(mockConfirmSensitive).not.toHaveBeenCalled();
  expect(mockInitiateSwap).not.toHaveBeenCalled();
});

it.each(['account', 'network'])('refuses a changed %s while authorization is open', async change => {
  let authorize!: (value: boolean) => void;
  mockConfirmSensitive.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        authorize = resolve;
      })
  );
  const { rerender } = renderFlow();
  setOffer('10');
  await act(async () => fireEvent.click(screen.getByTestId('rs-submit')));
  if (change === 'account') mockAccountReturn = { publicKey: 'other-account' };
  else mockNetworkScope = 'other|rpc';
  rerender(<SwapFlow />);
  await act(async () => authorize(true));
  expect(mockInitiateSwap).not.toHaveBeenCalled();
  expect(screen.getByTestId('rs-submit-error')).toHaveTextContent('swapBalanceUnavailable');
});
