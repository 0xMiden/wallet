import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ReportDeposit } from 'app/hooks/useFundTelemetry';
import type { Erc20Holding } from 'lib/agglayer/token-holdings';
import {
  TEST_BRIDGE_CONFIG,
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_EVM_CHAIN_ID,
  TEST_EVM_USDC,
  TEST_MIDEN_USDC_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import type { TokenPriceInfo, TokenPrices } from 'lib/prices';
import type { BridgeFeature, FeatureAvailability } from 'lib/remote-config/availability';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { AgglayerDepositToken } from 'lib/remote-config/values';
import { bridgeReceiveLibraryError } from 'lib/telemetry/bridge-receive-failure';
import { NativeReown, NativeSessionChainNotApprovedError, prepareNativeSessionChain } from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, readEvmErc20Allowance, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import type { DepositToken } from './deposit-token';
import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

let mockBalanceEncodingFailure = false;
jest.mock('viem', () => {
  const actual = jest.requireActual<typeof import('viem')>('viem');
  return {
    ...actual,
    encodeFunctionData: (parameters: Parameters<typeof actual.encodeFunctionData>[0]) => {
      if (mockBalanceEncodingFailure) throw new Error('synthetic balance encoding failure');
      return actual.encodeFunctionData(parameters);
    }
  };
});

// Covers the deposit submission (the tap that turns a quoted/valid amount into a
// tracked bridge transfer, and the reporter the hosting page wraps it with) and
// the network banner the shell renders over the committing steps. Every
// collaborator beyond the step components is stubbed - this suite is not a test
// of the bridge itself.

// The key, then any values it names, so a case can read which balance, token and network a message was given.
// This suite exercises the retained legacy Epoch engine and its in-flight submission guards.
// New deposit UI seeds Circle USDC instead and rejects selecting the retired test token.
jest.mock('./useDepositToken', () => ({
  useDepositToken: (onChange: () => void) =>
    jest.requireActual<typeof import('./useDepositToken')>('./useDepositToken').useDepositToken(onChange, 'USDC')
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)
  })
}));

// The web wallet's provider, connected unless a case takes it away.
let mockWebProviderConnected = true;
jest.mock('@reown/appkit/react', () => ({
  useAppKitProvider: () => ({ walletProvider: mockWebProviderConnected ? { request: jest.fn() } : undefined })
}));

const mockMutateAsync = jest.fn();
const mockSwitchChainAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: mockSwitchChainAsync }),
  useWriteContract: () => ({ mutateAsync: mockMutateAsync })
}));

// The Fast USDC pair and the Slow route's L1 bridge come from the bridge config. As in the runtime, every publish is
// a new snapshot object, and as the real selectors do, the ones below build new objects from it on every call.
interface MockConfigFields {
  chainId: number;
  allocatorUrl: string;
  evmUsdc: string;
  midenUsdcFaucet: string;
}
function mockConfigFor({ chainId, allocatorUrl, evmUsdc, midenUsdcFaucet }: MockConfigFields) {
  return {
    'bridge-providers': { epoch: { allocatorUrl, outputs: { 'usdc-testnet-output': { faucetId: midenUsdcFaucet } } } },
    supportedEvmChains: { source: { chainId, bridges: { epoch: { tokens: { USDC: { contractAddress: evmUsdc } } } } } }
  };
}
interface MockSnapshot {
  status: 'loading' | 'ready';
  config: ReturnType<typeof mockConfigFor> | null;
  lastFetch: { at: number; ok: boolean } | null;
}
function updateMockConfig(config: ReturnType<typeof mockConfigFor>, fields: Partial<MockConfigFields>) {
  return mockConfigFor({
    chainId: config.supportedEvmChains.source.chainId,
    allocatorUrl: config['bridge-providers'].epoch.allocatorUrl,
    evmUsdc: config.supportedEvmChains.source.bridges.epoch.tokens.USDC.contractAddress,
    midenUsdcFaucet: config['bridge-providers'].epoch.outputs['usdc-testnet-output'].faucetId,
    ...fields
  });
}
const READY_SNAPSHOT: MockSnapshot = {
  status: 'ready',
  config: mockConfigFor({
    chainId: 11155111,
    allocatorUrl: 'https://allocator.test',
    evmUsdc: '0x00000000000000000000000000000000000000c0',
    midenUsdcFaucet: '0x00000000000000000000000000e2e0'
  }),
  lastFetch: null
};
const TESTNET_SNAPSHOT: MockSnapshot = {
  status: 'ready',
  config: mockConfigFor({
    chainId: TEST_EVM_CHAIN_ID,
    allocatorUrl: 'https://allocator.test',
    evmUsdc: TEST_EVM_USDC.address,
    midenUsdcFaucet: TEST_MIDEN_USDC_FAUCET
  }),
  lastFetch: null
};
let mockSnapshot = READY_SNAPSHOT;
const mockSnapshotListeners = new Set<() => void>();
const publishSnapshot = (next: MockSnapshot) => {
  mockSnapshot = next;
  mockSnapshotListeners.forEach(listener => listener());
};
let mockAvailability: Partial<Record<BridgeFeature, FeatureAvailability>> = {};
const mockFeatureAvailability = jest.fn(
  (feature: BridgeFeature, _options?: { hold?: boolean }): FeatureAvailability =>
    mockAvailability[feature] ?? { state: 'available' }
);
jest.mock('lib/remote-config/use-feature-availability', () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
  const subscribe = (listener: () => void) => {
    mockSnapshotListeners.add(listener);
    return () => {
      mockSnapshotListeners.delete(listener);
    };
  };
  return {
    useBridgeConfigSnapshot: () => useSyncExternalStore(subscribe, () => mockSnapshot),
    useFeatureAvailability: (feature: BridgeFeature, options?: { hold?: boolean }) =>
      mockFeatureAvailability(feature, options)
  };
});
// The suite's Miden account is no real address; the Slow route only needs its EVM form to exist.
// The native Reown signer encodes `bridgeAsset` itself, so the ABI carries that one entry.
jest.mock('lib/agglayer', () => ({
  AGGLAYER_BRIDGE_ABI: [
    {
      type: 'function',
      name: 'bridgeAsset',
      stateMutability: 'payable',
      inputs: [
        { name: 'destinationNetwork', type: 'uint32' },
        { name: 'destinationAddress', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'forceUpdateGlobalExitRoot', type: 'bool' },
        { name: 'permitData', type: 'bytes' }
      ],
      outputs: []
    }
  ],
  AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL: 'ETH',
  midenAddrToEvmAddr: () => '0x00000000000000000000000000000000000000a1'
}));
// The symbol the Sepolia token read gave the configured USDC.
let mockEvmUsdcSymbol = 'USDC';
// Null: the config names no AggLayer chain.
let mockAgglayerChainId: number | null = 11155111;
// A USDC of the AggLayer chain's own, which picking Slow moves to; unset, it is the Fast one.
let mockAgglayerUsdc: string | undefined;
// The test network's token API, which offers the wallet's holdings: none unless a case sets one.
let mockTokenApiUrl: string | undefined;
let mockHeldErc20s: Erc20Holding[] = [];
jest.mock('lib/agglayer/token-holdings', () => ({ readErc20Holdings: async () => mockHeldErc20s }));
// The document's bridge-in ceiling: none unless a case sets one.
let mockBridgeInCapUsd: number | null = null;
// The ERC-20s the document lists for the AggLayer chain, as the derivation verified them.
let mockDepositTokens: AgglayerDepositToken[] = [];
jest.mock('lib/remote-config/values', () => ({
  // These synthetic ETH fixtures do not describe a priced delivery faucet.
  selectNativeEthFaucet: () => undefined,
  selectAgglayerRecoveryConfig: () =>
    mockAgglayerChainId === null
      ? null
      : {
          chainId: mockAgglayerChainId,
          contractAddress: '0x00000000000000000000000000000000000000b2',
          midenBridgeId: '0x3b66e20b5088f25133b69216484652',
          indexerUrl: 'https://indexer.test',
          rollupId: 77,
          evmNetworkId: 0
        },
  selectAgglayerChain: () =>
    mockAgglayerChainId === null
      ? null
      : {
          chainId: mockAgglayerChainId,
          bridges: {
            agglayer: {
              contractAddress: '0x00000000000000000000000000000000000000b2',
              midenBridgeId: '0x3b66e20b5088f25133b69216484652',
              tokenApiUrl: mockTokenApiUrl
            }
          }
        },
  selectEvmUsdc: ({ config }: MockSnapshot, chainId?: number) =>
    config
      ? {
          address:
            mockAgglayerUsdc && chainId === mockAgglayerChainId
              ? mockAgglayerUsdc
              : config.supportedEvmChains.source.bridges.epoch.tokens.USDC.contractAddress,
          symbol: mockEvmUsdcSymbol,
          decimals: 18,
          chainId: config.supportedEvmChains.source.chainId
        }
      : null,
  selectMidenUsdc: ({ config }: MockSnapshot) =>
    config
      ? {
          faucetId: config['bridge-providers'].epoch.outputs['usdc-testnet-output'].faucetId,
          symbol: 'USDC',
          decimals: 6
        }
      : null,
  getAgglayerDeposit: () => ({ l1Bridge: '0x00000000000000000000000000000000000000b2', rollupId: 77 }),
  selectBridgeInMaxBalanceUsd: () => mockBridgeInCapUsd,
  // Unless a case lists one, the document lists no deposit token and the registry holds none: the picker offers ETH
  // and the USDC rows alone. Each call returns a new list, as the selector does for an absent read, to test that
  // balance updates stop.
  selectAgglayerDepositTokens: () => mockDepositTokens.map(token => ({ ...token })),
  selectAgglayerRegistryToken: () => null
}));
// The receiving account holds nothing, so a ceiling weighs the deposit alone.
jest.mock('lib/miden/front', () => ({
  ...jest.requireActual<typeof import('lib/miden/front')>('lib/miden/front'),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => ({ data: [], isLoading: false })
}));

jest.mock('use-debounce', () => ({
  useDebounce: (value: unknown) => [value]
}));

const epochState = {
  status: 'idle',
  flow: null,
  quote: null,
  error: null,
  compactWatchClosed: false,
  quoteEVMToMiden: jest.fn(),
  executeEVMToMiden: jest.fn(),
  poll: jest.fn(),
  reset: jest.fn()
};
const idleEpoch = { ...epochState };

jest.mock('lib/epoch', () => ({
  MIDEN_DESTINATION_CHAIN_ID: 1,
  // The real conversion: `fastReady` holds only while the quote's `minTokenOut` is what the typed
  // amount asks for, and the screen aborts a requote on an undefined result. Unused on the Slow
  // route, which needs no quote.
  evmToMidenMinTokenOut:
    jest.requireActual<typeof import('lib/epoch/bridge')>('lib/epoch/bridge').evmToMidenMinTokenOut,
  useEpochStore: Object.assign((selector: (s: typeof epochState) => unknown) => selector(epochState), {
    getState: () => epochState
  })
}));

jest.mock('lib/miden/activity', () => ({
  initiateBridgedReceiveTransaction: jest.fn(),
  updateBridgedReceivePhase: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
}));

// The banner renders nothing on mainnet: pin a test network so its assertion does not rest on jest.setup's default.
let mockTestNetwork: 'testnet' | 'devnet' = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => mockTestNetwork
}));

// The sheet the banner opens needs a router this suite does not mount; it is never opened here.
jest.mock('components/NetworkModeSheet', () => ({
  NetworkModeSheet: () => null
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: () => undefined
}));

// The signer flavour: the wagmi one unless a case selects the native Reown one. The session-chain
// check passes unless a case refuses the chain; the error class is the real one the screen maps.
let mockNativeReown = false;
// The fee read hits the chain; here the wallet estimates, as it does when the read fails.
jest.mock('lib/walletconnect/fees', () => ({ readNativeFeeFields: async () => ({}) }));

jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => mockNativeReown,
  NativeReown: { sendTransaction: jest.fn() },
  NativeSessionChainNotApprovedError:
    jest.requireActual<typeof import('lib/walletconnect/native')>('lib/walletconnect/native')
      .NativeSessionChainNotApprovedError,
  prepareNativeSessionChain: jest.fn().mockResolvedValue(undefined),
  unwrapNativeResult: (value: unknown) => value
}));

jest.mock('lib/walletconnect/receipt', () => ({
  EvmTransactionRevertedError: jest.requireActual('lib/walletconnect/receipt').EvmTransactionRevertedError,
  waitForEvmReceipt: jest.fn().mockResolvedValue(undefined),
  readEvmErc20Allowance: jest.fn()
}));

jest.mock('lib/walletconnect/config', () => ({
  ...jest.requireActual('lib/walletconnect/config'),
  DEFAULT_CHAIN_ID: 11155111,
  SUPPORTED_CHAINS: [{ id: 11155111 }],
  getChain: () => ({ rpcUrl: 'https://rpc.test', name: 'Sepolia' })
}));

/** The handlers the screen last rendered into the form and the drawers: a guard is driven through them directly. */
let mockLastOpenTokenDrawer: () => void = () => undefined;
let mockLastTokenSelect: (token: DepositToken) => void = () => undefined;
let mockLastConnectAnother: () => void = () => undefined;

// Step components stubbed down to the affordances the deposit path needs.
jest.mock('./EvmBridgeDepositForm', () => {
  const legacy = (() => ({
    EvmBridgeDepositForm: ({
      token,
      tokenLabel,
      arrivingName,
      amount,
      isValidAmount,
      error,
      onAmountChange,
      onContinue,
      onSelectToken,
      onSwitch
    }: {
      token: { balance: number | null };
      tokenLabel: string;
      arrivingName: string;
      amount: string;
      isValidAmount: boolean;
      error?: string;
      onAmountChange: (value: string) => void;
      onContinue: () => void;
      onSelectToken: () => void;
      onSwitch: () => void;
    }) => {
      mockLastOpenTokenDrawer = onSelectToken;
      return (
        <div>
          <span data-testid="form-ready">{String(isValidAmount)}</span>
          <span data-testid="form-error">{error}</span>
          <span data-testid="form-balance">{token.balance === null ? 'loading' : token.balance}</span>
          <span data-testid="form-amount">{amount}</span>
          <span data-testid="form-token">{tokenLabel}</span>
          <span data-testid="form-arriving">{`arrives as ${arrivingName}`}</span>
          <button data-testid="set-amount" onClick={() => onAmountChange('1.5')}>
            amount
          </button>
          <button data-testid="set-amount-padded" onClick={() => onAmountChange('1.5050')}>
            padded amount
          </button>
          <button data-testid="set-amount-four-places" onClick={() => onAmountChange('10.6512')}>
            four-place amount
          </button>
          <button data-testid="open-token-drawer" onClick={onSelectToken}>
            token
          </button>
          <button data-testid="switch-wallet" onClick={onSwitch}>
            switch
          </button>
          <button data-testid="continue" onClick={onContinue}>
            continue
          </button>
        </div>
      );
    }
  }))();
  return {
    ...legacy,
    EvmBridgeDepositForm: (
      props: React.ComponentProps<typeof import('./EvmBridgeDepositForm').EvmBridgeDepositForm>
    ) =>
      mockRealBridgeDisplays
        ? React.createElement(
            jest.requireActual<typeof import('./EvmBridgeDepositForm')>('./EvmBridgeDepositForm').EvmBridgeDepositForm,
            props
          )
        : legacy.EvmBridgeDepositForm(props)
  };
});

