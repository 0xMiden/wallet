import React from 'react';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import Dexie from 'dexie';
import { decodeFunctionData, getAddress, toFunctionSelector } from 'viem';

import type { BatchCall } from 'lib/evm-relay/batch';
import { RelayRevertedError, RelayUnknownOutcomeError } from 'lib/evm-relay/errors';
import type { PendingRelayDeposit } from 'lib/evm-relay/pending-deposit';
import type { RelaySource } from 'lib/evm-relay/source';
import type { RelaySubmitOptions } from 'lib/evm-relay/submit';
import type { RelayJobRef } from 'lib/evm-relay/types';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import type { IBridgedReceiveExtraInputs, IBridgedReceivePhase, ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import type { WalletAccount } from 'lib/shared/types';
import type { CctpBurnQuote } from 'lib/usdcx/cctp';
import {
  ERC20_APPROVE_ABI,
  TOKEN_MESSENGER_WITH_FEES_ABI,
  type UsdcxSourceChain,
  XRESERVE_ABI
} from 'lib/usdcx/constant';
import { prepareNativeSessionChain } from 'lib/walletconnect/native';
import { waitForEvmReceipt } from 'lib/walletconnect/receipt';
import { WalletType } from 'screens/onboarding/types';

import { legacyBridgeReceiveFixture } from './bridge-receive-test-fixture';
import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

const CHAIN_ID = 11155111;
const ARC_ID = 5042002;
const RELAY = '0x00000000000000000000000000000000000000e5';
const RELAY_SOURCE: RelaySource = { accountPublicKey: 'mtst1account', address: RELAY };
const CIRCLE_USDC = '0x00000000000000000000000000000000000000c1';
const X_RESERVE = '0x00000000000000000000000000000000000000d1';
const MESSENGER = '0x00000000000000000000000000000000000000f1';
const RECIPIENT = `0x${'ab'.repeat(32)}`;
const MINED = `0x${'12'.repeat(32)}`;
const JOB: RelayJobRef = { chainId: CHAIN_ID, id: `0x${'ab'.repeat(32)}`, deadline: 1_900_000_000 };
/** 1.5 USDC at Circle's 6 decimals. */
const AMOUNT = 1_500_000n;
/** Circle's quoted fee of the executor route: 0.02 USDC. */
const FEE = 20_000n;
const FUNDED = 10n ** 12n;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)
  }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values?: Record<string, string> }) => (
    <>{`${i18nKey} ${JSON.stringify(values)}`}</>
  )
}));
jest.mock('@reown/appkit/react', () => ({ useAppKitProvider: () => ({ walletProvider: undefined }) }));
const mockSwitchChain = jest.fn();
jest.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: mockSwitchChain }),
  useWriteContract: () => ({ mutateAsync: jest.fn() })
}));
jest.mock('./EpochWithdrawalGate', () => ({
  EpochWithdrawalGate: ({ children }: { children: React.ReactNode }) => children
}));

const SNAPSHOT = {
  status: 'ready',
  config: {
    network: 'testnet',
    'bridge-providers': { epoch: { allocatorUrl: 'https://allocator.test' } },
    supportedEvmChains: { source: { chainId: CHAIN_ID, bridges: { usdcx: { depositEnabled: true } } } }
  },
  lastFetch: null
};
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => SNAPSHOT,
  useFeatureAvailability: () => ({ state: 'available' })
}));
// The Epoch tokens of the chain: none, unless a case lists one at Circle's USDC contract.
interface MockEpochToken {
  key: string;
  address: string;
  chainId: number;
  symbol: string;
  decimals: number;
  midenFaucetId: string;
  midenSymbol: string;
  midenDecimals: number;
}
let mockEpochTokens: MockEpochToken[] = [];
jest.mock('lib/remote-config/values', () => ({
  selectNativeEthFaucet: () => undefined,
  selectAgglayerRecoveryConfig: () => null,
  selectAgglayerChain: () => null,
  selectEvmUsdc: () => null,
  selectEpochDepositTokens: () => mockEpochTokens,
  selectAgglayerDepositTokens: () => [],
  selectAgglayerRegistryToken: () => null,
  selectBridgeInMaxBalanceUsd: () => null
}));
jest.mock('lib/remote-config/token-labels', () => ({
  ...jest.requireActual('lib/remote-config/token-labels'),
  evmUsdcLabel: (_snapshot: unknown, symbol: string) => symbol
}));

