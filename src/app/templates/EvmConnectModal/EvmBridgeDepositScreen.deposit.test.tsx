import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { ReportDeposit } from 'app/hooks/useFundTelemetry';
import { initiateBridgedReceiveTransaction } from 'lib/miden/activity';
import type { BridgeFeature, FeatureAvailability } from 'lib/remote-config/availability';

import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

// Covers the deposit submission (the tap that turns a quoted/valid amount into a
// tracked bridge transfer, and the reporter the hosting page wraps it with) and
// the network banner the shell renders over the committing steps. Every
// collaborator beyond the step components is stubbed - this suite is not a test
// of the bridge itself.

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('@reown/appkit/react', () => ({
  useAppKitProvider: () => ({ walletProvider: { request: jest.fn() } })
}));

const mockMutateAsync = jest.fn();
jest.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: jest.fn().mockResolvedValue(undefined) }),
  useWriteContract: () => ({ mutateAsync: mockMutateAsync })
}));

// The Fast USDC pair and the Slow route's L1 bridge come from the bridge config. As in the runtime, every publish is
// a new snapshot object, and as the real selectors do, the ones below build new objects from it on every call.
interface MockSnapshot {
  status: 'loading' | 'ready';
  config: {
    evm: { chainId: number };
    epoch: { allocatorUrl: string; evmUsdc: string; midenUsdcFaucet: string };
  } | null;
  lastFetch: { at: number; ok: boolean } | null;
}
const READY_SNAPSHOT: MockSnapshot = {
  status: 'ready',
  config: {
    evm: { chainId: 84532 },
    epoch: {
      allocatorUrl: 'https://allocator.test',
      evmUsdc: '0x00000000000000000000000000000000000000c0',
      midenUsdcFaucet: '0x00000000000000000000000000e2e0'
    }
  },
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
jest.mock('lib/agglayer', () => ({
  AGGLAYER_BRIDGE_ABI: [],
  AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL: 'ETH',
  midenAddrToEvmAddr: () => '0x00000000000000000000000000000000000000a1'
}));
jest.mock('lib/remote-config/values', () => ({
  selectEvmUsdc: ({ config }: MockSnapshot) =>
    config ? { address: config.epoch.evmUsdc, symbol: 'USDC', decimals: 18, chainId: config.evm.chainId } : null,
  selectMidenUsdc: ({ config }: MockSnapshot) =>
    config ? { faucetId: config.epoch.midenUsdcFaucet, symbol: 'USDC', decimals: 6 } : null,
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
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
}));

// The sheet the banner opens needs a router this suite does not mount; it is never opened here.
jest.mock('components/NetworkModeSheet', () => ({
  NetworkModeSheet: () => null
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: () => undefined
}));

jest.mock('lib/walletconnect/native', () => ({
  isNativeReownAvailable: () => false,
  NativeReown: { sendTransaction: jest.fn() },
  unwrapNativeResult: (value: unknown) => value
}));

jest.mock('lib/walletconnect/receipt', () => ({
  waitForSepoliaReceipt: jest.fn().mockResolvedValue(undefined)
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
    token,
    amount,
    error,
    onAmountChange,
    onContinue,
    onSelectToken,
    onSwitch
  }: {
    token: { name: string };
    amount: string;
    error?: string;
    onAmountChange: (value?: string) => void;
    onContinue: () => void;
    onSelectToken: () => void;
    onSwitch: () => void;
  }) => {
    mockLastOpenTokenDrawer = onSelectToken;
    return (
      <div>
        <span data-testid="form-error">{error}</span>
        <span data-testid="form-amount">{amount}</span>
        <span data-testid="form-token">{token.name}</span>
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
jest.mock('./EvmBridgeDepositReview', () => ({
  EvmBridgeDepositReview: ({
    amount,
    fiat,
    outputAmount,
    onConfirm
  }: {
    amount: string;
    fiat?: number;
    outputAmount?: string;
    onConfirm: () => void;
  }) => {
    mockLastReviewConfirm = onConfirm;
    return (
      <div>
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
  EvmBridgeDepositStatus: () => <div data-testid="deposit-status" />
}));

jest.mock('./EvmBridgeTokenDrawer', () => ({
  EvmBridgeTokenDrawer: ({
    open,
    onSelect,
    usdcBalance,
    usdcLoading
  }: {
    open: boolean;
    onSelect: (token: string) => void;
    usdcBalance: string;
    usdcLoading: boolean;
  }) => {
    mockLastTokenSelect = onSelect;
    return (
      <div>
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

/** Drive the ETH + Slow route to Review, the deposit path with no quote needed. */
const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

const reachReview = async (amountButton = 'set-amount') => {
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
  await settle();
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

const reachFastReview = async () => {
  fireEvent.click(screen.getByTestId('set-amount-padded'));
  await settle();
  fireEvent.click(screen.getByTestId('continue'));
  await settle();
  fireEvent.click(await screen.findByTestId('confirm-route'));
  await settle();
};

/** Drive USDC (the default token) + Slow route to Review. The amount is typed on the default Fast route, which quotes it. */
const reachSlowUsdcReview = async () => {
  Object.assign(epochState, { quoteEVMToMiden: jest.fn().mockResolvedValue(undefined) });
  fireEvent.click(screen.getByTestId('set-amount-four-places'));
  await settle();
  fireEvent.click(screen.getByTestId('continue'));
  await settle();
  fireEvent.click(await screen.findByTestId('pick-slow'));
  await settle();
  fireEvent.click(screen.getByTestId('confirm-route'));
  await settle();
};

const connectAnother = jest.fn();
const depositScreen = (reportDeposit?: ReportDeposit) => (
  <EvmBridgeDepositScreen
    evmAddress="0xevm-wallet"
    midenAccount={midenAccount as never}
    onConnectAnother={connectAnother}
    onClose={jest.fn()}
    reportDeposit={reportDeposit}
  />
);

const renderScreen = (reportDeposit?: ReportDeposit) => render(depositScreen(reportDeposit));

type ConfigMove = (config: NonNullable<MockSnapshot['config']>) => MockSnapshot['config'];
const CONFIG_MOVES: [string, ConfigMove, Record<string, unknown>][] = [
  ['the allocator', config => ({ ...config, epoch: { ...config.epoch, allocatorUrl: 'https://moved.test' } }), {}],
  [
    'the Miden USDC faucet',
    config => ({ ...config, epoch: { ...config.epoch, midenUsdcFaucet: '0x00000000000000000000000000e2e1' } }),
    { midenFaucetId: '0x00000000000000000000000000e2e1' }
  ]
];
const NO_MIDEN_USDC: [string, ConfigMove] = [
  'the Miden USDC faucet, to none',
  config => ({ ...config, epoch: { ...config.epoch, midenUsdcFaucet: '' } })
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
    mockSnapshot = READY_SNAPSHOT;
    jest.mocked(initiateBridgedReceiveTransaction).mockResolvedValue('bridge-tx');
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ result: '0x0' }) }) as never;
  });

  // The Fast case below quotes into the shared store; every case starts from it idle.
  afterEach(() => {
    Object.assign(epochState, idleEpoch);
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
    renderScreen();

    await reachReview();
    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();

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
        sourceChainId: 84532,
        evmTokenAddress: '0x00000000000000000000000000000000000000c0',
        midenFaucetId: '0x00000000000000000000000000e2e0',
        minTokenOut: '1500000'
      }),
      '0xevm-wallet'
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
        sourceChainId: 84532,
        evmTokenAddress: '0x00000000000000000000000000000000000000c0',
        midenFaucetId: '0x00000000000000000000000000e2e0',
        minTokenOut: '1500000',
        ...moved
      }),
      '0xevm-wallet'
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

    expect(screen.getByTestId('form-token')).toHaveTextContent(/^USDC$/);
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
    expect(screen.getByTestId('form-token')).toHaveTextContent(/^USDC$/);

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
      const moved = { ...config, epoch: { ...config.epoch, allocatorUrl: 'https://moved.test' } };
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
        '0xevm-wallet'
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
    const moved = { ...config, epoch: { ...config.epoch, evmUsdc: '0x00000000000000000000000000000000000000c1' } };
    act(() => publishSnapshot({ ...READY_SNAPSHOT, config: moved }));
    await settle();

    expect(ethReads()).toBe(1);
  });

  it.each<[string, BridgeFeature, () => Promise<void>]>([
    ['Fast', 'fastBridgeIn', reachFastReview],
    ['Slow', 'bridgeIn', reachReview]
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
    expect(lastHold('fastBridgeIn')).toEqual({ hold: true });
    expect(lastHold('bridgeIn')).toEqual({ hold: true });

    fireEvent.click(screen.getByTestId('confirm-deposit'));
    await settle();
    expect(await screen.findByTestId('deposit-status')).toBeInTheDocument();
    expect(lastHold('fastBridgeIn')).toEqual({ hold: false });
    expect(lastHold('bridgeIn')).toEqual({ hold: false });
  });

  it('starts every case from an idle epoch store', () => {
    expect(epochState).toMatchObject({ status: 'idle', flow: null, quote: null });
    expect(epochState.quoteEVMToMiden).toBe(idleEpoch.quoteEVMToMiden);
    expect(epochState.quoteEVMToMiden()).toBeUndefined();
  });
});

describe('EvmBridgeDepositScreen names the network', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ result: '0x0' }) }) as never;
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
