import React from 'react';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Dexie from 'dexie';
import { decodeFunctionData, getAddress } from 'viem';

import { AGGLAYER_BRIDGE_ABI } from 'lib/agglayer';
import type { BatchCall } from 'lib/evm-relay/batch';
import { RelayApiError, RelayRevertedError, RelayUnknownOutcomeError } from 'lib/evm-relay/errors';
import type { PendingRelayDeposit } from 'lib/evm-relay/pending-deposit';
import type { RelaySource } from 'lib/evm-relay/source';
import type { RelaySubmitOptions } from 'lib/evm-relay/submit';
import type { RelayJobRef } from 'lib/evm-relay/types';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import type { IBridgedReceiveExtraInputs, IBridgedReceivePhase, ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import type { WalletAccount } from 'lib/shared/types';
import { ERC20_APPROVE_ABI } from 'lib/usdcx/constant';
import { readEvmErc20Allowance, waitForEvmReceipt } from 'lib/walletconnect/receipt';
import { WalletType } from 'screens/onboarding/types';

import { legacyBridgeReceiveFixture } from './bridge-receive-test-fixture';
import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

const CHAIN_ID = 11155111;
const RELAY = '0x00000000000000000000000000000000000000e5';
const RELAY_SOURCE: RelaySource = { accountPublicKey: 'mtst1account', address: RELAY };
const USDC = '0x00000000000000000000000000000000000000c0';
const L1_BRIDGE = '0x00000000000000000000000000000000000000b2';
const NATIVE = '0x0000000000000000000000000000000000000000';
const MINED = `0x${'12'.repeat(32)}`;
const JOB: RelayJobRef = { chainId: CHAIN_ID, id: `0x${'ab'.repeat(32)}`, deadline: 1_900_000_000 };
/** 1.5 ETH. */
const ETH_DEPOSIT = 1_500_000_000_000_000_000n;
/** 1.505 USDC at the 18 decimals the suite gives the configured USDC. */
const USDC_DEPOSIT = 1_505_000_000_000_000_000n;
/** The Fast quote's deposit for 1.505 USDC out: 1.5065 at 18 decimals. */
const QUOTED_IN = 1_506_500_000_000_000_000n;
const FUNDED = 10n ** 30n;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)
  }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, string> }) => (
    <>{`${i18nKey} ${JSON.stringify(values)}`}</>
  )
}));
jest.mock('@reown/appkit/react', () => ({ useAppKitProvider: () => ({ walletProvider: undefined }) }));
jest.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: jest.fn() }),
  useWriteContract: () => ({ mutateAsync: jest.fn() })
}));

const SNAPSHOT = {
  status: 'ready',
  config: {
    network: 'testnet',
    'bridge-providers': { epoch: { allocatorUrl: 'https://allocator.test' } },
    supportedEvmChains: {
      source: { chainId: CHAIN_ID, bridges: { agglayer: { depositEnabled: true }, epoch: { depositEnabled: true } } }
    }
  },
  lastFetch: null
};
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => SNAPSHOT,
  useFeatureAvailability: () => ({ state: 'available' })
}));
jest.mock('lib/remote-config/values', () => {
  const chainId = 11155111;
  const usdc = '0x00000000000000000000000000000000000000c0';
  return {
    selectNativeEthFaucet: () => undefined,
    selectAgglayerRecoveryConfig: () => ({
      chainId,
      contractAddress: '0x00000000000000000000000000000000000000b2',
      midenBridgeId: '0x3b66e20b5088f25133b69216484652',
      indexerUrl: 'https://indexer.test',
      rollupId: 77,
      evmNetworkId: 0
    }),
    selectAgglayerChain: (_snapshot: unknown, wanted?: number) =>
      wanted === undefined || wanted === chainId
        ? { chainId, bridges: { agglayer: { contractAddress: '0x00000000000000000000000000000000000000b2' } } }
        : null,
    selectEvmUsdc: () => ({ address: usdc, symbol: 'USDC', decimals: 18, chainId }),
    selectEpochDepositTokens: (_snapshot: unknown, wanted: number) =>
      wanted === chainId
        ? [
            {
              key: 'USDC',
              address: usdc,
              chainId,
              symbol: 'USDC',
              decimals: 18,
              midenFaucetId: 'usdc-faucet',
              midenSymbol: 'USDC',
              midenDecimals: 6
            }
          ]
        : [],
    selectAgglayerDepositTokens: () => [],
    selectAgglayerRegistryToken: () => null,
    selectBridgeInMaxBalanceUsd: () => null
  };
});
jest.mock('lib/remote-config/token-labels', () => ({
  ...jest.requireActual('lib/remote-config/token-labels'),
  evmUsdcLabel: (_snapshot: unknown, symbol: string) => symbol
}));
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
jest.mock('lib/agglayer/token-holdings', () => ({ readErc20Holdings: async () => [] }));
jest.mock('lib/epoch/bridge-in-lock-scan', () => ({
  compactLockId: () => 42n,
  readCompactLockConfig: jest.fn().mockResolvedValue({
    allocator: '0x0000000000000000000000000000000000000003',
    resetPeriod: 2,
    scope: 0
  }),
  readCompactLockState: jest.fn().mockResolvedValue({ withdrawal: { status: 'Disabled' } })
}));
jest.mock('lib/epoch/bridge-in-recovery', () => ({
  LockedDepositError: class extends Error {},
  cancelLockWithdrawal: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('use-debounce', () => ({ useDebounce: (value: unknown) => [value] }));
// The phone layout unless a case takes the extension one.
let mockExtension = false;
jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  // Modules read it on load, before this suite's variables exist.
  isExtension: () => {
    try {
      return mockExtension;
    } catch {
      return false;
    }
  }
}));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'native-faucet' }));

