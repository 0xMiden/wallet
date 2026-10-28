import React from 'react';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';
import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { confirmSensitiveAction } from 'lib/biometric';
import { bridgeEpochSend } from 'lib/epoch';
import {
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { stringToBigInt } from 'lib/i18n/numbers';
import { deserializeInternalError, serializeInternalError } from 'lib/intercom/helpers';
import { initiateSendTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { TEST_SWAP_TOKENS, TEST_TOKEN_IETH } from 'lib/miden/swap/testing/registry';
import { _setSwapTokensForTest } from 'lib/miden/swap/tokens';
import { isExtension } from 'lib/platform';
import type { BridgeFeature, FeatureAvailability } from 'lib/remote-config/availability';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { initiateUsdcxBurn, readUsdcxMinimumBurn } from 'lib/usdcx/burn';
import { UsdcxBurnError } from 'lib/usdcx/withdrawal';
import { goBack, navigate } from 'lib/woozie';
import { isValidMidenAddress } from 'utils/miden';

import { dateTimeToRecallBlocks } from './RecallCalendarDrawer';
import { ReviewTransaction } from './ReviewTransaction';
import { clearSendDraft } from './send-draft';
import { enterSendFlow, settleSendFlow } from './send-telemetry';

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

// ---------------------------------------------------------------------------
// Mutable per-test state read by the hook mocks. All prefixed with `mock` so
// they are legal to reference from hoisted jest.mock factories.
// ---------------------------------------------------------------------------
let mockSearch = '';
let mockFullPage = false;
let mockPublicKey: string | null = 'pubkey-1';
let mockBalanceData: any[] | undefined;
let mockTokensMeta: any[] = [];
let mockDetectedChain: 'miden' | 'ethereum' = 'miden';
let mockEpochQuote: { amount?: string; loading: boolean; error: null; symbol: string } = {
  amount: undefined,
  loading: false,
  error: null,
  symbol: 'USDC'
};
let mockEpochQuoteArgs: { amount?: bigint } = {};
let mockBurnMinimum = 5_000_000n;
let mockUseRealBurnMinimum = false;
// The native asset's chain metadata; null until a test discovers one, as before discovery.
let mockNativeMetadata: { symbol: string; decimals: number } | null = null;
jest.mock('lib/telemetry/user-visible-error', () => ({ reportUserVisibleError: jest.fn() }));

jest.mock('lib/usdcx/burn', () => ({
  initiateUsdcxBurn: jest.fn(async () => 'burn-tx'),
  readUsdcxMinimumBurn: jest.fn()
}));
jest.mock('lib/usdcx/use-burn-minimum', () => ({
  useBurnMinimum: (enabled: boolean) => {
    const useMinimum = mockUseRealBurnMinimum
      ? jest.requireActual<typeof import('lib/usdcx/use-burn-minimum')>('lib/usdcx/use-burn-minimum').useBurnMinimum
      : () => mockBurnMinimum;
    return useMinimum(enabled);
  }
}));

const mockWalletStoreState = {
  tokenPrices: { USDC: { price: 2 } } as Record<string, { price: number; observedAt?: number }>,
  setLastCompletedTxHash: jest.fn(),
  assessSpendingLimit: jest.fn(),
  readSpendingLimit: jest.fn()
};

type TelemetryHandle = { complete: jest.Mock; cancel: jest.Mock; fail: jest.Mock; step: jest.Mock };
const telemetryHandles: TelemetryHandle[] = [];
const beginFlowMock = jest.fn((_flow: string) => {
  const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn(), step: jest.fn() };
  telemetryHandles.push(handle);
  return handle;
});
const classifyErrorMock = jest.fn((_error: unknown) => 'rpc');

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// RpcClient lives on the lazy SDK subpath (mapped to wasmMock, which has no
// RpcClient). Provide a controllable class + expose its header fn.
// The network banner now tops this screen, so the wallet names the chain on every surface that
// commits value. Its sheet and the effective-endpoint lookup are tested in their own suites;
// stubbing only those keeps the banner itself real here, so the assertion is not on a stub.
// The bridged price entries the testnet config names (the manual mock beside the module).
jest.mock('lib/miden/swap/bridge-price-allowlist');
// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
let mockBridgeAvailability: FeatureAvailability = { state: 'available' };
jest.mock('lib/remote-config/use-feature-availability', () => ({
  ...jest.requireActual<typeof import('lib/remote-config/use-feature-availability')>(
    'lib/remote-config/use-feature-availability'
  ),
  useFeatureAvailability: jest.fn(() => mockBridgeAvailability)
}));
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
});
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveRpcUrl: () => 'https://rpc.review.example',
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const getBlockHeaderByNumber = jest.fn();
  class RpcClient {
    endpoint: string;
    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }
    getBlockHeaderByNumber() {
      return getBlockHeaderByNumber();
    }
  }
  return { RpcClient, __getBlockHeaderByNumber: getBlockHeaderByNumber };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The recall note names its amount, a fee label its fee asset, a USDCx payout line its amount and network,
    // and the Advanced options summary its transfer type and expiration; every other key reads as itself.
    t: (
      key: string,
      params?: { amount?: string; symbol?: string; network?: string; transferType?: string; expiration?: string }
    ) =>
      key === 'recallReturnsNote' && params?.amount
        ? `${key} ${params.amount}`
        : key === 'advancedOptionsSummary'
          ? `${params?.transferType} · ${params?.expiration}`
          : params?.symbol !== undefined
            ? `${key}|${params.symbol}`
            : params?.amount !== undefined
              ? [key, params.amount, params.network].filter(part => part !== undefined).join('|')
              : key
  })
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: mockFullPage })
}));

jest.mock('./SendStepLayout', () => ({
  SendStepLayout: ({ title, onBack, onClose, children, footer }: any) => (
    <div data-testid="review-layout">
      <h1>{title}</h1>
      <button data-testid="back-btn" aria-label="back" onClick={onBack}>
        back
      </button>
      <button data-testid="close-btn" aria-label="close" onClick={onClose}>
        close
      </button>
      <div data-testid="hero">{children}</div>
      <div data-testid="footer">{footer}</div>
    </div>
  )
}));
jest.mock('components/NetworkChip', () => ({
  NetworkLogo: ({ kind }: any) => <span data-testid="network-logo" data-kind={kind} />
}));

// Set by a test that needs the mock challenge to hand back an authorization for a DIFFERENT
// account than the one the challenge itself was opened for - a stale/forged credential, which the
// real `SpendingLimitChallenge` never produces (its authorization always carries the challenge's
// own `source.accountId`) but which `runSameChainSend`/`runBridgeSend` must independently refuse.
let mockAuthorizationAccountOverride: string | undefined;

jest.mock('components/SpendingLimitChallenge', () => ({
  SpendingLimitChallenge: (props: any) => {
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

// The public notice slides in and out on the `reveal` preset; the tests read the DOM, not the
// motion, and a real exit animation would keep a dismissed notice mounted past the assertion.
jest.mock('framer-motion', () => {
  const React = jest.requireActual('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef(
        ({ initial: _i, animate: _a, exit: _e, transition: _t, ...props }: any, ref: React.Ref<HTMLDivElement>) => (
          <div ref={ref} {...props} />
        )
      )
    },
    useReducedMotion: () => false
  };
});

jest.mock('components/ui/DetailCard', () => ({
  DetailCard: ({ children }: any) => <div data-testid="rows">{children}</div>,
  DetailRow: ({
    label,
    children,
    action,
    sub,
    onClick,
    disabled,
    'aria-haspopup': hasPopup,
    'data-testid': testId
  }: any) => (
    <div data-testid={testId ?? 'review-row'}>
      <span data-testid="row-label">{label}</span>
      {children !== undefined && <span data-testid="row-children">{children}</span>}
      {action && (
        <button
          data-testid={action['data-testid']}
          aria-haspopup={action['aria-haspopup']}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
      {onClick && (
        <button data-testid="row-open" aria-haspopup={hasPopup} disabled={disabled} onClick={onClick}>
          open
        </button>
      )}
      {sub !== undefined && <span data-testid="row-note">{sub}</span>}
    </div>
  ),
  // Like the real one, the rows inside render only while open and the summary only while closed.
  DetailDisclosure: ({ title, summary, summaryEmphasis, open, onOpenChange, children, 'data-testid': testId }: any) => (
    <div data-testid={testId} data-open={String(open)} data-emphasis={String(Boolean(summaryEmphasis))}>
      <button data-testid={`${testId}-toggle`} onClick={() => onOpenChange(!open)}>
        {title}
      </button>
      {!open && summary && <span data-testid={`${testId}-summary`}>{summary}</span>}
      {open && children}
    </div>
  )
}));
jest.mock('./TransferTypeDrawer', () => ({
  TransferTypeDrawer: (props: any) => (
    <div data-testid="transfer-type-drawer" data-open={String(props.open)} data-value={props.value}>
      <button data-testid="transfer-type-pick-public" onClick={() => props.onChange('public')}>
        public
      </button>
      <button data-testid="transfer-type-pick-private" onClick={() => props.onChange('private')}>
        private
      </button>
      <button data-testid="transfer-type-close" onClick={() => props.onOpenChange(false)}>
        close
      </button>
    </div>
  )
}));
jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId?: string }) => <span data-testid="token-logo" data-faucet-id={faucetId} />
}));
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary' },
  Button: ({ title, variant: _variant, isLoading: _isLoading, accent, ...rest }: any) => (
    <button type="button" data-accent={accent} {...rest}>
      {title}
    </button>
  )
}));