/** The Review's latest Confirm handler: a tap can land on Review while the Navigator is leaving it. */
let mockLastReviewConfirm: () => unknown = () => undefined;
// The real `arrivingTokenName`, so the amount step names the arriving token by the rule the Review renders with.
jest.mock('./EvmBridgeDepositReview', () => {
  const legacy = (() => ({
    ...jest.requireActual<typeof import('./EvmBridgeDepositReview')>('./EvmBridgeDepositReview'),
    EvmBridgeDepositReview: ({
      amount,
      sourceQuote,
      outputAmount,
      label,
      promptContract,
      epochResourceLockRequired,
      epochQuoteTransactions,
      onConfirm
    }: {
      amount: string;
      sourceQuote?: TokenPriceInfo;
      outputAmount?: string;
      label?: string;
      promptContract?: string;
      epochResourceLockRequired?: boolean;
      epochQuoteTransactions?: Array<{ target: string }>;
      onConfirm: () => void;
    }) => {
      mockLastReviewConfirm = onConfirm;
      return (
        <div>
          <span data-testid="review-label">{label}</span>
          <span data-testid="review-amount">{amount}</span>
          <span data-testid="review-price">{sourceQuote?.price}</span>
          <span data-testid="review-output">{outputAmount}</span>
          <span data-testid="review-contract">{promptContract}</span>
          <span data-testid="review-resource-lock">{String(epochResourceLockRequired)}</span>
          <span data-testid="review-quote-target">{epochQuoteTransactions?.[0]?.target}</span>
          <button data-testid="confirm-deposit" onClick={onConfirm}>
            confirm
          </button>
        </div>
      );
    }
  }))();
  return {
    ...legacy,
    EvmBridgeDepositReview: (
      props: React.ComponentProps<typeof import('./EvmBridgeDepositReview').EvmBridgeDepositReview>
    ) =>
      mockRealBridgeDisplays
        ? React.createElement(
            jest.requireActual<typeof import('./EvmBridgeDepositReview')>('./EvmBridgeDepositReview')
              .EvmBridgeDepositReview,
            props
          )
        : legacy.EvmBridgeDepositReview(props)
  };
});

jest.mock('./EvmBridgeDepositStatus', () => {
  const legacy = (() => ({
    EvmBridgeDepositStatus: ({ awaitingNextConfirmation }: { awaitingNextConfirmation?: boolean }) => (
      <div data-testid="deposit-status" data-awaiting={String(Boolean(awaitingNextConfirmation))} />
    )
  }))();
  return {
    ...legacy,
    EvmBridgeDepositStatus: (
      props: React.ComponentProps<typeof import('./EvmBridgeDepositStatus').EvmBridgeDepositStatus>
    ) =>
      mockRealBridgeDisplays
        ? React.createElement(
            jest.requireActual<typeof import('./EvmBridgeDepositStatus')>('./EvmBridgeDepositStatus')
              .EvmBridgeDepositStatus,
            props
          )
        : legacy.EvmBridgeDepositStatus(props)
  };
});

// This realm's bridge config, for anything under the screen that reads it: the real, unloaded one, or the loaded testnet
// one a case sets. The screen's own labels read the screen's snapshot above, so a label case sets both alike.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);

jest.mock('./EvmBridgeTokenDrawer', () => ({
  EvmBridgeTokenDrawer: ({ open, onSelect }: { open: boolean; onSelect: (token: DepositToken) => void }) => {
    mockLastTokenSelect = onSelect;
    return open ? (
      <button data-testid="pick-eth" onClick={() => onSelect('ETH')}>
        ETH
      </button>
    ) : null;
  }
}));

jest.mock('./EvmSwitchWalletDrawer', () => ({
  EvmSwitchWalletDrawer: ({ open, onConnectAnother }: { open: boolean; onConnectAnother: () => void }) => {
    mockLastConnectAnother = onConnectAnother;
    return open ? (
      <button data-testid="connect-another" onClick={onConnectAnother}>
        connect another
      </button>
    ) : null;
  }
}));

jest.mock('./EvmBridgeUsdcxRoute', () => ({
  EvmBridgeUsdcxRoute: ({ onConfirm }: { onConfirm: () => void }) => (
    <button data-testid="usdcx-confirm-route" onClick={onConfirm}>
      route
    </button>
  )
}));

jest.mock('screens/send-flow/Route', () => ({
  Route: ({
    notice,
    confirmDisabled,
    onRouteChange,
    onConfirm
  }: {
    notice?: React.ReactNode;
    confirmDisabled?: boolean;
    onRouteChange: (route: string) => void;
    onConfirm: () => void;
  }) => (
    <div>
      <span data-testid="route-notice">{notice}</span>
      <button data-testid="pick-slow" onClick={() => onRouteChange('agglayer')}>
        slow
      </button>
      <button data-testid="confirm-route" disabled={confirmDisabled} onClick={onConfirm}>
        route
      </button>
    </div>
  )
}));

const midenAccount = { publicKey: 'mtst1account' };

/** A 32-byte word: what an `eth_call` returns, and a hex `eth_getBalance` parses as well. */
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
/** More of every token than any case types. */
const FUNDED = 10n ** 30n;
/** Every RPC read answers `balance`, the ETH and USDC reads alike; a null balance fails every read. */
const answerBalance = (balance: bigint | null) => {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => (balance === null ? { error: { message: 'rpc down' } } : { result: word(balance) })
  }) as never;
};
const balanceTooLow = (balance: string, token: string) =>
  `bridgeDepositBalanceTooLow ${JSON.stringify({ balance, token, network: 'Sepolia' })}`;

// The failure write the screen makes: the row's text, and the step and error its crash report names.
// A balance the check refused for its amount, or could not read; every other failure carries no balance check.
const BALANCE_CHECK_OF: Record<string, string> = {
  bridgeDepositBalanceTooLow: 'too_low',
  usdcxDepositFeeAboveBalance: 'too_low',
  bridgeDepositBalanceReadFailed: 'read_failed'
};
const failedAt = (step: string, error: string, errorId = 'raw_bridge_deposit_failed') => ({
  error,
  errorId,
  failure: {
    step,
    cause: expect.any(Error),
    ...(BALANCE_CHECK_OF[errorId] === undefined ? {} : { balanceCheck: BALANCE_CHECK_OF[errorId] })
  }
});
/** The library error the crash report names for the cause the last failure write handed it. */
const reportedEvmError = (): string =>
  bridgeReceiveLibraryError(
    jest
      .mocked(updateBridgedReceivePhase)
      .mock.calls.filter(([, phase]) => phase === 'failed')
      .at(-1)?.[2]?.failure?.cause
  );

/** Drive the ETH + Slow route to Review, the deposit path with no quote needed. */
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const reachReview = async (amountButton = 'set-amount', expectReview = true) => {
  fireEvent.click(screen.getByTestId('open-token-drawer'));
  await settle();
  fireEvent.click(screen.getByTestId('pick-eth'));
  await settle();
  fireEvent.click(screen.getByTestId(amountButton));
  await settle();
  fireEvent.click(screen.getByTestId('continue'));
  await settle();
  fireEvent.click(await screen.findByTestId('pick-slow'));
  await settle();
  fireEvent.click(screen.getByTestId('confirm-route'));
  if (expectReview) await screen.findByTestId('confirm-deposit');
};

/**
 * A Fast quote for the padded typed amount: `minTokenOut` is what 1.5050 asks for (1.505 at the
 * faucet's 6 decimals), `tokenOut` a quote of 10, and `tokenIn` a deposit of 10.6512 at 18. Both
 * need more than two decimals so typed, rounded up, half-up and rounded down each read differently.
 */
const quoteFast = (
  resourceLockRequired = true,
  transactions: Array<{ target: string; value: string; callData: string; chainId: number }> = []
) =>
  Object.assign(epochState, {
    quoteEVMToMiden: jest.fn().mockResolvedValue(undefined),
    status: 'quoted',
    flow: 'evm-to-miden',
    quote: {
      params: { minTokenOut: '1505000' },
      quoteResult: { tokenIn: '10651200000000000000', tokenOut: '10000000', resourceLockRequired, transactions }
    }
  });

const reachFastReview = async (expectReview = true) => {
  fireEvent.click(screen.getByTestId('set-amount-padded'));
  await settle();
  fireEvent.click(screen.getByTestId('continue'));
  await settle();
  fireEvent.click(await screen.findByTestId('confirm-route'));
  if (expectReview) await screen.findByTestId('confirm-deposit');
};

/** Drive USDC (the default token) + Slow route to Review. The amount is typed on the default Fast route, which quotes it. */
const reachSlowUsdcReview = async (expectReview = true) => {
  Object.assign(epochState, { quoteEVMToMiden: jest.fn().mockResolvedValue(undefined) });
  fireEvent.click(screen.getByTestId('set-amount-four-places'));
  await settle();
  fireEvent.click(screen.getByTestId('continue'));
  await settle();
  fireEvent.click(await screen.findByTestId('pick-slow'));
  await settle();
  fireEvent.click(screen.getByTestId('confirm-route'));
  if (expectReview) await screen.findByTestId('confirm-deposit');
  else await settle();
};

const connectAnother = jest.fn();
// A real address: the USDC balance read refuses anything else, and the form holds Continue until that read lands.
const EVM_ADDRESS = '0x00000000000000000000000000000000000000e0';
const depositScreen = (reportDeposit?: ReportDeposit, evmAddress = EVM_ADDRESS) => (
  <EvmBridgeDepositScreen
    evmAddress={evmAddress}
    midenAccount={midenAccount as never}
    onConnectAnother={connectAnother}
    onClose={jest.fn()}
    reportDeposit={reportDeposit}
  />
);

const renderScreen = (reportDeposit?: ReportDeposit) => render(depositScreen(reportDeposit));

type ConfigMove = (config: NonNullable<MockSnapshot['config']>) => MockSnapshot['config'];
const CONFIG_MOVES: [string, ConfigMove, Record<string, unknown>][] = [
  ['the allocator', config => updateMockConfig(config, { allocatorUrl: 'https://moved.test' }), {}],
  [
    'the Miden USDC faucet',
    config => updateMockConfig(config, { midenUsdcFaucet: '0x00000000000000000000000000e2e1' }),
    { midenFaucetId: '0x00000000000000000000000000e2e1' }
  ]
];
const NO_MIDEN_USDC: [string, ConfigMove] = [
  'the Miden USDC faucet, to none',
  config => updateMockConfig(config, { midenUsdcFaucet: '' })
];

/** Quotes as the store does, quoting then quoted, and renders each landed quote as its subscribers would. */
const quoteMovingTheStore = (rerender: () => void) =>
  jest.fn(async () => {
    Object.assign(epochState, { status: 'quoting', flow: 'evm-to-miden', error: null });
    await Promise.resolve();
    Object.assign(epochState, { status: 'quoted' });
    rerender();
  });