// The cap verdict a case sets: clear unless a case moves it.
let mockCapVerdict: { state: string; capUsd?: number; heldUsd?: number; depositUsd?: number } = {
  state: 'clear',
  capUsd: 1000,
  heldUsd: 0,
  depositUsd: 1
};
jest.mock('./bridge-in-balance-cap', () => ({
  depositTokenPrice: () => ({ priceUsd: 1, pending: false }),
  useBridgeInBalanceCap: () => mockCapVerdict
}));

// Each change to a mock that a hook reads re-renders its readers.
const mockListeners = new Set<() => void>();
let mockVersion = 0;
const mockBump = () => {
  mockVersion += 1;
  mockListeners.forEach(listener => listener());
};
// Called only from the mocked hooks below, on every render of their readers. The `mock` prefix lets the hoisted
// module factories reach it.
const mockUseVersion = () => {
  const react = jest.requireActual<typeof import('react')>('react');
  return react.useSyncExternalStore(
    (listener: () => void) => {
      mockListeners.add(listener);
      return () => {
        mockListeners.delete(listener);
      };
    },
    () => mockVersion
  );
};

interface MockEpochState {
  status: string;
  flow: string | null;
  quote: { params: { minTokenOut: string }; quoteResult: { tokenIn: string; tokenOut: string } } | null;
  error: string | null;
  compactWatchClosed: boolean;
  quoteEVMToMiden: jest.Mock;
  executeEVMToMiden: jest.Mock;
  poll: jest.Mock;
  reset: jest.Mock;
}
const mockEpochState: MockEpochState = {
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
jest.mock('lib/epoch', () => ({
  MIDEN_DESTINATION_CHAIN_ID: 1,
  evmToMidenMinTokenOut:
    jest.requireActual<typeof import('lib/epoch/bridge')>('lib/epoch/bridge').evmToMidenMinTokenOut,
  useEpochStore: Object.assign(
    (selector: (s: MockEpochState) => unknown) => {
      mockUseVersion();
      return selector(mockEpochState);
    },
    { getState: () => mockEpochState }
  )
}));
/** Every quote is a new object for 1.505 USDC out, with a deposit of `tokenIn`. */
const quoteWith = (tokenIn: bigint) => {
  mockEpochState.quoteEVMToMiden.mockImplementation(async () => {
    Object.assign(mockEpochState, {
      status: 'quoted',
      flow: 'evm-to-miden',
      quote: { params: { minTokenOut: '1505000' }, quoteResult: { tokenIn: tokenIn.toString(), tokenOut: '1505000' } }
    });
    mockBump();
  });
};

jest.mock('lib/miden/activity', () => ({
  initiateBridgedReceiveTransaction: jest.fn(),
  updateBridgedReceivePhase: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticSelection: jest.fn(),
  hapticSuccess: jest.fn()
}));
let mockBackHandler: () => boolean = () => false;
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean) => {
    mockBackHandler = handler;
  }
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));
jest.mock('components/NetworkModeSheet', () => ({ NetworkModeSheet: () => null }));
jest.mock('lib/walletconnect/fees', () => ({ readNativeFeeFields: async () => ({}) }));
jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => true,
  NativeReown: { sendTransaction: jest.fn() },
  NativeSessionChainNotApprovedError: class extends Error {},
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

