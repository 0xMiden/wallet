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
    useFeatureAvailability: (feature: BridgeFeature) => mockAvailability[feature] ?? { state: 'available' }
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
  useEpochStore: (selector: (s: typeof epochState) => unknown) => selector(epochState)
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
  DEFAULT_CHAIN_ID: 11155111,
  SUPPORTED_CHAINS: [{ id: 11155111 }],
  getChain: () => ({ rpcUrl: 'https://rpc.test', name: 'Sepolia' })
}));

// Step components stubbed down to the affordances the deposit path needs.
jest.mock('./EvmBridgeDepositForm', () => ({
  EvmBridgeDepositForm: ({
    error,
    onAmountChange,
    onContinue,
    onSelectToken
  }: {
    error?: string;
    onAmountChange: (value?: string) => void;
    onContinue: () => void;
    onSelectToken: () => void;
  }) => (
    <div>
      <span data-testid="form-error">{error}</span>
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
      <button data-testid="continue" onClick={onContinue}>
        continue
      </button>
    </div>
  )
}));

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
  }) => (
    <div>
      <span data-testid="review-amount">{amount}</span>
      <span data-testid="review-fiat">{fiat}</span>
      <span data-testid="review-output">{outputAmount}</span>
      <button data-testid="confirm-deposit" onClick={onConfirm}>
        confirm
      </button>
    </div>
  )
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
  }) => (
    <div>
      <span data-testid="usdc-balance">{usdcLoading ? 'loading' : usdcBalance}</span>
      {open ? (
        <button data-testid="pick-eth" onClick={() => onSelect('ETH')}>
          ETH
        </button>
      ) : null}
    </div>
  )
}));

jest.mock('./EvmSwitchWalletDrawer', () => ({
  EvmSwitchWalletDrawer: () => null
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

const renderScreen = (reportDeposit?: ReportDeposit) =>
  render(
    <EvmBridgeDepositScreen
      evmAddress="0xevm-wallet"
      midenAccount={midenAccount as never}
      onConnectAnother={jest.fn()}
      onClose={jest.fn()}
      reportDeposit={reportDeposit}
    />
  );

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

  it.each<[string, (config: NonNullable<MockSnapshot['config']>) => MockSnapshot['config'], Record<string, unknown>]>([
    ['the allocator', config => ({ ...config, epoch: { ...config.epoch, allocatorUrl: 'https://moved.test' } }), {}],
    [
      'the Miden USDC faucet',
      config => ({ ...config, epoch: { ...config.epoch, midenUsdcFaucet: '0x00000000000000000000000000e2e1' } }),
      { midenFaucetId: '0x00000000000000000000000000e2e1' }
    ]
  ])('quotes again once the config moves only %s', async (_case, move, moved) => {
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

  it('shows the USDC balance as loading, not as an error, while the config loads', async () => {
    mockSnapshot = { status: 'loading', config: null, lastFetch: null };
    renderScreen();
    await settle();

    expect(screen.getByTestId('usdc-balance')).toHaveTextContent('loading');
    expect(screen.getByTestId('form-error')).toBeEmptyDOMElement();
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