jest.mock('lib/biometric', () => ({
  confirmSensitiveAction: jest.fn()
}));

jest.mock('lib/miden/back/protector-probe', () => ({
  probeHardwareProtector: jest.fn()
}));

jest.mock('lib/agglayer/allowed-faucets', () => ({
  isAgglayerFaucetAllowed: jest.fn()
}));

jest.mock('lib/agglayer/b2agg', () => ({
  initiateB2AggBridge: jest.fn()
}));

jest.mock('lib/epoch', () => ({
  EPOCH_DESTINATION_CHAIN_ID: 11155111,
  bridgeEpochSend: jest.fn()
}));

jest.mock('lib/i18n/numbers', () => ({
  formatUsd: jest.requireActual('lib/i18n/numbers').formatUsd,
  toAdaptiveFixed: (v: number) => v.toFixed(2),
  stringToBigInt: jest.fn(),
  // The deep-link balance guard compares base units. The stringToBigInt stand-in above is a fixed
  // return, so the guard has to call the real helper.
  typedAmountExceedsBalance: (...a: [string, number, number]) =>
    jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers').typedAmountExceedsBalance(...a),
  amountExceedsTokenDecimals: (...a: [string, number]) =>
    jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers').amountExceedsTokenDecimals(...a)
}));

jest.mock('lib/miden/activity', () => ({
  initiateSendTransaction: jest.fn(),
  requestSWTransactionProcessing: jest.fn()
}));

jest.mock('lib/miden/front', () => ({
  useAccount: () => ({ publicKey: mockPublicKey }),
  useAllBalances: () => ({ data: mockBalanceData }),
  useAllTokensBaseMetadata: () => mockTokensMeta
}));

jest.mock('lib/miden/front/client', () => ({
  useMidenContext: () => ({ signTransaction: jest.fn() })
}));

// Distinct, so an assertion on it fails for any other provider.
jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: { provider: 'zustand' }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => a === b
}));

// USDCx is the chain's native asset, so the faucet the review accepts is the discovered one.
const USDCX_FAUCET_ID_BECH32 = 'mtst1usdcxnative';
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual<typeof import('lib/miden-chain/native-asset')>('lib/miden-chain/native-asset'),
  getNativeAssetIdSync: () => 'mtst1usdcxnative',
  getNativeAssetMetadataSync: () => mockNativeMetadata
}));

jest.mock('lib/miden-chain/constants', () => ({
  // The real network names and default: the network banner's pill pulls in the icon set, which reads
  // both at import.
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: jest.fn(),
  getRpcEndpoint: jest.fn(() => 'https://rpc.example')
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));
jest.mock('lib/platform', () => ({
  isExtension: jest.fn(() => false),
  isMobile: () => false,
  isDesktop: () => false,
  isIOS: () => false,
  isAndroid: () => false
}));

jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: jest.fn(() => false)
}));

jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (state: typeof mockWalletStoreState) => unknown) =>
      selector ? selector(mockWalletStoreState) : mockWalletStoreState,
    { getState: () => mockWalletStoreState }
  )
}));

jest.mock('lib/woozie', () => ({
  goBack: jest.fn(),
  navigate: jest.fn(),
  HistoryAction: { Push: 'pushstate', Replace: 'replacestate' },
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">redirect:{to}</div>,
  useLocation: () => ({ search: mockSearch })
}));

jest.mock('utils/miden', () => {
  const validate = jest.fn(() => true);
  return {
    isValidMidenAddress: validate,
    isValidRecipientAddress: validate,
    detectAddressChain: () => mockDetectedChain
  };
});

jest.mock('./RecallCalendarDrawer', () => ({
  SECONDS_PER_BLOCK: 3,
  dateTimeToRecallBlocks: jest.fn(() => 999),
  RecallCalendarDrawer: (props: any) => (
    <div data-testid="recall-drawer" data-open={String(props.open)} data-recall-time={props.recallTime}>
      <button data-testid="recall-pick-never" onClick={() => props.onRecallNever()}>
        recall-never
      </button>
      <button data-testid="recall-pick-blocks" onClick={() => props.onRecallBlocksChange('42')}>
        recall-blocks
      </button>
      <button data-testid="recall-pick-time" onClick={() => props.onRecallTimeChange('changed-time')}>
        recall-time
      </button>
      <button data-testid="recall-pick-date" onClick={() => props.onRecallDateChange(new Date(0))}>
        recall-date
      </button>
    </div>
  )
}));

jest.mock('./send-draft', () => ({
  clearSendDraft: jest.fn()
}));

// The real `./send-telemetry` is kept: this page settling the flow the send form
// began is the whole point of that module, so it must not be stubbed out.
jest.mock('lib/telemetry', () => ({
  beginFlow: (flow: string) => beginFlowMock(flow),
  classifyError: (error: unknown) => classifyErrorMock(error)
}));

jest.mock('./useEpochQuote', () => ({
  useEpochQuote: (args: { amount?: bigint }) => {
    mockEpochQuoteArgs = args;
    return mockEpochQuote;
  }
}));