const mockRelaySendCalls = jest.fn<Promise<string>, [BatchCall[], RelaySubmitOptions]>();
const mockBuildRelayProvider = jest.fn((_source: RelaySource, _chainId: number, hooks: RelaySubmitOptions = {}) => ({
  sendCalls: (calls: BatchCall[]) => mockRelaySendCalls(calls, hooks)
}));
jest.mock('lib/evm-relay/source', () => ({
  relayServesChain: (chainId: number) => chainId === 11155111,
  buildRelayProvider: (source: RelaySource, chainId: number, hooks?: RelaySubmitOptions) =>
    mockBuildRelayProvider(source, chainId, hooks),
  findRelaySource: () => null,
  relaySourceOf: () => null
}));

// The relay's view of the address: the balance of the deposit's token and the gas mode.
let mockRelayBalance: bigint | null = null;
let mockRelayMode: 'sponsor' | 'deduct' = 'sponsor';
const setRelayBalance = (balance: bigint | null) =>
  act(async () => {
    mockRelayBalance = balance;
    mockBump();
  });
jest.mock('lib/evm-relay/use-deposit-arrival', () => {
  const actual = jest.requireActual<typeof import('lib/evm-relay/use-deposit-arrival')>(
    'lib/evm-relay/use-deposit-arrival'
  );
  return {
    depositArrivalOf: actual.depositArrivalOf,
    useDepositArrival: (deposit: PendingRelayDeposit | null) => {
      mockUseVersion();
      if (deposit === null) {
        return { state: 'waiting', balance: null, needsAuthorization: null, mode: null, error: undefined };
      }
      return {
        ...actual.depositArrivalOf(mockRelayBalance, BigInt(deposit.amountBaseUnits)),
        needsAuthorization: false,
        mode: mockRelayMode,
        error: undefined
      };
    }
  };
});
jest.mock('lib/evm-relay/use-relay-account', () => ({
  useRelayAccount: ({ chainId }: { chainId: number | null }) => {
    mockUseVersion();
    return { account: chainId === null ? undefined : { mode: mockRelayMode }, error: undefined, isLoading: false };
  }
}));

// The pending deposits of the account, in memory; the claim takes one out as the storage one does.
let mockPending: PendingRelayDeposit[] = [];
let mockNextId = 0;
jest.mock('lib/evm-relay/pending-deposit', () => ({
  createPendingRelayDepositId: () => {
    mockNextId += 1;
    return `pending-${mockNextId}`;
  },
  savePendingRelayDeposit: jest.fn(async (deposit: PendingRelayDeposit) => {
    mockPending = [deposit, ...mockPending.filter(entry => entry.id !== deposit.id)];
  }),
  removePendingRelayDeposit: jest.fn(async (_account: string, id: string) => {
    mockPending = mockPending.filter(entry => entry.id !== id);
  }),
  readPendingRelayDeposits: async () => mockPending
}));
jest.mock('./relay-deposit-record', () => ({
  ...jest.requireActual('./relay-deposit-record'),
  claimPendingRelayDeposit: jest.fn(async (_account: string, id: string) => {
    const claimed = mockPending.find(entry => entry.id === id) ?? null;
    mockPending = mockPending.filter(entry => entry.id !== id);
    return claimed;
  })
}));

// The tracked row, as `useTransactionRow` and the open-job read see it.
let mockRow: ITransaction | undefined;
const setRow = (phase: IBridgedReceivePhase, extra: Partial<IBridgedReceiveExtraInputs> = {}) =>
  act(async () => {
    const args = jest.mocked(initiateBridgedReceiveTransaction).mock.calls.at(-1)?.[0];
    if (!args) throw new Error('no row was created');
    const row = legacyBridgeReceiveFixture(args, 'bridge-tx');
    Object.assign(row.extraInputs, { phase, ...extra });
    mockRow = row;
    mockBump();
  });
