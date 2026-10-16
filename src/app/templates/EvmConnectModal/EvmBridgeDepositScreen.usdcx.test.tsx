import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toFunctionSelector } from 'viem';

import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { AgglayerChainConfig } from 'lib/remote-config/schema';
import type { CctpBurnQuote } from 'lib/usdcx/cctp';
import { runUsdcxDeposit } from 'lib/usdcx/deposit';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import {
  buildExecutorBurnIntent,
  quoteExecutorBurn,
  runUsdcxExecutorDeposit,
  UsdcxExecutorBalanceTooLowError,
  UsdcxForwardQuoteUnavailableError
} from 'lib/usdcx/executor';
import { NativeSessionChainNotApprovedError, prepareNativeSessionChain } from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

// The suite's document unless a case sets another before it renders.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    mockBridgeSnapshot ??
    jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
      .TEST_BRIDGE_CONFIG_SNAPSHOT,
  subscribeBridgeConfig: () => () => {},
  initBridgeConfig: async () => {},
  holdFastPoll: () => () => {}
}));

/**
 * The RPC URLs the screen's xReserve registration read went to: the eth_call to `xReserve` whose data is
 * `isRemoteDomainRegistered`. The Circle USDC balance read goes to the same RPC at mount, so a URL alone proves nothing.
 */
const REGISTRATION_SELECTOR = toFunctionSelector('isRemoteDomainRegistered(uint32)');
const registrationReadUrls = (xReserve: string): unknown[] =>
  jest
    .mocked(global.fetch)
    .mock.calls.filter(([, init]) => {
      const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}'));
      const call = body.params?.[0];
      return (
        body.method === 'eth_call' &&
        String(call?.to).toLowerCase() === xReserve.toLowerCase() &&
        String(call?.data).startsWith(REGISTRATION_SELECTOR)
      );
    })
    .map(([url]) => url);

// Covers the USDCx (Circle xReserve) path of the deposit screen: a USDC deposit
// has one route, auto-selected, and confirming it creates a `usdcx` tracking row
// and hands the EVM leg to `runUsdcxDeposit` with the encoded Miden recipient.
// ETH keeps the Fast/Slow picker. The bridge itself is stubbed.

// The key, then any values it names, so a case can read which balance, token and network a message was given.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)
  })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKitProvider: () => ({ walletProvider: { request: jest.fn() } })
}));

const mockWriteContract = jest.fn().mockResolvedValue(`0x${'2'.repeat(64)}`);
const mockSwitchChain = jest.fn().mockResolvedValue(undefined);
let mockNativeAvailable = false;
const mockNativeSend = jest.fn().mockResolvedValue({ hash: `0x${'2'.repeat(64)}` });

jest.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: mockSwitchChain }),
  useWriteContract: () => ({ mutateAsync: mockWriteContract })
}));

// Pass-through unless a test holds back a value, as a debounce does while the input still moves.
const mockUseDebounce = jest.fn((value: unknown) => [value]);
jest.mock('use-debounce', () => ({
  useDebounce: (value: unknown) => mockUseDebounce(value)
}));

const epochState = {
  status: 'idle',
  flow: null,
  quote: null,
  error: null,
  quoteEVMToMiden: jest.fn().mockResolvedValue(undefined),
  executeEVMToMiden: jest.fn(),
  poll: jest.fn(),
  reset: jest.fn()
};

jest.mock('lib/epoch', () => ({
  MIDEN_DESTINATION_CHAIN_ID: 1,
  evmToMidenMinTokenOut: (amount: string) => (Number(amount) > 0 ? '1000000' : undefined),
  // The screen opens on the bridge's own USDC and the Fast route, whose quote effect reads the store directly.
  useEpochStore: Object.assign((selector: (s: typeof epochState) => unknown) => selector(epochState), {
    getState: () => epochState
  })
}));

jest.mock('lib/miden/activity', () => ({
  initiateBridgedReceiveTransaction: jest.fn(),
  updateBridgedReceivePhase: jest.fn().mockResolvedValue(undefined)
}));

// The SDK is stubbed globally, so the account id parser is replaced with one
// that returns the guide's first test vector in hex form.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: () => ({ toString: () => '0xb64e1827414584510723cad8e145a4' })
}));

// USDCx is the chain's native asset, so the tracking row carries the discovered faucet id.
const USDCX_FAUCET_ID_BECH32 = 'mtst1usdcxnative';
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual<typeof import('lib/miden-chain/native-asset')>('lib/miden-chain/native-asset'),
  getNativeAssetId: async () => 'mtst1usdcxnative'
}));

jest.mock('lib/usdcx/deposit', () => ({
  runUsdcxDeposit: jest.fn().mockResolvedValue(`0x${'2'.repeat(64)}`),
  isUsdcxDomainNotRegisteredError: () => false
}));

// The real derivation, spied on: a test can hand the screen a recipient no other path would produce.
jest.mock('lib/usdcx/deposit-target', () => {
  const actual = jest.requireActual<typeof import('lib/usdcx/deposit-target')>('lib/usdcx/deposit-target');
  return { ...actual, usdcxRemoteRecipientFor: jest.fn(actual.usdcxRemoteRecipientFor) };
});
const { usdcxRemoteRecipientFor: actualUsdcxRemoteRecipientFor } =
  jest.requireActual<typeof import('lib/usdcx/deposit-target')>('lib/usdcx/deposit-target');
/** A recipient only `usdcxRemoteRecipientFor` returns, never the bytes the account id encodes to. */
const SIGNED_RECIPIENT = `0x${'ab'.repeat(32)}` as const;

