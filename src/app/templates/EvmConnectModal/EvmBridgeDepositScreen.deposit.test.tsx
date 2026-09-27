import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { ReportDeposit } from 'app/hooks/useFundTelemetry';
import { initiateBridgedReceiveTransaction } from 'lib/miden/activity';

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

jest.mock('wagmi', () => ({
  useWriteContract: () => ({ mutateAsync: jest.fn() })
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
  // Mirrors the real contract (`string | undefined`): the screen aborts a requote on
  // a falsy result, so a constant would hide that branch. Unused on the Slow route,
  // which needs no quote.
  evmToMidenMinTokenOut: (amount: string) => (Number(amount) > 0 ? '1000000' : undefined),
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

// The banner renders nothing on mainnet; a test network makes its render assertion mean something.
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: () => 'testnet'
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
  getChain: () => ({ rpcUrl: 'https://rpc.test', name: 'Sepolia' })
}));

// Step components stubbed down to the affordances the deposit path needs.
jest.mock('./EvmBridgeDepositForm', () => ({
  EvmBridgeDepositForm: ({
    onAmountChange,
    onContinue,
    onSelectToken
  }: {
    onAmountChange: (value?: string) => void;
    onContinue: () => void;
    onSelectToken: () => void;
  }) => (
    <div>
      <button data-testid="set-amount" onClick={() => onAmountChange('1.5')}>
        amount
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
  EvmBridgeDepositReview: ({ amount, onConfirm }: { amount: string; onConfirm: () => void }) => (
    <div>
      <span data-testid="review-amount">{amount}</span>
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
  EvmBridgeTokenDrawer: ({ open, onSelect }: { open: boolean; onSelect: (token: string) => void }) =>
    open ? (
      <button data-testid="pick-eth" onClick={() => onSelect('ETH')}>
        ETH
      </button>
    ) : null
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

const reachReview = async () => {
  fireEvent.click(screen.getByTestId('open-token-drawer'));
  await settle();
  fireEvent.click(screen.getByTestId('pick-eth'));
  await settle();
  fireEvent.click(screen.getByTestId('set-amount'));
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

  it('shows the Fast-route deposit on the Review rounded down, not half-up', async () => {
    Object.assign(epochState, {
      quoteEVMToMiden: jest.fn().mockResolvedValue(undefined),
      status: 'quoted',
      flow: 'evm-to-miden',
      quote: {
        params: { minTokenOut: '1000000' },
        quoteResult: { tokenIn: '10655500000000000000', tokenOut: '10000000' }
      }
    });
    renderScreen();

    fireEvent.click(screen.getByTestId('set-amount'));
    await settle();
    fireEvent.click(screen.getByTestId('continue'));
    await settle();
    fireEvent.click(await screen.findByTestId('confirm-route'));
    await settle();

    expect(await screen.findByTestId('review-amount')).toHaveTextContent(/^10\.65$/);
    expect(idleEpoch.quoteEVMToMiden()).toBeUndefined();
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

  // The flow commits value on amount entry and route choice, and the shell's banner is what names the
  // network there (the registry in NetworkModeBanner.registry.test.ts points here). getByTestId also
  // fails on two banners.
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
