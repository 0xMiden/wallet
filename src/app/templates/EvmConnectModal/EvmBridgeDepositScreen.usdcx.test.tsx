import React from 'react';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toFunctionSelector } from 'viem';

import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import { installProviderReceiptBackend } from 'lib/miden/recovery/receipt-backend';
import * as Repo from 'lib/miden/repo';
import { getStorageHealth } from 'lib/miden/storage-health';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { AgglayerChainConfig, UsdcxChainConfig } from 'lib/remote-config/schema';
import { requestTimeoutError } from 'lib/remote-json';
import { bridgeReceiveLibraryError } from 'lib/telemetry/bridge-receive-failure';
import type { CctpBurnQuote } from 'lib/usdcx/cctp';
import { runUsdcxDeposit, UsdcxDomainNotRegisteredError } from 'lib/usdcx/deposit';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import {
  buildExecutorBurnIntent,
  quoteExecutorBurn,
  runUsdcxExecutorDeposit,
  UsdcxExecutorBalanceTooLowError,
  type UsdcxExecutorDepositDeps,
  UsdcxForwardQuoteUnavailableError
} from 'lib/usdcx/executor';
import { NativeSessionChainNotApprovedError, prepareNativeSessionChain } from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, waitForEvmReceipt } from 'lib/walletconnect/receipt';

import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

// The suite's document unless a case sets another before it renders, or publishes one mid-flow.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
const mockConfigListeners = new Set<() => void>();
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    mockBridgeSnapshot ??
    jest.requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
      .TEST_BRIDGE_CONFIG_SNAPSHOT,
  subscribeBridgeConfig: (listener: () => void) => {
    mockConfigListeners.add(listener);
    return () => {
      mockConfigListeners.delete(listener);
    };
  },
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
    t: (key: string, values?: Record<string, unknown>) =>
      mockRealBridgeDisplays && mockBridgeErrorCopy[key]
        ? `${mockBridgeErrorCopy[key]}${values ? ' ' + JSON.stringify(values) : ''}`
        : values
          ? `${key} ${JSON.stringify(values)}`
          : key
  })
}));

// The web wallet's provider, connected unless a case takes it away.
let mockWebProviderConnected = true;
jest.mock('@reown/appkit/react', () => ({
  useAppKitProvider: () => ({ walletProvider: mockWebProviderConnected ? { request: jest.fn() } : undefined })
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

let mockSubmissionComplete = () => {};
jest.mock('lib/miden/activity/bridge-receive', () => {
  const actual = jest.requireActual<typeof import('lib/miden/activity/bridge-receive')>(
    'lib/miden/activity/bridge-receive'
  );
  return {
    ...actual,
    startBridgeReceiveSubmission: (create: () => Promise<string>, drive: (id: string) => Promise<void>) =>
      actual.startBridgeReceiveSubmission(create, async id => {
        try {
          await drive(id);
        } finally {
          mockSubmissionComplete();
        }
      })
  };
});

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
  isUsdcxDomainNotRegisteredError:
    jest.requireActual<typeof import('lib/usdcx/deposit')>('lib/usdcx/deposit').isUsdcxDomainNotRegisteredError,
  UsdcxDomainNotRegisteredError:
    jest.requireActual<typeof import('lib/usdcx/deposit')>('lib/usdcx/deposit').UsdcxDomainNotRegisteredError
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
  usdcxExecutorFeeShortfall:
    jest.requireActual<typeof import('lib/usdcx/executor')>('lib/usdcx/executor').usdcxExecutorFeeShortfall,
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

const mockMobileBackHandlers = new Set<() => boolean | void>();
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: (handler: () => boolean | void, deps: React.DependencyList) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => {
      mockMobileBackHandlers.add(handler);
      return () => {
        mockMobileBackHandlers.delete(handler);
      };
      // Match the production hook: re-register when the caller’s declared dependencies change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
  }
}));
const pressMobileBack = () => {
  for (const handler of [...mockMobileBackHandlers].reverse()) if (handler() === true) return true;
  return false;
};

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

// Each chain has its own name, so a message that names the wrong chain fails.
jest.mock('lib/walletconnect/config', () => {
  const names: Record<number, string> = {
    84532: 'Base Sepolia',
    421614: 'Arbitrum Sepolia',
    11155111: 'Sepolia',
    5042002: 'Arc Testnet'
  };
  return {
    ...jest.requireActual('lib/walletconnect/config'),
    DEFAULT_CHAIN_ID: 11155111,
    getChain: (id: number) => ({ rpcUrl: `https://rpc.test/${id}`, name: names[id] ?? `Chain ${id}` })
  };
});