jest.mock('lib/usdcx/executor', () => ({
  runUsdcxExecutorDeposit: jest.fn().mockResolvedValue(`0x${'2'.repeat(64)}`),
  // The route card's display quote; Circle is not reached from this suite.
  buildExecutorBurnIntent: jest.fn().mockReturnValue({ value: 1_500_000n, destinationCaller: '0x', hookData: '0x' }),
  quoteExecutorBurn: jest.fn().mockRejectedValue(new Error('no quote in tests')),
  // The real refusals, so the screen's error mapping can be tested with the real error classes.
  isUsdcxForwardQuoteUnavailableError:
    jest.requireActual<typeof import('lib/usdcx/executor')>('lib/usdcx/executor').isUsdcxForwardQuoteUnavailableError,
  UsdcxForwardQuoteUnavailableError:
    jest.requireActual<typeof import('lib/usdcx/executor')>('lib/usdcx/executor').UsdcxForwardQuoteUnavailableError,
  isUsdcxExecutorBalanceTooLowError:
    jest.requireActual<typeof import('lib/usdcx/executor')>('lib/usdcx/executor').isUsdcxExecutorBalanceTooLowError,
  UsdcxExecutorBalanceTooLowError:
    jest.requireActual<typeof import('lib/usdcx/executor')>('lib/usdcx/executor').UsdcxExecutorBalanceTooLowError
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: () => undefined
}));

// The fee read hits the chain; here the wallet estimates, as it does when the read fails.
jest.mock('lib/walletconnect/fees', () => ({ readNativeFeeFields: async () => ({}) }));

// The session-chain check passes unless a case refuses the chain; the error class is the real one the screen maps.
jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => mockNativeAvailable,
  NativeReown: { sendTransaction: (options: unknown) => mockNativeSend(options) },
  NativeSessionChainNotApprovedError:
    jest.requireActual<typeof import('lib/walletconnect/native')>('lib/walletconnect/native')
      .NativeSessionChainNotApprovedError,
  prepareNativeSessionChain: jest.fn().mockResolvedValue(undefined),
  unwrapNativeResult: (value: unknown) => value
}));

jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt'),
  waitForEvmReceipt: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('lib/walletconnect/config', () => ({
  ...jest.requireActual('lib/walletconnect/config'),
  DEFAULT_CHAIN_ID: 11155111,
  getChain: (id: number) => ({ rpcUrl: `https://rpc.test/${id}`, name: id === 5042002 ? 'Arc Testnet' : 'Sepolia' })
}));

jest.mock('./EvmBridgeDepositForm', () => ({
  EvmBridgeDepositForm: ({
    onAmountChange,
    onContinue,
    onSelectToken,
    onSelectNetwork,
    network,
    isValidAmount,
    error
  }: {
    network?: { chainId: number };
    isValidAmount: boolean;
    error?: string;
    onAmountChange: (value?: string) => void;
    onContinue: () => void;
    onSelectToken: () => void;
    onSelectNetwork?: () => void;
  }) => (
    <div>
      <span data-testid="form-network">{String(network?.chainId)}</span>
      <span data-testid="form-ready">{String(isValidAmount)}</span>
      <span data-testid="form-error">{error}</span>
      <button data-testid="set-amount" onClick={() => onAmountChange('1.5')}>
        amount
      </button>
      <button data-testid="open-token-drawer" onClick={onSelectToken}>
        token
      </button>
      {onSelectNetwork && (
        <button data-testid="open-network-drawer" onClick={onSelectNetwork}>
          network
        </button>
      )}
      <button data-testid="continue" onClick={onContinue}>
        continue
      </button>
    </div>
  )
}));

jest.mock('./EvmBridgeDepositReview', () => {
  // The real naming helper: the screen and the Review both name the arriving token through it.
  const actual = jest.requireActual<typeof import('./EvmBridgeDepositReview')>('./EvmBridgeDepositReview');
  return {
    ...actual,
    EvmBridgeDepositReview: ({
      onConfirm,
      symbol,
      label,
      route,
      fee,
      sourceChainId,
      canConfirm,
      error
    }: {
      onConfirm: () => void;
      symbol: string;
      label?: string;
      route: Parameters<typeof actual.arrivingTokenName>[0];
      fee?: string;
      sourceChainId?: number;
      canConfirm?: boolean;
      error?: string;
    }) => (
      <div>
        {fee && <span data-testid="review-fee">{fee}</span>}
        <span data-testid="review-error">{error}</span>
        <span data-testid="review-can-confirm">{String(canConfirm)}</span>
        <span data-testid="review-source">{String(sourceChainId)}</span>
        <span data-testid="review-symbols">{`${symbol}->${actual.arrivingTokenName(route, symbol, label ?? symbol)}`}</span>
        <button data-testid="confirm-deposit" onClick={onConfirm}>
          confirm
        </button>
      </div>
    )
  };
});

jest.mock('./EvmBridgeDepositStatus', () => ({
  EvmBridgeDepositStatus: ({ awaitingNextConfirmation }: { awaitingNextConfirmation?: boolean }) => (
    <div data-testid="deposit-status" data-awaiting={String(awaitingNextConfirmation ?? false)} />
  )
}));

jest.mock('./EvmBridgeTokenDrawer', () => ({
  EvmBridgeTokenDrawer: ({ open, onSelect }: { open: boolean; onSelect: (token: string) => void }) =>
    open ? (
      <div>
        <button data-testid="pick-eth" onClick={() => onSelect('ETH')}>
          ETH
        </button>
        <button data-testid="pick-circle-usdc" onClick={() => onSelect('CIRCLE_USDC')}>
          USDC
        </button>
        <button data-testid="pick-usdc" onClick={() => onSelect('USDC')}>
          bridge USDC
        </button>
      </div>
    ) : null
}));

jest.mock('./EvmBridgeNetworkDrawer', () => ({
  EvmBridgeNetworkDrawer: ({
    open,
    networks,
    onSelect
  }: {
    open: boolean;
    networks: readonly { id: string; name: string; chainId: number }[];
    onSelect: (network: { id: string; name: string; chainId: number }) => void;
  }) =>
    open ? (
      <div data-testid="network-drawer">
        {networks.map(network => (
          <button key={network.id} data-testid={`pick-network-${network.id}`} onClick={() => onSelect(network)}>
            {network.name}
          </button>
        ))}
      </div>
    ) : null
}));