// Circle's source on the chain: a direct xReserve deposit, or the executor route when a case sets it.
const sepolia = { id: CHAIN_ID, name: 'Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } };
const XRESERVE_SOURCE: UsdcxSourceChain = {
  route: 'xreserve',
  chain: { ...sepolia, rpcUrls: { default: { http: ['https://rpc.test'] } } },
  usdc: CIRCLE_USDC,
  domain: 0,
  midenDomain: 10007,
  xReserve: X_RESERVE,
  attestationApi: 'https://attest.test'
};
const EXECUTOR_SOURCE: UsdcxSourceChain = {
  route: 'cctp-executor',
  chain: { ...sepolia, rpcUrls: { default: { http: ['https://rpc.test'] } } },
  usdc: CIRCLE_USDC,
  domain: 0,
  midenDomain: 10007,
  tokenMessengerWithFees: MESSENGER,
  irisApi: 'https://iris.test',
  target: {
    midenDomain: 10007,
    chain: { ...sepolia, id: ARC_ID, name: 'Arc Testnet', rpcUrls: { default: { http: ['https://arc.test'] } } },
    domain: 26,
    executor: '0x0000000000000000000000000000000000000a01',
    handler: '0x0000000000000000000000000000000000000a02',
    xReserve: '0x0000000000000000000000000000000000000a03',
    usdc: '0x0000000000000000000000000000000000000a04',
    attestationApi: 'https://attest.test',
    irisApi: 'https://iris.test'
  }
};
let mockCircleSource: UsdcxSourceChain = XRESERVE_SOURCE;
jest.mock('lib/usdcx/constant', () => ({
  ...jest.requireActual<typeof import('lib/usdcx/constant')>('lib/usdcx/constant'),
  usdcxSourceChains: () => new Map([[11155111, mockCircleSource]]),
  listUsdcxSourceChains: () => [mockCircleSource],
  defaultUsdcxChainId: () => 11155111,
  isUsdcxRouteEnabled: () => true
}));
jest.mock('lib/usdcx/deposit-target', () => ({ usdcxRemoteRecipientFor: () => `0x${'ab'.repeat(32)}` }));
// Circle's quote of a forwarded burn, for the display, the arrival and the burn alike.
let mockFee = 20_000n;
let mockQuoteRefused = false;
jest.mock('lib/usdcx/cctp', () => ({
  ...jest.requireActual<typeof import('lib/usdcx/cctp')>('lib/usdcx/cctp'),
  fetchCctpBurnQuote: async (): Promise<CctpBurnQuote> => {
    if (mockQuoteRefused) throw new Error('refused');
    return { signedQuote: '0x0102', feeTotalAmount: mockFee, expiresAt: 4_000_000_000 };
  }
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual<typeof import('lib/miden-chain/native-asset')>('lib/miden-chain/native-asset'),
  getNativeAssetId: async () => 'mtst1usdcxnative'
}));

jest.mock('lib/agglayer/token-holdings', () => ({ readErc20Holdings: async () => [] }));
jest.mock('use-debounce', () => ({ useDebounce: (value: unknown) => [value] }));
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => false }));
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'native-faucet' }));
jest.mock('./bridge-in-balance-cap', () => ({
  depositTokenPrice: () => ({ priceUsd: 1, pending: false }),
  useBridgeInBalanceCap: () => ({ state: 'clear', capUsd: 1000, heldUsd: 0, depositUsd: 1 })
}));

