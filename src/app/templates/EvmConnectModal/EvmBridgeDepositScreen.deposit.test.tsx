import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ReportDeposit } from 'app/hooks/useFundTelemetry';
import {
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_EVM_CHAIN_ID,
  TEST_EVM_USDC,
  TEST_MIDEN_USDC_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import type { BridgeFeature, FeatureAvailability } from 'lib/remote-config/availability';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { NativeReown, NativeSessionChainNotApprovedError, prepareNativeSessionChain } from 'lib/walletconnect/native';
import { readEvmErc20Allowance, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

// Covers the deposit submission (the tap that turns a quoted/valid amount into a
// tracked bridge transfer, and the reporter the hosting page wraps it with) and
// the network banner the shell renders over the committing steps. Every
// collaborator beyond the step components is stubbed - this suite is not a test
// of the bridge itself.

// The key, then any values it names, so a case can read which balance, token and network a message was given.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)
  })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKitProvider: () => ({ walletProvider: { request: jest.fn() } })
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
let mockAgglayerChainId = 11155111;
jest.mock('lib/remote-config/values', () => ({
  selectAgglayerRecoveryConfig: () => ({
    chainId: mockAgglayerChainId,
    contractAddress: '0x00000000000000000000000000000000000000b2',
    midenBridgeId: '0x3b66e20b5088f25133b69216484652',
    indexerUrl: 'https://indexer.test',
    rollupId: 77,
    evmNetworkId: 0
  }),
  selectAgglayerChain: () => ({
    chainId: mockAgglayerChainId,
    bridges: {
      agglayer: {
        contractAddress: '0x00000000000000000000000000000000000000b2',
        midenBridgeId: '0x3b66e20b5088f25133b69216484652'
      }
    }
  }),
  selectEvmUsdc: ({ config }: MockSnapshot) =>
    config
      ? {
          address: config.supportedEvmChains.source.bridges.epoch.tokens.USDC.contractAddress,
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
  getAgglayerDeposit: () => ({ l1Bridge: '0x00000000000000000000000000000000000000b2', rollupId: 77 })
}));

jest.mock('use-debounce', () => ({
  useDebounce: (value: unknown) => [value]
}));

const epochState = {
  status: 'idle',
  flow: null,
  quote: null,
  error: null,
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
let mockLastTokenSelect: (token: string) => void = () => undefined;
let mockLastConnectAnother: () => void = () => undefined;

// Step components stubbed down to the affordances the deposit path needs.
jest.mock('./EvmBridgeDepositForm', () => ({
  EvmBridgeDepositForm: ({
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
    tokenLabel: string;
    arrivingName: string;
    amount: string;
    isValidAmount: boolean;
    error?: string;
    onAmountChange: (value?: string) => void;
    onContinue: () => void;
    onSelectToken: () => void;
    onSwitch: () => void;
  }) => {
    mockLastOpenTokenDrawer = onSelectToken;
    return (
      <div>
        <span data-testid="form-ready">{String(isValidAmount)}</span>
        <span data-testid="form-error">{error}</span>
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
}));

/** The Review's latest Confirm handler: a tap can land on Review while the Navigator is leaving it. */
let mockLastReviewConfirm: () => unknown = () => undefined;
// The real `arrivingTokenName`, so the amount step names the arriving token by the rule the Review renders with.
jest.mock('./EvmBridgeDepositReview', () => ({
  ...jest.requireActual<typeof import('./EvmBridgeDepositReview')>('./EvmBridgeDepositReview'),
  EvmBridgeDepositReview: ({
    amount,
    fiat,
    outputAmount,
    label,
    onConfirm
  }: {
    amount: string;
    fiat?: number;
    outputAmount?: string;
    label?: string;
    onConfirm: () => void;
  }) => {
    mockLastReviewConfirm = onConfirm;
    return (
      <div>
        <span data-testid="review-label">{label}</span>
        <span data-testid="review-amount">{amount}</span>
        <span data-testid="review-fiat">{fiat}</span>
        <span data-testid="review-output">{outputAmount}</span>
        <button data-testid="confirm-deposit" onClick={onConfirm}>
          confirm
        </button>
      </div>
    );
  }
}));

jest.mock('./EvmBridgeDepositStatus', () => ({
  EvmBridgeDepositStatus: ({ awaitingNextConfirmation }: { awaitingNextConfirmation?: boolean }) => (
    <div data-testid="deposit-status" data-awaiting={String(Boolean(awaitingNextConfirmation))} />
  )
}));

// This realm's bridge config, for anything under the screen that reads it: the real, unloaded one, or the loaded testnet
// one a case sets. The screen's own labels read the screen's snapshot above, so a label case sets both alike.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);

jest.mock('./EvmBridgeTokenDrawer', () => ({
  EvmBridgeTokenDrawer: ({
    open,
    onSelect,
    usdcBalance,
    usdcLabel,
    usdcLoading
  }: {
    open: boolean;
    onSelect: (token: string) => void;
    usdcBalance: string;
    usdcLabel: string;
    usdcLoading: boolean;
  }) => {
    mockLastTokenSelect = onSelect;
    return (
      <div>
        <span data-testid="usdc-label">{usdcLabel}</span>
        <span data-testid="usdc-balance">{usdcLoading ? 'loading' : usdcBalance}</span>
        {open ? (
          <button data-testid="pick-eth" onClick={() => onSelect('ETH')}>
            ETH
          </button>
        ) : null}
      </div>
    );
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
  Route: ({ onRouteChange, onConfirm }: { onRouteChange: (route: string) => void; onConfirm: () => void }) => (
    <div>
      <button data-testid="pick-slow" onClick={() => onRouteChange('agglayer')}>
        slow
      </button>
      <button data-testid="confirm-route" onClick={onConfirm}>
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
const quoteFast = () =>
  Object.assign(epochState, {
    quoteEVMToMiden: jest.fn().mockResolvedValue(undefined),
    status: 'quoted',
    flow: 'evm-to-miden',
    quote: {
      params: { minTokenOut: '1505000' },
      quoteResult: { tokenIn: '10651200000000000000', tokenOut: '10000000' }
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

  it('names the USDC row USDC while no bridge config is loaded', () => {
    mockSnapshot = { status: 'loading', config: null, lastFetch: null };
    renderScreen();

    expect(screen.getByTestId('usdc-label')).toHaveTextContent(/^USDC$/);
  });

  it('names the USDC row by the testnet label once the config names the token', () => {
    mockSnapshot = TESTNET_SNAPSHOT;
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderScreen();

    expect(screen.getByTestId('usdc-label')).toHaveTextContent('Test Epoch USDC');
  });

  it('names the configured USDC by the testnet label on the Review', async () => {
    mockSnapshot = TESTNET_SNAPSHOT;
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    renderScreen();

    await reachSlowUsdcReview();

    expect(await screen.findByTestId('review-label')).toHaveTextContent('Test Epoch USDC');
  });

  // Off testnet no label applies, so the drawer row must carry the symbol the token read gave, as the Review does.
  it('names the USDC on the drawer row as the Review does, off testnet too', async () => {
    mockTestNetwork = 'devnet';
    mockEvmUsdcSymbol = 'USDC.e';
    renderScreen();

    await reachSlowUsdcReview();

    expect(await screen.findByTestId('review-label')).toHaveTextContent(/^USDC\.e$/);
    expect(screen.getByTestId('usdc-label')).toHaveTextContent(/^USDC\.e$/);
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

  it('prices the Fast-route deposit on the Review at the rounded-up figure it shows', async () => {
    quoteFast();
    renderScreen();

    await reachFastReview();

    expect(await screen.findByTestId('review-amount')).toHaveTextContent(/^10\.66$/);
    expect(screen.getByTestId('review-fiat')).toHaveTextContent(/^10\.66$/);
  });

  it('prices a Slow-route USDC deposit on the Review at the typed amount it shows', async () => {
    renderScreen();

    await reachSlowUsdcReview();

    expect(await screen.findByTestId('review-amount')).toHaveTextContent(/^10\.6512$/);
    expect(screen.getByTestId('review-fiat')).toHaveTextContent(/^10\.6512$/);
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
    expect(screen.getByTestId('usdc-balance')).not.toHaveTextContent('loading');
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

    expect(screen.getByTestId('usdc-balance')).toHaveTextContent('loading');
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
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
        error: stage === 'receipt' ? 'approval receipt failed' : 'second prompt rejected'
      });
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
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
      error: 'Could not check the USDC allowance the bridge has on Sepolia.'
    });
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
    'raises no prompt and fails the row when the balance falls under a Slow deposit before Confirm (native=%s, %s)',
    async (native, token) => {
      mockNativeReown = native;
      await renderWallet();
      await reachSlowReviewWith(token);
      answerBalance(SLOW_DEPOSIT[token] - 1n);

      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expectNoPrompt();
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
        error: balanceTooLow(token === 'ETH' ? '1.4999' : '10.6511', LABEL[token])
      });
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
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
        error: `bridgeDepositBalanceReadFailed ${JSON.stringify({ token: LABEL[token], network: 'Sepolia' })}`
      });
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

  it.each([false, true])(
    'starts no Fast deposit and fails the row when the balance falls under its quote before Confirm (native=%s)',
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
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
        error: balanceTooLow('10.6511', LABEL.USDC)
      });
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
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
      error: chainNotApproved('Sepolia')
    });
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
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
      error: chainNotApproved('Sepolia')
    });
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
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
      error: chainNotApproved('Sepolia')
    });
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
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
      error: chainNotApproved('Base Sepolia')
    });
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