// The xReserve route starts on testnet only; these cases run where it can.
jest.mock('lib/usdcx/use-bridge-in-availability', () => ({ isUsdcxDepositAvailable: () => true }));

jest.mock('./EvmSwitchWalletDrawer', () => ({
  EvmSwitchWalletDrawer: () => null
}));

jest.mock('./EvmBridgeUsdcxRoute', () => ({
  EvmBridgeUsdcxRoute: ({
    confirmDisabled,
    onConfirm,
    fee,
    notice,
    sourceChainId
  }: {
    confirmDisabled?: boolean;
    onConfirm: () => void;
    fee?: string;
    notice?: string;
    sourceChainId: number;
  }) => (
    <div>
      {fee && <span data-testid="usdcx-route-fee">{fee}</span>}
      <span data-testid="usdcx-route-notice">{notice}</span>
      <span data-testid="usdcx-route-source">{String(sourceChainId)}</span>
      <button data-testid="usdcx-route-confirm" disabled={confirmDisabled} onClick={onConfirm}>
        usdcx
      </button>
    </div>
  )
}));

jest.mock('screens/send-flow/Route', () => ({
  Route: ({ onConfirm, fastAvailability }: { onConfirm: () => void; fastAvailability: { state: string } }) => (
    <div>
      <span data-testid="fast-availability">{fastAvailability.state}</span>
      <button data-testid="fast-slow-route-confirm" onClick={onConfirm}>
        fast/slow
      </button>
    </div>
  )
}));

const midenAccount = { publicKey: 'mtst1azmyuxp8g9zcg5g8y09d3c295s3n6fl4' };

/** A 32-byte word: what an `eth_call` returns, and a hex `eth_getBalance` parses as well. */
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
/** The typed 1.5 in Circle USDC's 6 decimals. */
const TYPED = 1_500_000n;
/** What every balance read answers, Circle's USDC included; read at each call, so a case can move it mid-flow. */
let mockBalance = 10n ** 30n;
/** Balance reads answer `mockBalance`, and xReserve's registration read a zero word the stubbed deposits ignore. */
const answerRpc = () =>
  jest.fn(async (_url: string, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body ?? '{}')).params?.[0];
    const registration = String(call?.data).startsWith(REGISTRATION_SELECTOR);
    return { json: async () => ({ result: word(registration ? 0n : mockBalance) }) };
  });

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const depositScreen = (evmAddress = '0x1111111111111111111111111111111111111111') => (
  <EvmBridgeDepositScreen
    evmAddress={evmAddress}
    midenAccount={midenAccount as never}
    onConnectAnother={jest.fn()}
    onClose={jest.fn()}
  />
);

const renderScreen = () => render(depositScreen());

/** USDC is the default token: amount, continue, and the route step is up. */
const pickToken = async (testId: 'pick-eth' | 'pick-circle-usdc' | 'pick-usdc') => {
  fireEvent.click(screen.getByTestId('open-token-drawer'));
  await settle();
  fireEvent.click(screen.getByTestId(testId));
  await settle();
};

const reachRouteStep = async () => {
  fireEvent.click(screen.getByTestId('set-amount'));
  await settle();
  fireEvent.click(screen.getByTestId('continue'));
  await settle();
};

// The screen opens on the bridge's own USDC; Circle's Arc USDC is the token xReserve takes.
const reachUsdcxRoute = async () => {
  await pickToken('pick-circle-usdc');
  await reachRouteStep();
};