jest.mock('./EvmBridgeDepositForm', () => {
  const legacy = (() => ({
    EvmBridgeDepositForm: ({
      onAmountChange,
      onContinue,
      onSelectToken,
      onSelectNetwork,
      network,
      tokenLabel,
      isValidAmount,
      error
    }: {
      network?: { chainId: number };
      tokenLabel: string;
      isValidAmount: boolean;
      error?: string;
      onAmountChange: (value: string) => void;
      onContinue: () => void;
      onSelectToken: () => void;
      onSelectNetwork?: () => void;
    }) => (
      <div>
        <span data-testid="form-token">{tokenLabel}</span>
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

jest.mock('./EvmBridgeDepositReview', () => {
  const legacy = (() => {
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
  })();
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
      <div data-testid="deposit-status" data-awaiting={String(awaitingNextConfirmation ?? false)} />
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

jest.mock('./EvmBridgeTokenDrawer', () => ({
  EvmBridgeTokenDrawer: ({
    open,
    onSelect,
    epochRows
  }: {
    open: boolean;
    onSelect: (token: 'ETH' | 'CIRCLE_USDC' | 'USDC' | { kind: 'epoch'; key: string }) => void;
    epochRows?: readonly { key: string }[];
  }) =>
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
        {(epochRows ?? []).map(row => (
          <button
            key={row.key}
            data-testid={`pick-epoch-${row.key}`}
            onClick={() => onSelect({ kind: 'epoch', key: row.key })}
          >
            {row.key}
          </button>
        ))}
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
    sourceChainId,
    fast
  }: {
    confirmDisabled?: boolean;
    onConfirm: () => void;
    fee?: string;
    notice?: string;
    sourceChainId: number;
    fast?: { onSelect: () => void };
  }) => (
    <div>
      {fee && <span data-testid="usdcx-route-fee">{fee}</span>}
      <span data-testid="usdcx-route-notice">{notice}</span>
      <span data-testid="usdcx-route-source">{String(sourceChainId)}</span>
      {fast && (
        <button data-testid="circle-fast" onClick={fast.onSelect}>
          fast
        </button>
      )}
      <button data-testid="usdcx-route-confirm" disabled={confirmDisabled} onClick={onConfirm}>
        usdcx
      </button>
    </div>
  )
}));

jest.mock('screens/send-flow/Route', () => ({
  Route: ({
    onConfirm,
    onRouteChange,
    fastAvailability
  }: {
    onConfirm: () => void;
    onRouteChange: (route: 'epoch') => void;
    fastAvailability: { state: string };
  }) => (
    <div>
      <span data-testid="fast-availability">{fastAvailability.state}</span>
      <button data-testid="pick-fast" onClick={() => onRouteChange('epoch')}>
        fast
      </button>
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

const mockCloseDeposit = jest.fn();
const depositScreen = (evmAddress = '0x1111111111111111111111111111111111111111') => (
  <EvmBridgeDepositScreen
    evmAddress={evmAddress}
    midenAccount={midenAccount as never}
    onConnectAnother={jest.fn()}
    onClose={mockCloseDeposit}
  />
);

const renderScreen = () => render(depositScreen());

// The failure write the screen makes: the row's text, and the step and error its crash report names.
// A balance the check refused for its amount, or could not read; every other failure carries no balance check.
const BALANCE_CHECK_OF: Record<string, string> = {
  bridgeDepositBalanceTooLow: 'too_low',
  usdcxDepositFeeAboveBalance: 'too_low',
  bridgeDepositBalanceReadFailed: 'read_failed'
};
const failedAt = (
  step: string,
  error: string,
  errorId = 'raw_bridge_deposit_failed',
  requestClient?: 'native_reown' | 'wagmi'
) => ({
  error,
  errorId,
  failure: {
    step,
    cause: expect.any(Error),
    ...(BALANCE_CHECK_OF[errorId] === undefined ? {} : { balanceCheck: BALANCE_CHECK_OF[errorId] }),
    ...(requestClient === undefined ? {} : { requestClient })
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

/** USDC is the default token: amount, continue, and the route step is up. */
const pickToken = async (testId: 'pick-eth' | 'pick-circle-usdc' | 'pick-usdc') => {
  fireEvent.click(screen.getByTestId('open-token-drawer'));
  await settle();
  fireEvent.click(screen.getByTestId(testId));
  await settle();
};

/** Picks the source network `id` in the network drawer. */
const pickNetwork = async (id: string) => {
  fireEvent.click(screen.getByTestId('open-network-drawer'));
  await settle();
  fireEvent.click(screen.getByTestId(`pick-network-${id}`));
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
    mockWebProviderConnected = true;
  });

  it('opens on Circle USDC even while the config still advertises the retired Epoch token', async () => {
    renderScreen();
    await settle();
    expect(screen.getByTestId('form-network')).toHaveTextContent(/^5042002$/);
    await reachRouteStep();
    expect(screen.getByTestId('usdcx-route-confirm')).toBeInTheDocument();
    expect(epochState.quoteEVMToMiden).not.toHaveBeenCalled();
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

  it('ignores attempts to select the retired Epoch token', async () => {
    mockBridgeSnapshot = withoutEpochUsdc();
    renderScreen();
    await settle();

    await pickToken('pick-usdc');

    expect(screen.getByTestId('form-network')).toHaveTextContent(/^5042002$/);
    expect(screen.getByTestId('form-error')).toHaveTextContent(/^$/);
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

  it('opens on native ETH rather than retired USDC when Circle has no configured source', async () => {
    const config = TEST_BRIDGE_CONFIG_SNAPSHOT.config!;
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
        supportedEvmChains: Object.fromEntries(
          Object.entries(config.supportedEvmChains).map(([slug, chain]) => {
            const { usdcx: _usdcx, ...bridges } = chain.bridges;
            return [slug, { ...chain, bridges: slug === 'sepolia' ? { ...bridges, agglayer } : bridges }];
          })
        )
      }
    };
    renderScreen();
    await settle();
    expect(screen.getByTestId('form-token')).toHaveTextContent(/^ETH$/);
    expect(screen.getByTestId('form-network')).toHaveTextContent(/^11155111$/);
    expect(epochState.quoteEVMToMiden).not.toHaveBeenCalled();
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
    // ETH is offered on the chain that has the AggLayer route, so that chain is picked first.
    await pickNetwork('sepolia');
    await pickToken('pick-eth');
    await reachRouteStep();

    expect(screen.getByTestId('fast-slow-route-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('usdcx-route-confirm')).not.toBeInTheDocument();
  });

  // ETH bridges only through AggLayer; these cases name it on Sepolia, which the suite's document lacks.
  const AGGLAYER: AgglayerChainConfig = {
    contractAddress: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582',
    midenBridgeId: '0x187cabbc',
    depositEnabled: true,
    withdrawalEnabled: true
  };
  /** `snapshot` with AggLayer ETH on Sepolia and each chain's Circle route passed through `circle`. */
  const withAgglayerEth = (
    snapshot: BridgeConfigSnapshot,
    circle: (route: UsdcxChainConfig) => UsdcxChainConfig | undefined
  ): BridgeConfigSnapshot => ({
    ...snapshot,
    config: {
      ...snapshot.config!,
      supportedEvmChains: Object.fromEntries(
        Object.entries(snapshot.config!.supportedEvmChains).map(([slug, chain]) => {
          const { usdcx, ...bridges } = chain.bridges;
          const route = usdcx && circle(usdcx);
          return [
            slug,
            {
              ...chain,
              bridges: {
                ...bridges,
                ...(route ? { usdcx: route } : {}),
                ...(slug === 'sepolia' ? { agglayer: AGGLAYER } : {})
              }
            }
          ];
        })
      )
    }
  });
  const publish = (next: BridgeConfigSnapshot) =>
    act(() => {
      mockBridgeSnapshot = next;
      mockConfigListeners.forEach(listener => listener());
    });

  it('opens on native ETH and the AggLayer route when Circle deposits are switched off on a named source', async () => {
    mockBridgeSnapshot = withAgglayerEth(TEST_BRIDGE_CONFIG_SNAPSHOT, route => ({ ...route, depositEnabled: false }));
    renderScreen();
    await settle();

    expect(screen.getByTestId('form-token')).toHaveTextContent(/^ETH$/);
    expect(screen.getByTestId('form-network')).toHaveTextContent(/^11155111$/);
  });

  it('moves to the AggLayer route once its chain is picked and ETH chosen, and continues', async () => {
    mockBridgeSnapshot = withAgglayerEth(withoutEpochUsdc(), route => route);
    renderScreen();
    await settle();
    expect(screen.getByTestId('form-network')).toHaveTextContent(/^5042002$/);

    await pickNetwork('sepolia');
    await pickToken('pick-eth');
    expect(screen.getByTestId('form-network')).toHaveTextContent(/^11155111$/);
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    expect(screen.getByTestId('form-ready')).toHaveTextContent(/^true$/);
    fireEvent.click(screen.getByTestId('continue'));
    await settle();

    expect(screen.getByTestId('fast-slow-route-confirm')).toBeInTheDocument();
  });

  it('keeps the token, the route and the quote of a deposit on Review when a publish drops the Circle source', async () => {
    mockBridgeSnapshot = withAgglayerEth(TEST_BRIDGE_CONFIG_SNAPSHOT, route => route);
    renderScreen();
    await reachRouteStep();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('review-symbols')).toHaveTextContent('USDC->USDCx');
    epochState.reset.mockClear();

    publish(withAgglayerEth(TEST_BRIDGE_CONFIG_SNAPSHOT, () => undefined));
    await settle();

    expect(screen.getByTestId('confirm-deposit')).toBeInTheDocument();
    expect(screen.getByTestId('review-symbols')).toHaveTextContent('USDC->USDCx');
    expect(epochState.reset).not.toHaveBeenCalled();
  });

  it('reviews a USDC deposit as arriving in USDCx', async () => {
    renderScreen();

    await reachUsdcxRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();

    expect(screen.getByTestId('review-symbols')).toHaveTextContent('USDC->USDCx');
  });

  it.each([
    ['owner', false, false],
    ['owner', true, false],
    ['catch', false, true],
    ['catch', true, true]
  ] satisfies [string, boolean, boolean][])(
    'Task4C2 supplemental USDCx %s preserves attempted source after native=%s wallet response loss',
    async (_boundary, native, directGate) => {
      await Repo.db.open();
      mockNativeAvailable = native;
      installProviderReceiptBackend(async () => {});
      let createdId = '';
      let observedAttempt: unknown;
      let complete = () => {};
      const finished = new Promise<void>(resolve => {
        complete = resolve;
      });
      mockSubmissionComplete = complete;
      const initiate = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
        'lib/miden/transaction/initiate'
      ).initiateBridgedReceiveTransaction;
      const update = jest.requireActual<typeof import('lib/miden/transaction/complete')>(
        'lib/miden/transaction/complete'
      ).updateBridgedReceivePhase;
      jest.mocked(initiateBridgedReceiveTransaction).mockImplementation(async args => {
        createdId = await initiate(args);
        return createdId;
      });
      jest.mocked(updateBridgedReceivePhase).mockImplementation(update);
      const loseResponse = async () => {
        observedAttempt = (await Repo.transactions.get(createdId))?.extraInputs.sourceSubmission;
        throw new Error('Wallet response lost');
      };
      mockWriteContract.mockImplementation(loseResponse);
      mockNativeSend.mockImplementation(loseResponse);
      jest
        .mocked(runUsdcxDeposit)
        .mockImplementation((id, amount, recipient, deps) =>
          jest
            .requireActual<typeof import('lib/usdcx/deposit')>('lib/usdcx/deposit')
            .runUsdcxDeposit(id, amount, recipient, { ...deps, updatePhase: directGate ? update : deps.updatePhase })
        );
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: jest.fn(async (_url: string, init?: RequestInit) => {
          const call = JSON.parse(String(init?.body ?? '{}')).params?.[0];
          const registration = String(call?.data).startsWith(REGISTRATION_SELECTOR);
          return { json: async () => ({ result: word(registration ? 1n : mockBalance) }) };
        })
      });
      const rendered = renderScreen();
      try {
        await reachUsdcxRoute();
        fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
        await settle();
        fireEvent.click(screen.getByTestId('confirm-deposit'));
        await act(async () => {
          await finished;
        });
        expect(mockWriteContract.mock.calls.length + mockNativeSend.mock.calls.length).toBe(1);
        expect(observedAttempt).toBe('attempted');
        const row = await Repo.transactions.get(createdId);
        expect(row?.extraInputs.phase).toBe('submitting');
        expect(row?.extraInputs.sourceSubmission).toBe('attempted');
        expect(row?.extraInputs.evmTxHash).toBeUndefined();
        expect(getStorageHealth().status).toBe('healthy');
      } finally {
        mockSubmissionComplete = () => {};
        rendered.unmount();
        installProviderReceiptBackend(undefined);
        mockNativeAvailable = false;
        jest.mocked(initiateBridgedReceiveTransaction).mockReset().mockResolvedValue('bridge-tx');
        jest.mocked(updateBridgedReceivePhase).mockReset().mockResolvedValue(undefined);
      }
    }
  );
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
    // The stub throws once the screen recorded the deposit, or before any step but the route's own setup.
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      failed ? 'failed' : 'submitting',
      failed
        ? {
            error: error.message,
            errorId: 'raw_bridge_deposit_failed',
            failure: { step: broadcast ? 'deposit_receipt' : 'precheck_route', cause: error }
          }
        : { evmTxHash: `0x${'2'.repeat(64)}` }
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
    expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
      'bridge-tx',
      'failed',
      failedAt(
        'precheck_session_chain',
        `evmChainNotApproved ${JSON.stringify({ network: 'Arc Testnet' })}`,
        'evmChainNotApproved'
      )
    );
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
  // Arc, as Base and Arbitrum do; only an e2e build with MIDEN_E2E_USDCX_CHAIN=sepolia keeps the xReserve route.
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
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_quote', 'usdcxForwardQuoteUnavailable', 'usdcxForwardQuoteUnavailable')
    );
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
  const feeAboveBalance = (balance: string, network: string) =>
    `usdcxDepositFeeAboveBalance ${JSON.stringify({
      total: '1.531908',
      fee: '0.031908',
      balance,
      token: 'USDC',
      network
    })}`;
  const FEE_QUOTE: CctpBurnQuote = { signedQuote: '0x01', feeTotalAmount: 31_908n };
  const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const BALANCE_OF_SELECTOR = toFunctionSelector('balanceOf(address)');
  const balanceOfRequests = () =>
    jest
      .mocked(global.fetch)
      .mock.calls.filter(([, init]) =>
        String(JSON.parse(String(init?.body ?? '{}')).params?.[0]?.data).startsWith(BALANCE_OF_SELECTOR)
      );
  /** The next executor deposit runs the real executor, with Circle's quote and Arc's registration answered here. */
  const runRealExecutor = (overrides: Partial<UsdcxExecutorDepositDeps> = {}) =>
    jest.mocked(runUsdcxExecutorDeposit).mockImplementationOnce((id, amount, recipient, deps) =>
      jest
        .requireActual<typeof import('lib/usdcx/executor')>('lib/usdcx/executor')
        .runUsdcxExecutorDeposit(id, amount, recipient, {
          ...deps,
          isRemoteDomainRegistered: async () => true,
          fetchQuote: async () => FEE_QUOTE,
          ...overrides
        })
    );

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
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_balance', feeAboveBalance('1.52', 'Base Sepolia'), 'usdcxDepositFeeAboveBalance')
    );
  });

  it('hands the executor a read of the Circle USDC balance on the source chain, not the amount step value', async () => {
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
    mockBalance = 3_000_000n;
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(read.value).toBe(3_000_000n);
    expect(read.requests).toEqual([
      [
        'https://rpc.test/84532',
        { to: BASE_SEPOLIA_USDC, data: expect.stringMatching(new RegExp(`^${BALANCE_OF_SELECTOR}`)) }
      ]
    ]);
  });

  // Switching the chain can wait on the user, so the balance held to the fee is read after it.
  it('reads the balance before the chain step and again after it', async () => {
    runRealExecutor();
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    const before = balanceOfRequests().length;
    const readsSinceConfirm = () => balanceOfRequests().length - before;
    const reads: { atChainStep?: number; atBurn?: number } = {};
    mockSwitchChain.mockImplementationOnce(async () => {
      reads.atChainStep = readsSinceConfirm();
    });
    mockWriteContract.mockImplementationOnce(async () => {
      reads.atBurn = readsSinceConfirm();
      return `0x${'2'.repeat(64)}`;
    });

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    // The allowance covers the burn, so its prompt is the first one.
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    expect(reads).toEqual({ atChainStep: 1, atBurn: 2 });
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'delivering',
      expect.anything(),
      undefined,
      undefined
    );
  });

  it('refuses before the approval when the balance dropped during the chain step', async () => {
    runRealExecutor({ readAllowance: async () => 0n });
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    mockSwitchChain.mockImplementationOnce(async () => {
      mockBalance = TYPED + FEE_QUOTE.feeTotalAmount - 1n;
    });

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_balance', feeAboveBalance('1.531907', 'Base Sepolia'), 'usdcxDepositFeeAboveBalance')
    );
  });

  it('fails the row with the balance-read message when the read after an approval fails', async () => {
    runRealExecutor({ readAllowance: async () => 0n });
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    mockWriteContract.mockImplementationOnce(async () => {
      global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ error: { message: 'rpc down' } }) });
      return `0x${'1'.repeat(64)}`;
    });

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    // The approval only: the burn is never asked for.
    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt(
        'precheck_balance',
        `bridgeDepositBalanceReadFailed ${JSON.stringify({ token: 'USDC', network: 'Base Sepolia' })}`,
        'bridgeDepositBalanceReadFailed'
      )
    );
  });

  it('fails the row with the balance-read message when the read after the chain step fails', async () => {
    runRealExecutor({ readAllowance: async () => 0n });
    renderScreen();
    await reachBaseSepoliaRoute();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    mockSwitchChain.mockImplementationOnce(async () => {
      global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ error: { message: 'rpc down' } }) });
    });

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt(
        'precheck_balance',
        `bridgeDepositBalanceReadFailed ${JSON.stringify({ token: 'USDC', network: 'Base Sepolia' })}`,
        'bridgeDepositBalanceReadFailed'
      )
    );
  });

  // The burn pulls Circle's fee on top of the amount, so once the fee is on screen Confirm holds on a balance that
  // covers only the amount, with the words the deposit would fail with.
  it('holds the route card on an amount whose displayed fee takes it past the balance', async () => {
    jest.mocked(quoteExecutorBurn).mockResolvedValue(FEE_QUOTE);
    mockBalance = TYPED + FEE_QUOTE.feeTotalAmount - 1n;
    renderScreen();
    await reachBaseSepoliaRoute();

    expect(screen.getByTestId('usdcx-route-fee')).toHaveTextContent('usdcxForwardFee');
    expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(feeAboveBalance('1.531907', 'Base Sepolia'));
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
    expect(screen.getByTestId('review-error').textContent).toBe(feeAboveBalance('1.531907', 'Base Sepolia'));
    expect(screen.getByTestId('review-can-confirm')).toHaveTextContent(/^false$/);
  });

  // A hold that tells the user to add USDC has to see it arrive.
  describe('while Confirm is held on the Circle USDC balance', () => {
    // The suite's settle() waits on a timer, so the fake clock also runs with real time.
    beforeEach(() => jest.useFakeTimers({ advanceTimers: true }));

    const advance = (ms: number) =>
      act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    const reachFeeHold = async () => {
      jest.mocked(quoteExecutorBurn).mockResolvedValue(FEE_QUOTE);
      mockBalance = TYPED + FEE_QUOTE.feeTotalAmount - 1n;
      const view = renderScreen();
      await reachBaseSepoliaRoute();
      expect(screen.getByTestId('usdcx-route-confirm')).toBeDisabled();
      return view;
    };
    const expectFeeHold = () => {
      expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(feeAboveBalance('1.531907', 'Base Sepolia'));
      expect(screen.getByTestId('usdcx-route-confirm')).toBeDisabled();
    };

    it('re-reads the source balance while a hold is up and enables Confirm once it covers', async () => {
      await reachFeeHold();
      const confirm = screen.getByTestId('usdcx-route-confirm');

      mockBalance = TYPED + FEE_QUOTE.feeTotalAmount;
      expect(confirm).toBeDisabled();
      await advance(10_000);

      expect(confirm).toBeEnabled();
    });

    it('stops re-reading once the hold clears', async () => {
      await reachFeeHold();
      mockBalance = TYPED + FEE_QUOTE.feeTotalAmount;
      await advance(10_000);
      expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();
      const reads = balanceOfRequests().length;

      await advance(30_000);

      expect(balanceOfRequests()).toHaveLength(reads);
    });

    it('stops re-reading on unmount', async () => {
      const view = await reachFeeHold();
      await advance(10_000);
      const reads = balanceOfRequests().length;

      view.unmount();
      await advance(30_000);

      expect(balanceOfRequests()).toHaveLength(reads);
    });

    // A read that never answers is aborted after RPC_TIMEOUT_MS (15 s); until then no second read is sent.
    it('reads one balance at a time and again after the timeout', async () => {
      await reachFeeHold();
      global.fetch = jest.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          })
      );

      await advance(10_000);
      expect(balanceOfRequests()).toHaveLength(1);
      expectFeeHold();
      await advance(10_000);
      expect(balanceOfRequests()).toHaveLength(1);
      expectFeeHold();
      // The read timed out at 25 s, so the tick at 30 s reads again.
      await advance(10_000);
      expect(balanceOfRequests()).toHaveLength(2);
      expectFeeHold();
    });

    it('re-reads the source balance while the amount alone is held and enables Confirm once it covers', async () => {
      mockBalance = TYPED - 1n;
      renderScreen();
      await reachUsdcxRoute();
      expect(screen.getByTestId('form-error')).toHaveTextContent(/^amountMustBeLessThanBalance$/);

      mockBalance = TYPED;
      await advance(10_000);
      expect(screen.getByTestId('form-error')).toBeEmptyDOMElement();
      fireEvent.click(screen.getByTestId('continue'));
      await settle();

      expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();
    });

    it('sends no balance re-read while no hold is up', async () => {
      jest.mocked(quoteExecutorBurn).mockResolvedValue(FEE_QUOTE);
      renderScreen();
      await reachBaseSepoliaRoute();
      expect(screen.getByTestId('usdcx-route-confirm')).toBeEnabled();
      const reads = balanceOfRequests().length;

      await advance(30_000);

      expect(balanceOfRequests()).toHaveLength(reads);
    });

    // The opening token is now Circle USDC, so its balance hold uses the normal bounded re-read.
    it('rechecks the default Circle USDC balance while it holds the amount', async () => {
      mockBalance = 1n;
      renderScreen();
      fireEvent.click(screen.getByTestId('set-amount'));
      await settle();
      expect(screen.getByTestId('form-error')).toHaveTextContent(/^amountMustBeLessThanBalance$/);
      const reads = balanceOfRequests().length;

      await advance(30_000);

      expect(balanceOfRequests()).toHaveLength(reads + 3);
    });

    it('keeps the held balance on screen while its re-reads fail', async () => {
      await reachFeeHold();
      global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ error: { message: 'rpc down' } }) });

      for (const ms of [10_000, 20_000]) {
        await advance(ms);
        expect(screen.getByTestId('usdcx-route-notice').textContent).toBe(feeAboveBalance('1.531907', 'Base Sepolia'));
        expect(screen.getByTestId('usdcx-route-confirm')).toBeDisabled();
      }
    });
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
    expect(jest.mocked(runUsdcxDeposit).mock.calls[0]?.[3]).not.toHaveProperty('readBalance');
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

  it('keeps the Circle source and route when a stale picker attempts the retired token', async () => {
    renderScreen();
    await pickToken('pick-circle-usdc');
    fireEvent.click(screen.getByTestId('open-network-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-network-base-sepolia'));
    await settle();
    await pickToken('pick-usdc');
    expect(screen.getByTestId('form-network')).toHaveTextContent('84532');
    await reachRouteStep();
    expect(screen.getByTestId('usdcx-route-confirm')).toBeInTheDocument();
    expect(epochState.quoteEVMToMiden).not.toHaveBeenCalled();
  });

  // Two chains whose Epoch routes list the same token entry: only the chain tells their balances apart.
  const sameEpochTokenOnTwoChains = (): BridgeConfigSnapshot => {
    const { config, derived } = TEST_BRIDGE_CONFIG_SNAPSHOT;
    const epoch = {
      depositEnabled: true,
      withdrawalEnabled: true,
      tokens: { ETH: { contractAddress: '0x0000000000000000000000000000000000000000' as const, outputs: [] } }
    };
    const reads = {
      ...derived!.chains[11155111]!,
      epoch: {
        tokens: {
          ETH: {
            state: 'ok' as const,
            value: {
              symbol: 'ETH',
              decimals: 18,
              midenFaucetId: '0x00000000000000000000000000e2e1',
              midenSymbol: 'ETH',
              midenDecimals: 8
            }
          }
        }
      }
    };
    return {
      ...TEST_BRIDGE_CONFIG_SNAPSHOT,
      config: {
        ...config!,
        supportedEvmChains: {
          sepolia: { chainId: 11155111, bridges: { epoch } },
          'base-sepolia': { chainId: 84532, bridges: { epoch } }
        }
      },
      derived: { ...derived!, chains: { 11155111: reads, 84532: reads } }
    };
  };

  it('rereads the Epoch balance on a chain that lists the same token entry', async () => {
    mockBridgeSnapshot = sameEpochTokenOnTwoChains();
    global.fetch = jest.fn(async (url: string) => ({
      json: async () => ({ result: word(url.endsWith('/84532') ? 2n * 10n ** 18n : 0n) })
    })) as never;
    renderScreen();
    await settle();
    expect(screen.getByTestId('form-network')).toHaveTextContent(/^11155111$/);
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    expect(screen.getByTestId('form-ready')).toHaveTextContent(/^false$/);

    await pickNetwork('base-sepolia');

    expect(screen.getByTestId('form-network')).toHaveTextContent(/^84532$/);
    expect(screen.getByTestId('form-ready')).toHaveTextContent(/^true$/);
  });

  const CIRCLE_SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const NATIVE_ETH_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
  const OTHER_ETH_ADDRESS = '0x00000000000000000000000000000000000000c1' as const;
  const QUOTED_OTHER_ETH = '0x00000000000000000000000000000000000000C1';
  const QUOTE_ACCOUNT = '0x1111111111111111111111111111111111111111';

  /** Sepolia's Epoch USDC retargeted at `contractAddress`, leaving Circle's USDC where the snapshot names it. */
  const withSepoliaEpochUsdc = (contractAddress: `0x${string}`): BridgeConfigSnapshot => {
    const snapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    const sepolia = snapshot.config!.supportedEvmChains.sepolia!;
    const epoch = sepolia.bridges.epoch!;
    return {
      ...snapshot,
      config: {
        ...snapshot.config!,
        supportedEvmChains: {
          ...snapshot.config!.supportedEvmChains,
          sepolia: {
            ...sepolia,
            bridges: {
              ...sepolia.bridges,
              epoch: {
                ...epoch,
                tokens: { ...epoch.tokens, USDC: { ...epoch.tokens.USDC!, contractAddress } }
              }
            }
          }
        }
      }
    };
  };

  /** AggLayer on Sepolia plus an Epoch ETH at `contractAddress` whose derived read names a faucet. */
  const withSepoliaEpochEth = (contractAddress: `0x${string}`): BridgeConfigSnapshot => {
    const snapshot = withAgglayerEth(TEST_BRIDGE_CONFIG_SNAPSHOT, route => route);
    const sepolia = snapshot.config!.supportedEvmChains.sepolia!;
    const epoch = sepolia.bridges.epoch!;
    const derived = snapshot.derived!;
    const chain = derived.chains[11155111]!;
    return {
      ...snapshot,
      config: {
        ...snapshot.config!,
        supportedEvmChains: {
          ...snapshot.config!.supportedEvmChains,
          sepolia: {
            ...sepolia,
            bridges: {
              ...sepolia.bridges,
              epoch: { ...epoch, tokens: { ...epoch.tokens, ETH: { contractAddress, outputs: [] } } }
            }
          }
        }
      },
      derived: {
        ...derived,
        chains: {
          ...derived.chains,
          11155111: {
            ...chain,
            epoch: {
              tokens: {
                ...chain.epoch.tokens,
                ETH: {
                  state: 'ok',
                  value: {
                    symbol: 'ETH',
                    decimals: 18,
                    midenFaucetId: '0x00000000000000000000000000e2e1',
                    midenSymbol: 'ETH',
                    midenDecimals: 18
                  }
                }
              }
            }
          }
        }
      }
    };
  };

  const backToAmount = async () => {
    fireEvent.click(screen.getByTestId('page-back'));
    await settle();
  };

  // Sepolia's Circle USDC and Epoch USDC are different contracts, so each keeps its own row and its own route.
  it('keeps Sepolia Epoch USDC when its contract differs from Circle', async () => {
    renderScreen();
    await settle();
    await pickNetwork('sepolia');
    await reachRouteStep();

    expect(screen.queryByTestId('circle-fast')).not.toBeInTheDocument();
    await backToAmount();
    await pickToken('pick-usdc');

    expect(screen.getByTestId('form-token')).toHaveTextContent(/^Test Epoch USDC$/);
    expect(epochState.quoteEVMToMiden).toHaveBeenCalledWith(
      expect.objectContaining({
        evmTokenAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
        isNative: false
      }),
      QUOTE_ACCOUNT
    );
  });

  // The same contract, spelled in lowercase on the Epoch route, is still Circle's USDC: Fast quotes that contract.
  it('shares Fast when Circle and Epoch name the same USDC contract', async () => {
    mockBridgeSnapshot = withSepoliaEpochUsdc('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
    renderScreen();
    await settle();
    await pickNetwork('sepolia');
    await reachRouteStep();

    expect(screen.getByTestId('circle-fast')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('circle-fast'));
    await settle();
    expect(epochState.quoteEVMToMiden).toHaveBeenCalledWith(
      expect.objectContaining({ evmTokenAddress: CIRCLE_SEPOLIA_USDC, isNative: false }),
      QUOTE_ACCOUNT
    );

    await backToAmount();
    await pickToken('pick-usdc');
    expect(screen.getByTestId('form-token')).toHaveTextContent(/^USDC$/);
  });

  // An Epoch token keyed ETH at another contract is its own row. Native ETH then has no Fast route.
  it('lists Epoch ETH on its own contract beside native ETH', async () => {
    mockBridgeSnapshot = withSepoliaEpochEth(OTHER_ETH_ADDRESS);
    renderScreen();
    await settle();
    await pickNetwork('sepolia');
    fireEvent.click(screen.getByTestId('open-token-drawer'));
    await settle();
    fireEvent.click(screen.getByTestId('pick-epoch-ETH'));
    await settle();
    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();

    expect(epochState.quoteEVMToMiden).toHaveBeenCalledWith(
      expect.objectContaining({ evmTokenAddress: QUOTED_OTHER_ETH, isNative: false }),
      QUOTE_ACCOUNT
    );
    await pickToken('pick-eth');
    await reachRouteStep();
    expect(screen.getByTestId('fast-availability')).toHaveTextContent(/^unavailable$/);
  });

  // The zero address is AggLayer's native ETH, so that Epoch row is the Fast route of the native pick.
  it('shares Fast when Epoch ETH is the native coin', async () => {
    mockBridgeSnapshot = withSepoliaEpochEth(NATIVE_ETH_ADDRESS);
    renderScreen();
    await settle();
    await pickNetwork('sepolia');
    fireEvent.click(screen.getByTestId('open-token-drawer'));
    await settle();

    expect(screen.queryByTestId('pick-epoch-ETH')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pick-eth'));
    await settle();
    await reachRouteStep();
    fireEvent.click(screen.getByTestId('pick-fast'));
    await settle();

    expect(epochState.quoteEVMToMiden).toHaveBeenCalledWith(
      expect.objectContaining({ evmTokenAddress: NATIVE_ETH_ADDRESS, isNative: true }),
      QUOTE_ACCOUNT
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
      expect(failedWrites).toEqual(
        outcome === 'rejected'
          ? [
              [
                'bridge-tx',
                'failed',
                failedAt('wallet_deposit', 'User rejected', undefined, native ? 'native_reown' : 'wagmi')
              ]
            ]
          : []
      );
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
    'raises no prompt and fails the row with no answer when the balance falls under a %s deposit before Confirm (native=%s)',
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
      const network = route === 'xreserve' ? 'Arc Testnet' : 'Base Sepolia';
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
        'bridge-tx',
        'failed',
        failedAt(
          'precheck_balance',
          `bridgeDepositBalanceTooLow ${JSON.stringify({ balance: '1.4999', token: 'USDC', network })}`,
          'bridgeDepositBalanceTooLow'
        )
      );
      expect(reportedEvmError()).toBe('none');
    }
  );

  it.each(['xreserve', 'cctp-executor'])(
    'fails the row at the balance check with the RPC timeout when the %s balance re-read at Confirm times out',
    async route => {
      renderScreen();
      if (route === 'xreserve') await reachUsdcxRoute();
      else await reachBaseSepoliaRoute();
      fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
      await settle();
      // What a read that never answered rejects with once its timer aborts it.
      global.fetch = jest.fn().mockRejectedValue(requestTimeoutError(15_000));

      fireEvent.click(screen.getByTestId('confirm-deposit'));
      await settle();

      expect(runUsdcxDeposit).not.toHaveBeenCalled();
      expect(runUsdcxExecutorDeposit).not.toHaveBeenCalled();
      const network = route === 'xreserve' ? 'Arc Testnet' : 'Base Sepolia';
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith(
        'bridge-tx',
        'failed',
        failedAt(
          'precheck_balance',
          `bridgeDepositBalanceReadFailed ${JSON.stringify({ token: 'USDC', network })}`,
          'bridgeDepositBalanceReadFailed'
        )
      );
      expect(reportedEvmError()).toBe('timeout');
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

  const confirmDeposit = async (route: 'xreserve' | 'cctp-executor' = 'xreserve') => {
    renderScreen();
    await reachRoute(route);
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();
  };
  /** Every RPC read from here on fails; the balance the screen checks first has already been read. */
  const failRpc = () => {
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ error: { message: 'rpc down' } }) });
  };

  // A registration read that throws, rather than answering false, still fails the row at the domain check.
  it.each(['xreserve', 'cctp-executor'] as const)(
    'fails the row at the domain check, before any prompt, when the %s registration read fails',
    async route => {
      const readDomain = async (deps: Pick<UsdcxExecutorDepositDeps, 'isRemoteDomainRegistered'>) => {
        failRpc();
        await deps.isRemoteDomainRegistered(10007);
        return `0x${'2'.repeat(64)}` as const;
      };
      if (route === 'xreserve') {
        jest.mocked(runUsdcxDeposit).mockImplementationOnce((_id, _amount, _recipient, deps) => readDomain(deps));
      } else {
        jest
          .mocked(runUsdcxExecutorDeposit)
          .mockImplementationOnce((_id, _amount, _recipient, deps) => readDomain(deps));
      }

      await confirmDeposit(route);

      expect(mockWriteContract).not.toHaveBeenCalled();
      expect(mockNativeSend).not.toHaveBeenCalled();
      expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
        'bridge-tx',
        'failed',
        failedAt('precheck_domain', 'rpc down')
      );
    }
  );

  it('fails the row at the allowance check, before any prompt, when the allowance read fails', async () => {
    jest.mocked(runUsdcxDeposit).mockImplementationOnce(async (_id, _amount, _recipient, deps) => {
      await deps.isRemoteDomainRegistered(10007);
      failRpc();
      await deps.readAllowance('0x008888878f94C0d87defdf0B07f46B93C1934442');
      return deps.signer.approve('0x008888878f94C0d87defdf0B07f46B93C1934442', 1_500_000n);
    });

    await confirmDeposit();

    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(mockNativeSend).not.toHaveBeenCalled();
    expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith(
      'bridge-tx',
      'failed',
      failedAt('precheck_allowance', 'rpc down')
    );
  });

  it.each((['prompt', 'receipt'] as const).flatMap(stage => [false, true].map(native => [stage, native] as const)))(
    'retainsTheApprovalRejectionAsFailureCause: %s (native=%s)',
    async (stage, native) => {
      mockNativeAvailable = native;
      const walletPrompt = native ? mockNativeSend : mockWriteContract;
      const error = new Error(`approval ${stage} failed`);
      if (stage === 'prompt') walletPrompt.mockRejectedValueOnce(error);
      else jest.mocked(waitForEvmReceipt).mockRejectedValueOnce(error);
      jest.mocked(runUsdcxDeposit).mockImplementationOnce(async (_id, _amount, recipient, deps) => {
        await deps.isRemoteDomainRegistered(10007);
        await deps.readAllowance('0x008888878f94C0d87defdf0B07f46B93C1934442');
        await deps.waitForReceipt(await deps.signer.approve('0x008888878f94C0d87defdf0B07f46B93C1934442', 1_500_000n));
        return deps.signer.depositToRemote([
          1_500_000n,
          10007,
          recipient,
          '0x3600000000000000000000000000000000000000',
          0n,
          '0x'
        ]);
      });

      await confirmDeposit();

      expect(walletPrompt).toHaveBeenCalledTimes(1);
      expect(updateBridgedReceivePhase).toHaveBeenLastCalledWith('bridge-tx', 'failed', {
        error: error.message,
        errorId: 'raw_bridge_deposit_failed',
        failure: {
          step: stage === 'prompt' ? 'wallet_approve' : 'approve_receipt',
          cause: error,
          ...(stage === 'prompt' ? { requestClient: native ? 'native_reown' : 'wagmi' } : {})
        }
      });
      const lastCall = jest.mocked(updateBridgedReceivePhase).mock.calls.at(-1);
      expect(lastCall?.[2]?.failure?.cause).toBe(error);
    }
  );

  it('fails the row at provider_unavailable, before any prompt, with no native or web provider', async () => {
    mockNativeAvailable = false;
    mockWebProviderConnected = false;

    await confirmDeposit();

    await waitFor(() =>
      expect(updateBridgedReceivePhase).toHaveBeenCalledWith('bridge-tx', 'failed', {
        error: 'The connected EVM wallet provider is unavailable.',
        errorId: 'raw_bridge_deposit_failed',
        failure: { step: 'provider_unavailable' }
      })
    );
    expect(runUsdcxDeposit).not.toHaveBeenCalled();
    expect(runUsdcxExecutorDeposit).not.toHaveBeenCalled();
    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(mockNativeSend).not.toHaveBeenCalled();
    expect(mockSwitchChain).not.toHaveBeenCalled();
    expect(prepareNativeSessionChain).not.toHaveBeenCalled();
  });
});