jest.mock('screens/generating-transaction/useTransactionRow', () => ({
  useTransactionRow: (txId: string) => {
    mockUseVersion();
    return { row: mockRow?.id === txId ? mockRow : undefined, loaded: true };
  }
}));
jest.mock('lib/dexie-live-query', () => ({
  subscribeToLiveQuery: (_query: unknown, observer: { next: (row: ITransaction | undefined) => void }) => {
    const listener = () => observer.next(mockRow);
    listener();
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  }
}));

jest.mock('components/TokenLogo', () => ({
  TokenLogo: ({ faucetId }: { faucetId: string | undefined }) => <span data-testid={`logo-${faucetId}`} />
}));
jest.mock('components/NetworkChip', () => ({
  NetworkLogo: ({ network }: { network?: string }) => <span data-testid={`network-${network}`} />
}));
jest.mock('components/QRCode', () => ({
  QRCode: ({ address }: { address: string }) => <span data-testid="qr" data-value={address} />
}));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
/** Every RPC balance read answers `balance`. */
const answerBalance = (balance: bigint) => {
  global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ result: word(balance) }) });
};

const midenAccount: WalletAccount = {
  publicKey: 'mtst1account',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.OnChain,
  hdIndex: 0,
  authScheme: 'falcon'
};

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const onConnectAnother = jest.fn();
const onClose = jest.fn();
const onExit = jest.fn();
const relayScreen = (pendingDepositId?: string) => (
  <EvmBridgeDepositScreen
    evmAddress={RELAY}
    relaySource={RELAY_SOURCE}
    midenAccount={midenAccount}
    onConnectAnother={onConnectAnother}
    onClose={onClose}
    onExit={onExit}
    pendingDepositId={pendingDepositId}
  />
);
const renderRelay = async (pendingDepositId?: string) => {
  const view = render(relayScreen(pendingDepositId));
  await settle();
  return view;
};

const typeAmount = async (value: string) => {
  fireEvent.change(screen.getByTestId('deposit-amount-input'), { target: { value } });
  await settle();
};
const pickUsdc = async () => {
  fireEvent.click(screen.getByTestId('deposit-token-selector'));
  fireEvent.click(screen.getByTestId(`deposit-token-${CHAIN_ID}:EPOCH_USDC`));
  await settle();
};
const toAddress = async () => {
  fireEvent.click(screen.getByTestId('deposit-amount-review'));
  await settle();
  fireEvent.keyDown(screen.getByTestId('deposit-review-slide-knob'), { key: 'Enter' });
  await settle();
};
const sentCalls = (): BatchCall[] => mockRelaySendCalls.mock.calls[0]?.[0] ?? [];
const failedWrites = () => jest.mocked(updateBridgedReceivePhase).mock.calls.filter(([, phase]) => phase === 'failed');
const relayAnswers = (outcome: () => Promise<string>, events: string[] = []) =>
  mockRelaySendCalls.mockImplementation(async (_calls, hooks) => {
    await hooks.beforeSign?.();
    await hooks.onJob?.(JOB);
    events.push('post');
    return outcome();
  });

/** A stored deposit of 1.5 ETH on Agglayer, as the slide saves it. */
const storedEthDeposit = (id = 'stored-1'): PendingRelayDeposit => ({
  id,
  accountPublicKey: 'mtst1account',
  address: RELAY,
  chainId: CHAIN_ID,
  route: 'agglayer',
  token: { address: NATIVE, symbol: 'ETH', decimals: 18 },
  amount: '1.5',
  amountBaseUnits: ETH_DEPOSIT.toString(),
  outputAmount: '1.5',
  outputSymbol: 'ETH',
  createdAt: 1,
  form: { tokenKind: 'ETH', tokenId: '', chainId: String(CHAIN_ID), route: 'agglayer', amount: '1.5' }
});