describe('EvmBridgeDepositScreen USDCx route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseDebounce.mockImplementation((value: unknown) => [value]);
    jest.mocked(usdcxRemoteRecipientFor).mockImplementation(actualUsdcxRemoteRecipientFor);
    jest.mocked(quoteExecutorBurn).mockRejectedValue(new Error('no quote in tests'));
    mockNativeAvailable = false;
    // A case that fails mid-flow leaves its queued wallet answers behind; each case starts from the plain ones.
    mockWriteContract.mockReset().mockResolvedValue(`0x${'2'.repeat(64)}`);
    mockNativeSend.mockReset().mockResolvedValue({ hash: `0x${'2'.repeat(64)}` });
    jest
      .mocked(runUsdcxDeposit)
      .mockReset()
      .mockResolvedValue(`0x${'2'.repeat(64)}`);
    jest.mocked(waitForEvmReceipt).mockReset().mockResolvedValue(undefined);
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    mockBalance = 10n ** 30n;
    global.fetch = answerRpc() as never;
  });

  afterEach(() => {
    mockBridgeSnapshot = undefined;
  });

  it('offers only the xReserve route for a USDC deposit, already selected', async () => {
    renderScreen();

    await reachUsdcxRoute();

    expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();
    expect(screen.queryByTestId('fast-slow-route-confirm')).not.toBeInTheDocument();
  });

  /** The suite's document with no Epoch USDC on any chain, as a mainnet document that names only USDCx routes. */
  const withoutEpochUsdc = (): BridgeConfigSnapshot => {
    const config = TEST_BRIDGE_CONFIG_SNAPSHOT.config!;
    return {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: {
        ...config,
        supportedEvmChains: Object.fromEntries(
          Object.entries(config.supportedEvmChains).map(([slug, chain]) => {
            const { epoch: _epoch, ...bridges } = chain.bridges;
            return [slug, { ...chain, bridges }];
          })
        )
      }
    };
  };

  // A mainnet document names no Epoch USDC, only USDCx sources: the screen opens on Circle USDC and the first source
  // the document lists, not on a token it does not name over a compiled Sepolia label.
  it('opens on Circle USDC and a listed source when the document names no Epoch USDC', async () => {
    mockBridgeSnapshot = withoutEpochUsdc();
    renderScreen();
    await settle();

    expect(screen.getByTestId('form-network')).toHaveTextContent(/^5042002$/);
    expect(screen.getByTestId('form-error')).toHaveTextContent(/^$/);
    await reachRouteStep();
    expect(screen.getByTestId('usdcx-route-confirm')).toBeInTheDocument();
  });

  it('keeps the token the user picked over the document opening token', async () => {
    mockBridgeSnapshot = withoutEpochUsdc();
    renderScreen();
    await settle();

    await pickToken('pick-usdc');

    expect(screen.getByTestId('form-error')).toHaveTextContent(/^The bridge config names no USDC token\.$/);
  });

  it('asks for a network instead of naming Sepolia when no route has a chain', async () => {
    const snapshot = withoutEpochUsdc();
    mockBridgeSnapshot = {
      ...snapshot,
      config: {
        ...snapshot.config!,
        supportedEvmChains: Object.fromEntries(
          Object.entries(snapshot.config!.supportedEvmChains).map(([slug, chain]) => {
            const { usdcx: _usdcx, ...bridges } = chain.bridges;
            return [slug, { ...chain, bridges }];
          })
        )
      }
    };
    renderScreen();
    await settle();

    expect(screen.getByTestId('form-network')).toHaveTextContent(/^undefined$/);
  });

  it('shows the Fast/Slow picker again once ETH is chosen', async () => {
    // ETH bridges only through AggLayer, so its balance is read on that chain, which the suite's document lacks.
    const config = TEST_BRIDGE_CONFIG_SNAPSHOT.config!;
    const sepolia = config.supportedEvmChains.sepolia!;
    const agglayer: AgglayerChainConfig = {
      contractAddress: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582',
      midenBridgeId: '0x187cabbc',
      depositEnabled: true,
      withdrawalEnabled: true
    };
    mockBridgeSnapshot = {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: {
        ...config,
        supportedEvmChains: {
          ...config.supportedEvmChains,
          sepolia: { ...sepolia, bridges: { ...sepolia.bridges, agglayer } }
        }
      }
    };
    renderScreen();

    await pickToken('pick-circle-usdc');
    await pickToken('pick-eth');
    await reachRouteStep();

    expect(screen.getByTestId('fast-slow-route-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-route-confirm')).not.toBeInTheDocument();
  });

  it('reviews a USDC deposit as arriving in USDCx', async () => {
    renderScreen();

    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();

    expect(screen.getByTestId('review-symbols')).toHaveTextContent('USDC->USDCx');
  });

  it('creates a usdcx tracking row and runs the EVM leg with the encoded recipient', async () => {
    renderScreen();

    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledTimes(1);
    expect(initiateBridgedReceiveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'usdcx',
        sourceChainId: 5042002,
        faucetId: USDCX_FAUCET_ID_BECH32,
        amount: 1_500_000n,
        sourceAmount: '1.5',
        sourceSymbol: 'USDC',
        outputAmount: '1.5',
        outputSymbol: 'USDCx'
      })
    );
    expect(runUsdcxDeposit).toHaveBeenCalledTimes(1);
    expect(runUsdcxDeposit).toHaveBeenCalledWith(
      'bridge-tx',
      '1.5',
      '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400',
      expect.objectContaining({
        signer: expect.objectContaining({ approve: expect.any(Function), depositToRemote: expect.any(Function) }),
        isRemoteDomainRegistered: expect.any(Function),
        readAllowance: expect.any(Function),
        waitForReceipt: expect.any(Function),
        updatePhase: expect.any(Function)
      })
    );
  });

  it.each([
    ['receipt timeout', true, new Error('Receipt timeout'), false],
    ['receipt connection failure', true, new Error('RPC disconnected'), false],
    ['deposit revert', true, new EvmTransactionRevertedError('Arc Testnet'), true],
    ['wallet rejection', false, new Error('User rejected'), true]
  ])('handles %s without losing a pending deposit', async (_label, broadcast, error, failed) => {
    jest.mocked(runUsdcxDeposit).mockImplementationOnce(async (id, _amount, _recipient, deps) => {
      if (broadcast) await deps.updatePhase(id, 'submitting', { evmTxHash: `0x${'2'.repeat(64)}` });
      throw error;
    });
    renderScreen();
    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    const failedWrites = jest.mocked(updateBridgedReceivePhase).mock.calls.filter(([, phase]) => phase === 'failed');
    expect(failedWrites).toHaveLength(failed ? 1 : 0);
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      failed ? 'failed' : 'submitting',
      failed ? { error: error.message } : { evmTxHash: `0x${'2'.repeat(64)}` }
    );
  });

  it.each([false, true])('pins both signer calls and receipt reads to Arc (native=%s)', async native => {
    mockNativeAvailable = native;
    jest.mocked(runUsdcxDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
      await deps.isRemoteDomainRegistered(10007);
      await deps.signer.approve('0x008888878f94C0d87defdf0B07f46B93C1934442', 1_500_000n);
      const hash = await deps.signer.depositToRemote([
        1_500_000n,
        10007,
        recipient,
        '0x3600000000000000000000000000000000000000',
        0n,
        '0x'
      ]);
      await deps.waitForReceipt(hash);
      return hash;
    });
    renderScreen();
    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    const signer = native ? mockNativeSend : mockWriteContract;
    expect(signer).toHaveBeenCalledTimes(2);
    expect(signer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chainId: 5042002,
        [native ? 'to' : 'address']: '0x3600000000000000000000000000000000000000'
      })
    );
    expect(signer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chainId: 5042002,
        [native ? 'to' : 'address']: '0x008888878f94C0d87defdf0B07f46B93C1934442'
      })
    );
    expect(waitForEvmReceipt).toHaveBeenCalledWith(`0x${'2'.repeat(64)}`, expect.objectContaining({ id: 5042002 }));
    expect(registrationReadUrls('0x008888878f94C0d87defdf0B07f46B93C1934442')).toEqual(['https://rpc.test/5042002']);
    expect(mockSwitchChain.mock.calls).toEqual(native ? [] : [[{ chainId: 5042002 }]]);
    expect(jest.mocked(prepareNativeSessionChain).mock.calls).toEqual(native ? [[5042002]] : []);
  });

  it('fails a native deposit with the reconnect message before any prompt when the session did not approve Arc', async () => {
    mockNativeAvailable = true;
    jest
      .mocked(prepareNativeSessionChain)
      .mockRejectedValueOnce(new NativeSessionChainNotApprovedError(5042002, 'Arc Testnet'));
    jest.mocked(runUsdcxDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
      await deps.signer.approve('0x008888878f94C0d87defdf0B07f46B93C1934442', 1_500_000n);
      return deps.signer.depositToRemote([
        1_500_000n,
        10007,
        recipient,
        '0x3600000000000000000000000000000000000000',
        0n,
        '0x'
      ]);
    });
    renderScreen();
    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(mockNativeSend).not.toHaveBeenCalled();
    expect(prepareNativeSessionChain).toHaveBeenCalledWith(5042002);
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
      error: `evmChainNotApproved ${JSON.stringify({ network: 'Arc Testnet' })}`
    });
  });

  it('offers the source-chain picker with the configured routes', async () => {
    renderScreen();
    expect(screen.getByTestId('open-network-drawer')).toBeInTheDocument();
    await pickToken('pick-circle-usdc');
    fireEvent.click(screen.getByTestId('open-network-drawer'));
    await settle();
    expect(screen.getByTestId('pick-network-arc-testnet')).toBeInTheDocument();
    expect(screen.getByTestId('pick-network-sepolia')).toBeInTheDocument();
    expect(screen.getByTestId('pick-network-base-sepolia')).toBeInTheDocument();
    expect(screen.getByTestId('pick-network-arbitrum-sepolia')).toBeInTheDocument();
  });

  it.each([false, true])('burns through the fee entry point on an executor source (native=%s)', async native => {
    mockNativeAvailable = native;
    jest.mocked(runUsdcxExecutorDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
      await deps.isRemoteDomainRegistered(10007);
      await deps.signer.approve('0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A', 1_600_000n);
      const hash = await deps.signer.depositForBurnWithHookAndFees([
        1_500_000n,
        26,
        `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
        `0x${recipient.slice(2)}`,
        { signedQuote: '0x0102', refundAddress: deps.depositor }
      ]);
      await deps.waitForReceipt(hash);
      return hash;
    });
    renderScreen();
    await pickToken('pick-circle-usdc');
    fireEvent.click(screen.getByTestId('open-network-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-network-base-sepolia'));
    await settle();
    await reachRouteStep();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(runUsdcxDeposit).not.toHaveBeenCalled();
    expect(runUsdcxExecutorDeposit).toHaveBeenCalledWith(
      expect.any(String),
      '1.5',
      expect.any(String),
      expect.objectContaining({
        source: expect.objectContaining({ route: 'cctp-executor', chain: expect.objectContaining({ id: 84532 }) }),
        depositor: '0x1111111111111111111111111111111111111111'
      })
    );
    // The registration check reads Arc's xReserve, where the executor deposits, never the source chain.
    expect(registrationReadUrls('0x008888878f94C0d87defdf0B07f46B93C1934442')).toEqual(['https://rpc.test/5042002']);
    const signer = native ? mockNativeSend : mockWriteContract;
    expect(signer).toHaveBeenCalledTimes(2);
    expect(signer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chainId: 84532,
        [native ? 'to' : 'address']: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      })
    );
    expect(signer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chainId: 84532,
        [native ? 'to' : 'address']: '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'
      })
    );
    expect(waitForEvmReceipt).toHaveBeenCalledWith(`0x${'2'.repeat(64)}`, expect.objectContaining({ id: 84532 }));
    expect(mockSwitchChain.mock.calls).toEqual(native ? [] : [[{ chainId: 84532 }]]);
  });

  // Circle has not registered Miden on Sepolia's xReserve, so a Sepolia deposit burns through CCTP to the executor on
  // Arc, as Base and Arbitrum do; only the e2e build's Sepolia fork keeps the xReserve route.
  it.each([false, true])(
    'burns a Sepolia deposit through the executor on Arc, pinned to Sepolia (native=%s)',
    async native => {
      mockNativeAvailable = native;
      jest.mocked(runUsdcxExecutorDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
        await deps.isRemoteDomainRegistered(10007);
        await deps.signer.approve('0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A', 1_600_000n);
        const hash = await deps.signer.depositForBurnWithHookAndFees([
          1_500_000n,
          26,
          `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
          '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
          `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
          `0x${recipient.slice(2)}`,
          { signedQuote: '0x0102', refundAddress: deps.depositor }
        ]);
        await deps.waitForReceipt(hash);
        return hash;
      });
      renderScreen();
      await pickToken('pick-circle-usdc');
      fireEvent.click(screen.getByTestId('open-network-drawer'));
      await settle();
      fireEvent.click(screen.getByTestId('pick-network-sepolia'));
      await settle();
      // The balance of the chosen chain's USDC is read once the drawer closes.
      expect(global.fetch).toHaveBeenCalledWith('https://rpc.test/11155111', expect.any(Object));
      await reachRouteStep();
      fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
      await settle();
      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expect(runUsdcxDeposit).not.toHaveBeenCalled();
      expect(runUsdcxExecutorDeposit).toHaveBeenCalledWith(
        expect.any(String),
        '1.5',
        expect.any(String),
        expect.objectContaining({
          source: expect.objectContaining({ route: 'cctp-executor', chain: expect.objectContaining({ id: 11155111 }) })
        })
      );
      // Sepolia's xReserve shares Arc's address, so the URL is what proves the check read Arc, where the deposit lands.
      expect(registrationReadUrls('0x008888878f94C0d87defdf0B07f46B93C1934442')).toEqual(['https://rpc.test/5042002']);
      const signer = native ? mockNativeSend : mockWriteContract;
      expect(signer).toHaveBeenCalledTimes(2);
      expect(signer).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          chainId: 11155111,
          [native ? 'to' : 'address']: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
        })
      );
      expect(signer).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          chainId: 11155111,
          [native ? 'to' : 'address']: '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'
        })
      );
      expect(waitForEvmReceipt).toHaveBeenCalledWith(`0x${'2'.repeat(64)}`, expect.objectContaining({ id: 11155111 }));
      expect(mockSwitchChain.mock.calls).toEqual(native ? [] : [[{ chainId: 11155111 }]]);
    }
  );

  const reachBaseSepoliaRoute = async () => {
    await pickToken('pick-circle-usdc');
    fireEvent.click(screen.getByTestId('open-network-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-network-base-sepolia'));
    await settle();
    await reachRouteStep();
  };

  // There is no burn without a quote: the refusal fails the row with its own words and raises no wallet prompt.
  it('fails the row with the quote-unavailable message when Circle does not quote the burn', async () => {
    jest
      .mocked(runUsdcxExecutorDeposit)
      .mockRejectedValueOnce(new UsdcxForwardQuoteUnavailableError('the quote request failed'));
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(mockNativeSend).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith('bridge-tx', 'failed', {
      error: 'usdcxForwardQuoteUnavailable'
    });
  });

  it('shows the fee Circle quoted for the amount on screen on the route and the review', async () => {
    jest.mocked(quoteExecutorBurn).mockResolvedValue({ signedQuote: '0x01', feeTotalAmount: 31_908n });
    renderScreen();
    await reachBaseSepoliaRoute();

    expect(screen.getByTestId('usdcx-route-fee')).toHaveTextContent('usdcxForwardFee');
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-fee')).toHaveTextContent('0.031908');
  });

  // A burst of keystrokes asks Circle once, for the amount the user settled on; a fee quoted for another amount
  // never reaches the card.
  it('asks Circle for the debounced amount and shows no fee for an amount it was not quoted for', async () => {
    mockUseDebounce.mockImplementation((value: unknown) => [value === '1.5' ? '1.2' : value]);
    jest.mocked(quoteExecutorBurn).mockResolvedValue({ signedQuote: '0x01', feeTotalAmount: 31_908n });
    renderScreen();
    await reachBaseSepoliaRoute();

    expect(buildExecutorBurnIntent).toHaveBeenCalledWith(
      '1.2',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(buildExecutorBurnIntent).not.toHaveBeenCalledWith(
      '1.5',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(screen.queryByTestId('usdcx-route-fee')).toBeNull();
  });

  /** The refusal of a 1.5 USDC deposit and Circle's 31,908-unit fee against `balance`, as the suite's `t` prints it. */
  const feeAboveBalance = (balance: string) =>
    `usdcxDepositFeeAboveBalance ${JSON.stringify({
      total: '1.531908',
      fee: '0.031908',
      balance,
      token: 'USDC',
      network: 'Sepolia'
    })}`;
  const FEE_QUOTE: CctpBurnQuote = { signedQuote: '0x01', feeTotalAmount: 31_908n };
  const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const BALANCE_OF_SELECTOR = toFunctionSelector('balanceOf(address)');

  // The executor refuses a balance short of the amount plus the fee before any prompt; the row says what the deposit
  // needs and what to do about it.
  it("fails the row with the fee-above-balance message when the balance cannot pay Circle's fee", async () => {
    jest
      .mocked(runUsdcxExecutorDeposit)
      .mockRejectedValueOnce(new UsdcxExecutorBalanceTooLowError(1_531_908n, 31_908n, 1_520_000n));
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(mockNativeSend).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith('bridge-tx', 'failed', {
      error: feeAboveBalance('1.52')
    });
  });

  it('hands the executor a read of the Circle USDC balance on the source chain', async () => {
    mockBalance = 2_000_000n;
    const read: { value?: bigint; requests?: unknown[] } = {};
    jest.mocked(runUsdcxExecutorDeposit).mockImplementationOnce(async (_id, _amount, _recipient, deps) => {
      const before = jest.mocked(global.fetch).mock.calls.length;
      read.value = await deps.readBalance();
      read.requests = jest
        .mocked(global.fetch)
        .mock.calls.slice(before)
        .map(([url, init]) => [url, JSON.parse(String(init?.body ?? '{}')).params?.[0]]);
      return `0x${'2'.repeat(64)}`;
    });
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(read.value).toBe(2_000_000n);
    expect(read.requests).toEqual([
      [
        'https://rpc.test/84532',
        { to: BASE_SEPOLIA_USDC, data: expect.stringMatching(new RegExp(`^${BALANCE_OF_SELECTOR}`)) }
      ]
    ]);
  });

  // The burn pulls Circle's fee on top of the amount, so once the fee is on screen Confirm holds on a balance that
  // covers only the amount, with the words the deposit would fail with.
  it('holds the route card on an amount whose displayed fee takes it past the balance', async () => {
    jest.mocked(quoteExecutorBurn).mockResolvedValue(FEE_QUOTE);
    mockBalance = TYPED + FEE_QUOTE.feeTotalAmount - 1n;
    renderScreen();
    await reachBaseSepoliaRoute();

    expect(screen.getByTestId('usdcx-route-fee')).toHaveTextContent('usdcxForwardFee');
    expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(feeAboveBalance('1.531907'));
    expect(screen.getByTestId('usdcx-route-confirm')).toBeDisabled();
  });

  it('holds the review and says why when the fee lands after the route card', async () => {
    let answerQuote: (quote: CctpBurnQuote) => void = () => undefined;
    jest.mocked(quoteExecutorBurn).mockImplementation(
      () =>
        new Promise<CctpBurnQuote>(resolve => {
          answerQuote = resolve;
        })
    );
    mockBalance = TYPED + FEE_QUOTE.feeTotalAmount - 1n;
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-can-confirm')).toHaveTextContent(/^true$/);

    await act(async () => answerQuote(FEE_QUOTE));
    await settle();

    expect(screen.getByTestId('review-fee')).toHaveTextContent('0.031908');
    expect(screen.getByTestId('review-error').textContent).toBe(feeAboveBalance('1.531907'));
    expect(screen.getByTestId('review-can-confirm')).toHaveTextContent(/^false$/);
  });

  it('runs an executor deposit whose amount plus the displayed fee is exactly the balance', async () => {
    jest.mocked(quoteExecutorBurn).mockResolvedValue(FEE_QUOTE);
    mockBalance = TYPED + FEE_QUOTE.feeTotalAmount;
    renderScreen();
    await reachBaseSepoliaRoute();

    expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(
      `usdcxExecutorRouteNotice ${JSON.stringify({ source: 'Base Sepolia', target: 'Arc Testnet' })}`
    );
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-error')).toBeEmptyDOMElement();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(runUsdcxExecutorDeposit).toHaveBeenCalledTimes(1);
    expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());
  });

  // xReserve takes no fee: Circle is never asked, and a deposit of the whole balance runs.
  it('runs an Arc deposit of the whole balance with no Circle fee to cover', async () => {
    jest.mocked(quoteExecutorBurn).mockResolvedValue(FEE_QUOTE);
    mockBalance = TYPED;
    renderScreen();
    await reachUsdcxRoute();

    expect(screen.queryByTestId('usdcx-route-fee')).toBeNull();
    expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(quoteExecutorBurn).not.toHaveBeenCalled();
    expect(runUsdcxDeposit).toHaveBeenCalledTimes(1);
    expect(jest.mocked(runUsdcxDeposit).mock.calls[0][3]).not.toHaveProperty('readBalance');
    expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());
  });

  // The reconciler re-derives the recipient with the same helper, so the bytes a deposit signs are the bytes Circle's
  // attestation is matched against.
  it('signs an xReserve deposit for the recipient usdcxRemoteRecipientFor derives from the account', async () => {
    jest.mocked(usdcxRemoteRecipientFor).mockReturnValue(SIGNED_RECIPIENT);
    renderScreen();
    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(usdcxRemoteRecipientFor).toHaveBeenCalledWith(midenAccount.publicKey);
    expect(runUsdcxDeposit).toHaveBeenCalledWith('bridge-tx', '1.5', SIGNED_RECIPIENT, expect.anything());
  });

  it('quotes and burns an executor deposit for the recipient usdcxRemoteRecipientFor derives', async () => {
    jest.mocked(usdcxRemoteRecipientFor).mockReturnValue(SIGNED_RECIPIENT);
    renderScreen();
    await reachBaseSepoliaRoute();

    expect(buildExecutorBurnIntent).toHaveBeenCalledWith(
      '1.5',
      expect.objectContaining({ route: 'cctp-executor' }),
      SIGNED_RECIPIENT,
      '0x1111111111111111111111111111111111111111'
    );
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(usdcxRemoteRecipientFor).toHaveBeenCalledWith(midenAccount.publicKey);
    expect(runUsdcxExecutorDeposit).toHaveBeenCalledWith(
      expect.any(String),
      '1.5',
      SIGNED_RECIPIENT,
      expect.anything()
    );
  });

  // Each source has its own arrival estimate, so the route card and the review are told which chain the deposit leaves.
  it('hands the Arc Testnet source to the route card and the review', async () => {
    renderScreen();
    await reachUsdcxRoute();
    expect(screen.getByTestId('usdcx-route-source')).toHaveTextContent('5042002');
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-source')).toHaveTextContent('5042002');
  });

  it('hands an executor source to the route card and the review', async () => {
    renderScreen();
    await reachBaseSepoliaRoute();
    expect(screen.getByTestId('usdcx-route-source')).toHaveTextContent('84532');
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-source')).toHaveTextContent('84532');
  });

  // One picked chain; each route resolves its own from it, so a USDCx-only chain does not strand the Fast route.
  it('keeps the Fast route on its own chain after a USDCx-only pick', async () => {
    renderScreen();
    await pickToken('pick-circle-usdc');
    fireEvent.click(screen.getByTestId('open-network-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-network-base-sepolia'));
    await settle();
    await pickToken('pick-usdc');
    expect(screen.getByTestId('form-network')).toHaveTextContent('11155111');
    await reachRouteStep();

    expect(screen.getByTestId('fast-availability')).toHaveTextContent('available');
    expect(epochState.quoteEVMToMiden).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChainId: 11155111 }),
      expect.any(String)
    );
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

  // Both routes approve once before their deposit prompt.
  it.each(
    (['xreserve', 'cctp-executor'] as const).flatMap(route =>
      [false, true].flatMap(native =>
        (['answered', 'rejected'] as const).map(outcome => [route, native, outcome] as const)
      )
    )
  )(
    'shows the second-confirmation wait on a %s deposit until its last prompt is answered (native=%s, %s)',
    async (route, native, outcome) => {
      mockNativeAvailable = native;
      const signed = `0x${'2'.repeat(64)}` as const;
      const approvals = 1;
      const receipt = deferred<void>();
      const prompt = deferred<`0x${string}`>();
      jest.mocked(waitForEvmReceipt).mockReturnValueOnce(receipt.promise);
      const walletPrompt = native ? mockNativeSend : mockWriteContract;
      for (let i = 0; i < approvals; i++) walletPrompt.mockResolvedValueOnce(native ? { hash: signed } : signed);
      if (native) mockNativeSend.mockImplementationOnce(async () => ({ hash: await prompt.promise }));
      else mockWriteContract.mockReturnValueOnce(prompt.promise);
      if (route === 'xreserve') {
        jest.mocked(runUsdcxDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
          await deps.waitForReceipt(
            await deps.signer.approve('0x008888878f94C0d87defdf0B07f46B93C1934442', 1_500_000n)
          );
          return deps.signer.depositToRemote([
            1_500_000n,
            10007,
            recipient,
            '0x3600000000000000000000000000000000000000',
            0n,
            '0x'
          ]);
        });
      } else {
        jest.mocked(runUsdcxExecutorDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
          await deps.waitForReceipt(await deps.signer.approve(deps.source.tokenMessengerWithFees, 1_600_000n));
          return deps.signer.depositForBurnWithHookAndFees([
            1_500_000n,
            26,
            `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
            '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            `0x${'0'.repeat(24)}edc81040756accff070c21d37b265b9d0b5ba45e`,
            `0x${recipient.slice(2)}`,
            { signedQuote: '0x0102', refundAddress: deps.depositor }
          ]);
        });
      }
      renderScreen();
      if (route === 'xreserve') await reachUsdcxRoute();
      else await reachBaseSepoliaRoute();
      fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
      await settle();
      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      const status = await screen.findByTestId('deposit-status');
      await waitFor(() => expect(status).toHaveAttribute('data-awaiting', 'true'));
      expect(walletPrompt).toHaveBeenCalledTimes(1);
      await act(async () => receipt.resolve(undefined));
      await waitFor(() => expect(walletPrompt).toHaveBeenCalledTimes(approvals + 1));
      expect(status).toHaveAttribute('data-awaiting', 'true');
      await act(async () =>
        outcome === 'answered' ? prompt.resolve(signed) : prompt.reject(new Error('User rejected'))
      );
      await waitFor(() => expect(status).toHaveAttribute('data-awaiting', 'false'));
      const failedWrites = jest.mocked(updateBridgedReceivePhase).mock.calls.filter(([, phase]) => phase === 'failed');
      expect(failedWrites).toEqual(outcome === 'rejected' ? [['bridge-tx', 'failed', { error: 'User rejected' }]] : []);
    }
  );

  // #1431: an approval never checks the balance, so a deposit above it failed only at the wallet's last prompt.
  it('holds Continue and says so for an amount above the Circle USDC balance', async () => {
    mockBalance = TYPED - 1n;
    renderScreen();

    await reachUsdcxRoute();

    expect(screen.getByTestId('form-ready')).toHaveTextContent(/^false$/);
    expect(screen.getByTestId('form-error')).toHaveTextContent(/^amountMustBeLessThanBalance$/);
    expect(screen.queryByTestId('usdcx-route-confirm')).not.toBeInTheDocument();
  });

  it.each(
    (['xreserve', 'cctp-executor'] as const).flatMap(route => [false, true].map(native => [route, native] as const))
  )(
    'raises no prompt and fails the row when the balance falls under a %s deposit before Confirm (native=%s)',
    async (route, native) => {
      mockNativeAvailable = native;
      renderScreen();
      if (route === 'xreserve') await reachUsdcxRoute();
      else await reachBaseSepoliaRoute();
      fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
      await settle();
      mockBalance = TYPED - 1n;

      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expect(runUsdcxDeposit).not.toHaveBeenCalled();
      expect(runUsdcxExecutorDeposit).not.toHaveBeenCalled();
      expect(mockNativeSend).not.toHaveBeenCalled();
      expect(mockWriteContract).not.toHaveBeenCalled();
      expect(mockSwitchChain).not.toHaveBeenCalled();
      // Adding and switching the chain is a wallet prompt too, so the balance is checked first.
      expect(prepareNativeSessionChain).not.toHaveBeenCalled();
      // The suite's chain stub names every chain but Arc "Sepolia", Base Sepolia included.
      const network = route === 'xreserve' ? 'Arc Testnet' : 'Sepolia';
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
        error: `bridgeDepositBalanceTooLow ${JSON.stringify({ balance: '1.4999', token: 'USDC', network })}`
      });
    }
  );

  it('runs a deposit equal to the Circle USDC balance', async () => {
    mockBalance = TYPED;
    renderScreen();
    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(runUsdcxDeposit).toHaveBeenCalledTimes(1);
    expect(updateBridgedReceivePhase).not.toHaveBeenCalledWith('bridge-tx', 'failed', expect.anything());
  });

  const ANOTHER_WALLET = '0x00000000000000000000000000000000000000e2';
  const EXECUTOR_NOTICE = `usdcxExecutorRouteNotice ${JSON.stringify({ source: 'Base Sepolia', target: 'Arc Testnet' })}`;
  const reachRoute = (route: 'xreserve' | 'cctp-executor') =>
    route === 'xreserve' ? reachUsdcxRoute() : reachBaseSepoliaRoute();

  type HeldRead = [route: 'xreserve' | 'cctp-executor', read: string, answer: () => void, notice: string];
  it.each<HeldRead>(
    (['xreserve', 'cctp-executor'] as const).flatMap((route): HeldRead[] => [
      [route, 'is pending', () => (global.fetch = jest.fn(() => new Promise(() => undefined)) as never), 'loading'],
      [
        route,
        'failed',
        () =>
          (global.fetch = jest
            .fn()
            .mockResolvedValue({ json: async () => ({ error: { message: 'rpc down' } }) }) as never),
        'rpc down'
      ],
      [route, 'is below the amount', () => (mockBalance = TYPED - 1n), 'amountMustBeLessThanBalance']
    ])
  )(
    'says on the %s route step why Confirm is held while the Circle USDC balance read for another wallet %s',
    async (route, _read, answer, notice) => {
      const { rerender } = render(depositScreen());
      await reachRoute(route);
      expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();

      answer();
      rerender(depositScreen(ANOTHER_WALLET));
      await settle();

      expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(notice);
      expect(screen.getByTestId('usdcx-route-confirm')).toBeDisabled();
    }
  );

  it('keeps the executor route notice for another wallet whose Circle USDC balance covers the amount', async () => {
    const { rerender } = render(depositScreen());
    await reachRoute('cctp-executor');
    expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(EXECUTOR_NOTICE);

    rerender(depositScreen(ANOTHER_WALLET));
    await settle();

    expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(EXECUTOR_NOTICE);
    expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();
  });
});