describe('EvmBridgeDepositScreen deposit reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAvailability = {};
    mockAgglayerChainId = 11155111;
    mockSnapshot = READY_SNAPSHOT;
    mockTestNetwork = 'testnet';
    mockEvmUsdcSymbol = 'USDC';
    mockMutateAsync.mockReset();
    jest.mocked(readEvmErc20Allowance).mockResolvedValue(0n);
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    answerBalance(FUNDED);
  });

  // The Fast case below quotes into the shared store; every case starts from it idle.
  afterEach(() => {
    Object.assign(epochState, idleEpoch);
    mockBridgeSnapshot = undefined;
    mockWebProviderConnected = true;
  });

  it('routes the deposit submission through the reporter', async () => {
    const reported = jest.fn();
    const reportDeposit: ReportDeposit = attempt => {
      reported();
      return attempt();
    };
    renderScreen(reportDeposit);

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(reported).toHaveBeenCalledTimes(1);
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
  });

  it('lets the reporter see a failed submission', async () => {
    jest.mocked(initiateBridgedReceiveTransaction).mockRejectedValue(new Error('row failed'));
    const seen: unknown[] = [];
    const reportDeposit: ReportDeposit = async attempt => {
      try {
        return await attempt();
      } catch (err) {
        seen.push(err);
        throw err;
      }
    };
    renderScreen(reportDeposit);

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(seen.length).toBeGreaterThan(0);
    // The screen still absorbs the failure rather than throwing out of the tap.
    expect(screen.getByTestId('confirm-deposit')).toBeInTheDocument();
  });

  it('still submits when no reporter is supplied', async () => {
    renderScreen();

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
  });

  it('fails the AggLayer row at provider_unavailable, before any prompt, with no native or web provider', async () => {
    mockNativeReown = false;
    mockWebProviderConnected = false;
    renderScreen();

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    await waitFor(() =>
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
        error: 'The connected EVM wallet provider is unavailable.',
        errorId: 'raw_bridge_deposit_failed',
        failure: { step: 'provider_unavailable' }
      })
    );
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockSwitchChainAsync).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(prepareNativeSessionChain).not.toHaveBeenCalled();
  });

  it('names the USDC token USDC while no bridge config is loaded', () => {
    mockSnapshot = { status: 'loading', config: null, lastFetch: null };
    renderScreen();

    expect(screen.getByTestId('form-token')).toHaveTextContent(/^USDC$/);
  });

  it('names the USDC token by the testnet label once the config names the token', () => {
    mockSnapshot = TESTNET_SNAPSHOT;
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderScreen();

    expect(screen.getByTestId('form-token')).toHaveTextContent('Test Epoch USDC');
  });

  it('names the configured USDC by the testnet label on the Review', async () => {
    mockSnapshot = TESTNET_SNAPSHOT;
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderScreen();

    await reachSlowUsdcReview();

    expect(await screen.findByTestId('review-label')).toHaveTextContent('Test Epoch USDC');
  });

  // Off testnet no label applies, so the amount step must carry the symbol the token read gave, as the Review does.
  it('names the USDC on the amount step as the Review does, off testnet too', async () => {
    mockTestNetwork = 'devnet';
    mockEvmUsdcSymbol = 'USDC.e';
    renderScreen();
    expect(screen.getByTestId('form-token')).toHaveTextContent(/^USDC\.e$/);

    await reachSlowUsdcReview();

    expect(await screen.findByTestId('review-label')).toHaveTextContent(/^USDC\.e$/);
  });

  it('keeps ETH on its symbol on the Review on testnet', async () => {
    mockSnapshot = TESTNET_SNAPSHOT;
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderScreen();

    await reachReview();

    expect(await screen.findByTestId('review-label')).toHaveTextContent(/^ETH$/);
  });

  // The deposit is what the wallet signs for, so it rounds up: never less than leaves the account.
  it('shows the Fast-route deposit on the Review rounded up, never down or half-up', async () => {
    quoteFast();
    renderScreen();

    await reachFastReview();

    expect(await screen.findByTestId('review-amount')).toHaveTextContent(/^10\.66$/);
    expect(idleEpoch.quoteEVMToMiden()).toBeUndefined();
  });

  it('shows The Compact as the Fast-route approval spender and deposit target', async () => {
    quoteFast();
    renderScreen();

    await reachFastReview();

    expect(screen.getByTestId('review-contract')).toHaveTextContent('0x00000000000000171ede64904551eeDF3C6C9788');
  });

  it('passes the Fast quote wallet calls to the review when existing collateral is used', async () => {
    quoteFast(false, [
      { chainId: 11155111, target: '0x1234567890123456789012345678901234567890', value: '0', callData: '0x12345678' }
    ]);
    renderScreen();

    await reachFastReview();

    expect(screen.getByTestId('review-resource-lock')).toHaveTextContent('false');
    expect(screen.getByTestId('review-quote-target')).toHaveTextContent('0x1234567890123456789012345678901234567890');
  });

  it('keeps the Fast-route review amount without inventing a nominal USD quote', async () => {
    quoteFast();
    renderScreen();

    await reachFastReview();

    expect(await screen.findByTestId('review-amount')).toHaveTextContent(/^10\.66$/);
    expect(screen.getByTestId('review-price')).toBeEmptyDOMElement();
  });

  it('keeps the Slow-route USDC review amount without inventing a nominal USD quote', async () => {
    renderScreen();

    await reachSlowUsdcReview();

    expect(await screen.findByTestId('review-amount')).toHaveTextContent(/^10\.6512$/);
    expect(screen.getByTestId('review-price')).toBeEmptyDOMElement();
  });

  it('shows the Fast "you receive" as the typed minTokenOut, not the quote', async () => {
    quoteFast();
    renderScreen();

    await reachFastReview();

    expect(await screen.findByTestId('review-output')).toHaveTextContent(/^1\.505$/);
  });

  it('stores the exact typed "you receive" on a Fast row, and the quoted tokenOut as its amount', async () => {
    quoteFast();
    renderScreen();

    await reachFastReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10_000_000n, sourceAmount: '10.6512', outputAmount: '1.505' })
    );
  });

  it('shows a Slow-route amount on the Review as typed, without its trailing zero', async () => {
    renderScreen();

    await reachReview('set-amount-padded');

    expect(screen.getByTestId('review-amount')).toHaveTextContent(/^1\.505$/);
    expect(screen.getByTestId('review-output')).toHaveTextContent(/^1\.505$/);
  });

  it("keeps storing a Slow row's amounts exactly as typed", async () => {
    renderScreen();

    await reachReview('set-amount-padded');
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAmount: '1.5050', outputAmount: '1.5050' })
    );
  });

  it('bridges the Slow route through the L1 bridge and the rollup id the config names', async () => {
    mockSwitchChainAsync.mockClear();
    renderScreen();

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    // A USDCx deposit may have left the web wallet on Arc or Base: the Slow route switches back before it signs.
    expect(mockSwitchChainAsync).toHaveBeenCalledWith({ chainId: 11155111 });
    expect(mockSwitchChainAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mockMutateAsync.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0x00000000000000000000000000000000000000b2',
        functionName: 'bridgeAsset',
        args: [
          77,
          '0x00000000000000000000000000000000000000a1',
          1_500_000_000_000_000_000n,
          expect.any(String),
          true,
          '0x'
        ]
      })
    );
  });

  it('quotes the Fast route for the USDC pair the config names', async () => {
    const quoteEVMToMiden = jest.fn().mockResolvedValue(undefined);
    Object.assign(epochState, { quoteEVMToMiden });
    renderScreen();

    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();

    expect(quoteEVMToMiden).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChainId: 11155111,
        evmTokenAddress: '0x00000000000000000000000000000000000000c0',
        midenFaucetId: '0x00000000000000000000000000e2e0',
        minTokenOut: '1500000'
      }),
      EVM_ADDRESS
    );
  });

  it('neither reads the USDC balance again nor re-quotes on a publish that moves no value they read', async () => {
    const quoteEVMToMiden = jest.fn().mockResolvedValue(undefined);
    Object.assign(epochState, { quoteEVMToMiden });
    renderScreen();
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    expect(quoteEVMToMiden).toHaveBeenCalledTimes(1);
    const reads = jest.mocked(global.fetch).mock.calls.length;

    act(() => publishSnapshot({ ...mockSnapshot, lastFetch: { at: 1, ok: true } }));
    expect(screen.getByTestId('form-balance')).not.toHaveTextContent('loading');
    await settle();

    expect(quoteEVMToMiden).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(reads);
  });

  it.each(CONFIG_MOVES)('quotes again once the config moves only %s', async (_case, move, moved) => {
    const quoteEVMToMiden = jest.fn().mockResolvedValue(undefined);
    Object.assign(epochState, { quoteEVMToMiden });
    renderScreen();
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();

    act(() => publishSnapshot({ ...READY_SNAPSHOT, config: move(READY_SNAPSHOT.config!) }));
    await settle();

    expect(quoteEVMToMiden).toHaveBeenCalledTimes(2);
    expect(quoteEVMToMiden).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceChainId: 11155111,
        evmTokenAddress: '0x00000000000000000000000000000000000000c0',
        midenFaucetId: '0x00000000000000000000000000e2e0',
        minTokenOut: '1500000',
        ...moved
      }),
      EVM_ADDRESS
    );
  });

  // A quote resets the store's deposit state, and a declined one resets the store outright.
  it.each(
    (['signing', 'pending', 'done'] as const).flatMap(status =>
      [...CONFIG_MOVES, NO_MIDEN_USDC].map(([moved, move]) => [status, moved, move] as const)
    )
  )('leaves a %s deposit in place when the config moves only %s', async (status, _moved, move) => {
    const quoteEVMToMiden = jest.fn().mockResolvedValue(undefined);
    Object.assign(epochState, { quoteEVMToMiden });
    renderScreen();
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    expect(quoteEVMToMiden).toHaveBeenCalledTimes(1);
    jest.mocked(epochState.reset).mockClear();

    Object.assign(epochState, { status, flow: 'evm-to-miden' });
    act(() => publishSnapshot({ ...READY_SNAPSHOT, config: move(READY_SNAPSHOT.config!) }));
    await settle();

    expect(quoteEVMToMiden).toHaveBeenCalledTimes(1);
    expect(epochState.reset).not.toHaveBeenCalled();
  });

  // The Retry tap re-quotes through the same path, so a failed deposit stays recoverable.
  it.each(CONFIG_MOVES)('quotes again after a failed deposit once the config moves only %s', async (_case, move) => {
    const quoteEVMToMiden = jest.fn().mockResolvedValue(undefined);
    Object.assign(epochState, { quoteEVMToMiden });
    renderScreen();
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();

    Object.assign(epochState, { status: 'failed', flow: 'evm-to-miden' });
    act(() => publishSnapshot({ ...READY_SNAPSHOT, config: move(READY_SNAPSHOT.config!) }));
    await settle();

    expect(quoteEVMToMiden).toHaveBeenCalledTimes(2);
  });

  it('quotes an amount once while the store moves from quoting to quoted', async () => {
    let rerenderScreen = (): void => undefined;
    const quoteEVMToMiden = quoteMovingTheStore(() => rerenderScreen());
    Object.assign(epochState, { quoteEVMToMiden });
    const { rerender } = renderScreen();
    rerenderScreen = () => rerender(depositScreen());

    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();

    expect(epochState.status).toBe('quoted');
    expect(quoteEVMToMiden).toHaveBeenCalledTimes(1);
  });

  /** Holds the tracking row's creation open after the Confirm tap, as a slow write would, until it is written or fails. */
  const holdRowCreation = () => {
    let resolveRow: (id: string) => void = () => undefined;
    let rejectRow: (err: Error) => void = () => undefined;
    jest.mocked(initiateBridgedReceiveTransaction).mockReturnValue(
      new Promise<string>((resolve, reject) => {
        resolveRow = resolve;
        rejectRow = reject;
      })
    );
    return { release: () => resolveRow('bridge-tx'), fail: () => rejectRow(new Error('row failed')) };
  };

  // The store still reads 'quoted' while the row is written, so the status alone cannot tell the deposit has started.
  it.each([...CONFIG_MOVES, NO_MIDEN_USDC].map(([moved, move]) => [moved, move] as const))(
    'leaves a confirmed deposit alone while its row is written and the config moves only %s',
    async (_moved, move) => {
      quoteFast();
      renderScreen();
      await reachFastReview();
      const quotes = jest.mocked(epochState.quoteEVMToMiden).mock.calls.length;
      jest.mocked(epochState.reset).mockClear();
      const row = holdRowCreation();
      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      act(() => publishSnapshot({ ...READY_SNAPSHOT, config: move(READY_SNAPSHOT.config!) }));
      await settle();
      expect(epochState.quoteEVMToMiden).toHaveBeenCalledTimes(quotes);
      expect(epochState.reset).not.toHaveBeenCalled();

      row.release();
      await settle();
      expect(epochState.executeEVMToMiden).toHaveBeenCalledTimes(1);
    }
  );

  // Back stays open while the row is written, so a route or token change then must not reset the deposit.
  const goBackTo = async (steps: number) => {
    for (let step = 0; step < steps; step++) {
      fireEvent.click(screen.getByTestId('page-back'));
      await settle();
    }
  };
  const changeRoute = async () => {
    await goBackTo(1);
    fireEvent.click(screen.getByTestId('pick-slow'));
    await settle();
  };
  // The drawer cannot open under the lock, so the pick goes to the handler the drawer last rendered with.
  const changeToken = async () => {
    await goBackTo(2);
    act(() => mockLastTokenSelect('ETH'));
    await settle();
  };

  it.each([
    ['route', changeRoute],
    ['token', changeToken]
  ] as const)('keeps a deposit whose row is being written when the %s changes', async (_change, change) => {
    quoteFast();
    renderScreen();
    await reachFastReview();
    jest.mocked(epochState.reset).mockClear();
    const row = holdRowCreation();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    await change();
    expect(epochState.reset).not.toHaveBeenCalled();

    row.release();
    await settle();
    expect(epochState.executeEVMToMiden).toHaveBeenCalledTimes(1);
  });

  // The screen keeps the route when the user steps back, so the amount step names what that route delivers.
  it('names the arriving USDC on the amount step by its symbol on the Slow route, as its Review does', async () => {
    renderScreen();
    await reachSlowUsdcReview();

    await goBackTo(2);

    expect(screen.getByTestId('form-arriving')).toHaveTextContent(/^arrives as USDC$/);
  });

  it('names the arriving USDC on the amount step by the testnet label on the Fast route', async () => {
    quoteFast();
    renderScreen();
    await reachFastReview();

    await goBackTo(2);

    expect(screen.getByTestId('form-arriving')).toHaveTextContent(/^arrives as Test Epoch USDC$/);
  });

  it('lets the route change again once a confirm whose row failed has settled', async () => {
    quoteFast();
    renderScreen();
    await reachFastReview();
    jest.mocked(initiateBridgedReceiveTransaction).mockRejectedValue(new Error('row failed'));
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();
    jest.mocked(epochState.reset).mockClear();

    await changeRoute();

    expect(epochState.reset).toHaveBeenCalledTimes(1);
  });

  // The confirmed deposit carries the amount, token and wallet on screen at the tap; none of them may move under it.
  const confirmHeld = async () => {
    quoteFast();
    renderScreen();
    await reachFastReview();
    const row = holdRowCreation();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();
    await goBackTo(2);
    return row;
  };

  it('keeps the amount a deposit was confirmed with while its row is written', async () => {
    const row = await confirmHeld();
    const quotes = jest.mocked(epochState.quoteEVMToMiden).mock.calls.length;

    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();

    expect(screen.getByTestId('form-amount')).toHaveTextContent(/^1\.5050$/);
    expect(epochState.quoteEVMToMiden).toHaveBeenCalledTimes(quotes);
    row.release();
    await settle();
  });

  it('keeps the token a deposit was confirmed with while its row is written', async () => {
    const row = await confirmHeld();

    act(() => mockLastTokenSelect('ETH'));
    await settle();

    // The default snapshot is testnet's and names the EVM USDC, so the form names it by the label.
    expect(screen.getByTestId('form-token')).toHaveTextContent(/^Test Epoch USDC$/);
    row.release();
    await settle();
  });

  it('opens no wallet switch while a confirmed row is written', async () => {
    const row = await confirmHeld();

    fireEvent.click(screen.getByTestId('switch-wallet'));
    await settle();

    expect(screen.queryByTestId('connect-another')).not.toBeInTheDocument();
    expect(connectAnother).not.toHaveBeenCalled();
    row.release();
    await settle();
  });

  it('hands a switch drawer already open no wallet change while a confirmed row is written', async () => {
    quoteFast();
    renderScreen();
    fireEvent.click(screen.getByTestId('switch-wallet'));
    await settle();
    await reachFastReview();
    const row = holdRowCreation();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    act(() => mockLastConnectAnother());
    await settle();

    expect(connectAnother).not.toHaveBeenCalled();
    row.release();
    await settle();
  });

  // The lock taken at the tap holds once the row exists: the status page follows, and nothing may reset what it shows.
  const tryEveryInput = async () => {
    act(() => mockLastOpenTokenDrawer());
    act(() => mockLastTokenSelect('ETH'));
    act(() => mockLastConnectAnother());
    await settle();
  };

  it('refuses every input of a confirmed deposit while its row is written and once it exists', async () => {
    const row = await confirmHeld();
    jest.mocked(epochState.reset).mockClear();

    await tryEveryInput();
    expect(screen.queryByTestId('pick-eth')).not.toBeInTheDocument();
    expect(screen.getByTestId('form-token')).toHaveTextContent(/^Test Epoch USDC$/);

    row.release();
    await settle();
    await tryEveryInput();

    expect(screen.queryByTestId('pick-eth')).not.toBeInTheDocument();
    expect(epochState.reset).not.toHaveBeenCalled();
    expect(connectAnother).not.toHaveBeenCalled();
    expect(epochState.executeEVMToMiden).toHaveBeenCalledTimes(1);
  });

  it.each(['quoted', 'failed'] as const)(
    'quotes nothing over a deposit whose row exists when the config moves, the store reading %s',
    async status => {
      quoteFast();
      renderScreen();
      await reachFastReview();
      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();
      Object.assign(epochState, { status, flow: 'evm-to-miden' });
      const quotes = jest.mocked(epochState.quoteEVMToMiden).mock.calls.length;
      jest.mocked(epochState.reset).mockClear();

      const config = READY_SNAPSHOT.config!;
      const moved = updateMockConfig(config, { allocatorUrl: 'https://moved.test' });
      act(() => publishSnapshot({ ...READY_SNAPSHOT, config: moved }));
      await settle();

      expect(epochState.quoteEVMToMiden).toHaveBeenCalledTimes(quotes);
      expect(epochState.reset).not.toHaveBeenCalled();
    }
  );

  it('closes an open token or wallet drawer at the Confirm tap', async () => {
    quoteFast();
    renderScreen();
    fireEvent.click(screen.getByTestId('open-token-drawer'));
    fireEvent.click(screen.getByTestId('switch-wallet'));
    await settle();
    await reachFastReview();
    const row = holdRowCreation();

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(screen.queryByTestId('pick-eth')).not.toBeInTheDocument();
    expect(screen.queryByTestId('connect-another')).not.toBeInTheDocument();
    row.release();
    await settle();
  });

  it('creates no second row from a Confirm that lands once the row exists', async () => {
    quoteFast();
    renderScreen();
    await reachFastReview();
    const row = holdRowCreation();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    row.release();
    await settle();
    // A tap on Review as the Navigator leaves it runs the handler Review last rendered with.
    await act(async () => {
      await mockLastReviewConfirm();
    });
    await settle();

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
  });

  it('switches the wallet outside a confirm', async () => {
    renderScreen();

    fireEvent.click(screen.getByTestId('switch-wallet'));
    await settle();
    fireEvent.click(screen.getByTestId('connect-another'));

    expect(connectAnother).toHaveBeenCalledTimes(1);
  });

  // The quote effect skips whatever moves during a confirm; a confirm that leaves no row must not leave that quote.
  it.each(CONFIG_MOVES)(
    'quotes a move of only %s made while a confirm was out once its row fails',
    async (_case, move, moved) => {
      quoteFast();
      renderScreen();
      await reachFastReview();
      const quotes = jest.mocked(epochState.quoteEVMToMiden).mock.calls.length;
      const row = holdRowCreation();
      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();
      act(() => publishSnapshot({ ...READY_SNAPSHOT, config: move(READY_SNAPSHOT.config!) }));
      await settle();

      row.fail();
      await settle();

      expect(epochState.quoteEVMToMiden).toHaveBeenCalledTimes(quotes + 1);
      expect(epochState.quoteEVMToMiden).toHaveBeenLastCalledWith(
        expect.objectContaining({
          midenFaucetId: '0x00000000000000000000000000e2e0',
          minTokenOut: '1505000',
          ...moved
        }),
        EVM_ADDRESS
      );
    }
  );

  it('resets the store once a confirm whose row fails settles after the config named no Miden USDC', async () => {
    const [, move] = NO_MIDEN_USDC;
    quoteFast();
    renderScreen();
    await reachFastReview();
    const quotes = jest.mocked(epochState.quoteEVMToMiden).mock.calls.length;
    jest.mocked(epochState.reset).mockClear();
    const row = holdRowCreation();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();
    act(() => publishSnapshot({ ...READY_SNAPSHOT, config: move(READY_SNAPSHOT.config!) }));
    await settle();
    expect(epochState.reset).not.toHaveBeenCalled();

    row.fail();
    await settle();

    expect(epochState.reset).toHaveBeenCalledTimes(1);
    expect(epochState.quoteEVMToMiden).toHaveBeenCalledTimes(quotes);
  });

  it('quotes nothing more once a confirm whose row is written settles', async () => {
    quoteFast();
    renderScreen();
    await reachFastReview();
    const quotes = jest.mocked(epochState.quoteEVMToMiden).mock.calls.length;

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(epochState.executeEVMToMiden).toHaveBeenCalledTimes(1);
    expect(epochState.quoteEVMToMiden).toHaveBeenCalledTimes(quotes);
  });

  it("keeps a failed deposit's error on screen and quotes nothing for it on its own", async () => {
    let rerenderScreen = (): void => undefined;
    const quoteEVMToMiden = quoteMovingTheStore(() => rerenderScreen());
    Object.assign(epochState, { quoteEVMToMiden });
    const { rerender } = renderScreen();
    rerenderScreen = () => rerender(depositScreen());
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    quoteEVMToMiden.mockClear();

    Object.assign(epochState, { status: 'signing' });
    rerenderScreen();
    await settle();
    Object.assign(epochState, { status: 'failed', error: 'The wallet rejected the deposit.' });
    rerenderScreen();
    await settle();

    expect(quoteEVMToMiden).not.toHaveBeenCalled();
    expect(screen.getByTestId('form-error')).toHaveTextContent('The wallet rejected the deposit.');
  });

  it('shows the USDC balance as loading, not as an error, while the config loads', async () => {
    mockSnapshot = { status: 'loading', config: null, lastFetch: null };
    renderScreen();
    await settle();

    expect(screen.getByTestId('form-balance')).toHaveTextContent('loading');
    expect(screen.getByTestId('form-error')).toBeEmptyDOMElement();
  });

  // The ETH balance names no config value, so neither a loading config nor a moved token touches it.
  const ethReads = () =>
    jest
      .mocked(global.fetch)
      .mock.calls.filter(([, init]) => JSON.parse(String((init as RequestInit).body)).method === 'eth_getBalance')
      .length;

  it('reads the ETH balance while the config loads', async () => {
    mockSnapshot = { status: 'loading', config: null, lastFetch: null };
    renderScreen();
    await settle();

    expect(ethReads()).toBe(1);
  });

  it('does not read the ETH balance again when the config moves the USDC token', async () => {
    renderScreen();
    await settle();
    expect(ethReads()).toBe(1);

    const config = READY_SNAPSHOT.config!;
    const moved = updateMockConfig(config, { evmUsdc: '0x00000000000000000000000000000000000000c1' });
    act(() => publishSnapshot({ ...READY_SNAPSHOT, config: moved }));
    await settle();

    expect(ethReads()).toBe(1);
  });

  it.each<[string, BridgeFeature, () => Promise<void>]>([
    ['Fast', 'fastBridgeIn', () => reachFastReview(false)],
    ['Slow', 'bridgeIn', () => reachReview('set-amount', false)]
  ])('keeps the %s route from Review while %s is unavailable', async (_route, feature, reach) => {
    quoteFast();
    mockAvailability = { [feature]: { state: 'unavailable', reason: 'service-down', detail: 'down' } };
    renderScreen();

    await reach();

    expect(screen.queryByTestId('confirm-deposit')).not.toBeInTheDocument();
  });

  // The fast poll is held only for a greyed-out route card, which the status page never draws.
  it('asks for the fast-poll hold on every step but the status page', async () => {
    mockAvailability = { fastBridgeIn: { state: 'unavailable', reason: 'service-down', detail: 'down' } };
    const lastHold = (feature: BridgeFeature) =>
      mockFeatureAvailability.mock.calls.filter(([called]) => called === feature).at(-1)?.[1];
    renderScreen();

    await reachReview();
    expect(lastHold('fastBridgeIn')).toEqual({ hold: true, chainId: 11155111 });
    expect(lastHold('bridgeIn')).toEqual({ hold: true, chainId: 11155111 });

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();
    expect(await screen.findByTestId('deposit-status')).toBeInTheDocument();
    expect(lastHold('fastBridgeIn')).toEqual({ hold: false, chainId: 11155111 });
    expect(lastHold('bridgeIn')).toEqual({ hold: false, chainId: 11155111 });
  });

  it('stops the status interval once the compact watch closes', async () => {
    jest.useFakeTimers();
    const poll = jest.fn().mockResolvedValue(undefined);
    Object.assign(epochState, { status: 'pending', flow: 'evm-to-miden', compactWatchClosed: false, poll });
    const view = renderScreen();
    try {
      await act(() => jest.advanceTimersByTimeAsync(3_000));
      expect(poll).toHaveBeenCalledTimes(1);

      epochState.compactWatchClosed = true;
      view.rerender(depositScreen());
      await act(() => jest.advanceTimersByTimeAsync(9_000));

      expect(poll).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      jest.useRealTimers();
    }
  });

  it('starts every case from an idle epoch store', () => {
    expect(epochState).toMatchObject({ status: 'idle', flow: null, quote: null });
    expect(epochState.quoteEVMToMiden).toBe(idleEpoch.quoteEVMToMiden);
    expect(epochState.quoteEVMToMiden()).toBeUndefined();
  });
});