let restoreLookup: () => void = () => undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockPending = [];
  mockNextId = 0;
  mockRow = undefined;
  mockRelayBalance = null;
  mockRelayMode = 'sponsor';
  mockExtension = false;
  mockCapVerdict = { state: 'clear', capUsd: 1000, heldUsd: 0, depositUsd: 1 };
  Object.assign(mockEpochState, { status: 'idle', flow: null, quote: null, error: null });
  quoteWith(QUOTED_IN);
  answerBalance(FUNDED);
  jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
  jest.mocked(readEvmErc20Allowance).mockResolvedValue(0n);
  jest.mocked(waitForEvmReceipt).mockResolvedValue(undefined);
  relayAnswers(async () => MINED);
  const get = Repo.transactions.get.bind(Repo.transactions);
  const lookup = jest.spyOn(Repo.transactions, 'get').mockImplementation(key => {
    const args = jest.mocked(initiateBridgedReceiveTransaction).mock.calls.at(-1)?.[0];
    if (typeof key === 'string' && key === 'bridge-tx' && args)
      return Dexie.Promise.resolve(legacyBridgeReceiveFixture(args, key));
    return get(key);
  });
  restoreLookup = () => lookup.mockRestore();
});
afterEach(() => {
  restoreLookup();
  cleanup();
});