// ---------------------------------------------------------------------------
// Typed handles to the mocks
// ---------------------------------------------------------------------------
const confirmMock = confirmSensitiveAction as jest.Mock;
const initiateB2AggBridgeMock = initiateB2AggBridge as jest.Mock;
const bridgeEpochSendMock = bridgeEpochSend as jest.Mock;
const stringToBigIntMock = stringToBigInt as jest.Mock;
const initiateMock = initiateSendTransaction as jest.Mock;
const requestSWMock = requestSWTransactionProcessing as jest.Mock;
const isExtensionMock = isExtension as jest.Mock;
const isDelegateProofEnabledMock = isDelegateProofEnabled as jest.Mock;
const isValidMidenAddressMock = isValidMidenAddress as jest.Mock;
const goBackMock = goBack as jest.Mock;
const navigateMock = navigate as jest.Mock;
const clearSendDraftMock = clearSendDraft as jest.Mock;
const dateTimeToRecallBlocksMock = dateTimeToRecallBlocks as jest.Mock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** Advanced options is collapsed by default; the expiration and transfer-type rows live under it. */
const openAdvancedOptions = async () => {
  fireEvent.click(screen.getByTestId('review-advanced-options-toggle'));
  await flush();
};
function deferred<T = unknown>() {
  let resolve!: (v?: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (v?: T) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const VALID_TOKEN = {
  tokenId: 'tok1',
  metadata: { symbol: 'MDN', decimals: 8 },
  balance: 100,
  fiatPrice: 2
};

// Same token, but its faucet never resolved — so `metadata.decimals` is the
// unknown-token placeholder's guess of 6 rather than anything the faucet said.
const UNSCALED_TOKEN = {
  tokenId: 'tok1',
  metadata: { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true },
  balance: 100,
  fiatPrice: 0
};

const setValidRoute = (tokenId = VALID_TOKEN.tokenId) => {
  mockSearch = `amount=5&to=0xrecipient&tokenId=${tokenId}`;
  mockBalanceData = [{ ...VALID_TOKEN, tokenId }];
};

const breachAssessment = (overrides: Record<string, unknown> = {}) => ({
  accountId: 'pubkey-1',
  usdAmount: 12345n,
  revision: 'revision-1',
  assessedAt: 100,
  breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: 200 },
  ...overrides
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
  mockBridgeAvailability = { state: 'available' };
  jest.resetAllMocks();
  jest.mocked(useFeatureAvailability).mockImplementation(() => mockBridgeAvailability);
  mockBurnMinimum = 5_000_000n;
  jest.mocked(initiateUsdcxBurn).mockResolvedValue('burn-tx');
  mockAuthorizationAccountOverride = undefined;

  // Base implementations (resetAllMocks wipes impls).
  confirmMock.mockResolvedValue(true);
  stringToBigIntMock.mockReturnValue(12345n);
  initiateMock.mockResolvedValue('tx-abc');
  initiateB2AggBridgeMock.mockResolvedValue('tx-bridge');
  jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(true);
  bridgeEpochSendMock.mockResolvedValue({ txId: 'tx-epoch' });
  dateTimeToRecallBlocksMock.mockReturnValue(999);
  isExtensionMock.mockReturnValue(false);
  isDelegateProofEnabledMock.mockReturnValue(false);
  isValidMidenAddressMock.mockReturnValue(true);
  mockWalletStoreState.setLastCompletedTxHash.mockReset();
  mockWalletStoreState.assessSpendingLimit.mockResolvedValue(undefined);
  mockWalletStoreState.readSpendingLimit.mockReset();
  mockWalletStoreState.readSpendingLimit.mockResolvedValue({
    accountId: 'pubkey-1',
    limit: 100_000_000n,
    revision: 'revision-1',
    createdAt: 1,
    updatedAt: 2
  });

  // Base route state.
  mockSearch = '';
  mockFullPage = false;
  mockPublicKey = 'pubkey-1';
  mockBalanceData = undefined;
  mockTokensMeta = [];
  mockDetectedChain = 'miden';
  mockEpochQuote = { amount: undefined, loading: false, error: null, symbol: 'USDC' };
  mockEpochQuoteArgs = {};
  mockNativeMetadata = null;

  delete process.env.MIDEN_E2E_TEST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete (globalThis as any).__TEST_SET_SHARE_PRIVATELY__;
});

// ---------------------------------------------------------------------------
// Deep-link redirect guards
// ---------------------------------------------------------------------------
describe('USDCx burn review', () => {
  beforeEach(() => {
    mockDetectedChain = 'ethereum';
    mockBalanceData = [{ ...VALID_TOKEN, tokenId: USDCX_FAUCET_ID_BECH32, metadata: { symbol: 'USDCX', decimals: 6 } }];
    mockSearch = `amount=5.000001&to=0x1111111111111111111111111111111111111111&tokenId=${USDCX_FAUCET_ID_BECH32}&network=arc-testnet&route=usdcx`;
  });

  it('submits the exact base-unit burn and shows Circle fee as varying, with no payout bound', async () => {
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('usdcxWithdrawalNotice')).toBeInTheDocument();
    expect(screen.getByText('usdcxPayoutFeeVaries')).toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-payout-net')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() =>
      expect(initiateUsdcxBurn).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 5_000_001n,
          faucetId: USDCX_FAUCET_ID_BECH32,
          destinationChainId: 5042002,
          destinationAddress: '0x1111111111111111111111111111111111111111'
        })
      )
    );
    expect(bridgeEpochSend).not.toHaveBeenCalled();
    expect(initiateB2AggBridge).not.toHaveBeenCalled();
  });

  it.each([
    ['sepolia', 11155111],
    ['base-sepolia', 84532],
    ['arbitrum-sepolia', 421614]
  ])('accepts a USDCx deep link targeting %s', async (network, chainId) => {
    mockSearch = mockSearch.replace('network=arc-testnet', `network=${network}`);
    render(<ReviewTransaction />);
    await flush();
    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() =>
      expect(initiateUsdcxBurn).toHaveBeenCalledWith(expect.objectContaining({ destinationChainId: chainId }))
    );
  });

  it('rejects a USDCx deep link targeting a network that is not a destination', async () => {
    mockSearch = mockSearch.replace('network=arc-testnet', 'network=mainnet');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.queryByTestId('send-review-submit')).not.toBeInTheDocument();
    expect(initiateUsdcxBurn).not.toHaveBeenCalled();
  });

  it('disables submission below the minimum burn, naming it', async () => {
    mockBurnMinimum = 5_000_000n;
    mockSearch = mockSearch.replace('amount=5.000001', 'amount=4.999999');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('5 USDCx')).toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxBelowMinimumBurn|5');
  });

  it('accepts a burn at the minimum', async () => {
    mockBurnMinimum = 5_000_000n;
    mockSearch = mockSearch.replace('amount=5.000001', 'amount=5');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
  });

  it('rejects precision that would otherwise silently round', async () => {
    mockSearch = mockSearch.replace('amount=5.000001', 'amount=5.0000001');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    expect(screen.getByText('usdcxInvalidAmount')).toBeInTheDocument();
  });

  it('marks the withdrawal notice for the e2e harness', async () => {
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('usdcx-burn-notice')).toHaveTextContent('usdcxWithdrawalNotice');
  });

  it('names the native fee asset in the burn fee row, never MIDEN', async () => {
    mockNativeMetadata = { symbol: 'USDCx', decimals: 6 };
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('usdcxSponsorshipFee|USDCx')).toBeInTheDocument();
  });

  it('rejects a deep link trying to burn a different faucet', async () => {
    mockBalanceData = [VALID_TOKEN];
    mockSearch = mockSearch.replace(USDCX_FAUCET_ID_BECH32, 'tok1');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect')).toBeInTheDocument();
    expect(initiateUsdcxBurn).not.toHaveBeenCalled();
  });

  it('names the allowance and the network a refused burn carries', async () => {
    jest
      .mocked(initiateUsdcxBurn)
      .mockRejectedValueOnce(
        new UsdcxBurnError('usdcxSendMoreThanPayoutFee', { amount: '0.1', network: 'Arc Testnet' })
      );
    render(<ReviewTransaction />);
    await flush();
    fireEvent.click(screen.getByTestId('send-review-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee|0.1|Arc Testnet')
    );
  });

  // Circle took 2.5635 USDC from a Sepolia payout, above the 1.5 USDC allowance, so no fee bound or payout is shown.
  it('shows the Sepolia fee as varying and promises no payout', async () => {
    mockSearch = mockSearch.replace('network=arc-testnet', 'network=sepolia').replace('amount=5.000001', 'amount=10');
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('usdcxCircleFee')).toBeInTheDocument();
    expect(screen.getByText('usdcxPayoutFeeVaries')).toBeInTheDocument();
    expect(screen.queryByText('youReceive')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
  });
});