describe('EvmBridgeDepositScreen Slow-route USDC approval', () => {
  const EVM_WALLET = '0x00000000000000000000000000000000000000e1';
  const USDC = '0x00000000000000000000000000000000000000c0';
  const L1_BRIDGE = '0x00000000000000000000000000000000000000b2';
  /** The typed 10.6512 at the 18 decimals the suite gives the configured USDC. */
  const DEPOSIT = 10_651_200_000_000_000_000n;

  /** The allowance the Sepolia read answers with; a null answer is a failed read. */
  const answerAllowance = (allowance: bigint | null) =>
    allowance === null
      ? jest.mocked(readEvmErc20Allowance).mockRejectedValue(new Error('rpc down'))
      : jest.mocked(readEvmErc20Allowance).mockResolvedValue(allowance);

  const confirmSlowUsdcDeposit = async () => {
    render(depositScreen(undefined, EVM_WALLET));
    await reachSlowUsdcReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAvailability = {};
    mockAgglayerChainId = 11155111;
    mockSnapshot = READY_SNAPSHOT;
    mockNativeReown = false;
    answerBalance(FUNDED);
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    mockMutateAsync.mockReset().mockResolvedValue('0xhash');
    jest.mocked(waitForEvmReceipt).mockReset().mockResolvedValue(undefined);
    jest.mocked(NativeReown.sendTransaction).mockReset().mockResolvedValue({ hash: '0xhash' });
  });

  afterEach(() => {
    Object.assign(epochState, idleEpoch);
    mockNativeReown = false;
  });

  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it.each([false, true])('shows the second-confirmation wait during the approval receipt (native=%s)', async native => {
    mockNativeReown = native;
    answerAllowance(0n);
    const receipt = deferred<void>();
    const prompt = deferred<string>();
    jest.mocked(waitForEvmReceipt).mockReturnValueOnce(receipt.promise);
    if (native) {
      jest
        .mocked(NativeReown.sendTransaction)
        .mockResolvedValueOnce({ hash: '0xapprove' })
        .mockImplementationOnce(async () => ({ hash: await prompt.promise }));
    } else {
      mockMutateAsync.mockResolvedValueOnce('0xapprove').mockReturnValueOnce(prompt.promise);
    }
    await confirmSlowUsdcDeposit();
    const status = await screen.findByTestId('deposit-status');
    await waitFor(() => expect(status).toHaveAttribute('data-awaiting', 'true'));
    const signer = native ? NativeReown.sendTransaction : mockMutateAsync;
    expect(signer).toHaveBeenCalledTimes(1);
    await act(async () => receipt.resolve(undefined));
    await waitFor(() => expect(signer).toHaveBeenCalledTimes(2));
    expect(status).toHaveAttribute('data-awaiting', 'true');
    await act(async () => prompt.resolve('0xbridge'));
    await waitFor(() => expect(status).toHaveAttribute('data-awaiting', 'false'));
  });

  it.each([false, true].flatMap(native => ['receipt', 'prompt'].map(stage => [native, stage] as const)))(
    'clears the wait on %s signer %s failure',
    async (native, stage) => {
      mockNativeReown = native;
      answerAllowance(0n);
      const receipt = deferred<void>();
      const prompt = deferred<string>();
      jest.mocked(waitForEvmReceipt).mockReturnValueOnce(receipt.promise);
      if (native) {
        jest
          .mocked(NativeReown.sendTransaction)
          .mockResolvedValueOnce({ hash: '0xapprove' })
          .mockImplementationOnce(async () => ({ hash: await prompt.promise }));
      } else {
        mockMutateAsync.mockResolvedValueOnce('0xapprove').mockReturnValueOnce(prompt.promise);
      }
      await confirmSlowUsdcDeposit();
      const status = await screen.findByTestId('deposit-status');
      await waitFor(() => expect(status).toHaveAttribute('data-awaiting', 'true'));
      const signer = native ? NativeReown.sendTransaction : mockMutateAsync;
      if (stage === 'receipt') {
        await act(async () => receipt.reject(new Error('approval receipt failed')));
      } else {
        await act(async () => receipt.resolve(undefined));
        await act(async () => prompt.reject(new Error('second prompt rejected')));
      }
      await waitFor(() => expect(status).toHaveAttribute('data-awaiting', 'false'));
      expect(signer).toHaveBeenCalledTimes(stage === 'receipt' ? 1 : 2);
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
        'bridge-tx',
        'failed',
        stage === 'receipt'
          ? failedAt('approve_receipt', 'approval receipt failed')
          : failedAt('wallet_deposit', 'second prompt rejected')
      );
    }
  );

  it.each([false, true].flatMap(native => ['ETH', 'allowance'].map(route => [native, route] as const)))(
    'keeps a one-prompt route out of the wait (native=%s, route=%s)',
    async (native, route) => {
      mockNativeReown = native;
      answerAllowance(DEPOSIT);
      const prompt = deferred<string>();
      if (native) {
        jest.mocked(NativeReown.sendTransaction).mockImplementationOnce(async () => ({ hash: await prompt.promise }));
      } else {
        mockMutateAsync.mockReturnValueOnce(prompt.promise);
      }
      if (route === 'ETH') {
        render(depositScreen(undefined, EVM_WALLET));
        await reachReview();
        fireEvent.click(screen.getByTestId('confirm-deposit'));
      } else {
        await confirmSlowUsdcDeposit();
      }
      const status = await screen.findByTestId('deposit-status');
      expect(status).toHaveAttribute('data-awaiting', 'false');
      expect(native ? NativeReown.sendTransaction : mockMutateAsync).toHaveBeenCalledTimes(1);
      await act(async () => prompt.resolve('0xbridge'));
    }
  );

  it('does not deposit an Epoch USDC token from another chain through AggLayer', async () => {
    mockAgglayerChainId = 84532;
    render(depositScreen(undefined, EVM_WALLET));
    await reachSlowUsdcReview(false);
    expect(screen.queryByTestId('confirm-deposit')).not.toBeInTheDocument();
    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
    expect(readEvmErc20Allowance).not.toHaveBeenCalled();
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
  });

  it('reads the allowance the wallet gave the L1 bridge on the USDC, through the Sepolia RPC', async () => {
    answerAllowance(DEPOSIT);

    await confirmSlowUsdcDeposit();

    expect(readEvmErc20Allowance).toHaveBeenCalledTimes(1);
    expect(readEvmErc20Allowance).toHaveBeenCalledWith(USDC, EVM_WALLET, L1_BRIDGE, 11155111);
  });

  it.each([
    ['equal to the deposit', DEPOSIT],
    ['larger than the deposit', DEPOSIT * 2n]
  ])('sends no approval through wagmi when the allowance is %s', async (_name, allowance) => {
    answerAllowance(allowance);

    await confirmSlowUsdcDeposit();

    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 11155111, address: L1_BRIDGE, functionName: 'bridgeAsset', value: 0n })
    );
    // The one receipt is the deposit's.
    expect(waitForEvmReceipt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['zero', 0n],
    ['one unit short of the deposit', DEPOSIT - 1n]
  ])('approves the exact deposit through wagmi when the allowance is %s', async (_name, allowance) => {
    answerAllowance(allowance);

    await confirmSlowUsdcDeposit();

    expect(mockMutateAsync).toHaveBeenCalledTimes(2);
    expect(mockMutateAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chainId: 11155111,
        address: USDC,
        functionName: 'approve',
        args: [L1_BRIDGE, DEPOSIT]
      })
    );
    expect(mockMutateAsync).toHaveBeenNthCalledWith(2, expect.objectContaining({ functionName: 'bridgeAsset' }));
    expect(waitForEvmReceipt).toHaveBeenCalledTimes(2);
  });

  it('sends no approval through native Reown when the allowance covers the deposit', async () => {
    mockNativeReown = true;
    answerAllowance(DEPOSIT);

    await confirmSlowUsdcDeposit();

    expect(NativeReown.sendTransaction).toHaveBeenCalledTimes(1);
    expect(NativeReown.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 11155111, from: EVM_WALLET, to: L1_BRIDGE })
    );
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('approves the exact deposit through native Reown when the allowance is short', async () => {
    mockNativeReown = true;
    answerAllowance(DEPOSIT - 1n);

    await confirmSlowUsdcDeposit();

    expect(NativeReown.sendTransaction).toHaveBeenCalledTimes(2);
    // `approve(address,uint256)` on the USDC, for the bridge and the deposit amount.
    expect(NativeReown.sendTransaction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chainId: 11155111,
        from: EVM_WALLET,
        to: USDC,
        data: `0x095ea7b3${L1_BRIDGE.slice(2).padStart(64, '0')}${DEPOSIT.toString(16).padStart(64, '0')}`
      })
    );
    expect(NativeReown.sendTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ to: L1_BRIDGE }));
  });

  it('reads no allowance for a native ETH deposit', async () => {
    answerAllowance(0n);
    render(depositScreen(undefined, EVM_WALLET));

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(readEvmErc20Allowance).not.toHaveBeenCalled();
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'bridgeAsset' }));
  });

  it('sends nothing and fails the row when the allowance read fails', async () => {
    answerAllowance(null);

    await confirmSlowUsdcDeposit();

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_allowance', 'Could not check the USDC allowance the bridge has on Sepolia.')
    );
  });

  it.each([false, true])(
    'fails the row at the approval prompt when the wallet rejects it (native=%s)',
    async native => {
      mockNativeReown = native;
      answerAllowance(0n);
      if (native) jest.mocked(NativeReown.sendTransaction).mockRejectedValueOnce(new Error('approval rejected'));
      else mockMutateAsync.mockRejectedValueOnce(new Error('approval rejected'));

      await confirmSlowUsdcDeposit();

      const signer = native ? NativeReown.sendTransaction : mockMutateAsync;
      expect(signer).toHaveBeenCalledTimes(1);
      expect(signer).toHaveBeenCalledWith(expect.objectContaining(native ? { to: USDC } : { functionName: 'approve' }));
      expect(waitForEvmReceipt).not.toHaveBeenCalled();
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
        'bridge-tx',
        'failed',
        failedAt('wallet_approve', 'approval rejected')
      );
    }
  );

  // The web wallet is moved to the AggLayer chain before its first prompt, so a refused switch prompts for nothing.
  it('fails the row at the session chain when the web wallet refuses the switch', async () => {
    mockSwitchChainAsync.mockRejectedValueOnce(new Error('switch rejected'));
    render(depositScreen(undefined, EVM_WALLET));

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(mockSwitchChainAsync).toHaveBeenCalledWith({ chainId: 11155111 });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_session_chain', 'switch rejected')
    );
  });

  it.each([false, true])('fails the row at the deposit receipt when the deposit reverted (native=%s)', async native => {
    mockNativeReown = native;
    jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(new EvmTransactionRevertedError('Sepolia'));
    render(depositScreen(undefined, EVM_WALLET));

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'submitting', { evmTxHash: '0xhash' });
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt('deposit_receipt', 'The Sepolia transaction reverted')
    );
  });

  it.each(
    [false, true].flatMap(native =>
      [new Error('Receipt timeout'), new Error('RPC disconnected')].map(error => [native, error] as const)
    )
  )('keeps a signed deposit submitting when its receipt cannot be read (native=%s, %s)', async (native, error) => {
    mockNativeReown = native;
    jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(error);
    render(depositScreen(undefined, EVM_WALLET));

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith('bridge-tx', 'submitting', { evmTxHash: '0xhash' });
  });

  it.each([false, true])(
    'keeps a signed deposit submitting when its delivering write fails (native=%s)',
    async native => {
      mockNativeReown = native;
      jest
        .mocked(updateBridgedReceivePhase)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('storage unavailable'));
      render(depositScreen(undefined, EVM_WALLET));

      await reachReview();
      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'delivering', { evmTxHash: '0xhash' });
      expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());
      expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith('bridge-tx', 'submitting', { evmTxHash: '0xhash' });
    }
  );

  it('fails the row at the approval receipt before any deposit is sent', async () => {
    answerAllowance(0n);
    jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(new Error('approval receipt failed'));

    await confirmSlowUsdcDeposit();

    expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'submitting', expect.anything());
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt('approve_receipt', 'approval receipt failed')
    );
  });
});