const mockReportUserVisibleError = jest.fn();
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: (...args: unknown[]) => mockReportUserVisibleError(...args)
}));

const expectErrorAfterDwell = async (id: string, surface: string) => {
  await act(async () => {
    jest.advanceTimersByTime(999);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockReportUserVisibleError.mock.calls).toEqual([[id, surface]]);
};

let mockRealBridgeDisplays = false;
let mockLiveBridgeRow: ITransaction | undefined;
const mockLiveBridgeListeners = new Set<() => void>();
let mockRealBridgeRowQuery = false;
jest.mock('screens/generating-transaction/useTransactionRow', () => {
  const useMockLiveBridgeRow = (_txId: string) => {
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
  };
  return {
    useTransactionRow: (txId: string) => {
      const useRow = mockRealBridgeRowQuery
        ? jest.requireActual<typeof import('screens/generating-transaction/useTransactionRow')>(
            'screens/generating-transaction/useTransactionRow'
          ).useTransactionRow
        : useMockLiveBridgeRow;
      return useRow(txId);
    }
  };
});
jest.mock('lib/dexie-live-query', () => {
  const actual = jest.requireActual<typeof import('lib/dexie-live-query')>('lib/dexie-live-query');
  return { ...actual, subscribeToLiveQuery: jest.fn(actual.subscribeToLiveQuery) };
});
jest.mock('app/hooks/useMidenFaucetId', () => ({ __esModule: true, default: () => 'synthetic-native' }));
jest.mock('lib/store', () => ({
  useWalletStore: <T,>(
    selector: (state: { assetsMetadata: Record<string, never>; tokenPrices: Record<string, never> }) => T
  ) => selector({ assetsMetadata: {}, tokenPrices: {} })
}));
// The bridge-in ceiling reads the receiving account's balances; with no ceiling in the document it holds nothing.
jest.mock('lib/miden/front', () => ({
  ...jest.requireActual<typeof import('lib/miden/front')>('lib/miden/front'),
  useAllTokensBaseMetadata: () => ({}),
  useAllBalances: () => ({ data: [], isLoading: false })
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

const mockBridgeErrorCopy: Record<string, string> = {
  evmChainNotApproved: 'Reconnect the selected wallet',
  bridgeDepositBalanceReadFailed: 'Could not check the balance',
  bridgeDepositBalanceTooLow: 'The source wallet holds too little',
  usdcxDomainNotRegistered: 'Circle has not enabled this destination',
  usdcxForwardQuoteUnavailable: 'Circle could not price this transfer',
  usdcxDepositFeeAboveBalance: 'Lower the amount to cover the fee'
};

describe('user-visible USDCx deposit producers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRealBridgeDisplays = true;
    mockLiveBridgeRow = undefined;
    mockBridgeSnapshot = undefined;
    mockNativeAvailable = false;
    mockWebProviderConnected = true;
    mockUseDebounce.mockImplementation((value: unknown) => [value]);
    mockBalance = 10n ** 30n;
    global.fetch = jest.fn().mockImplementation(answerRpc());
    jest.mocked(quoteExecutorBurn).mockReset().mockResolvedValue({ signedQuote: '0x01', feeTotalAmount: 31_908n });
    jest.mocked(runUsdcxDeposit).mockReset();
    jest.mocked(runUsdcxExecutorDeposit).mockReset();
    jest.mocked(prepareNativeSessionChain).mockReset().mockResolvedValue(undefined);
    mockSwitchChain.mockReset().mockResolvedValue(undefined);
    jest.mocked(initiateBridgedReceiveTransaction).mockReset();
    jest.mocked(updateBridgedReceivePhase).mockReset();
    observeBridgeWrites();
  });
  afterEach(() => {
    jest.useRealTimers();
    mockRealBridgeDisplays = false;
    mockLiveBridgeRow = undefined;
    mockBridgeSnapshot = undefined;
    mockNativeAvailable = false;
    mockWebProviderConnected = true;
    jest.mocked(initiateBridgedReceiveTransaction).mockReset().mockResolvedValue('bridge-tx');
    jest.mocked(updateBridgedReceivePhase).mockReset().mockResolvedValue(undefined);
    jest
      .mocked(runUsdcxDeposit)
      .mockReset()
      .mockResolvedValue(`0x${'2'.repeat(64)}`);
    jest
      .mocked(runUsdcxExecutorDeposit)
      .mockReset()
      .mockResolvedValue(`0x${'2'.repeat(64)}`);
  });
  const realUsdcxReview = async (executor = false) => {
    renderScreen();
    await settle();
    if (executor) {
      fireEvent.click(screen.getByTestId('bridge-source-network'));
      await settle();
      fireEvent.click(screen.getByTestId('pick-network-base-sepolia'));
      await settle();
    }
    fireEvent.change(screen.getByTestId('send-amount-input'), { target: { value: '1.5' } });
    await settle();
    fireEvent.click(screen.getByTestId('send-amount-confirm'));
    await settle();
    fireEvent.click(screen.getByTestId('usdcx-route-confirm'));
    await settle();
    expect(screen.getByTestId('bridge-deposit-review-confirm')).toBeInTheDocument();
  };
  const startAndObserve = async () => {
    fireEvent.click(screen.getByTestId('bridge-deposit-review-confirm'));
    await settle();
    expect(await screen.findByText('bridgeDepositProcessing')).toBeInTheDocument();
    jest.useFakeTimers();
  };

  it.each([false, true])(
    'blocks all dismissal through source signing and restores it on success (executor: %s)',
    async executor => {
      let finish: () => void = () => undefined;
      const pending = new Promise<`0x${string}`>(resolve => {
        finish = () => resolve(`0x${'2'.repeat(64)}`);
      });
      const complete = async (id: string, update: typeof updateBridgedReceivePhase): Promise<`0x${string}`> => {
        await pending;
        await update(id, 'delivering');
        return `0x${'2'.repeat(64)}`;
      };
      if (executor)
        jest
          .mocked(runUsdcxExecutorDeposit)
          .mockImplementationOnce((id, _amount, _recipient, deps) => complete(id, deps.updatePhase));
      else
        jest
          .mocked(runUsdcxDeposit)
          .mockImplementationOnce((id, _amount, _recipient, deps) => complete(id, deps.updatePhase));
      await realUsdcxReview(executor);
      await startAndObserve();
      expect(screen.queryByTestId('flow-close')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'hide' })).not.toBeInTheDocument();
      await act(async () => {
        expect(pressMobileBack()).toBe(true);
      });
      expect(mockCloseDeposit).not.toHaveBeenCalled();
      expect(screen.getByText('bridgeDepositProcessing')).toBeInTheDocument();
      await act(async () => {
        finish();
      });
      await flushBridgePromises();
      expect(screen.getByText('bridgeDepositSubmitted')).toBeInTheDocument();
      await act(async () => {
        pressMobileBack();
      });
      expect(mockCloseDeposit).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'done' }));
      expect(mockCloseDeposit).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['User rejected request', 'Request cancelled', 'RPC unavailable'])(
    'releases dismissal after %s and locks a new attempt again',
    async message => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let refuse: (error: Error) => void = () => undefined;
        jest.mocked(runUsdcxDeposit).mockReturnValueOnce(
          new Promise((_resolve, reject) => {
            refuse = reject;
          })
        );
        await realUsdcxReview();
        await startAndObserve();
        expect(screen.queryByRole('button', { name: 'hide' })).not.toBeInTheDocument();
        await act(async () => {
          pressMobileBack();
        });
        expect(mockCloseDeposit).toHaveBeenCalledTimes(attempt * 2);
        await act(async () => {
          refuse(new Error(message));
        });
        await flushBridgePromises();
        expect(screen.getByText('bridgeDepositFailed')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'done' }));
        await act(async () => {
          pressMobileBack();
        });
        expect(mockCloseDeposit).toHaveBeenCalledTimes((attempt + 1) * 2);
        cleanup();
        mockLiveBridgeRow = undefined;
        jest.useRealTimers();
      }
    }
  );

  it('releases dismissal when persisting a terminal error fails', async () => {
    let refuse: (error: Error) => void = () => undefined;
    jest.mocked(runUsdcxDeposit).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuse = reject;
      })
    );
    await realUsdcxReview();
    await startAndObserve();
    jest.mocked(updateBridgedReceivePhase).mockRejectedValueOnce(new Error('Synthetic write failure'));
    await act(async () => {
      refuse(new Error('User rejected request'));
    });
    await flushBridgePromises();
    // The stored row is still submitting, but the local signing attempt is over. Never trap the user on a failed save.
    expect(screen.getByText('bridgeDepositProcessing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    await act(async () => {
      pressMobileBack();
    });
    expect(mockCloseDeposit).toHaveBeenCalledTimes(2);
  });

  it('prevents backing out while creating the row and releases the review after creation fails', async () => {
    let refuse: (error: Error) => void = () => undefined;
    jest.mocked(initiateBridgedReceiveTransaction).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuse = reject;
      })
    );
    await realUsdcxReview();
    fireEvent.click(screen.getByTestId('bridge-deposit-review-confirm'));
    await settle();
    expect(screen.queryByTestId('page-back')).not.toBeInTheDocument();
    await act(async () => {
      pressMobileBack();
    });
    expect(screen.getByTestId('bridge-deposit-review-confirm')).toBeInTheDocument();
    expect(mockCloseDeposit).not.toHaveBeenCalled();
    await act(async () => {
      refuse(new Error('Synthetic storage failure'));
    });
    await flushBridgePromises();
    expect(screen.getByTestId('page-back')).toBeInTheDocument();
    await act(async () => {
      pressMobileBack();
    });
    await settle();
    expect(screen.getByTestId('usdcx-route-confirm')).toBeInTheDocument();
  });

  it.each([
    [
      'domain refusal',
      new UsdcxDomainNotRegisteredError(10007),
      'Circle has not enabled this destination',
      'usdcxDomainNotRegistered',
      false
    ],
    [
      'quote refusal',
      new UsdcxForwardQuoteUnavailableError('private quote cause'),
      'Circle could not price this transfer',
      'usdcxForwardQuoteUnavailable',
      true
    ],
    [
      'executor fee refusal',
      new UsdcxExecutorBalanceTooLowError(1_531_908n, 31_908n, 1_520_000n),
      'Lower the amount to cover the fee',
      'usdcxDepositFeeAboveBalance',
      true
    ],
    [
      'raw submission failure',
      new Error('private burn 42 https://synthetic.invalid/0xabc'),
      'private burn 42 https://synthetic.invalid/0xabc',
      'raw_bridge_deposit_failed',
      false
    ]
  ] satisfies [string, Error, string, string, boolean][])(
    'reports the observed %s using its retained producer identity',
    async (_label, cause, copy, id, executor) => {
      let refuse: (cause: Error) => void = () => undefined;
      const pending = new Promise<`0x${string}`>((_resolve, reject) => {
        refuse = reject;
      });
      if (executor) jest.mocked(runUsdcxExecutorDeposit).mockReturnValueOnce(pending);
      else jest.mocked(runUsdcxDeposit).mockReturnValueOnce(pending);
      await realUsdcxReview(executor);
      await startAndObserve();
      await act(async () => {
        refuse(cause);
      });
      await flushBridgePromises();
      expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveTextContent(copy);
      await expectErrorAfterDwell(id, 'status_screen');
    }
  );

  it('reports a wrapped native session refusal by its fixed translated identity', async () => {
    mockNativeAvailable = true;
    let refuse: (cause: Error) => void = () => undefined;
    jest.mocked(prepareNativeSessionChain).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        })
    );
    await realUsdcxReview();
    await startAndObserve();
    await act(async () => {
      refuse(new Error('private wrapper', { cause: new NativeSessionChainNotApprovedError(5042002, 'Arc Testnet') }));
    });
    await flushBridgePromises();
    expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveTextContent(
      'Reconnect the selected wallet'
    );
    await expectErrorAfterDwell('evmChainNotApproved', 'status_screen');
  });

  it.each(['read failure', 'balance dropped'])(
    'reports the actual preflight %s with a fixed identity',
    async outcome => {
      await realUsdcxReview();
      let resume: () => void = () => undefined;
      const pending = new Promise<void>(resolve => {
        resume = resolve;
      });
      global.fetch = jest.fn().mockImplementation(async () => {
        await pending;
        if (outcome === 'read failure') throw new Error('private balance cause');
        return { json: async () => ({ result: word(1n) }) };
      });
      await startAndObserve();
      await act(async () => {
        resume();
      });
      await flushBridgePromises();
      const copy = outcome === 'read failure' ? 'Could not check the balance' : 'The source wallet holds too little';
      const id = outcome === 'read failure' ? 'bridgeDepositBalanceReadFailed' : 'bridgeDepositBalanceTooLow';
      expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveTextContent(copy);
      await expectErrorAfterDwell(id, 'status_screen');
    }
  );

  it('reports a late fee hold through the actual review layout', async () => {
    let answer: (quote: CctpBurnQuote) => void = () => undefined;
    jest.mocked(quoteExecutorBurn).mockImplementation(
      () =>
        new Promise<CctpBurnQuote>(resolve => {
          answer = resolve;
        })
    );
    mockBalance = 1_531_907n;
    await realUsdcxReview(true);
    jest.useFakeTimers();
    await act(async () => {
      answer({ signedQuote: '0x01', feeTotalAmount: 31_908n });
    });
    await flushBridgePromises();
    expect(screen.getByText(/Lower the amount to cover the fee/)).toBeInTheDocument();
    expect(screen.getByTestId('bridge-deposit-review-confirm')).toBeDisabled();
    await expectErrorAfterDwell('usdcxDepositFeeAboveBalance', 'review');
  });

  it('keeps a pending Circle quote and the executor route guidance quiet', async () => {
    jest.mocked(quoteExecutorBurn).mockImplementation(() => new Promise<CctpBurnQuote>(() => undefined));
    await realUsdcxReview(true);
    jest.useFakeTimers();
    expect(screen.queryByText(/Lower the amount to cover the fee/)).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockReportUserVisibleError.mock.calls).toEqual([]);
  });

  it.each([
    ['xReserve', false, 5042002, 'xreserve'],
    ['executor', true, 84532, 'cctp-executor']
  ] satisfies [string, boolean, number, 'xreserve' | 'cctp-executor'][])(
    'reports a fresh %s producer failure when its first row read is already failed',
    async (_route, executor, sourceChainId, sourceRoute) => {
      const deferred = () => {
        let resolve: () => void = () => undefined;
        let reject: (error: unknown) => void = () => undefined;
        const promise = new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        });
        return { promise, resolve, reject };
      };
      const driverEntered = deferred();
      const releaseDriver = deferred();
      const subscriptionScheduled = deferred();
      const releaseSubscriptionStart = deferred();
      const firstRowDelivered = deferred();
      const failureStored = deferred();
      const deliveredRows: unknown[] = [];
      const cause = new Error('Fresh bridge runner refused');
      const actualSubscribe =
        jest.requireActual<typeof import('lib/dexie-live-query')>('lib/dexie-live-query').subscribeToLiveQuery;
      const actualCreate = jest.requireActual<typeof import('lib/miden/transaction/initiate')>(
        'lib/miden/transaction/initiate'
      ).initiateBridgedReceiveTransaction;
      const actualUpdate = jest.requireActual<typeof import('lib/miden/transaction/complete')>(
        'lib/miden/transaction/complete'
      ).updateBridgedReceivePhase;
      installProviderReceiptBackend(async () => {});
      let createdId = '';
      jest.mocked(initiateBridgedReceiveTransaction).mockImplementation(async input => {
        createdId = await actualCreate(input);
        return createdId;
      });
      jest.mocked(updateBridgedReceivePhase).mockImplementation(async (...args) => {
        await actualUpdate(...args).catch(error => {
          failureStored.reject(error);
          throw error;
        });
        if (args[1] === 'failed') failureStored.resolve();
      });
      const failDriver = async () => {
        driverEntered.resolve();
        await releaseDriver.promise;
        throw cause;
      };
      if (executor) jest.mocked(runUsdcxExecutorDeposit).mockImplementationOnce(failDriver);
      else jest.mocked(runUsdcxDeposit).mockImplementationOnce(failDriver);
      mockRealBridgeRowQuery = true;
      jest
        .mocked(subscribeToLiveQuery)
        .mockImplementationOnce(
          <T,>(
            query: () => T | Promise<T>,
            observer: { next: (value: T) => void; error: (error: unknown) => void }
          ) => {
            let disposed = false;
            let unsubscribe: (() => void) | undefined;
            subscriptionScheduled.resolve();
            void releaseSubscriptionStart.promise
              .then(() => {
                if (disposed) return;
                unsubscribe = actualSubscribe(query, {
                  next: value => {
                    if (deliveredRows.length === 0) jest.useFakeTimers();
                    deliveredRows.push(value);
                    observer.next(value);
                    firstRowDelivered.resolve();
                  },
                  error: error => {
                    observer.error(error);
                    firstRowDelivered.reject(error);
                  }
                });
              })
              .catch(error => {
                if (disposed) return;
                observer.error(error);
                firstRowDelivered.reject(error);
              });
            return () => {
              disposed = true;
              unsubscribe?.();
            };
          }
        );
      try {
        await realUsdcxReview(executor);
        await act(async () => {
          fireEvent.click(screen.getByTestId('bridge-deposit-review-confirm'));
          await driverEntered.promise;
        });
        await subscriptionScheduled.promise;
        expect(deliveredRows).toEqual([]);
        expect(mockReportUserVisibleError.mock.calls).toEqual([]);
        await act(async () => {
          releaseDriver.resolve();
          await failureStored.promise;
        });
        expect(await Repo.transactions.get(createdId)).toMatchObject({
          id: createdId,
          type: 'bridged-receive',
          extraInputs: {
            provider: 'usdcx',
            phase: 'failed',
            error: 'Fresh bridge runner refused',
            errorId: 'raw_bridge_deposit_failed',
            sourceChainId,
            usdcxSource: { route: sourceRoute }
          }
        });
        expect(deliveredRows).toEqual([]);
        await act(async () => {
          releaseSubscriptionStart.resolve();
          await firstRowDelivered.promise;
        });
        expect(deliveredRows).toEqual([
          expect.objectContaining({ id: createdId, extraInputs: expect.objectContaining({ phase: 'failed' }) })
        ]);
        expect(screen.getByTestId('bridge-deposit-processing-description')).toHaveTextContent(
          'Fresh bridge runner refused'
        );
        await act(async () => {
          jest.advanceTimersByTime(999);
        });
        expect(mockReportUserVisibleError.mock.calls).toEqual([]);
        await act(async () => {
          jest.advanceTimersByTime(1);
        });
        expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_bridge_deposit_failed', 'status_screen']]);
        await act(async () => {
          jest.advanceTimersByTime(1000);
        });
        expect(mockReportUserVisibleError.mock.calls).toEqual([['raw_bridge_deposit_failed', 'status_screen']]);
      } finally {
        releaseDriver.resolve();
        releaseSubscriptionStart.resolve();
        cleanup();
        jest.useRealTimers();
        mockRealBridgeRowQuery = false;
        installProviderReceiptBackend(undefined);
        jest.mocked(subscribeToLiveQuery).mockImplementation(actualSubscribe);
      }
    }
  );
});