describe('ReviewTransaction — redirect guards', () => {
  it('redirects to /send when required params are missing', async () => {
    mockSearch = ''; // no tokenId, empty amount, empty to
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when the amount is not greater than zero', async () => {
    mockSearch = 'amount=0&to=0xrecipient&tokenId=tok1';
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when the recipient address is invalid', async () => {
    mockSearch = 'amount=5&to=bad&tokenId=tok1';
    isValidMidenAddressMock.mockReturnValue(false);
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when a deep link tries to send to the current account', async () => {
    mockSearch = 'amount=5&to=pubkey-1&tokenId=tok1';
    mockBalanceData = [VALID_TOKEN];

    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when balances are loaded but the token id has no match', async () => {
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, tokenId: 'other' }];
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when the amount exceeds the token balance', async () => {
    mockSearch = 'amount=500&to=0xrecipient&tokenId=tok1';
    mockBalanceData = [VALID_TOKEN]; // balance 100 < 500
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  it('redirects when a typed base unit exceeds an 18-decimal token balance', async () => {
    mockSearch = 'amount=1.000000000000000001&to=0xrecipient&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, balance: 1, metadata: { ...VALID_TOKEN.metadata, decimals: 18 } }];
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });

  // Epoch and Agglayer settle on Sepolia alone; the send flow clears a non-USDCx token on these chains, and this is the
  // backstop for a link that skips the flow.
  it.each([
    ['arc-testnet', 'epoch'],
    ['base-sepolia', 'epoch'],
    ['arbitrum-sepolia', 'epoch'],
    ['arc-testnet', 'agglayer'],
    ['base-sepolia', 'agglayer'],
    ['arbitrum-sepolia', 'agglayer']
  ])('redirects a bridge link to %s on the %s route', async (network, route) => {
    mockDetectedChain = 'ethereum';
    mockSearch = `amount=5&to=0xrecipient&tokenId=tok1&network=${network}&route=${route}`;
    mockBalanceData = [VALID_TOKEN];
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByTestId('redirect').textContent).toBe('redirect:/send');
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
describe('ReviewTransaction — rendering', () => {
  it('draws no fiat line for a token the price feed does not list, not the store $1 default', async () => {
    setValidRoute();
    mockBalanceData = [{ tokenId: 'tok1', metadata: { symbol: 'UNLISTED', decimals: 8 }, balance: 100, fiatPrice: 1 }];
    render(<ReviewTransaction />);
    await flush();

    const hero = within(screen.getByTestId('review-amount'));
    expect(hero.getByText('5 UNLISTED')).toBeInTheDocument();
    expect(hero.queryByText('approxFiatValue')).not.toBeInTheDocument();
  });

  it('values a swap token at the asset it stands for', async () => {
    // The document lists IETH, which testnet names Test iETH.
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    mockSearch = `amount=5&to=0xrecipient&tokenId=${TEST_TOKEN_IETH.faucetId}`;
    mockBalanceData = [
      { tokenId: TEST_TOKEN_IETH.faucetId, metadata: { symbol: 'IETH', decimals: 8 }, balance: 10, fiatPrice: 0 }
    ];
    mockWalletStoreState.tokenPrices = { ETH: { price: 3, observedAt: Date.now() } };
    try {
      render(<ReviewTransaction />);
      await flush();

      const hero = within(screen.getByTestId('review-amount'));
      expect(hero.getByText('5 Test iETH')).toBeInTheDocument();
      expect(hero.getByText('approxFiatValue')).toBeInTheDocument();
    } finally {
      mockWalletStoreState.tokenPrices = { USDC: { price: 2 } };
    }
  });

  it('renders header, hero and detail rows, seeding the 7-day expiration', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByRole('heading', { level: 1, name: 'reviewDetails' })).toBeInTheDocument();
    expect(screen.getByTestId('back-btn')).toBeInTheDocument();
    // The network is a plain value with its mark, not a chip; the fee has no inline note.
    expect(screen.getByTestId('network-logo')).toHaveAttribute('data-kind', 'miden');
    expect(screen.queryByText('networkFeeEstimateNote')).not.toBeInTheDocument();
    // The amount is inside the hero; the unquoted asset has no inferred fiat value.
    const hero = within(screen.getByTestId('review-amount'));
    expect(hero.getByText('5 MDN')).toBeInTheDocument();
    expect(screen.getByTestId('token-logo')).toHaveAttribute('data-faucet-id', VALID_TOKEN.tokenId);
    expect(hero.queryByText('approxFiatValue')).not.toBeInTheDocument();
    // Recipient row value.
    expect(screen.getByTestId('review-row-to')).toHaveTextContent('0xrecipient');

    // Seeding effect ran -> recallDate seeded -> capitalized relative
    // label + reclaim note both present.
    // The reclaim reassurance is one caption under the card, not a note in the expiration row.
    await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());
    expect(screen.getByTestId('review-recall-note').textContent).toBe('recallReturnsNote 5 MDN');
    expect(screen.queryByTestId('row-note')).not.toBeInTheDocument();
    // Advanced options starts closed, its summary naming the default transfer type and the window.
    expect(screen.getByTestId('review-advanced-options')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('review-advanced-options-summary').textContent).toMatch(/^private · In .+/);
    expect(screen.queryByTestId('review-row-expiration')).not.toBeInTheDocument();
    await openAdvancedOptions();
    expect(screen.getByText(/^In .+/)).toBeInTheDocument();
    expect(screen.getByTestId('row-open')).toBeInTheDocument();
    // Relative blocks-until-recall — no block height involved (#308).
    expect(dateTimeToRecallBlocksMock).toHaveBeenCalledWith(expect.any(Date));
  });

  it('renders with an undefined token when balances have not loaded (hero symbol empty)', async () => {
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1';
    mockBalanceData = undefined; // token undefined but tokenInvalid guard is skipped
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('review-amount').textContent).toBe('5 ');

    // onSubmit early-returns because there is no token: nothing fires.
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();
  });

  it('invokes goBack from the header back button', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    fireEvent.click(screen.getByTestId('back-btn'));
    expect(goBackMock).toHaveBeenCalledTimes(1);
    // Back keeps the draft, so the form reopens with what was entered.
    expect(clearSendDraftMock).not.toHaveBeenCalled();
  });

  it('abandons the send from the header X: clears the draft, then goes home', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    fireEvent.click(screen.getByTestId('close-btn'));
    expect(clearSendDraftMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/');
    expect(clearSendDraftMock.mock.invocationCallOrder[0]).toBeLessThan(navigateMock.mock.invocationCallOrder[0]!);
  });

  it('opens the recall calendar drawer via the expiration Edit pill', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('recall-drawer').getAttribute('data-open')).toBe('false');
    await openAdvancedOptions();
    expect(screen.getByTestId('review-expiration-edit')).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(screen.getByTestId('review-expiration-edit'));
    await flush();
    expect(screen.getByTestId('recall-drawer').getAttribute('data-open')).toBe('true');
  });

  it.each([
    [40, 'expiresInSeconds'], // 40 blocks * 3s = 120s  (< 180 → seconds)
    [400, 'expiresInMinutes'] // 400 blocks * 3s = 1200s (< 1800 → minutes)
  ])('renders the precise expiration label derived from recallBlocks=%d', async (blocks, expectedLabel) => {
    // The label reads the relative recall offset (recallBlocks), NOT the picked
    // absolute instant, so it always matches the window the send will apply.
    dateTimeToRecallBlocksMock.mockReturnValue(blocks);
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('review-advanced-options-summary').textContent).toBe(`private · ${expectedLabel}`);
    await openAdvancedOptions();
    expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    unmount();
  });

  it('never shows "None" while a recall offset is attached (label derives from the offset, not the clock)', async () => {
    // recallBlocks set → P2IDE, so the note IS recallable — the label must surface
    // the window and never "None" (which would imply a plain P2ID). Being offset-
    // derived, it also can't count down to "None" or snap backwards as time passes.
    dateTimeToRecallBlocksMock.mockReturnValue(1); // 1 block * 3s = 3s window
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();
    await openAdvancedOptions();

    expect(screen.queryByText('none')).not.toBeInTheDocument();
    expect(screen.getByText('expiresInSeconds')).toBeInTheDocument();
    unmount();
  });

  it('renders the slow bridge route without a Miden expiration row', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];

    render(<ReviewTransaction />);
    await flush();

    expect(screen.getAllByText('Sepolia').length).toBeGreaterThan(0);
    expect(screen.getByText('slow slowArrival')).toBeInTheDocument();
    expect(screen.queryByTestId('review-recall-note')).not.toBeInTheDocument();
    expect(dateTimeToRecallBlocksMock).not.toHaveBeenCalled();
    // A bridge has neither a transfer type nor an expiration, so nothing to fold away.
    expect(screen.queryByTestId('review-advanced-options')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transfer-type-drawer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-public-notice')).not.toBeInTheDocument();
  });

  it('renders the fast bridge route loading state from the Epoch quote', async () => {
    mockDetectedChain = 'ethereum';
    mockEpochQuote = { amount: '4.8', loading: true, error: null, symbol: 'USDC' };
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];

    const { container } = render(<ReviewTransaction />);
    await flush();

    expect(screen.getByText('fast fastArrival')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });

  // What arrives is the quote at most, so "you receive" rounds it down.
  it('rounds the Fast route quote down in "you receive", never up', async () => {
    mockDetectedChain = 'ethereum';
    mockEpochQuote = { amount: '10.655599', loading: false, error: null, symbol: 'USDC' };
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];

    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByText('≈ 10.65 Test Epoch USDC')).toBeInTheDocument();
  });

  it('uses the configured testnet label for the output token in "you receive"', async () => {
    mockDetectedChain = 'ethereum';
    mockEpochQuote = { amount: '2', loading: false, error: null, symbol: 'USDC.e' };
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];

    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByText('≈ 2 Test Epoch USDC')).toBeInTheDocument();
  });

  // 12.3450 separates the kinds: down reads 12.34 and up 12.35, so only an exact 12.345 is typed.
  // Agglayer carries the bridgeable token 1:1, so the line names the sent token, never the Fast route's USDC.
  it('shows the Slow route "you receive" as typed, in the sent token, without its trailing zero', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=12.3450&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];

    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByText('≈ 12.345 MDN')).toBeInTheDocument();
    expect(screen.queryByText(/12\.345 (USDC|Test Epoch USDC)/)).not.toBeInTheDocument();
  });

  describe('testnet bridge USDC label', () => {
    beforeEach(() => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    });

    it('names the Fast route output by the testnet label in "you receive"', async () => {
      mockDetectedChain = 'ethereum';
      mockEpochQuote = { amount: '10.655599', loading: false, error: null, symbol: 'USDC' };
      mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
      mockBalanceData = [VALID_TOKEN];

      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByText('≈ 10.65 Test Epoch USDC')).toBeInTheDocument();
    });

    it('names the Fast route output by the testnet label while the token read has not succeeded', async () => {
      mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null };
      mockDetectedChain = 'ethereum';
      mockEpochQuote = { amount: '10.655599', loading: false, error: null, symbol: 'USDC' };
      mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
      mockBalanceData = [VALID_TOKEN];

      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByText('≈ 10.65 Test Epoch USDC')).toBeInTheDocument();
    });

    it('holds a review of another token while Testnet config is unavailable, without leaving it', async () => {
      mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null, status: 'loading' };
      setValidRoute(MIDEN_USDC_FAUCET);
      mockBalanceData = [{ ...VALID_TOKEN, tokenId: MIDEN_USDC_FAUCET, metadata: { symbol: 'USDC', decimals: 6 } }];
      render(<ReviewTransaction />);
      await flush();
      expect(screen.queryByTestId('redirect')).not.toBeInTheDocument();
      expect(screen.getByTestId('send-review-submit')).toBeDisabled();
      expect(screen.getByTestId('review-held-notice')).toHaveTextContent('sendTokenAvailabilityChecking');
      await act(async () => {
        fireEvent.click(screen.getByTestId('send-review-submit'));
      });
      await flush();
      expect(confirmMock).not.toHaveBeenCalled();
      expect(initiateSendTransaction).not.toHaveBeenCalled();
    });

    it('lets a native-asset review confirm while Testnet config is unavailable', async () => {
      mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null, status: 'loading' };
      setValidRoute(USDCX_FAUCET_ID_BECH32);
      render(<ReviewTransaction />);
      await flush();
      await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());
      expect(screen.queryByTestId('redirect')).not.toBeInTheDocument();
      expect(screen.getByTestId('send-review-submit')).toBeEnabled();
      expect(screen.queryByTestId('review-held-notice')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByTestId('send-review-submit'));
      });
      await flush();
      expect(initiateSendTransaction).toHaveBeenCalledWith(
        'pubkey-1',
        '0xrecipient',
        USDCX_FAUCET_ID_BECH32,
        'private',
        12345n,
        999,
        false
      );
    });

    it('redirects a retired Epoch USDC deep link to the new send flow', async () => {
      setValidRoute(MIDEN_USDC_FAUCET);
      mockBalanceData = [{ ...VALID_TOKEN, tokenId: MIDEN_USDC_FAUCET, metadata: { symbol: 'USDC', decimals: 6 } }];

      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByTestId('redirect')).toHaveTextContent('/send');
      expect(screen.queryByTestId('send-review-submit')).not.toBeInTheDocument();
    });

    it('does not render a new recallable send for the retired faucet', async () => {
      setValidRoute(MIDEN_USDC_FAUCET);
      mockBalanceData = [{ ...VALID_TOKEN, tokenId: MIDEN_USDC_FAUCET, metadata: { symbol: 'USDC', decimals: 6 } }];

      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByTestId('redirect')).toHaveTextContent('/send');
      expect(screen.queryByTestId('review-recall-note')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Submit pipeline
// ---------------------------------------------------------------------------
describe('ReviewTransaction — onSubmit', () => {
  const clickSubmit = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
  };

  it.each([
    ['same-chain', 'miden', ''],
    ['Epoch', 'ethereum', '&network=sepolia&route=epoch'],
    ['Agglayer', 'ethereum', '&network=sepolia&route=agglayer']
  ])('refuses a direct %s review URL with digits past token precision', async (_label, chain, suffix) => {
    const actualNumbers = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
    stringToBigIntMock.mockImplementation(actualNumbers.stringToBigInt);
    mockDetectedChain = chain as 'miden' | 'ethereum';
    mockSearch = `amount=1.001&to=0xrecipient&tokenId=tok1${suffix}`;
    mockBalanceData = [{ ...VALID_TOKEN, metadata: { ...VALID_TOKEN.metadata, decimals: 2 } }];
    render(<ReviewTransaction />);
    await flush();

    expect(mockEpochQuoteArgs.amount).toBeUndefined();
    expect(screen.getByTestId('review-error')).toHaveTextContent('amountExceedsTokenDecimals');
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    await clickSubmit();
    expect(initiateMock).not.toHaveBeenCalled();
    expect(bridgeEpochSendMock).not.toHaveBeenCalled();
    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();
  });

  // This screen is reachable by URL and re-derives its own token, so it cannot
  // rely on the amount screen having refused. Every conversion below it runs
  // `stringToBigInt(amount, token.decimals)`: at the placeholder's guessed 6, a
  // "5" typed for an 18-decimal faucet authorises a transfer a trillion times
  // smaller than the one being confirmed, irreversibly.
  describe('a token whose scale never resolved', () => {
    beforeEach(() => {
      setValidRoute();
      mockBalanceData = [UNSCALED_TOKEN];
    });

    it('refuses to submit and says why, instead of converting by a guess', async () => {
      render(<ReviewTransaction />);
      await flush();

      await clickSubmit();

      expect(confirmMock).not.toHaveBeenCalled();
      expect(initiateMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('review-error').textContent).toBe('unknownTokenScale');
    });

    it('disables the CTA rather than waiting for the press to reject it', async () => {
      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    });

    it('gives the CTA the send flow colour', async () => {
      mockBalanceData = [VALID_TOKEN];
      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByTestId('send-review-submit')).toHaveAttribute('data-accent', 'send');
    });

    it('leaves an ordinary token CTA alone', async () => {
      mockBalanceData = [VALID_TOKEN];
      render(<ReviewTransaction />);
      await flush();

      expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
      expect(screen.queryByTestId('review-error')).not.toBeInTheDocument();
    });
  });

  it('runs the full private send pipeline (non-extension, popup route)', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();
    // Wait until the recall blocks have been seeded.
    await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());

    await clickSubmit();

    expect(mockWalletStoreState.assessSpendingLimit).toHaveBeenCalledWith('pubkey-1', [
      { faucetId: 'tok1', amount: 12345n }
    ]);
    expect(confirmMock).toHaveBeenCalledWith('confirmSendReason', expect.any(Function));
    expect(mockWalletStoreState.setLastCompletedTxHash).toHaveBeenCalledWith(null);
    expect(initiateMock).toHaveBeenCalledWith('pubkey-1', '0xrecipient', 'tok1', 'private', 12345n, 999, false);
    expect(requestSWMock).not.toHaveBeenCalled();
    expect(clearSendDraftMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-abc', 'replacestate');
  });

  it('uses strict authentication instead of the ordinary confirmation for a spending-limit breach', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('assessment');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateMock).toHaveBeenCalledWith(
      'pubkey-1',
      '0xrecipient',
      'tok1',
      'private',
      12345n,
      999,
      false,
      expect.objectContaining({
        id: 'authorization-1',
        accountId: 'pubkey-1',
        revision: 'revision-1'
      })
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('discards an authorization for a different account instead of sending against it', async () => {
    // `SpendingLimitChallenge` always mints an authorization bound to the account its own
    // assessment named; this plants a forged/stale one directly to prove `runSameChainSend`
    // refuses it on its own, the same way the dApp custom-transaction gate refuses forged fields.
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    mockAuthorizationAccountOverride = 'pubkey-someone-else';
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
  });

  it('opens the unvalued challenge when the pre-check cannot price the transaction', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
      code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
      symbol: 'MDN'
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(mockWalletStoreState.readSpendingLimit).toHaveBeenCalledWith('pubkey-1');
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();
  });

  it('falls back to the generic error when the pre-check itself cannot open the unpriced challenge', async () => {
    // Distinct from the "no configured limit" fallback above: here `readSpendingLimit` fails
    // outright (a storage fault), reached from `onSubmit`'s OWN catch rather than
    // `runSameChainSend`'s - the pre-check throws before either send path is ever entered.
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
      code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
      symbol: 'MDN'
    });
    mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
  });

  it('opens the unvalued challenge when the actual send cannot be priced', async () => {
    setValidRoute();
    initiateMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
  });

  it('opens the unvalued challenge from a rejection that actually crossed the intercom port', async () => {
    // Unlike the raw-object rejections above (the in-process shape mobile/desktop reject with),
    // this is what the extension's popup <-> SW port actually delivers: the real `serializeInternalError`
    // followed by the real `deserializeInternalError`, round-tripping a price-unavailable refusal through
    // the intercom wire format rather than assuming it survives untouched.
    setValidRoute();
    initiateMock.mockRejectedValue(
      deserializeInternalError(
        serializeInternalError({
          message: 'No current price is available for MDN',
          code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
          symbol: 'MDN'
        })
      )
    );
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
  });

  it('re-enables the submit button when the drawer authorize path cannot open the unpriced challenge', async () => {
    // `handleSpendingLimitResult` fires `runSameChainSend(authorization)` without awaiting it and
    // with no catch of its own - unlike `onSubmit`, which has a surrounding catch that would mask
    // this. This is the one call path where a throw inside `openUnpricedChallenge` used to leave
    // the button disabled forever with no visible error.
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    initiateMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

    mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
  });

  it('falls back to a generic error when the price-unavailable pre-check has no configured limit to read', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockRejectedValue({
      code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE',
      symbol: 'MDN'
    });
    mockWalletStoreState.readSpendingLimit.mockResolvedValue(undefined);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
  });

  it.each<[string, BridgeFeature]>([
    ['agglayer', 'bridgeOut'],
    ['epoch', 'fastBridgeOut']
  ])('blocks a direct review link when the selected %s withdrawal is off', async (route, feature) => {
    mockDetectedChain = 'ethereum';
    mockSearch = `amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=${route}`;
    mockBalanceData = [VALID_TOKEN];
    mockBridgeAvailability = { state: 'unavailable', reason: 'off', detail: 'route is off' };
    render(<ReviewTransaction />);
    await flush();

    expect(useFeatureAvailability).toHaveBeenLastCalledWith(feature, { hold: true, chainId: 11155111 });
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    await clickSubmit();
    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();
    expect(bridgeEpochSendMock).not.toHaveBeenCalled();
  });

  it('bridges over the Slow route with the faucet of the token being sent', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockResolvedValue('tx-agg');
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(isAgglayerFaucetAllowed).toHaveBeenCalledWith('tok1', 'https://rpc.review.example', 11155111);
    expect(initiateB2AggBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12345n,
        faucetId: 'tok1',
        destinationAddress: '0xrecipient',
        senderPublicKey: 'pubkey-1',
        guardianProvider: zustandProvider
      })
    );
    // The bridge build reads the destination network from the config; the review passes none.
    expect(initiateB2AggBridgeMock.mock.calls[0]![0]).not.toHaveProperty('destinationNetwork');
    expect(initiateB2AggBridgeMock.mock.calls[0]?.[0].guardianProvider).toBe(zustandProvider);
  });

  it('refuses a Slow bridge-out of a token the registry does not list (#1276)', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    jest.mocked(isAgglayerFaucetAllowed).mockResolvedValue(false);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('review-error')).toHaveTextContent('agglayerTokenUnsupported');
  });

  it('refuses a Slow bridge-out when the registry cannot be read (#1276)', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    jest.mocked(isAgglayerFaucetAllowed).mockRejectedValue(new Error('registry down'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('review-error')).toHaveTextContent('registry down');
  });

  it('uses strict authentication before building an Agglayer bridge request', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateB2AggBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12345n,
        faucetId: 'tok1',
        senderPublicKey: 'pubkey-1',
        spendingLimitAuthorization: expect.objectContaining({ id: 'authorization-1', revision: 'revision-1' })
      })
    );
  });

  it('discards a bridge authorization for a different account instead of bridging against it', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    mockAuthorizationAccountOverride = 'pubkey-someone-else';
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(initiateB2AggBridgeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
  });

  it('re-enables the bridge submit button when the drawer authorize path cannot open the unpriced challenge', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    initiateB2AggBridgeMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

    mockWalletStoreState.readSpendingLimit.mockRejectedValue(new Error('storage offline'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).not.toBeDisabled();
    expect(screen.getByTestId('review-error')).toBeInTheDocument();
  });

  it('stringifies a non-Error bridge rejection instead of showing an empty message', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockRejectedValue('bridge relay unreachable');
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('review-error')).toHaveTextContent('bridge relay unreachable');
  });

  it('shows a real Error bridge rejection by its own message', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockRejectedValue(new Error('bridge relay timed out'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('review-error')).toHaveTextContent('bridge relay timed out');
  });

  it('opens the unvalued challenge when the actual bridge send cannot be priced', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    initiateB2AggBridgeMock.mockRejectedValue({ code: 'SPENDING_LIMIT_PRICE_UNAVAILABLE', symbol: 'MDN' });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-kind')).toHaveTextContent('unpriced');
  });

  it('keeps the ordinary confirmation and sends no authorization for a below-limit bridge', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=agglayer';
    mockBalanceData = [VALID_TOKEN];
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(mockWalletStoreState.assessSpendingLimit).toHaveBeenCalledWith('pubkey-1', [
      { faucetId: 'tok1', amount: 12345n }
    ]);
    expect(confirmMock).toHaveBeenCalledWith('confirmSendReason', expect.any(Function));
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(initiateB2AggBridgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12345n,
        senderPublicKey: 'pubkey-1',
        spendingLimitAuthorization: undefined
      })
    );
  });

  it('reopens an Epoch bridge challenge when external preparation outlives authorization', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];
    const firstAssessment = breachAssessment({
      breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null }
    });
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(firstAssessment);
    bridgeEpochSendMock.mockRejectedValue({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: { ...firstAssessment, revision: 'revision-2', assessedAt: 240 }
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(bridgeEpochSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spendingLimitAuthorization: expect.objectContaining({ id: 'authorization-1', revision: 'revision-1' })
      })
    );
    expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
  });

  it('cancels a spending-limit challenge without queueing or losing the review draft', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(
      breachAssessment({ breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null } })
    );
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));
    await flush();

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    expect(initiateMock).not.toHaveBeenCalled();
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
  });

  it('cancels a bridge challenge before any external bridge work', async () => {
    mockDetectedChain = 'ethereum';
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1&network=sepolia&route=epoch';
    mockBalanceData = [VALID_TOKEN];
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(
      breachAssessment({ breach: { spent: 90n, proposedTotal: 12435n, limit: 100n, overBy: 12335n, resetAt: null } })
    );
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    fireEvent.click(screen.getByRole('button', { name: 'cancel-limit' }));
    await flush();

    expect(bridgeEpochSendMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
  });

  it('reopens the challenge with the final atomic assessment when authorization expires or loses a race', async () => {
    setValidRoute();
    const firstAssessment = breachAssessment();
    const finalAssessment = {
      ...firstAssessment,
      revision: 'revision-2',
      assessedAt: 121,
      breach: { ...firstAssessment.breach, spent: 95n, proposedTotal: 12440n, overBy: 12340n }
    };
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(firstAssessment);
    initiateMock.mockRejectedValue({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: finalAssessment
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
    // The hero now carries the fiat subtitle too, so assert the value inside it
    // rather than the whole hero's text.
    expect(within(screen.getByTestId('review-amount')).getByText('5 MDN')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('nudges the service worker and uses the full-page route on extension', async () => {
    setValidRoute();
    mockFullPage = true;
    isExtensionMock.mockReturnValue(true);
    render(<ReviewTransaction />);
    await flush();
    await waitFor(() => expect(screen.getByTestId('review-recall-note')).toBeInTheDocument());

    await clickSubmit();

    expect(requestSWMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction-full/tx-abc', 'replacestate');
  });

  it('forwards the delegate-proof flag from settings', async () => {
    setValidRoute();
    isDelegateProofEnabledMock.mockReturnValue(true);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    const call = initiateMock.mock.calls[0];
    expect(call[6]).toBe(true);
  });

  it('aborts when biometric confirmation is declined', async () => {
    setValidRoute();
    confirmMock.mockResolvedValue(false);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    // isSubmitting was reset, so a subsequent confirmed attempt goes through.
    confirmMock.mockResolvedValue(true);
    await clickSubmit();
    expect(initiateMock).toHaveBeenCalledTimes(1);
  });

  it('confirms with the shared hardware-only protector probe', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(confirmMock).toHaveBeenCalledWith('confirmSendReason', probeHardwareProtector);
  });

  it("shows the review screen's own error, and sends nothing, when the protector probe rejects", async () => {
    setValidRoute();
    confirmMock.mockRejectedValue(new Error('protector check failed'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('review-error')).toHaveTextContent('protector check failed');
  });

  it('logs and resets when transaction creation throws', async () => {
    setValidRoute();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    initiateMock.mockRejectedValue(new Error('create failed'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(consoleSpy).toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    // isSubmitting reset -> retry works.
    initiateMock.mockResolvedValue('tx-retry');
    await clickSubmit();
    expect(navigateMock).toHaveBeenCalledWith('/generating-transaction/tx-retry', 'replacestate');
    consoleSpy.mockRestore();
  });

  it('no-ops when there is no public key', async () => {
    setValidRoute();
    mockPublicKey = null;
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(initiateMock).not.toHaveBeenCalled();
  });

  it('ignores a second submit while the first is still in flight', async () => {
    setValidRoute();
    const confirmD = deferred<boolean>();
    confirmMock.mockReturnValue(confirmD.promise);
    render(<ReviewTransaction />);
    await flush();

    // First click: sets isSubmitting, then awaits the pending confirmation.
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    // Second click: guarded out because isSubmitting is now true.
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    await act(async () => {
      confirmD.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(initiateMock).toHaveBeenCalledTimes(1);
  });

  it('closes an open spending-limit challenge when the active account changes underneath it', async () => {
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    const view = render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();

    mockPublicKey = 'pubkey-2';
    await act(async () => view.rerender(<ReviewTransaction />));

    expect(screen.queryByTestId('spending-limit-challenge')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Advanced options: the transfer type
// ---------------------------------------------------------------------------
describe('ReviewTransaction — transfer type', () => {
  it('opens the transfer-type sheet from the row under Advanced options', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('transfer-type-drawer')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('transfer-type-drawer')).toHaveAttribute('data-value', 'private');
    await openAdvancedOptions();
    expect(screen.getByTestId('review-row-transfer-type')).toBeInTheDocument();
    expect(screen.getByTestId('row-open')).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(screen.getByTestId('row-open'));
    await flush();
    expect(screen.getByTestId('transfer-type-drawer')).toHaveAttribute('data-open', 'true');
  });

  it('keeps the choice and its consequence visible once Advanced options is closed again', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    // Private by default: the plain CTA, no notice, a quiet summary.
    expect(screen.getByTestId('send-review-submit').textContent).toBe('sendPayment');
    expect(screen.queryByRole('button', { name: 'continue' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('review-public-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-advanced-options')).toHaveAttribute('data-emphasis', 'false');

    await openAdvancedOptions();
    fireEvent.click(screen.getByTestId('transfer-type-pick-public'));
    await flush();
    fireEvent.click(screen.getByTestId('transfer-type-close'));
    await flush();

    // The row and the sheet agree, the CTA says what it will do and the notice spells out the cost.
    expect(screen.getByTestId('transfer-type-drawer')).toHaveAttribute('data-value', 'public');
    expect(within(screen.getByTestId('review-row-transfer-type')).getByText('public')).toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit').textContent).toBe('sendPublicly');
    expect(screen.queryByRole('button', { name: 'continue' })).not.toBeInTheDocument();
    expect(screen.getByTestId('review-public-notice')).toBeInTheDocument();
    expect(screen.getByTestId('review-public-notice')).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByText('publicTransferNotice')).toBeInTheDocument();

    // Folding Advanced options away hides the rows but not the choice: the summary names it, in
    // the emphasised ink, and the notice stays on the page.
    await openAdvancedOptions();
    expect(screen.getByTestId('review-advanced-options')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('review-advanced-options-summary').textContent).toMatch(/^public · In .+/);
    expect(screen.getByTestId('review-advanced-options')).toHaveAttribute('data-emphasis', 'true');
    expect(screen.getByTestId('review-public-notice')).toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit').textContent).toBe('sendPublicly');
  });

  it('submits a PUBLIC note after the sheet picked Public, and a private one again after Private', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();
    await openAdvancedOptions();
    // A send that goes through leaves the page; a failed one hands the choices back.
    initiateMock.mockRejectedValueOnce(new Error('send failed'));

    fireEvent.click(screen.getByTestId('transfer-type-pick-public'));
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
    expect(initiateMock).toHaveBeenLastCalledWith('pubkey-1', '0xrecipient', 'tok1', 'public', 12345n, 999, false);

    fireEvent.click(screen.getByTestId('transfer-type-pick-private'));
    await flush();
    expect(screen.getByTestId('send-review-submit').textContent).toBe('sendPayment');
    expect(screen.queryByTestId('review-public-notice')).not.toBeInTheDocument();
  });

  it('freezes the transfer type and the expiration from the press until the send settles', async () => {
    setValidRoute();
    const assessment = deferred<undefined>();
    mockWalletStoreState.assessSpendingLimit.mockReturnValue(assessment.promise);
    render(<ReviewTransaction />);
    await flush();
    await openAdvancedOptions();
    fireEvent.click(screen.getByTestId('transfer-type-pick-public'));
    await flush();

    const recallTimeBefore = screen.getByTestId('recall-drawer').getAttribute('data-recall-time');

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('row-open')).toBeDisabled();
    expect(screen.getByTestId('review-expiration-edit')).toBeDisabled();
    fireEvent.click(screen.getByTestId('row-open'));
    fireEvent.click(screen.getByTestId('review-expiration-edit'));
    await flush();
    expect(screen.getByTestId('transfer-type-drawer')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('recall-drawer')).toHaveAttribute('data-open', 'false');
    // A sheet already on screen, or one closing, can still hand a change back.
    fireEvent.click(screen.getByTestId('transfer-type-pick-private'));
    fireEvent.click(screen.getByTestId('recall-pick-never'));
    fireEvent.click(screen.getByTestId('recall-pick-blocks'));
    fireEvent.click(screen.getByTestId('recall-pick-time'));
    fireEvent.click(screen.getByTestId('recall-pick-date'));
    await flush();

    await act(async () => {
      assessment.resolve(undefined);
    });
    await flush();

    // What went out and what the page shows still agree: public, with the 7-day window.
    expect(initiateMock).toHaveBeenLastCalledWith('pubkey-1', '0xrecipient', 'tok1', 'public', 12345n, 999, false);
    expect(screen.getByTestId('recall-drawer').getAttribute('data-recall-time')).toBe(recallTimeBefore);
    await openAdvancedOptions();
    expect(screen.getByTestId('review-advanced-options')).toHaveAttribute('data-open', 'false');
    expect(screen.getByTestId('review-public-notice')).toBeInTheDocument();
    expect(screen.getByTestId('review-advanced-options-summary').textContent).toMatch(/^public · In .+/);
    expect(screen.getByTestId('send-review-submit').textContent).toBe('sendPublicly');
  });
});

// ---------------------------------------------------------------------------
// E2E-only share-privately hook
// ---------------------------------------------------------------------------
describe('ReviewTransaction — E2E share-privately hook', () => {
  it('does not expose the setter outside the E2E harness', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();
    expect((globalThis as any).__TEST_SET_SHARE_PRIVATELY__).toBeUndefined();
  });

  it('exposes a setter that flips the send to PUBLIC, then cleans up on unmount', async () => {
    process.env.MIDEN_E2E_TEST = 'true';
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    const setter = (globalThis as any).__TEST_SET_SHARE_PRIVATELY__;
    expect(typeof setter).toBe('function');

    await act(async () => {
      setter(false);
    });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();

    expect(initiateMock).toHaveBeenCalledWith('pubkey-1', '0xrecipient', 'tok1', 'public', 12345n, 999, false);

    unmount();
    expect((globalThis as any).__TEST_SET_SHARE_PRIVATELY__).toBeUndefined();
  });

  // This screen commits value, so it names the network. The registry test proves the element is
  // in the file; this proves it actually renders - which is the distinction a source match could
  // not make, and how a banner once shipped behind an early return.
  it('names the network it will commit on', () => {
    // Without params the screen redirects and renders nothing, so the params are the test.
    mockSearch = 'amount=5&to=0xrecipient&tokenId=tok1';
    render(<ReviewTransaction />);

    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// `send` telemetry flow. This page owns the terminal call for a flow the send
// form (a separate React tree) began.
// ---------------------------------------------------------------------------
describe('ReviewTransaction — send telemetry', () => {
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
      settled: telemetryHandles.map(handle => [
        handle.complete.mock.calls,
        handle.cancel.mock.calls,
        handle.fail.mock.calls,
        handle.step.mock.calls
      ])
    });

  const clickSubmit = async () => {
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });
    await flush();
  };

  beforeEach(() => {
    // The outer beforeEach resets every mock, implementations included.
    beginFlowMock.mockImplementation((_flow: string) => {
      const handle: TelemetryHandle = { complete: jest.fn(), cancel: jest.fn(), fail: jest.fn(), step: jest.fn() };
      telemetryHandles.push(handle);
      return handle;
    });
    classifyErrorMock.mockImplementation((_error: unknown) => 'rpc');
    // The handle is module-scoped by design; drop any a previous test left open.
    settleSendFlow(flow => flow.cancel());
    beginFlowMock.mockClear();
    classifyErrorMock.mockClear();
    telemetryHandles.length = 0;
  });

  it('completes the flow the send form began, without beginning a second one', async () => {
    enterSendFlow();
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(beginFlowMock).toHaveBeenCalledWith('send');
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('begins a flow for a submit reached without one (deep link into review)', async () => {
    setValidRoute();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(beginFlowMock).toHaveBeenCalledWith('send');
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
  });

  it('reports a broad error kind when transaction creation fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setValidRoute();
    initiateMock.mockRejectedValue(new Error('rpc error: node unreachable at mtst1recipient'));
    enterSendFlow();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    // The caught error is classified, never forwarded.
    expect(classifyErrorMock).toHaveBeenCalledWith(expect.any(Error));
    expect(telemetryPayload()).not.toContain('node unreachable');
    consoleSpy.mockRestore();
  });

  it('gives a retry after a failed submit its own flow', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    setValidRoute();
    initiateMock.mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue('tx-retry');
    enterSendFlow();
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await clickSubmit();

    expect(beginFlowMock).toHaveBeenCalledTimes(2);
    expect(handleAt(0).fail).toHaveBeenCalledWith('rpc');
    expect(handleAt(1).complete).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('cancels an open flow when the user leaves review without submitting', async () => {
    enterSendFlow();
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();

    unmount();

    expect(handleAt(0).cancel).toHaveBeenCalledTimes(1);
  });

  it('leaves a settled flow alone on unmount, so a completed send is never re-reported', async () => {
    enterSendFlow();
    setValidRoute();
    const { unmount } = render(<ReviewTransaction />);
    await flush();
    await clickSubmit();

    unmount();

    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });

  it('does not begin a flow for a review page that only ever redirects', async () => {
    mockSearch = '';
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('redirect')).toBeInTheDocument();
    expect(beginFlowMock).not.toHaveBeenCalled();
  });

  it('never passes the recipient address or the amount to telemetry', async () => {
    mockSearch = 'amount=4200&to=mtst1recipientaddress&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, balance: 10_000 }];
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(beginFlowMock.mock.calls.length).toBeGreaterThan(0);
    expect(telemetryPayload()).not.toContain('mtst1recipientaddress');
    expect(telemetryPayload()).not.toContain('4200');
    expect(telemetryPayload()).not.toContain('tok1');
  });

  it('never passes the recipient address or the amount to telemetry when the submit fails', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSearch = 'amount=4200&to=mtst1recipientaddress&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, balance: 10_000 }];
    initiateMock.mockRejectedValue(new Error('rpc down'));
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(handleAt(0).fail).toHaveBeenCalledTimes(1);
    expect(telemetryPayload()).not.toContain('mtst1recipientaddress');
    expect(telemetryPayload()).not.toContain('4200');
    expect(telemetryPayload()).not.toContain('tok1');
    consoleSpy.mockRestore();
  });

  it('leaves the flow open across a spending-limit challenge and completes it once authorized', async () => {
    enterSendFlow();
    setValidRoute();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(breachAssessment());
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(screen.getByTestId('spending-limit-challenge')).toBeInTheDocument();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(handleAt(0).fail).not.toHaveBeenCalled();
    expect(handleAt(0).cancel).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(beginFlowMock).toHaveBeenCalledTimes(1);
    expect(handleAt(0).complete).toHaveBeenCalledTimes(1);
    expect(handleAt(0).step).toHaveBeenCalledWith('submitting');
    expect(telemetryPayload()).not.toContain('0xrecipient');
    expect(telemetryPayload()).not.toContain('tok1');
  });

  it('does not settle when the send itself raises a spending-limit challenge', async () => {
    enterSendFlow();
    setValidRoute();
    const assessment = breachAssessment();
    mockWalletStoreState.assessSpendingLimit.mockResolvedValue(assessment);
    initiateMock.mockRejectedValue({
      code: 'SPENDING_LIMIT_AUTHORIZATION_REQUIRED',
      assessment: { ...assessment, revision: 'revision-2', assessedAt: 121 }
    });
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'authorize-limit' })));
    await flush();

    expect(screen.getByTestId('spending-limit-challenge')).toHaveTextContent('revision-2');
    expect(handleAt(0).fail).not.toHaveBeenCalled();
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
    expect(handleAt(0).step).toHaveBeenCalledWith('submitting');
  });

  it('does not settle when the user cancels confirmation', async () => {
    enterSendFlow();
    setValidRoute();
    confirmMock.mockResolvedValue(false);
    render(<ReviewTransaction />);
    await flush();

    await clickSubmit();

    expect(initiateMock).not.toHaveBeenCalled();
    expect(handleAt(0).complete).not.toHaveBeenCalled();
    expect(handleAt(0).fail).not.toHaveBeenCalled();
    expect(handleAt(0).cancel).not.toHaveBeenCalled();
  });
});

describe('ReviewTransaction user-visible errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUseRealBurnMinimum = true;
    jest.mocked(readUsdcxMinimumBurn).mockResolvedValue(5_000_000n);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mockUseRealBurnMinimum = false;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const expectReport = async (id: string) => {
    await act(async () => jest.advanceTimersByTimeAsync(999));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTimeAsync(1));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([[id, 'review']]);
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  };

  const setBurnRoute = (amount = '5.000001') => {
    mockDetectedChain = 'ethereum';
    mockBalanceData = [{ ...VALID_TOKEN, tokenId: USDCX_FAUCET_ID_BECH32, metadata: { symbol: 'USDCX', decimals: 6 } }];
    mockSearch = `amount=${amount}&to=0x1111111111111111111111111111111111111111&tokenId=${USDCX_FAUCET_ID_BECH32}&network=arc-testnet&route=usdcx`;
  };

  it('reports a raw burn submit failure by its site code while retaining its message', async () => {
    setBurnRoute();
    const message = 'Faucet https://faucet.invalid/private?amount=123.45 failed for mtst1private';
    jest.mocked(initiateUsdcxBurn).mockRejectedValueOnce(new Error(message));
    render(<ReviewTransaction />);
    await flush();
    expect(screen.queryByTestId('review-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('review-error')).toHaveTextContent(message);
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await expectReport('raw_send_submit_failed');
  });

  it('reports an unrepresentable review amount with its precision error id', async () => {
    const actualNumbers = jest.requireActual<typeof import('lib/i18n/numbers')>('lib/i18n/numbers');
    stringToBigIntMock.mockImplementation(actualNumbers.stringToBigInt);
    mockSearch = 'amount=1.001&to=0xrecipient&tokenId=tok1';
    mockBalanceData = [{ ...VALID_TOKEN, metadata: { ...VALID_TOKEN.metadata, decimals: 2 } }];
    render(<ReviewTransaction />);
    await flush();

    expect(mockEpochQuoteArgs.amount).toBeUndefined();
    expect(screen.getByTestId('review-error')).toHaveTextContent('amountExceedsTokenDecimals');
    await expectReport('amountExceedsTokenDecimals');
  });

  it('reports the specific UsdcxBurnError code from a burn submit refusal', async () => {
    setBurnRoute();
    jest.mocked(initiateUsdcxBurn).mockRejectedValueOnce(new UsdcxBurnError('usdcxUnsupportedFaucet'));
    render(<ReviewTransaction />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxUnsupportedFaucet');
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await expectReport('usdcxUnsupportedFaucet');
  });

  it('does not report the immediate minimum or a pending minimum read as a failure', async () => {
    setBurnRoute();
    const minimum = deferred<bigint>();
    jest.mocked(readUsdcxMinimumBurn).mockReturnValueOnce(minimum.promise);
    render(<ReviewTransaction />);
    await flush();
    expect(screen.getByText('5 USDCx')).toBeVisible();
    expect(screen.queryByTestId('review-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await act(async () => jest.advanceTimersByTimeAsync(2000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();

    await act(async () => minimum.resolve(5_000_000n));
    await act(async () => jest.advanceTimersByTimeAsync(1000));
    expect(screen.queryByTestId('review-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('reports a raw same-chain submit failure by its site code while retaining the message', async () => {
    setValidRoute();
    const message = 'Send 123.45 to mtst1private failed at https://send.invalid/private';
    initiateMock.mockRejectedValueOnce(new Error(message));
    render(<ReviewTransaction />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('review-error')).toHaveTextContent(message);
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await expectReport('raw_send_submit_failed');
  });

  it.each([
    new Error('Bridge 123.45 to 0xprivate failed at https://bridge.invalid/private'),
    'Bridge 123.45 to 0xprivate failed at https://bridge.invalid/private'
  ])('reports a raw bridge submit failure without forwarding its runtime value (%s)', async reason => {
    setValidRoute();
    mockDetectedChain = 'ethereum';
    mockSearch += '&network=sepolia&route=agglayer';
    initiateB2AggBridgeMock.mockRejectedValueOnce(reason);
    render(<ReviewTransaction />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('review-error')).toHaveTextContent(reason instanceof Error ? reason.message : reason);
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await expectReport('raw_send_submit_failed');
  });

  it('reports the locally known Agglayer token refusal by its translation key', async () => {
    setValidRoute();
    mockDetectedChain = 'ethereum';
    mockSearch += '&network=sepolia&route=agglayer';
    jest.mocked(isAgglayerFaucetAllowed).mockResolvedValueOnce(false);
    render(<ReviewTransaction />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('review-error')).toHaveTextContent('agglayerTokenUnsupported');
    expect(initiateB2AggBridge).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await expectReport('agglayerTokenUnsupported');
  });

  it('reports a raw pre-submit assessment failure on the review surface', async () => {
    setValidRoute();
    const message = 'Assessment for mtst1private failed at https://limits.invalid/private?amount=123.45';
    mockWalletStoreState.assessSpendingLimit.mockRejectedValueOnce(new Error(message));
    render(<ReviewTransaction />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('review-error')).toHaveTextContent(message);
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    expect(initiateMock).not.toHaveBeenCalled();
    await expectReport('raw_send_submit_failed');
  });

  it('reports a typed burn submit refusal by its code without forwarding translated parameters', async () => {
    setBurnRoute();
    jest
      .mocked(initiateUsdcxBurn)
      .mockRejectedValueOnce(
        new UsdcxBurnError('usdcxSendMoreThanPayoutFee', { amount: '0.1', network: 'Arc Testnet' })
      );
    render(<ReviewTransaction />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-review-submit'));
    });

    expect(screen.getByTestId('review-error')).toHaveTextContent('usdcxSendMoreThanPayoutFee|0.1|Arc Testnet');
    expect(screen.getByTestId('send-review-submit')).toBeEnabled();
    await expectReport('usdcxSendMoreThanPayoutFee');
  });

  it.each([
    { amount: '5.0000001', minimum: 5_000_000n, id: 'usdcxInvalidAmount', text: 'usdcxInvalidAmount' },
    { amount: '5.000001', minimum: 6_000_000n, id: 'usdcxBelowMinimumBurn', text: 'usdcxBelowMinimumBurn|6' },
    { amount: '4.999999', minimum: 5_000_000n, id: 'usdcxBelowMinimumBurn', text: 'usdcxBelowMinimumBurn|5' }
  ])('reports the displayed $id burn validation refusal after 1000 ms', async ({ amount, minimum, id, text }) => {
    setBurnRoute(amount);
    jest.mocked(readUsdcxMinimumBurn).mockResolvedValueOnce(minimum);
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('review-error')).toHaveTextContent(text);
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    await expectReport(id);
  });

  it('reports unknownTokenScale on the review surface while its send remains blocked', async () => {
    setValidRoute();
    mockBalanceData = [UNSCALED_TOKEN];
    render(<ReviewTransaction />);
    await flush();

    expect(screen.getByTestId('review-error')).toHaveTextContent('unknownTokenScale');
    expect(screen.getByTestId('send-review-submit')).toBeDisabled();
    await expectReport('unknownTokenScale');
  });
});