// Each change to a mock that a hook reads re-renders its readers.
const mockListeners = new Set<() => void>();
let mockVersion = 0;
const mockBump = () => {
  mockVersion += 1;
  mockListeners.forEach(listener => listener());
};
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
/** Every Epoch quote is for 1.5 USDC out, with a deposit of `tokenIn`. */
const quoteWith = (tokenIn: bigint) => {
  mockEpochState.quoteEVMToMiden.mockImplementation(async () => {
    Object.assign(mockEpochState, {
      status: 'quoted',
      flow: 'evm-to-miden',
      quote: { params: { minTokenOut: '1500000' }, quoteResult: { tokenIn: tokenIn.toString(), tokenOut: '1500000' } }
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
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: () => undefined }));
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

// The relay's view of the address: the balance of the deposit's token.
let mockRelayBalance: bigint | null = null;
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
        mode: 'sponsor',
        error: undefined
      };
    }
  };
});
jest.mock('lib/evm-relay/use-relay-account', () => ({
  useRelayAccount: ({ chainId }: { chainId: number | null }) => {
    mockUseVersion();
    return { account: chainId === null ? undefined : { mode: 'sponsor' }, error: undefined, isLoading: false };
  }
}));

// The pending deposits of the account, in memory. The record keeps the route as an id that it does not read.
let mockPending: PendingRelayDeposit[] = [];
jest.mock('lib/evm-relay/pending-deposit', () => ({
  parsePendingRelayDeposit: (value: PendingRelayDeposit) => value,
  createPendingRelayDepositId: () => 'pending-1',
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
const BALANCE_OF = toFunctionSelector('balanceOf(address)');
const ALLOWANCE = toFunctionSelector('allowance(address,address)');
// The chain's answers to the screen's reads: the Circle USDC balance, the allowance, and the Miden domain registration.
let mockAllowance = 0n;
let mockChainBalance = FUNDED;
const answerReads = () => {
  global.fetch = jest.fn().mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
    const body: unknown = JSON.parse(String(init?.body ?? '{}'));
    const params: unknown = body && typeof body === 'object' ? Reflect.get(body, 'params') : undefined;
    const call: unknown = Array.isArray(params) ? params[0] : undefined;
    const data: unknown = call && typeof call === 'object' ? Reflect.get(call, 'data') : undefined;
    const selector = typeof data === 'string' ? data.slice(0, 10) : '';
    const answer = (() => {
      switch (selector) {
        case BALANCE_OF:
          return mockChainBalance;
        case ALLOWANCE:
          return mockAllowance;
        default:
          return 1n;
      }
    })();
    return { json: async () => ({ result: word(answer) }) };
  });
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
const renderRelay = async () => {
  const view = render(
    <EvmBridgeDepositScreen
      evmAddress={RELAY}
      relaySource={RELAY_SOURCE}
      midenAccount={midenAccount}
      onConnectAnother={onConnectAnother}
      onClose={onClose}
      onExit={onExit}
    />
  );
  await settle();
  return view;
};
const typeAmount = async (value: string) => {
  fireEvent.change(screen.getByTestId('deposit-amount-input'), { target: { value } });
  await settle();
};
const toAddress = async () => {
  fireEvent.click(screen.getByTestId('deposit-amount-review'));
  await settle();
  fireEvent.keyDown(screen.getByTestId('deposit-review-slide-knob'), { key: 'Enter' });
  await settle();
};
/** The amount step, Review, the address, and the funds at the address: the bridge starts from the relay address. */
const depositArrives = async (arrived: bigint) => {
  await renderRelay();
  await typeAmount('1.5');
  await toAddress();
  await setRelayBalance(arrived);
  await settle();
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

let restoreLookup: () => void = () => undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockPending = [];
  mockRow = undefined;
  mockRelayBalance = null;
  mockCircleSource = XRESERVE_SOURCE;
  mockEpochTokens = [];
  mockFee = FEE;
  mockQuoteRefused = false;
  mockAllowance = 0n;
  mockChainBalance = FUNDED;
  Object.assign(mockEpochState, { status: 'idle', flow: null, quote: null, error: null });
  quoteWith(AMOUNT + 1_000n);
  answerReads();
  jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
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

describe('EvmBridgeDepositScreen from a relay source: Circle xReserve', () => {
  it('opens on Circle USDC with the Circle route and no arrival row', async () => {
    await renderRelay();
    await typeAmount('1.5');

    expect(screen.getByTestId('deposit-token-selector')).toHaveAccessibleName(
      'depositFlowTokenOnNetworkChange {"token":"USDC","network":"Sepolia"}'
    );
    expect(screen.getByTestId('deposit-receipt-route')).toHaveTextContent('depositFlowRouteCircle');
    expect(screen.queryByTestId('deposit-route-change')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deposit-receipt-arrival')).not.toBeInTheDocument();
    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('none');
    expect(screen.getByTestId('deposit-receipt-total-amount')).toHaveTextContent('1.5 USDCx');
    expect(screen.getByTestId('deposit-amount-review')).toBeEnabled();
  });

  it('offers Circle USDC in the token sheet', async () => {
    await renderRelay();
    fireEvent.click(screen.getByTestId('deposit-token-selector'));

    expect(screen.getByTestId(`deposit-token-${CHAIN_ID}:CIRCLE_USDC`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`deposit-token-${CHAIN_ID}:CIRCLE_USDC`)).toHaveTextContent(
      'depositFlowTokenArrivesAs {"token":"USDCx"}'
    );
  });

  it('reviews with the Circle arrival time and saves the Circle deposit', async () => {
    await renderRelay();
    await typeAmount('1.5');
    fireEvent.click(screen.getByTestId('deposit-amount-review'));
    await settle();

    expect(screen.getByTestId('deposit-review-facts')).toHaveTextContent('usdcxArrival');
    expect(screen.getByTestId('deposit-review-facts')).toHaveTextContent('depositFlowRouteCircle');
    fireEvent.keyDown(screen.getByTestId('deposit-review-slide-knob'), { key: 'Enter' });
    await settle();
    expect(mockPending).toEqual([
      expect.objectContaining({
        route: 'usdcx',
        chainId: CHAIN_ID,
        token: { address: CIRCLE_USDC, symbol: 'USDC', decimals: 6 },
        amountBaseUnits: AMOUNT.toString(),
        outputAmount: '1.5',
        outputSymbol: 'USDCx',
        form: { tokenKind: 'CIRCLE_USDC', tokenId: '', chainId: String(CHAIN_ID), route: 'usdcx', amount: '1.5' }
      })
    ]);
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('1.5');
  });

  it('sends the approval and the deposit to xReserve as one relay batch, with no chain switch', async () => {
    await depositArrives(AMOUNT);

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'usdcx', sourceAddress: RELAY, usdcxSource: XRESERVE_SOURCE })
    );
    expect(mockBuildRelayProvider).toHaveBeenCalledWith(RELAY_SOURCE, CHAIN_ID, expect.anything());
    expect(mockRelaySendCalls).toHaveBeenCalledTimes(1);
    const [approve, deposit] = sentCalls();
    expect(sentCalls()).toHaveLength(2);
    expect(approve).toMatchObject({ to: CIRCLE_USDC, value: 0n });
    expect(decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approve?.data ?? '0x' }).args).toEqual([
      getAddress(X_RESERVE),
      AMOUNT
    ]);
    expect(deposit).toMatchObject({ to: X_RESERVE, value: 0n });
    const decoded = decodeFunctionData({ abi: XRESERVE_ABI, data: deposit?.data ?? '0x' });
    expect(decoded.functionName).toBe('depositToRemote');
    expect(decoded.args?.[0]).toBe(AMOUNT);
    expect(decoded.args?.[2]).toBe(RECIPIENT);
    expect(prepareNativeSessionChain).not.toHaveBeenCalled();
    expect(mockSwitchChain).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'submitting', {
      evmTxHash: MINED,
      usdcxRemoteRecipient: RECIPIENT
    });
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'delivering', { evmTxHash: MINED });
    expect(screen.getByTestId('deposit-processing')).toBeInTheDocument();
  });

  it('sends the deposit alone when the allowance covers it', async () => {
    mockAllowance = AMOUNT;
    await depositArrives(AMOUNT);

    expect(sentCalls()).toHaveLength(1);
    expect(sentCalls()[0]).toMatchObject({ to: X_RESERVE });
  });

  it('stores the relay job with the signed recipient on the row before the POST', async () => {
    const events: string[] = [];
    jest.mocked(updateBridgedReceivePhase).mockImplementation(async (_id, _phase, extra) => {
      if (extra?.relayJob) events.push('job');
    });
    relayAnswers(async () => MINED, events);
    await depositArrives(AMOUNT);

    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'submitting', {
      relayJob: JOB,
      usdcxRemoteRecipient: RECIPIENT
    });
    expect(events).toEqual(['job', 'post']);
  });

  it('keeps the row open, and signs nothing again, when the relay outcome is not known', async () => {
    relayAnswers(async () => {
      throw new RelayUnknownOutcomeError(JOB);
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await depositArrives(AMOUNT);

    expect(mockRelaySendCalls).toHaveBeenCalledTimes(1);
    expect(failedWrites()).toEqual([]);
    expect(waitForEvmReceipt).not.toHaveBeenCalled();
    expect(screen.getByTestId('deposit-processing')).toBeInTheDocument();
  });

  it('fails the row with the relay message after a reverted batch', async () => {
    relayAnswers(async () => {
      throw new RelayRevertedError(JOB.id, `0x${'34'.repeat(32)}`);
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await depositArrives(AMOUNT);

    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      expect.objectContaining({
        error: 'depositFlowRelayReverted',
        errorId: 'raw_bridge_deposit_failed',
        failure: expect.objectContaining({ step: 'wallet_deposit', requestClient: 'relay' })
      })
    );
  });

  it('checks the balance again before the relay signs', async () => {
    mockRelaySendCalls.mockImplementation(async (_calls, hooks) => {
      mockChainBalance = 0n;
      await hooks.beforeSign?.();
      return MINED;
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await depositArrives(AMOUNT);

    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      expect.objectContaining({ errorId: 'bridgeDepositBalanceTooLow' })
    );
  });
});

describe('EvmBridgeDepositScreen from a relay source: Circle executor route', () => {
  beforeEach(() => {
    mockCircleSource = EXECUTOR_SOURCE;
  });

  it('asks for the amount plus Circle fee, shown on top of the amount', async () => {
    await renderRelay();
    await typeAmount('1.5');

    expect(screen.getByTestId('deposit-receipt-fee')).toHaveTextContent('0.02 USDC');
    expect(screen.getByTestId('deposit-receipt-total-amount')).toHaveTextContent('1.5 USDCx');
    await toAddress();
    expect(mockPending[0]).toEqual(
      expect.objectContaining({ route: 'usdcx', amountBaseUnits: (AMOUNT + FEE).toString(), outputAmount: '1.5' })
    );
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('1.52');
  });

  it('says so, and holds Review, when Circle does not quote the fee', async () => {
    mockQuoteRefused = true;
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await renderRelay();
    await typeAmount('1.5');

    expect(screen.getByTestId('deposit-quote-failed')).toHaveTextContent('usdcxForwardQuoteUnavailable');
    expect(screen.getByTestId('deposit-amount-review')).toBeDisabled();
  });

  it('quotes the fee again on arrival, then sends the approval and the burn as one relay batch', async () => {
    const events: string[] = [];
    jest.mocked(updateBridgedReceivePhase).mockImplementation(async (_id, _phase, extra) => {
      if (extra?.relayJob) events.push('job');
    });
    relayAnswers(async () => MINED, events);
    await depositArrives(AMOUNT + FEE);

    expect(mockRelaySendCalls).toHaveBeenCalledTimes(1);
    const [approve, burn] = sentCalls();
    expect(sentCalls()).toHaveLength(2);
    expect(decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approve?.data ?? '0x' }).args).toEqual([
      getAddress(MESSENGER),
      AMOUNT + FEE
    ]);
    expect(burn).toMatchObject({ to: MESSENGER, value: 0n });
    const decoded = decodeFunctionData({ abi: TOKEN_MESSENGER_WITH_FEES_ABI, data: burn?.data ?? '0x' });
    expect(decoded.functionName).toBe('depositForBurnWithHookAndFees');
    expect(decoded.args?.[0]).toBe(AMOUNT);
    const facts = {
      usdcxRemoteRecipient: RECIPIENT,
      cctp: { sourceDomain: 0, forwarded: true, forwardFee: FEE.toString() }
    };
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'submitting', { relayJob: JOB, ...facts });
    expect(events).toEqual(['job', 'post']);
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'submitting', { evmTxHash: MINED, ...facts });
    expect(mockSwitchChain).not.toHaveBeenCalled();
  });

  it('waits for the rest when the fee quoted on arrival asks for more than arrived', async () => {
    await renderRelay();
    await typeAmount('1.5');
    await toAddress();
    mockFee = FEE + 5_000n;
    await setRelayBalance(AMOUNT + FEE);
    await settle();
    await settle();

    expect(initiateBridgedReceiveTransaction).not.toHaveBeenCalled();
    expect(screen.getByTestId('deposit-address-partial')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-address-amount')).toHaveTextContent('1.525');
  });
});