// #1431: an approval never checks the balance, so a deposit above it failed only at the wallet's second prompt.
describe('EvmBridgeDepositScreen holds a deposit to the wallet balance', () => {
  const EVM_WALLET = '0x00000000000000000000000000000000000000e1';
  const L1_BRIDGE = '0x00000000000000000000000000000000000000b2';
  /** The typed 1.5, and the Slow USDC case's 10.6512, at the 18 decimals ETH and this suite's USDC share. */
  const TYPED = 1_500_000_000_000_000_000n;
  const SLOW_DEPOSIT = { USDC: 10_651_200_000_000_000_000n, ETH: TYPED };
  const LABEL = { USDC: 'Test Epoch USDC', ETH: 'ETH' };
  /** The Fast quote's `tokenIn`: what the wallet signs for, more than the 1.505 typed. */
  const FAST_DEPOSIT = 10_651_200_000_000_000_000n;
  const TOKENS = ['USDC', 'ETH'] as const;
  const SLOW_CASES = [false, true].flatMap(native => TOKENS.map(token => [native, token] as const));

  beforeEach(() => {
    jest.clearAllMocks();
    mockAvailability = {};
    mockAgglayerChainId = 11155111;
    mockSnapshot = READY_SNAPSHOT;
    mockTestNetwork = 'testnet';
    mockEvmUsdcSymbol = 'USDC';
    mockNativeReown = false;
    answerBalance(FUNDED);
    // A USDC amount is typed on the Fast route, which quotes it.
    Object.assign(epochState, { quoteEVMToMiden: jest.fn().mockResolvedValue(undefined) });
    jest.mocked(readEvmErc20Allowance).mockResolvedValue(0n);
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    mockMutateAsync.mockReset().mockResolvedValue('0xhash');
    jest.mocked(waitForEvmReceipt).mockReset().mockResolvedValue(undefined);
    jest.mocked(NativeReown.sendTransaction).mockReset().mockResolvedValue({ hash: '0xhash' });
  });

  afterEach(() => {
    Object.assign(epochState, idleEpoch);
    mockNativeReown = false;
    mockAgglayerUsdc = undefined;
  });

  const renderWallet = async () => {
    render(depositScreen(undefined, EVM_WALLET));
    await settle();
  };

  const typeAmount = async (token: (typeof TOKENS)[number]) => {
    if (token === 'ETH') {
      fireEvent.click(screen.getByTestId('open-token-drawer'));
      await settle();
      fireEvent.click(screen.getByTestId('pick-eth'));
      await settle();
    }
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
  };

  /** Continue leads to the route step only from an amount the form accepted. */
  const expectContinueHeld = async () => {
    expect(screen.getByTestId('form-ready')).toHaveTextContent(/^false$/);
    fireEvent.click(screen.getByTestId('continue'));
    await settle();
    expect(screen.queryByTestId('pick-slow')).not.toBeInTheDocument();
  };

  const reachSlowReviewWith = (token: (typeof TOKENS)[number]) =>
    token === 'ETH' ? reachReview() : reachSlowUsdcReview();

  const expectNoPrompt = () => {
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockSwitchChainAsync).not.toHaveBeenCalled();
    expect(readEvmErc20Allowance).not.toHaveBeenCalled();
    // Adding and switching the chain is a wallet prompt too, so the balance is checked first.
    expect(prepareNativeSessionChain).not.toHaveBeenCalled();
  };

  it.each(TOKENS)('holds Continue and says so for an amount above the %s balance', async token => {
    answerBalance(TYPED - 1n);
    await renderWallet();

    await typeAmount(token);

    expect(screen.getByTestId('form-error')).toHaveTextContent(/^amountMustBeLessThanBalance$/);
    await expectContinueHeld();
  });

  it('holds Continue while the USDC balance is still loading', async () => {
    global.fetch = jest.fn(() => new Promise(() => undefined)) as never;
    await renderWallet();

    await typeAmount('USDC');

    // A balance still on its way is no error.
    expect(screen.getByTestId('form-error')).toBeEmptyDOMElement();
    await expectContinueHeld();
  });

  it('holds Continue and shows the read error when the USDC balance cannot be read', async () => {
    answerBalance(null);
    await renderWallet();

    await typeAmount('USDC');

    expect(screen.getByTestId('form-error')).toHaveTextContent(/^rpc down$/);
    await expectContinueHeld();
  });

  it('shows the ETH read error, not a loading balance, once the loaded config names no AggLayer chain', async () => {
    mockAgglayerChainId = null;
    await renderWallet();

    await typeAmount('ETH');

    expect(screen.getByTestId('form-balance')).not.toHaveTextContent('loading');
    expect(screen.getByTestId('form-error')).toHaveTextContent(/^The bridge config names no AggLayer chain\.$/);
    await expectContinueHeld();
  });

  it("shows Circle's USDC read error, not a loading balance, once USDCx settles as unavailable", async () => {
    mockSnapshot = { ...READY_SNAPSHOT, status: 'loading' };
    mockAvailability = { usdcxDeposit: { state: 'loading' } };
    await renderWallet();
    act(() => mockLastTokenSelect('CIRCLE_USDC'));
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    expect(screen.getByTestId('form-balance')).toHaveTextContent(/^loading$/);

    mockAvailability = { usdcxDeposit: { state: 'unavailable', reason: 'not-configured', detail: 'no USDCx' } };
    act(() => publishSnapshot({ ...READY_SNAPSHOT }));
    await settle();

    expect(screen.getByTestId('form-balance')).not.toHaveTextContent('loading');
    expect(screen.getByTestId('form-error')).toHaveTextContent(/^The bridge config names no USDCx source\.$/);
    await expectContinueHeld();
  });

  it.each(TOKENS)('continues with an amount equal to the %s balance', async token => {
    answerBalance(TYPED);
    await renderWallet();

    await typeAmount(token);

    expect(screen.getByTestId('form-ready')).toHaveTextContent(/^true$/);
    expect(screen.getByTestId('form-error')).toBeEmptyDOMElement();
    fireEvent.click(screen.getByTestId('continue'));
    expect(await screen.findByTestId('pick-slow')).toBeInTheDocument();
  });

  it.each(SLOW_CASES)(
    'raises no prompt and fails the row with no answer when the balance falls under a Slow deposit before Confirm (native=%s, %s)',
    async (native, token) => {
      mockNativeReown = native;
      await renderWallet();
      await reachSlowReviewWith(token);
      answerBalance(SLOW_DEPOSIT[token] - 1n);

      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expectNoPrompt();
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
        'bridge-tx',
        'failed',
        failedAt(
          'precheck_balance',
          balanceTooLow(token === 'ETH' ? '1.4999' : '10.6511', LABEL[token]),
          'bridgeDepositBalanceTooLow'
        )
      );
      expect(reportedEvmError()).toBe('none');
    }
  );

  it.each(TOKENS)(
    'raises no prompt and fails the row when the %s balance cannot be re-read at Confirm',
    async token => {
      await renderWallet();
      await reachSlowReviewWith(token);
      answerBalance(null);

      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expectNoPrompt();
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
        'bridge-tx',
        'failed',
        failedAt(
          'precheck_balance',
          `bridgeDepositBalanceReadFailed ${JSON.stringify({ token: LABEL[token], network: 'Sepolia' })}`,
          'bridgeDepositBalanceReadFailed'
        )
      );
    }
  );

  it.each(SLOW_CASES)(
    'sends a Slow deposit equal to the balance to the L1 bridge (native=%s, %s)',
    async (native, token) => {
      mockNativeReown = native;
      answerBalance(SLOW_DEPOSIT[token]);
      await renderWallet();
      await reachSlowReviewWith(token);

      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      const signer = native ? NativeReown.sendTransaction : mockMutateAsync;
      const bridgeCall = native ? { to: L1_BRIDGE } : { functionName: 'bridgeAsset' };
      expect(signer).toHaveBeenLastCalledWith(expect.objectContaining(bridgeCall));
      expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());
    }
  );

  it('keeps the Fast route from Review while its quoted deposit is above the balance', async () => {
    quoteFast();
    // Covers the 1.505 typed, not the quote's 10.6512.
    answerBalance(FAST_DEPOSIT - 1n);
    await renderWallet();

    await reachFastReview(false);
    await settle();

    expect(screen.queryByTestId('confirm-deposit')).not.toBeInTheDocument();
  });

  // The Review's deposit rounds up and the balance rounds down, so the two figures never read as equal.
  const ABOVE_BALANCE = `fastQuoteAboveBalanceNotice ${JSON.stringify({
    deposit: '10.66',
    balance: '10.65',
    token: LABEL.USDC
  })}`;

  const reachFastRoute = async (amountButton = 'set-amount-padded') => {
    fireEvent.click(screen.getByTestId(amountButton));
    await settle();
    fireEvent.click(screen.getByTestId('continue'));
    await screen.findByTestId('confirm-route');
  };

  it('says why Confirm is held while the Fast deposit is above a balance the typed amount fits', async () => {
    quoteFast();
    answerBalance(FAST_DEPOSIT - 1n);
    await renderWallet();

    await reachFastRoute();

    expect(screen.getByTestId('route-notice').textContent).toBe(ABOVE_BALANCE);
    expect(screen.getByTestId('confirm-route')).toBeDisabled();
  });

  it('shows no balance notice for a Fast quote the balance covers', async () => {
    quoteFast();
    answerBalance(FAST_DEPOSIT);
    await renderWallet();

    await reachFastRoute();

    expect(screen.getByTestId('route-notice')).toBeEmptyDOMElement();
    expect(screen.getByTestId('confirm-route')).toBeEnabled();
  });

  it.each<[string, () => void, string]>([
    ['still loading', () => Object.assign(epochState, { status: 'quoting' }), 'set-amount-padded'],
    // 1.5 asks for 1500000 faucet units; the quote is for 1505000.
    ['for another amount', () => undefined, 'set-amount']
  ])('shows no balance notice for a Fast quote %s', async (_case, stale, amountButton) => {
    quoteFast();
    stale();
    answerBalance(FAST_DEPOSIT - 1n);
    await renderWallet();

    await reachFastRoute(amountButton);

    expect(screen.getByTestId('route-notice')).toBeEmptyDOMElement();
    expect(screen.getByTestId('confirm-route')).toBeDisabled();
  });

  it.each<[string, () => void, string]>([
    ['is pending', () => (global.fetch = jest.fn(() => new Promise(() => undefined)) as never), 'loading'],
    ['failed', () => answerBalance(null), 'rpc down']
  ])('says on the Fast route step why Confirm is held while the USDC balance read %s', async (_case, read, notice) => {
    quoteFast();
    answerBalance(FAST_DEPOSIT - 1n);
    const { rerender } = render(depositScreen(undefined, EVM_WALLET));
    await settle();
    await reachFastRoute();
    expect(screen.getByTestId('route-notice').textContent).toBe(ABOVE_BALANCE);

    // Another wallet, whose balance read has not landed or failed.
    read();
    rerender(depositScreen(undefined, '0x00000000000000000000000000000000000000e2'));
    await settle();

    expect(screen.getByTestId('route-notice').textContent).toBe(notice);
    expect(screen.getByTestId('confirm-route')).toBeDisabled();
  });

  // Picking ETH resets the store in the app; this one keeps the USDC quote, so both notices could apply.
  it('keeps the ETH notice on the Fast route over a quote above the USDC balance', async () => {
    quoteFast();
    answerBalance(FAST_DEPOSIT - 1n);
    await renderWallet();
    fireEvent.click(screen.getByTestId('open-token-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-eth'));
    await settle();

    await reachFastRoute();

    expect(screen.getByTestId('route-notice').textContent).toBe('fastEthWrapNotice');
    expect(screen.getByTestId('confirm-route')).toBeDisabled();
  });

  // The amount step read the Fast USDC; picking Slow moves to this one and reads it for the first time.
  const AGGLAYER_USDC = '0x00000000000000000000000000000000000000c2';
  /** Every read answers FUNDED but the AggLayer chain's USDC, which answers `balance` or, stalled, only its abort. */
  const answerAgglayerUsdc = (balance: bigint | 'stalled') => {
    mockAgglayerUsdc = AGGLAYER_USDC;
    global.fetch = jest.fn((_url: string, init?: { body?: string; signal?: AbortSignal }) => {
      const [call] = JSON.parse(String(init?.body)).params;
      if (call?.to !== AGGLAYER_USDC) return Promise.resolve({ json: async () => ({ result: word(FUNDED) }) });
      if (balance !== 'stalled') return Promise.resolve({ json: async () => ({ result: word(balance) }) });
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) signal.addEventListener('abort', () => reject(signal.reason));
      });
    }) as never;
  };

  const reachSlowRoute = async () => {
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    fireEvent.click(screen.getByTestId('continue'));
    await screen.findByTestId('pick-slow');
  };

  it('says why Confirm is held while the typed amount is above the Slow USDC balance', async () => {
    answerAgglayerUsdc(TYPED - 1n);
    await renderWallet();
    await reachSlowRoute();

    fireEvent.click(screen.getByTestId('pick-slow'));
    await settle();

    expect(screen.getByTestId('route-notice')).toHaveTextContent(/^amountMustBeLessThanBalance$/);
    expect(screen.getByTestId('confirm-route')).toBeDisabled();
  });

  it.each([false, true])(
    'starts no Fast deposit and fails the row with no answer when the balance falls under its quote before Confirm (native=%s)',
    async native => {
      mockNativeReown = native;
      quoteFast();
      await renderWallet();
      await reachFastReview();
      answerBalance(FAST_DEPOSIT - 1n);

      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expect(epochState.executeEVMToMiden).not.toHaveBeenCalled();
      expect(prepareNativeSessionChain).not.toHaveBeenCalled();
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
        'bridge-tx',
        'failed',
        failedAt('precheck_balance', balanceTooLow('10.6511', LABEL.USDC), 'bridgeDepositBalanceTooLow')
      );
      expect(reportedEvmError()).toBe('none');
    }
  );

  it('starts a Fast deposit whose quote equals the balance', async () => {
    quoteFast();
    answerBalance(FAST_DEPOSIT);
    await renderWallet();
    await reachFastReview();

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(epochState.executeEVMToMiden).toHaveBeenCalledWith('bridge-tx');
  });

  // Every request is accepted and never answered: a fetch settles only when its signal aborts, as a real one does.
  describe('over an RPC that never answers', () => {
    const READ_BOUND_MS = 15_000;
    const TIMED_OUT = `Request timed out after ${READ_BOUND_MS} ms`;

    const stallRpc = () => {
      global.fetch = jest.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) signal.addEventListener('abort', () => reject(signal.reason));
          })
      ) as never;
    };
    const advance = (ms: number) =>
      act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });

    // Circle's USDC is offered only where the config names a USDCx deposit route; the Fast pair stays as it was.
    const offerCircleUsdc = () => {
      mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
      const config = READY_SNAPSHOT.config;
      mockSnapshot = {
        ...READY_SNAPSHOT,
        config: config && {
          ...config,
          supportedEvmChains: { ...TEST_BRIDGE_CONFIG.supportedEvmChains, ...config.supportedEvmChains }
        }
      };
    };

    afterEach(() => {
      jest.useRealTimers();
      mockBridgeSnapshot = undefined;
    });

    it.each<{ token: string; setup: () => void; pick: DepositToken | null; reads: number }>([
      { token: 'ETH', setup: () => undefined, pick: 'ETH', reads: 1 },
      { token: "Circle's USDC", setup: offerCircleUsdc, pick: 'CIRCLE_USDC', reads: 1 },
      // Its getBalance, then the balanceOf it falls back to.
      { token: "the bridge's USDC", setup: () => undefined, pick: null, reads: 2 }
    ])(
      'shows $token as loading, then its read error, and holds Continue throughout',
      async ({ setup, pick, reads }) => {
        jest.useFakeTimers();
        stallRpc();
        setup();
        render(depositScreen(undefined, EVM_WALLET));
        await advance(0);
        if (pick) act(() => mockLastTokenSelect(pick));
        fireEvent.click(screen.getByTestId('set-amount'));
        await advance(0);

        const expectHeld = async () => {
          expect(screen.getByTestId('form-ready')).toHaveTextContent(/^false$/);
          fireEvent.click(screen.getByTestId('continue'));
          await advance(0);
          expect(screen.queryByTestId('confirm-route')).not.toBeInTheDocument();
          expect(screen.queryByTestId('usdcx-confirm-route')).not.toBeInTheDocument();
        };
        expect(screen.getByTestId('form-balance')).toHaveTextContent(/^loading$/);
        expect(screen.getByTestId('form-error')).toBeEmptyDOMElement();
        await expectHeld();

        await advance(reads * READ_BOUND_MS - 1);
        expect(screen.getByTestId('form-balance')).toHaveTextContent(/^loading$/);
        expect(screen.getByTestId('form-error')).toBeEmptyDOMElement();

        await advance(1);
        expect(screen.getByTestId('form-error')).toHaveTextContent(TIMED_OUT);
        expect(screen.getByTestId('form-balance')).not.toHaveTextContent('loading');
        await expectHeld();
      }
    );

    it.each<{ route: string; token: 'USDC' | 'ETH'; setup: () => void; reach: () => Promise<void>; reads: number }>([
      { route: 'Fast', token: 'USDC' as const, setup: quoteFast, reach: () => reachFastReview(), reads: 2 },
      { route: 'Slow', token: 'ETH' as const, setup: () => undefined, reach: () => reachReview(), reads: 1 },
      { route: 'Slow', token: 'USDC' as const, setup: () => undefined, reach: () => reachSlowUsdcReview(), reads: 2 }
    ])(
      'fails a $route $token row with the RPC timeout once the re-read at Confirm times out, and opens no prompt',
      async ({ token, setup, reach, reads }) => {
        setup();
        await renderWallet();
        await reach();
        jest.useFakeTimers();
        stallRpc();

        fireEvent.click(screen.getByTestId('confirm-deposit'));
        await advance(reads * READ_BOUND_MS - 1);
        expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());

        await advance(1);
        expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
          'bridge-tx',
          'failed',
          failedAt(
            'precheck_balance',
            `bridgeDepositBalanceReadFailed ${JSON.stringify({ token: LABEL[token], network: 'Sepolia' })}`,
            'bridgeDepositBalanceReadFailed'
          )
        );
        expect(reportedEvmError()).toBe('timeout');
        expectNoPrompt();
        expect(epochState.executeEVMToMiden).not.toHaveBeenCalled();
      }
    );

    it('says on the Slow route step that its USDC balance is loading, then its read error, and holds Confirm', async () => {
      answerAgglayerUsdc('stalled');
      await renderWallet();
      await reachSlowRoute();
      jest.useFakeTimers();

      fireEvent.click(screen.getByTestId('pick-slow'));
      await advance(0);

      const expectHeldSaying = (notice: RegExp | string) => {
        expect(screen.getByTestId('route-notice')).toHaveTextContent(notice);
        expect(screen.getByTestId('confirm-route')).toBeDisabled();
      };
      expectHeldSaying(/^loading$/);
      // Its getBalance times out, then the balanceOf it falls back to.
      await advance(READ_BOUND_MS);
      expectHeldSaying(/^loading$/);
      await advance(READ_BOUND_MS - 1);
      expectHeldSaying(/^loading$/);

      await advance(1);
      expectHeldSaying(new RegExp(`^${TIMED_OUT}$`));
    });
  });
});