describe('EvmBridgeDepositScreen from a relay source: amount, review and address', () => {
  it('opens on the amount step with the relay token and its receipt', async () => {
    await renderRelay();

    expect(screen.getByRole('heading', { name: 'depositFlowTitle' })).toBeInTheDocument();
    expect(screen.getByTestId('deposit-token-selector')).toHaveAccessibleName(
      'depositFlowTokenOnNetworkChange {"token":"ETH","network":"Sepolia"}'
    );
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('none');
    expect(screen.getByTestId('deposit-receipt-route')).toHaveTextContent('depositFlowRouteAgglayer');
    expect(screen.queryByTestId('deposit-route-change')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-receipt-arrival')).toHaveTextContent('depositFlowArrivesAgglayer');
    expect(screen.getByTestId('deposit-receipt-gas')).toHaveTextContent('depositFlowPaidByBread');
    expect(screen.getByTestId('deposit-amount-review')).toBeDisabled();
    await typeAmount('1.5');
    expect(screen.getByTestId('deposit-receipt-total-amount')).toHaveTextContent('1.5 ETH');
    expect(screen.getByTestId('deposit-amount-review')).toBeEnabled();
  });

  it('holds Review and shows the cap notice over the cap', async () => {
    mockCapVerdict = { state: 'exceeded', capUsd: 1232, heldUsd: 1300, depositUsd: 2 };
    await renderRelay();
    await typeAmount('1.5');

    expect(screen.getByTestId('deposit-cap-notice')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-amount-review')).toBeDisabled();
  });

  it('saves the pending deposit on the slide and shows the address', async () => {
    await renderRelay();
    await typeAmount('1.5');
    await toAddress();

    expect(mockPending).toEqual([
      expect.objectContaining({
        id: 'pending-1',
        address: RELAY,
        chainId: CHAIN_ID,
        route: 'agglayer',
        token: { address: NATIVE, symbol: 'ETH', decimals: 18 },
        amount: '1.5',
        amountBaseUnits: ETH_DEPOSIT.toString(),
        outputAmount: '1.5',
        form: { tokenKind: 'ETH', tokenId: '', chainId: String(CHAIN_ID), route: 'agglayer', amount: '1.5' }
      })
    ]);
    expect(screen.getByRole('heading', { name: 'depositFlowDetailsTitle' })).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-lines')).toHaveTextContent(getAddress(RELAY));
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('1.5');
    expect(screen.getByTestId('deposit-address-waiting')).toHaveTextContent('depositFlowWaitingTitle');
    // Sepolia has no wallet link mapping, so Open wallet is not offered.
    expect(screen.queryByTestId('deposit-address-open-wallet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('deposit-address-qr'));
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', getAddress(RELAY));
  });

  it('opens on a stored deposit with its form state', async () => {
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');

    expect(screen.getByTestId('deposit-address-mobile')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('1.5');
    fireEvent.click(screen.getByTestId('page-back'));
    await settle();
    expect(screen.getByRole('heading', { name: 'depositFlowReviewTitle' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('page-close'));
    await settle();
    expect(screen.getByTestId('deposit-amount-input')).toHaveValue('1.5');
  });

  it('shows the extension address with the QR card and the token title', async () => {
    mockExtension = true;
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');

    expect(screen.getByRole('heading', { name: 'depositFlowDepositTokenTitle {"token":"ETH"}' })).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-extension')).toBeInTheDocument();
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', getAddress(RELAY));
  });

  it('opens on the amount step for an unknown deposit', async () => {
    await renderRelay('missing');

    expect(screen.getByTestId('deposit-amount-input')).toHaveValue('');
    expect(screen.queryByTestId('deposit-address-mobile')).not.toBeInTheDocument();
  });

  it('removes the deposit on Back and keeps it on Close', async () => {
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    fireEvent.click(screen.getByTestId('page-close'));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(mockPending).toHaveLength(1);

    fireEvent.click(screen.getByTestId('page-back'));
    await settle();
    expect(mockPending).toEqual([]);
    expect(screen.getByTestId('deposit-review-slide-knob')).toBeInTheDocument();
  });

  it('goes back one step on the hardware back', async () => {
    await renderRelay();
    await typeAmount('1.5');
    fireEvent.click(screen.getByTestId('deposit-amount-review'));
    await settle();

    act(() => {
      mockBackHandler();
    });
    await settle();
    expect(screen.getByTestId('deposit-amount-input')).toBeInTheDocument();
    act(() => {
      mockBackHandler();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a partial deposit and reviews what arrived', async () => {
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(500_000_000_000_000_000n);

    expect(screen.getByTestId('deposit-address-partial')).toHaveTextContent(
      'depositFlowPartialTitle {"received":"0.5 ETH","expected":"1.5 ETH"}'
    );
    fireEvent.click(screen.getByTestId('deposit-address-partial-action'));
    await settle();
    expect(mockPending).toEqual([]);
    expect(screen.getByTestId('deposit-review-send')).toHaveTextContent('"amount":"0.5 ETH"');
    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
  });

  it('sends a relay in deduct mode to the connect-wallet path', async () => {
    mockRelayMode = 'deduct';
    await renderRelay();

    expect(onConnectAnother).toHaveBeenCalled();
  });
});

describe('EvmBridgeDepositScreen from a relay source: the start of the bridge', () => {
  it('starts once when the funds arrive, removes the deposit and follows the row', async () => {
    mockPending = [storedEthDeposit()];
    const view = await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'agglayer', sourceAddress: RELAY })
    );
    expect(mockPending).toEqual([]);
    expect(screen.getByTestId('deposit-processing')).toBeInTheDocument();
    await setRelayBalance(FUNDED);
    view.rerender(relayScreen('stored-1'));
    await settle();
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
    expect(mockRelaySendCalls).toHaveBeenCalledTimes(1);
  });

  it('does not start again on a remount or on a second open page', async () => {
    mockPending = [storedEthDeposit()];
    mockRelayBalance = ETH_DEPOSIT;
    const first = render(relayScreen('stored-1'));
    const second = render(relayScreen('stored-1'));
    await settle();
    await settle();

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
    first.unmount();
    second.unmount();
    await renderRelay('stored-1');
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('deposit-amount-input')).toBeInTheDocument();
  });

  it('keeps the deposit and shows the failure when no row is created', async () => {
    jest.mocked(initiateBridgedReceiveTransaction).mockRejectedValueOnce(new Error('db closed'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);

    expect(mockPending.map(entry => entry.id)).toEqual(['stored-1']);
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('depositFlowStartFailedTitle');
    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('db closed');
    expect(mockRelaySendCalls).not.toHaveBeenCalled();
  });

  it('shows the cap failure when the funds arrive over the cap', async () => {
    mockCapVerdict = { state: 'exceeded', capUsd: 1232, heldUsd: 1300, depositUsd: 2 };
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);

    expect(screen.getByTestId('deposit-address-failed')).toHaveTextContent('bridgeDepositBalanceCapExceeded');
    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
  });

  it('sends native ETH as the value of the one relay call, with no allowance read', async () => {
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);
    await settle();

    expect(readEvmErc20Allowance).not.toHaveBeenCalled();
    expect(sentCalls()).toHaveLength(1);
    const [deposit] = sentCalls();
    expect(deposit).toMatchObject({ to: L1_BRIDGE, value: ETH_DEPOSIT });
    expect(decodeFunctionData({ abi: AGGLAYER_BRIDGE_ABI, data: deposit?.data ?? '0x' }).args).toEqual([
      77,
      '0x00000000000000000000000000000000000000A1',
      ETH_DEPOSIT,
      NATIVE,
      true,
      '0x'
    ]);
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'delivering', { evmTxHash: MINED });
  });

  it('sends the approval and the Agglayer deposit of the Epoch USDC as one relay batch', async () => {
    await renderRelay();
    await pickUsdc();
    fireEvent.click(screen.getByTestId('deposit-route-change'));
    fireEvent.click(screen.getByTestId('deposit-route-agglayer'));
    await settle();
    await typeAmount('1.505');
    await toAddress();
    await setRelayBalance(USDC_DEPOSIT);
    await settle();

    const [approve, deposit] = sentCalls();
    expect(sentCalls()).toHaveLength(2);
    expect(approve).toMatchObject({ to: USDC, value: 0n });
    expect(decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approve?.data ?? '0x' }).args).toEqual([
      L1_BRIDGE,
      USDC_DEPOSIT
    ]);
    expect(deposit).toMatchObject({ to: L1_BRIDGE, value: 0n });
    expect(readEvmErc20Allowance).toHaveBeenCalledWith(USDC, RELAY, L1_BRIDGE, CHAIN_ID);
  });

  it('stores the relay job on the row before the POST', async () => {
    const events: string[] = [];
    jest.mocked(updateBridgedReceivePhase).mockImplementation(async (_id, _phase, extra) => {
      if (extra?.relayJob) events.push('job');
    });
    relayAnswers(async () => MINED, events);
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);
    await settle();

    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'submitting', { relayJob: JOB });
    expect(events).toEqual(['job', 'post']);
  });

  it('keeps the row open, and signs nothing again, when the relay outcome is not known', async () => {
    relayAnswers(async () => {
      throw new RelayUnknownOutcomeError(JOB);
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);
    await settle();

    expect(mockRelaySendCalls).toHaveBeenCalledTimes(1);
    expect(failedWrites()).toEqual([]);
    expect(waitForEvmReceipt).not.toHaveBeenCalled();
    expect(screen.getByTestId('deposit-processing')).toBeInTheDocument();
  });

  it.each([
    ['a reverted batch', () => new RelayRevertedError(JOB.id, `0x${'34'.repeat(32)}`), 'depositFlowRelayReverted'],
    [
      'a relay refusal',
      () => new RelayApiError('simulation_failed', 409, 'simulation failed'),
      'depositFlowRelayRefused'
    ]
  ])('fails the row with its own message after %s', async (_case, error, message) => {
    relayAnswers(async () => {
      throw error();
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);
    await settle();

    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      expect.objectContaining({ error: message, errorId: 'raw_bridge_deposit_failed' })
    );
  });

  it('checks the balance again before the relay signs', async () => {
    mockRelaySendCalls.mockImplementation(async (_calls, hooks) => {
      answerBalance(0n);
      await hooks.beforeSign?.();
      return MINED;
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);
    await settle();

    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      expect.objectContaining({ errorId: 'bridgeDepositBalanceTooLow' })
    );
  });

  it('quotes the Epoch deposit again when the funds arrive, then runs it from the relay address', async () => {
    await renderRelay();
    await pickUsdc();
    await typeAmount('1.505');
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('0.0015 USDC');
    await toAddress();
    expect(mockPending[0]).toEqual(
      expect.objectContaining({ route: 'epoch', amountBaseUnits: QUOTED_IN.toString(), token: expect.anything() })
    );
    const quotesBefore = mockEpochState.quoteEVMToMiden.mock.calls.length;
    await setRelayBalance(QUOTED_IN);
    await settle();

    expect(mockEpochState.quoteEVMToMiden.mock.calls.length).toBe(quotesBefore + 1);
    expect(mockEpochState.quoteEVMToMiden).toHaveBeenLastCalledWith(
      expect.objectContaining({ evmSourceAddress: RELAY, sourceChainId: CHAIN_ID }),
      RELAY
    );
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'epoch', sourceAddress: RELAY })
    );
    await waitFor(() => expect(mockEpochState.executeEVMToMiden).toHaveBeenCalledWith('bridge-tx'));
    expect(mockRelaySendCalls).not.toHaveBeenCalled();
  });

  it('waits for the rest when the new Epoch quote asks for more than arrived', async () => {
    await renderRelay();
    await pickUsdc();
    await typeAmount('1.505');
    await toAddress();
    quoteWith(QUOTED_IN + 1n);
    await setRelayBalance(QUOTED_IN);
    await settle();

    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
    expect(screen.getByTestId('deposit-address-partial')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('1.506500000000000001');
  });
});

