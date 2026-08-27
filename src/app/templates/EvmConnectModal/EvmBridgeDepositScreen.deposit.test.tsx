import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { ReportDeposit } from 'app/hooks/useFundTelemetry';
import { initiateBridgedReceiveTransaction } from 'lib/miden/activity';

import { EvmBridgeDepositScreen } from './EvmBridgeDepositScreen';

// Covers only the deposit submission: the tap that turns a quoted/valid amount
// into a tracked bridge transfer, and the reporter the hosting page wraps it
// with. Every collaborator beyond the step components is stubbed — this suite is
// not a test of the bridge itself.

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

jest.mock('lib/epoch', () => ({
  MIDEN_DESTINATION_CHAIN_ID: 1,
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

jest.mock('components/ScreenHeader', () => ({
  ScreenHeader: () => <div data-testid="screen-header" />
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
  EvmBridgeDepositReview: ({ onConfirm }: { onConfirm: () => void }) => (
    <button data-testid="confirm-deposit" onClick={onConfirm}>
      confirm
    </button>
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
});