describe('EvmBridgeDepositScreen native session chain', () => {
  const EVM_WALLET = '0x00000000000000000000000000000000000000e1';
  const SEPOLIA = 11155111;
  const BASE_SEPOLIA = 84532;

  /** The native session did not approve Sepolia, and the add-and-switch attempt did not change that. */
  const refuseSepolia = () =>
    jest
      .mocked(prepareNativeSessionChain)
      .mockRejectedValueOnce(new NativeSessionChainNotApprovedError(SEPOLIA, 'Sepolia'));
  const chainNotApproved = (network: string) => `evmChainNotApproved ${JSON.stringify({ network })}`;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAvailability = {};
    mockAgglayerChainId = SEPOLIA;
    mockSnapshot = READY_SNAPSHOT;
    mockNativeReown = true;
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    jest.mocked(readEvmErc20Allowance).mockResolvedValue(0n);
    jest.mocked(NativeReown.sendTransaction).mockResolvedValue({ hash: '0xhash' });
    answerBalance(FUNDED);
  });

  afterEach(() => {
    Object.assign(epochState, idleEpoch);
    mockNativeReown = false;
  });

  it('fails a Slow ETH deposit with the reconnect message and opens no wallet prompt', async () => {
    refuseSepolia();
    render(depositScreen(undefined, EVM_WALLET));

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(prepareNativeSessionChain).toHaveBeenCalledWith(SEPOLIA);
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_session_chain', chainNotApproved('Sepolia'), 'evmChainNotApproved')
    );
    expect(await screen.findByTestId('deposit-status')).toBeInTheDocument();
  });

  it('fails a Slow USDC deposit with the reconnect message before the approval prompt', async () => {
    refuseSepolia();
    render(depositScreen(undefined, EVM_WALLET));

    await reachSlowUsdcReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(readEvmErc20Allowance).not.toHaveBeenCalled();
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_session_chain', chainNotApproved('Sepolia'), 'evmChainNotApproved')
    );
  });

  it('fails a Fast deposit with the reconnect message and never starts the Epoch SDK', async () => {
    refuseSepolia();
    quoteFast();
    render(depositScreen(undefined, EVM_WALLET));

    await reachFastReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(prepareNativeSessionChain).toHaveBeenCalledWith(SEPOLIA);
    expect(epochState.executeEVMToMiden).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_session_chain', chainNotApproved('Sepolia'), 'evmChainNotApproved')
    );
    expect(await screen.findByTestId('deposit-status')).toBeInTheDocument();
  });

  it('starts the Fast deposit once the session approved Sepolia', async () => {
    quoteFast();
    render(depositScreen(undefined, EVM_WALLET));

    await reachFastReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(prepareNativeSessionChain).toHaveBeenCalledWith(SEPOLIA);
    expect(epochState.executeEVMToMiden).toHaveBeenCalledWith('bridge-tx');
    expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());
  });

  // The remote config names each route's chain, so the check follows it rather than Sepolia.
  it('checks the AggLayer chain the config names before a Slow deposit', async () => {
    mockAgglayerChainId = BASE_SEPOLIA;
    jest
      .mocked(prepareNativeSessionChain)
      .mockRejectedValueOnce(new NativeSessionChainNotApprovedError(BASE_SEPOLIA, 'Base Sepolia'));
    render(depositScreen(undefined, EVM_WALLET));

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(prepareNativeSessionChain).toHaveBeenCalledWith(BASE_SEPOLIA);
    expect(NativeReown.sendTransaction).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_session_chain', chainNotApproved('Base Sepolia'), 'evmChainNotApproved')
    );
  });

  it('checks the chain the config names for the Fast USDC before a Fast deposit', async () => {
    mockSnapshot = { ...READY_SNAPSHOT, config: updateMockConfig(READY_SNAPSHOT.config!, { chainId: BASE_SEPOLIA }) };
    quoteFast();
    render(depositScreen(undefined, EVM_WALLET));

    await reachFastReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(prepareNativeSessionChain).toHaveBeenCalledWith(BASE_SEPOLIA);
    expect(epochState.executeEVMToMiden).toHaveBeenCalledWith('bridge-tx');
  });
});