describe('EvmBridgeDepositScreen from a relay source: sheets', () => {
  it('lists the relay tokens and offers to connect a wallet', async () => {
    await renderRelay();
    fireEvent.click(screen.getByTestId('deposit-token-selector'));

    expect(screen.getByTestId(`deposit-token-${CHAIN_ID}:ETH`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`deposit-token-${CHAIN_ID}:EPOCH_USDC`)).toHaveTextContent(
      'depositFlowTokenArrivesAs {"token":"USDC"}'
    );
    expect(screen.queryByText(/CIRCLE/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('deposit-token-connect-wallet'));
    expect(onConnectAnother).toHaveBeenCalledTimes(1);
  });

  it('tags Agglayer as most received and Epoch as fastest', async () => {
    await renderRelay();
    await pickUsdc();
    await typeAmount('1.505');
    fireEvent.click(screen.getByTestId('deposit-route-change'));

    expect(screen.getByTestId('deposit-route-agglayer-best')).toHaveTextContent('depositFlowMostReceived');
    expect(screen.queryByTestId('deposit-route-agglayer-fastest')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-route-epoch-fastest')).toHaveTextContent('depositFlowFastest');
    expect(screen.getByTestId('deposit-route-epoch')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('EvmBridgeDepositScreen from a relay source: processing and success', () => {
  const startEthDeposit = async () => {
    mockPending = [storedEthDeposit()];
    await renderRelay('stored-1');
    await setRelayBalance(ETH_DEPOSIT);
    await settle();
  };
  const stepState = (index: number) => screen.getByTestId(`deposit-processing-step-${index}`).dataset.state;

  it.each([
    ['submitting', 1],
    ['delivering', 1],
    ['ready', 2]
  ] satisfies [IBridgedReceivePhase, number][])('shows the steps of a %s row', async (phase, now) => {
    await startEthDeposit();
    await setRow(phase);

    expect(stepState(now)).toBe('now');
    expect(stepState(now - 1)).toBe('done');
    expect(screen.getByTestId('deposit-processing-note')).toHaveTextContent('depositFlowProcessingSlowNote');
  });

  it('shows the success screen and starts again', async () => {
    await startEthDeposit();
    await setRow('received');

    expect(screen.getByTestId('deposit-success')).toHaveTextContent('depositFlowArrivedTitle');
    expect(screen.getByTestId('deposit-success-received')).toHaveTextContent('1.5 ETH');
    fireEvent.click(screen.getByTestId('deposit-success-again'));
    await settle();
    expect(screen.getByTestId('deposit-amount-input')).toHaveValue('');
  });

  it('goes Home from Done', async () => {
    await startEthDeposit();
    await setRow('received');
    fireEvent.click(screen.getByTestId('deposit-success-done'));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('shows the failure of a failed row', async () => {
    await startEthDeposit();
    await setRow('failed', { error: 'The relay reverted' });

    expect(screen.getByTestId('deposit-processing-failed')).toHaveTextContent('The relay reverted');
  });

  it('keeps a row with an open relay job in progress, whatever the Epoch store says', async () => {
    await startEthDeposit();
    Object.assign(mockEpochState, { status: 'failed', flow: 'evm-to-miden', error: 'sdk said no' });
    await setRow('submitting', { relayJob: JOB });

    expect(stepState(1)).toBe('now');
    expect(screen.queryByTestId('deposit-processing-failed')).not.toBeInTheDocument();
    expect(screen.queryByText(/retry/)).not.toBeInTheDocument();
    expect(mockEpochState.quoteEVMToMiden).not.toHaveBeenCalled();
  });
});