describe('EvmBridgeDepositScreen from a relay source: Circle and Epoch on one token', () => {
  beforeEach(() => {
    mockEpochTokens = [
      {
        key: 'USDC',
        address: CIRCLE_USDC,
        chainId: CHAIN_ID,
        symbol: 'USDC',
        decimals: 6,
        midenFaucetId: 'usdc-faucet',
        midenSymbol: 'USDC',
        midenDecimals: 6
      }
    ];
  });

  it('tags a direct xReserve deposit as most received and Epoch as fastest', async () => {
    await renderRelay();
    await typeAmount('1.5');
    fireEvent.click(screen.getByTestId('deposit-route-change'));

    expect(screen.getByTestId('deposit-route-usdcx')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('deposit-route-usdcx-best')).toBeInTheDocument();
    expect(screen.getByTestId('deposit-route-epoch-fastest')).toBeInTheDocument();
    expect(screen.queryByTestId('deposit-route-agglayer')).not.toBeInTheDocument();
  });

  it('tags the route with the smaller real fee as most received', async () => {
    mockCircleSource = EXECUTOR_SOURCE;
    await renderRelay();
    await typeAmount('1.5');
    fireEvent.click(screen.getByTestId('deposit-route-change'));
    // The Epoch fee is not known before its route is chosen: Circle's known fee leads.
    expect(screen.getByTestId('deposit-route-usdcx-best')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('deposit-route-epoch'));
    await settle();
    fireEvent.click(screen.getByTestId('deposit-route-change'));
    // Epoch's 0.001 USDC is less than Circle's 0.02 USDC.
    expect(screen.getByTestId('deposit-route-epoch-best')).toBeInTheDocument();
    expect(screen.queryByTestId('deposit-route-usdcx-best')).not.toBeInTheDocument();
  });
});