describe('EvmBridgeDepositScreen names the network', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    answerBalance(FUNDED);
  });

  // The shell's banner names the network on every step of this flow, review included (the
  // registry in NetworkModeBanner.registry.test.ts points here).
  it('shows the banner on amount entry, route choice and review', async () => {
    renderScreen();

    expect(screen.getByTestId('set-amount')).toBeInTheDocument();
    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('open-token-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-eth'));
    await settle();
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    fireEvent.click(screen.getByTestId('continue'));
    await settle();

    expect(await screen.findByTestId('pick-slow')).toBeInTheDocument();
    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pick-slow'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-route'));
    await settle();

    expect(await screen.findByTestId('confirm-deposit')).toBeInTheDocument();
    expect(screen.getByTestId('network-mode-banner')).toBeInTheDocument();
  });
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string, diagnostics?: unknown) => {
  const expected = diagnostics === undefined ? [[id, surface]] : [[id, surface, diagnostics]];
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual(expected);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual(expected);
};

let mockRealBridgeDisplays = false;
let mockLiveBridgeRow: ITransaction | undefined;
const mockLiveBridgeListeners = new Set<() => void>();
jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: () => {
    const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
    const row = useSyncExternalStore(
      (listener: () => void) => {
        mockLiveBridgeListeners.add(listener);
        return () => {
          mockLiveBridgeListeners.delete(listener);
        };
      },
      () => mockLiveBridgeRow
    );
    return { row, loaded: true };
  }
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'synthetic-native' }));
let mockTokenPrices: TokenPrices = {};
// The symbols whose USD market the feed has not yet ruled out at both providers.
const mockPendingUsdMarkets = new Set<string>();
jest.mock('lib/prices/feed', () => ({
  ...jest.requireActual<typeof import('lib/prices/feed')>('lib/prices/feed'),
  usdMarketPending: (symbol: string | undefined) => symbol !== undefined && mockPendingUsdMarkets.has(symbol)
}));
// The price symbol each delivery faucet is quoted under; any other faucet has none.
const mockPriceSymbols = new Map<string, string>();
jest.mock('lib/miden/swap/tokens', () => ({
  ...jest.requireActual<typeof import('lib/miden/swap/tokens')>('lib/miden/swap/tokens'),
  priceSymbolFor: (faucetId: string) => mockPriceSymbols.get(faucetId)
}));
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(selector: (state: { assetsMetadata: Record<string, never>; tokenPrices: TokenPrices }) => T) =>
    selector({ assetsMetadata: {}, tokenPrices: mockTokenPrices })
}));
jest.mock('./UsdcxDepositSteps', () => ({ UsdcxDepositSteps: () => null }));
jest.mock('./UsdcxExecuteAction', () => ({ UsdcxExecuteAction: () => null }));
jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({ useHideNavbarWhileOpen: jest.fn() }));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));

const publishLiveBridgeRow = (row: ITransaction) => {
  mockLiveBridgeRow = row;
  mockLiveBridgeListeners.forEach(listener => listener());
};
const observeBridgeWrites = () => {
  jest.mocked(initiateBridgedReceiveTransaction).mockImplementation(async input => {
    publishLiveBridgeRow({
      id: 'bridge-tx',
      type: 'bridged-receive',
      accountId: input.accountId,
      amount: input.amount,
      faucetId: input.faucetId,
      status: ITransactionStatus.Queued,
      initiatedAt: 1,
      displayMessage: 'Bridging in',
      displayIcon: 'DEFAULT',
      extraInputs: { ...input, phase: 'submitting' }
    });
    return 'bridge-tx';
  });
  jest.mocked(updateBridgedReceivePhase).mockImplementation(async (_id, phase, update) => {
    if (mockLiveBridgeRow)
      publishLiveBridgeRow({
        ...mockLiveBridgeRow,
        extraInputs: { ...mockLiveBridgeRow.extraInputs, ...update, phase }
      });
  });
};
const flushBridgePromises = () =>
  act(async () => {
    for (let tick = 0; tick < 40; tick++) await Promise.resolve();
  });

describe('user-visible bridge deposit producers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealBridgeDisplays = true;
    mockBalanceEncodingFailure = false;
    mockLiveBridgeRow = undefined;
    mockAvailability = {};
    mockAgglayerChainId = 11155111;
    mockSnapshot = READY_SNAPSHOT;
    mockNativeReown = false;
    mockWebProviderConnected = true;
    Object.assign(epochState, idleEpoch);
    answerBalance(FUNDED);
    jest.mocked(initiateBridgedReceiveTransaction).mockReset().mockResolvedValue('bridge-tx');
    jest.mocked(updateBridgedReceivePhase).mockReset().mockResolvedValue(undefined);
    jest.mocked(readEvmErc20Allowance).mockResolvedValue(0n);
  });
  afterEach(() => {
    jest.useRealTimers();
    mockRealBridgeDisplays = false;
    mockBalanceEncodingFailure = false;
    mockBridgeInCapUsd = null;
    mockTokenPrices = {};
    mockPendingUsdMarkets.clear();
    mockPriceSymbols.clear();
    mockDepositTokens = [];
    mockTokenApiUrl = undefined;
    mockHeldErc20s = [];
    mockLiveBridgeRow = undefined;
    Object.assign(epochState, idleEpoch);
    mockNativeReown = false;
    mockWebProviderConnected = true;
    jest.mocked(initiateBridgedReceiveTransaction).mockReset().mockResolvedValue('bridge-tx');
    jest.mocked(updateBridgedReceivePhase).mockReset().mockResolvedValue(undefined);
  });
  const realSlowReview = async () => {
    renderScreen();
    await settle();
    fireEvent.click(screen.getByTestId('send-token-selector'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-eth'));
    await settle();
    fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '1.5' } });
    await settle();
    fireEvent.click(screen.getByTestId('send-amount-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-slow'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-route'));
    await settle();
    expect(screen.getByTestId('bridge-deposit-review-confirm')).toBeInTheDocument();
  };

  it('reports a real tracking-row creation failure on the review surface', async () => {
    jest
      .mocked(initiateBridgedReceiveTransaction)
      .mockRejectedValueOnce(new Error('private row 42 https://synthetic.invalid/0xabc'));
    await realSlowReview();
    jest.useFakeTimers();
    fireEvent.click(screen.getByTestId('bridge-deposit-review-confirm'));
    await flushBridgePromises();
    expect(screen.getByText('private row 42 https://synthetic.invalid/0xabc')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_deposit_submit_failed', 'review');
  });

  const typeEthAmount = async () => {
    renderScreen();
    await settle();
    fireEvent.click(screen.getByTestId('send-token-selector'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-eth'));
    await settle();
    jest.useFakeTimers();
    fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '1.5' } });
    await flushBridgePromises();
  };
  // Review is reached under no ceiling; one that lands while it is open holds Confirm there.
  const ceilingOnReview = async () => {
    await realSlowReview();
    jest.useFakeTimers();
    mockBridgeInCapUsd = 1;
    act(() => publishSnapshot({ ...mockSnapshot }));
    await flushBridgePromises();
  };
  const ethQuote = { ETH: { price: 2000, change24h: 0, percentageChange24h: 0 } };

  it('reports a ceiling the typed deposit passes by its own copy on the amount field', async () => {
    mockTokenPrices = ethQuote;
    mockBridgeInCapUsd = 1;
    await typeEthAmount();
    expect(screen.getByText(/^bridgeDepositBalanceCapExceeded /)).toBeInTheDocument();
    await expectErrorAfterDwell('bridgeDepositBalanceCapExceeded', 'field');
  });

  it('reports a ceiling the deposit passes by its own copy on the review', async () => {
    mockTokenPrices = ethQuote;
    await ceilingOnReview();
    expect(screen.getByText(/^bridgeDepositBalanceCapExceeded /)).toBeInTheDocument();
    await expectErrorAfterDwell('bridgeDepositBalanceCapExceeded', 'review');
  });

  it('reports an unpriced deposit token under a ceiling by its own copy on the amount field', async () => {
    mockBridgeInCapUsd = 1;
    await typeEthAmount();
    expect(screen.getByText(/^bridgeDepositBalanceCapUnpriced /)).toBeInTheDocument();
    await expectErrorAfterDwell('bridgeDepositBalanceCapUnpriced', 'field');
  });

  it('reports an unpriced deposit token under a ceiling by its own copy on the review', async () => {
    await ceilingOnReview();
    expect(screen.getByText(/^bridgeDepositBalanceCapUnpriced /)).toBeInTheDocument();
    await expectErrorAfterDwell('bridgeDepositBalanceCapUnpriced', 'review');
  });

  it('holds an ETH deposit with no quote yet under a ceiling without calling it unpriced', async () => {
    mockPendingUsdMarkets.add('ETH');
    mockBridgeInCapUsd = 1;
    await typeEthAmount();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    expect(screen.queryByText(/^bridgeDepositBalanceCap/)).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  // An ERC-20 is weighed at its own quote, under the price symbol of the faucet that delivers it, not at par.
  const WBTC_FAUCET = '0x00000000000000000000000000f1f1';
  const WBTC_LISTING: AgglayerDepositToken = {
    symbol: 'WBTC',
    contractAddress: '0x00000000000000000000000000000000000000d1',
    decimals: 8,
    midenFaucetId: WBTC_FAUCET,
    scale: 2
  };
  const typeErc20Amount = async () => {
    renderScreen();
    await settle();
    act(() => mockLastTokenSelect({ kind: 'erc20', contractAddress: WBTC_LISTING.contractAddress }));
    await settle();
    jest.useFakeTimers();
    fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '1.5' } });
    await flushBridgePromises();
  };

  it('holds an ERC-20 deposit its own quote takes past the ceiling, though it would clear at par', async () => {
    mockPriceSymbols.set(WBTC_FAUCET, 'BTC');
    mockTokenPrices = { BTC: { price: 60000, change24h: 0, percentageChange24h: 0 } };
    mockBridgeInCapUsd = 100;
    mockDepositTokens = [WBTC_LISTING];
    await typeErc20Amount();
    expect(screen.getByText(/^bridgeDepositBalanceCapExceeded /)).toBeInTheDocument();
    await expectErrorAfterDwell('bridgeDepositBalanceCapExceeded', 'field');
  });

  it('holds an ERC-20 deposit whose market the feed has ruled out as unpriced', async () => {
    mockPriceSymbols.set(WBTC_FAUCET, 'BTC');
    mockBridgeInCapUsd = 100;
    mockDepositTokens = [WBTC_LISTING];
    await typeErc20Amount();
    expect(screen.getByText(/^bridgeDepositBalanceCapUnpriced /)).toBeInTheDocument();
    await expectErrorAfterDwell('bridgeDepositBalanceCapUnpriced', 'field');
  });

  // A test network offers a held token the registry has no faucet for yet: there is no price symbol to quote it by.
  it('holds an ERC-20 deposit with no delivery faucet as unpriced, though its own symbol is quoted', async () => {
    mockTokenApiUrl = 'https://tokens.test';
    mockHeldErc20s = [{ contractAddress: WBTC_LISTING.contractAddress, symbol: 'WBTC', decimals: 8, value: FUNDED }];
    mockPendingUsdMarkets.add('WBTC');
    mockTokenPrices = { WBTC: { price: 1, change24h: 0, percentageChange24h: 0 } };
    mockBridgeInCapUsd = 100;
    await typeErc20Amount();
    expect(screen.getByText(/^bridgeDepositBalanceCapUnpriced /)).toBeInTheDocument();
    await expectErrorAfterDwell('bridgeDepositBalanceCapUnpriced', 'field');
  });

  it('holds an ERC-20 deposit whose quote is still on its way without calling it unpriced', async () => {
    mockPriceSymbols.set(WBTC_FAUCET, 'BTC');
    mockPendingUsdMarkets.add('BTC');
    mockBridgeInCapUsd = 100;
    mockDepositTokens = [WBTC_LISTING];
    await typeErc20Amount();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    expect(screen.queryByText(/^bridgeDepositBalanceCap/)).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  const typeUsdcAmount = async (cap: number) => {
    mockBridgeInCapUsd = cap;
    Object.assign(epochState, { quoteEVMToMiden: jest.fn().mockResolvedValue(undefined) });
    renderScreen();
    await settle();
    jest.useFakeTimers();
    fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '1.5' } });
    await flushBridgePromises();
    expect(screen.getByTestId('send-amount-input')).toHaveValue('1.5');
  };

  it('weighs a USDC deposit at par with no quote: a $2 ceiling clears 1.5 USDC', async () => {
    await typeUsdcAmount(2);
    expect(screen.queryByText(/^bridgeDepositBalanceCap/)).not.toBeInTheDocument();
  });

  it('weighs a USDC deposit at par with no quote: a $1 ceiling holds 1.5 USDC', async () => {
    await typeUsdcAmount(1);
    expect(screen.getByText(/^bridgeDepositBalanceCapExceeded /)).toBeInTheDocument();
  });

  it('reports the actual balance-read failure through the real amount field', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({ error: { message: 'private balance 42 https://synthetic.invalid/0xabc' } })
    });
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    expect(screen.getByText('private balance 42 https://synthetic.invalid/0xabc')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'fast_usdc',
      bridgeBalanceStage: 'rpc_rejected'
    });
  });

  const failedBalanceReads: [string, () => void][] = [
    [
      'request',
      () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('synthetic transport failure'));
      }
    ],
    [
      'response_decode',
      () => {
        global.fetch = jest.fn().mockResolvedValue({
          json: async () => {
            throw new SyntaxError('synthetic JSON failure');
          }
        });
      }
    ],
    [
      'value_decode',
      () => {
        global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ result: 'not hex data' }) });
      }
    ]
  ];

  it.each(failedBalanceReads)('reports the final Fast USDC %s failure at the real field', async (stage, setup) => {
    setup();
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'fast_usdc',
      bridgeBalanceStage: stage
    });
    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
  });

  it('records local balance input validation without claiming an RPC failure', async () => {
    jest.useFakeTimers();
    render(depositScreen(undefined, 'synthetic-invalid-address'));
    await flushBridgePromises();
    expect(screen.getByText(/^Invalid EVM address:/)).toBeInTheDocument();
    const methods = jest.mocked(global.fetch).mock.calls.map(([, init]) => {
      const payload: { method?: string } = JSON.parse(String(init?.body ?? '{}'));
      return payload.method;
    });
    expect(methods).not.toContain('eth_call');
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'fast_usdc',
      bridgeBalanceStage: 'input_validation'
    });
  });

  it('records a balance encoding exception before the request is issued', async () => {
    mockBalanceEncodingFailure = true;
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    expect(screen.getByText('synthetic balance encoding failure')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'fast_usdc',
      bridgeBalanceStage: 'request_build'
    });
  });

  it('records ABI decoding after a hex response without calling it a transport failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ result: '0x' }) });
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'fast_usdc',
      bridgeBalanceStage: 'value_decode'
    });
  });

  it('records native numeric decoding on the selected native balance', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ result: 'not a number' }) });
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    act(() => mockLastTokenSelect('ETH'));
    await flushBridgePromises();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'native',
      bridgeBalanceStage: 'value_decode'
    });
  });

  const answerFastFallback = (finalResult: unknown) => {
    let reads = 0;
    const contract = TEST_EVM_USDC.address;
    global.fetch = jest.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      const payload: { method?: unknown; params?: unknown[] } = JSON.parse(String(init?.body ?? '{}'));
      const call = payload.params?.[0];
      if (
        payload.method === 'eth_call' &&
        typeof call === 'object' &&
        call !== null &&
        'to' in call &&
        call.to === contract &&
        'data' in call &&
        typeof call.data === 'string'
      ) {
        reads++;
        const reply = call.data.startsWith('0x70a08231')
          ? { result: finalResult }
          : { error: { message: 'synthetic first read rejected' } };
        return Promise.resolve({ json: async () => reply });
      }
      return Promise.resolve({ json: async () => ({ result: word(FUNDED) }) });
    });
    return () => reads;
  };

  it('reports the final fallback decoding failure rather than the first rejected RPC', async () => {
    const reads = answerFastFallback('not hex data');
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    expect(reads()).toBe(2);
    expect(screen.getByText('USDC balanceOf returned no data')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'fast_usdc',
      bridgeBalanceStage: 'value_decode'
    });
  });

  it('reports the final fallback timeout at its request stage without changing the read bound', async () => {
    global.fetch = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        })
    ) as never;
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText('Request timed out after 15000 ms')).toBeInTheDocument();
    expect(screen.getByTestId('send-amount-confirm')).toBeDisabled();
    const balanceReads = jest.mocked(global.fetch).mock.calls.filter(([, init]) => {
      const payload: { method?: string } = JSON.parse(String(init?.body ?? '{}'));
      return payload.method === 'eth_call';
    });
    expect(balanceReads).toHaveLength(2);
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'fast_usdc',
      bridgeBalanceStage: 'request'
    });
    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
  });

  it('keeps a successful balanceOf fallback quiet after getBalance fails', async () => {
    const reads = answerFastFallback(word(FUNDED));
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    expect(reads()).toBe(2);
    expect(screen.getByTestId('send-token-selector')).toHaveTextContent('available');
    expect(screen.queryByText('synthetic first read rejected')).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
  });

  it('records a missing native balance configuration without inventing a request', async () => {
    mockAgglayerChainId = null;
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    act(() => mockLastTokenSelect('ETH'));
    await flushBridgePromises();
    expect(screen.getByText('The bridge config names no AggLayer chain.')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'native',
      bridgeBalanceStage: 'configuration'
    });
  });

  it('records a removed Circle source as configuration rather than a completed read', async () => {
    mockSnapshot = { ...READY_SNAPSHOT, status: 'loading' };
    mockAvailability = { usdcxDeposit: { state: 'loading' } };
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    act(() => mockLastTokenSelect('CIRCLE_USDC'));
    await flushBridgePromises();
    mockAvailability = { usdcxDeposit: { state: 'unavailable', reason: 'not-configured', detail: 'no USDCx' } };
    act(() => publishSnapshot({ ...READY_SNAPSHOT }));
    await flushBridgePromises();
    expect(screen.getByText('The bridge config names no USDCx source.')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'circle_usdc',
      bridgeBalanceStage: 'configuration'
    });
  });

  it('keeps a registered-token read failure attached to the selected row', async () => {
    mockDepositTokens = [WBTC_LISTING];
    const answer = global.fetch;
    global.fetch = jest.fn(async (...args: Parameters<typeof fetch>) => {
      const payload: { params?: { to?: string }[] } = JSON.parse(String(args[1]?.body ?? '{}'));
      if (payload.params?.[0]?.to === WBTC_LISTING.contractAddress) {
        throw new Error('synthetic registered token read failure');
      }
      return answer(...args);
    });
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    act(() => mockLastTokenSelect({ kind: 'erc20', contractAddress: WBTC_LISTING.contractAddress }));
    await flushBridgePromises();
    expect(screen.getByText('synthetic registered token read failure')).toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'registered_erc20',
      bridgeBalanceStage: 'request'
    });
    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
  });

  it('does not borrow a sibling registered-token decoding stage for a rejected request', async () => {
    const sibling: AgglayerDepositToken = {
      ...WBTC_LISTING,
      symbol: 'OTHER',
      contractAddress: '0x00000000000000000000000000000000000000d2',
      midenFaucetId: '0x00000000000000000000000000f1f2'
    };
    mockDepositTokens = [WBTC_LISTING, sibling];
    const answer = global.fetch;
    global.fetch = jest.fn().mockImplementation((...args: Parameters<typeof fetch>) => {
      const payload: { params?: { to?: string }[] } = JSON.parse(String(args[1]?.body ?? '{}'));
      if (payload.params?.[0]?.to === WBTC_LISTING.contractAddress) {
        return Promise.reject(new Error('synthetic selected request rejected'));
      }
      if (payload.params?.[0]?.to === sibling.contractAddress) {
        return Promise.resolve({
          json: async () => {
            throw new SyntaxError('synthetic sibling JSON failure');
          }
        });
      }
      return answer(...args);
    });
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    act(() => mockLastTokenSelect({ kind: 'erc20', contractAddress: WBTC_LISTING.contractAddress }));
    await flushBridgePromises();
    expect(screen.getByText('synthetic selected request rejected')).toBeInTheDocument();
    expect(screen.queryByText('synthetic sibling JSON failure')).not.toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_balance_failed', 'field', {
      kind: 'bridge_balance_read',
      bridgeBalanceBranch: 'registered_erc20',
      bridgeBalanceStage: 'request'
    });
  });

  it('does not attach a hidden balance failure to an action error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('synthetic hidden balance failure'));
    Object.assign(epochState, {
      status: 'failed',
      flow: 'evm-to-miden',
      error: 'synthetic displayed action failure'
    });
    jest.useFakeTimers();
    renderScreen();
    await flushBridgePromises();
    expect(screen.getByText('synthetic displayed action failure')).toBeInTheDocument();
    expect(screen.queryByText('synthetic hidden balance failure')).not.toBeInTheDocument();
    await expectErrorAfterDwell('raw_bridge_deposit_failed', 'field');
  });

  it('clears an amount failure when another connected account starts a pending read', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ json: async () => ({ error: { message: 'old account balance failed' } }) });
    jest.useFakeTimers();
    const view = renderScreen();
    await flushBridgePromises();
    expect(screen.getByText('old account balance failed')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    global.fetch = jest.fn(() => new Promise<Response>(() => undefined));
    view.rerender(depositScreen(undefined, '0x00000000000000000000000000000000000000e1'));
    await flushBridgePromises();
    expect(screen.queryByText('old account balance failed')).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it('keeps a successful row creation and the pending deposit quiet', async () => {
    observeBridgeWrites();
    mockMutateAsync.mockImplementation(() => new Promise(() => undefined));
    await realSlowReview();
    jest.useFakeTimers();
    fireEvent.click(screen.getByTestId('bridge-deposit-review-confirm'));
    await flushBridgePromises();
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await flushBridgePromises();
    expect(screen.getByText('bridgeDepositProcessing')).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });
});

describe('EvmBridgeDepositScreen Slow-route ERC-20 deposit', () => {
  const EVM_WALLET = '0x00000000000000000000000000000000000000e1';
  const L1_BRIDGE = '0x00000000000000000000000000000000000000b2';
  const WBTC = '0x00000000000000000000000000000000000000d1';
  const WBTC_LISTING: AgglayerDepositToken = {
    symbol: 'WBTC',
    contractAddress: WBTC,
    decimals: 8,
    midenFaucetId: '0x00000000000000000000000000f1f1',
    scale: 2
  };
  /** The typed 1.5 at the token's own 8 decimals. */
  const DEPOSIT = 150_000_000n;
  const DECIMALS_SELECTOR = '0x313ce567';

  /** Every balance read answers FUNDED, and the token's `decimals()` answers `decimals`. */
  const answerRpc = (decimals: bigint) => {
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body));
      const data: unknown = params?.[0]?.data;
      const value = typeof data === 'string' && data.startsWith(DECIMALS_SELECTOR) ? decimals : FUNDED;
      return { json: async () => ({ result: word(value) }) };
    }) as never;
  };

  const confirmErc20Deposit = async () => {
    render(depositScreen(undefined, EVM_WALLET));
    await settle();
    fireEvent.click(screen.getByTestId('open-token-drawer'));
    await settle();
    act(() => mockLastTokenSelect({ kind: 'erc20', contractAddress: WBTC }));
    await settle();
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    fireEvent.click(screen.getByTestId('continue'));
    await settle();
    fireEvent.click(await screen.findByTestId('confirm-route'));
    fireEvent.click(await screen.findByTestId('confirm-deposit'));
    await settle();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAvailability = {};
    mockAgglayerChainId = 11155111;
    mockSnapshot = READY_SNAPSHOT;
    mockNativeReown = false;
    mockDepositTokens = [WBTC_LISTING];
    answerRpc(8n);
    jest.mocked(readEvmErc20Allowance).mockResolvedValue(0n);
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    mockMutateAsync.mockReset().mockResolvedValue('0xhash');
    jest.mocked(waitForEvmReceipt).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.assign(epochState, idleEpoch);
    mockDepositTokens = [];
  });

  it('approves and bridges a listed ERC-20 at its own decimals and saves its delivery faucet', async () => {
    await confirmErc20Deposit();

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ address: WBTC, functionName: 'approve', args: [L1_BRIDGE, DEPOSIT] })
    );
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        address: L1_BRIDGE,
        functionName: 'bridgeAsset',
        args: [77, '0x00000000000000000000000000000000000000a1', DEPOSIT, WBTC, true, '0x']
      })
    );
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'agglayer',
        sourceSymbol: 'WBTC',
        agglayerDelivery: { originToken: WBTC, faucetId: WBTC_LISTING.midenFaucetId, scale: 2 }
      })
    );
  });

  const BALANCE_OF_SELECTOR = '0x70a08231';
  /** The balanceOf reads the screen sent, by token contract. */
  const balanceReads = (contract?: string) =>
    jest.mocked(global.fetch).mock.calls.filter(([, init]) => {
      const { params } = JSON.parse(String((init as RequestInit).body));
      const call = params?.[0];
      return (
        typeof call?.data === 'string' &&
        call.data.startsWith(BALANCE_OF_SELECTOR) &&
        (contract === undefined || call.to === contract)
      );
    }).length;

  // A publish rebuilds the listed token array from the same document: the set is unchanged, so nothing is read again.
  it('reads each ERC-20 balance once across a publish that lists the same tokens', async () => {
    render(depositScreen(undefined, EVM_WALLET));
    await settle();
    expect(balanceReads(WBTC)).toBe(1);

    act(() => publishSnapshot({ ...mockSnapshot, lastFetch: { at: 1, ok: true } }));
    await settle();

    expect(balanceReads(WBTC)).toBe(1);
  });

  const tokenAddress = (index: number): `0x${string}` => `0x${(0xd1 + index).toString(16).padStart(40, '0')}`;

  it('keeps at most four ERC-20 balance reads in flight', async () => {
    mockDepositTokens = Array.from({ length: 6 }, (_, index) => ({
      ...WBTC_LISTING,
      symbol: `T${index}`,
      contractAddress: tokenAddress(index)
    }));
    global.fetch = jest.fn(() => new Promise<Response>(() => undefined)) as never;
    render(depositScreen(undefined, EVM_WALLET));
    await settle();

    expect(balanceReads()).toBe(4);
  });

  // The decimals a token was offered at may be an indexer's: the contract's own decide what 1.5 means, so a token
  // whose contract reports others is refused before any prompt.
  it('refuses an ERC-20 whose contract reports other decimals than it was offered at', async () => {
    answerRpc(18n);

    await confirmErc20Deposit();

    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      expect.objectContaining({ failure: expect.objectContaining({ step: 'precheck_route' }) })
    );
  });
});