describe('EvmBridgeDepositScreen from a relay source: Circle processing', () => {
  const stepState = (index: number) => screen.getByTestId(`deposit-processing-step-${index}`).dataset.state;

  it.each([
    ['submitting', 1],
    ['delivering', 1],
    ['ready', 2]
  ] satisfies [IBridgedReceivePhase, number][])('shows the steps of a %s Circle row', async (phase, now) => {
    await depositArrives(AMOUNT);
    await setRow(phase);

    expect(stepState(now)).toBe('now');
    expect(screen.getByTestId('deposit-processing-note')).toHaveTextContent('depositFlowProcessingNote');
  });

  it('keeps a Circle row with an open relay job in progress, with no action that signs again', async () => {
    await depositArrives(AMOUNT);
    await setRow('submitting', { relayJob: JOB });

    expect(stepState(1)).toBe('now');
    expect(screen.queryByRole('button', { name: /retry|usdcxExecute/ })).not.toBeInTheDocument();
    expect(mockRelaySendCalls).toHaveBeenCalledTimes(1);
  });

  it('shows the success screen of a received Circle row', async () => {
    await depositArrives(AMOUNT);
    await setRow('received');

    expect(screen.getByTestId('deposit-success-received')).toHaveTextContent('1.5 USDCx');
  });
});
